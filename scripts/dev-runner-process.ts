import { isatty } from "node:tty";
import { isPidAlive, isProcessGroupAlive } from "../server/src/services/local-service-supervisor.ts";

/**
 * How the dev runner stops the server it supervises.
 *
 * The runner starts the server as `pnpm --filter @greatstone/server dev`. That
 * child is only the head of a tree: pnpm, the package script, tsx, the server
 * itself, and the server's own children (embedded PostgreSQL, esbuild, plugin
 * workers). On POSIX the runner starts the head as the leader of a new process
 * group, so it can see when every process of the tree has gone and, as a last
 * resort, kill all of them at once. Agent runs, the native runner and other
 * processes that must outlive a server restart already start their own process
 * groups, so they are not part of this one.
 *
 * The polite stop signal goes to the head only. The server package scripts
 * `exec` their command, so the chain relays it (pnpm -> tsx -> server) and the
 * server alone decides the shutdown order: hot-restart snapshot, HTTP listener,
 * database pools, then embedded PostgreSQL. Signalling the whole group first
 * would hand PostgreSQL the signal directly, before the snapshot is written.
 */

/** Time a stopping server tree gets before the runner kills it. */
export const SERVER_TREE_STOP_TIMEOUT_MS = 10_000;
/** How long the runner waits for the tree to go after SIGKILL. */
export const SERVER_TREE_KILL_WAIT_MS = 5_000;
/** Pause after the head exits before the rest of the tree counts as left over. */
export const SERVER_TREE_SETTLE_MS = 1_000;
/**
 * Upper bound for the runner itself to stop its server tree. Callers that stop
 * the runner from outside (for example `pnpm dev:stop`) must wait at least
 * this long before they kill the runner, or the runner cannot finish.
 */
export const DEV_RUNNER_STOP_BUDGET_MS =
  SERVER_TREE_STOP_TIMEOUT_MS + SERVER_TREE_KILL_WAIT_MS + 5_000;

export type ServerChildExit = { code: number; signal: NodeJS.Signals | null };

export type ServerProcessTree = {
  /** PID of the process the runner spawned, the head of the tree. */
  pid: number;
  /** The tree's process group, or null where none is used (Windows). */
  processGroupId: number | null;
  /** Resolves when the head process exits. */
  exited: Promise<ServerChildExit>;
};

export type StopServerProcessTreeOutcome =
  /** Every process of the tree exited after the stop signal. */
  | "exited"
  /** The head exited but left processes behind, which then got the signal. */
  | "stragglers_signalled"
  /** The tree was still running at the deadline and got SIGKILL. */
  | "killed"
  /** Even SIGKILL did not end the tree within the wait. */
  | "still_running";

export type StopServerProcessTreeResult = {
  exit: ServerChildExit | null;
  outcome: StopServerProcessTreeOutcome;
  elapsedMs: number;
};

const TIMED_OUT = Symbol("timed out");

/** Whether the runner should start its server child as a process group leader. */
export function serverChildUsesProcessGroup(platform: NodeJS.Platform = process.platform) {
  return platform !== "win32";
}

/**
 * Whether the runner is attached to a terminal: one of its standard streams is
 * one. nohup redirects every standard stream that is a terminal, and systemd
 * and scripts that log to a file give it none, so a runner started to outlive
 * its session never counts as attached.
 */
export function devRunnerAttachedToTerminal(isTerminal: (fd: number) => boolean = isatty) {
  return isTerminal(0) || isTerminal(1) || isTerminal(2);
}

export type DevRunnerHangupAction = "stop_server" | "ignore";

/**
 * What a hangup (SIGHUP) means to the runner. In a terminal it means the
 * terminal closed: the server tree has its own process group and gets no
 * hangup of its own (#274), so the runner stops it. A runner that is not
 * attached to a terminal was started to keep running after its session ends,
 * as live is, so it ignores the hangup: on 3 Oct 2026 the end of the session
 * that started live hung up the runner, and it stopped live.
 */
export function devRunnerHangupAction(attachedToTerminal: boolean): DevRunnerHangupAction {
  return attachedToTerminal ? "stop_server" : "ignore";
}

/**
 * Always installs a SIGHUP listener, also where the hangup is ignored. Node
 * resets a SIGHUP that nohup set to "ignore" back to the default when it
 * starts, and the default ends the runner at once, without stopping the server
 * tree it supervises.
 */
export function handleDevRunnerHangups(options: {
  attachedToTerminal: boolean;
  stopServer: () => void;
  log: (message: string) => void;
  target?: Pick<NodeJS.Process, "on">;
}): DevRunnerHangupAction {
  const action = devRunnerHangupAction(options.attachedToTerminal);
  (options.target ?? process).on("SIGHUP", () => {
    if (action === "stop_server") {
      options.stopServer();
      return;
    }
    options.log(
      "ignored SIGHUP: this dev runner is not attached to a terminal (nohup, systemd or a script started it), so a hangup does not stop it; stop it with SIGTERM or pnpm dev:stop",
    );
  });
  return action;
}

function sendSignal(target: number, signal: NodeJS.Signals) {
  try {
    process.kill(target, signal);
    return true;
  } catch {
    // The target already exited, or the group emptied between checks.
    return false;
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function settleBefore<T>(promise: Promise<T>, deadline: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Whether any process of the tree is still running. With a process group this
 * covers orphans the head left behind; without one only the head is known.
 */
export function isServerProcessTreeAlive(tree: ServerProcessTree, headRunning: boolean) {
  if (tree.processGroupId !== null) return isProcessGroupAlive(tree.processGroupId);
  return headRunning && isPidAlive(tree.pid);
}

/**
 * Stops the server tree and resolves only once no process of it is left, so a
 * restart never starts the next server while the old one still holds its port,
 * its database or an unwritten hot-restart snapshot.
 *
 * 1. `signal` goes to the head only (see the module comment).
 * 2. When the head has exited but the group still has members, those were
 *    orphaned without the signal (for example a server behind a shell that did
 *    not `exec` it), so the group gets `signal` once.
 * 3. At `timeoutMs` the whole group gets SIGKILL.
 */
export async function stopServerProcessTree(
  tree: ServerProcessTree,
  options: {
    signal: NodeJS.Signals;
    timeoutMs?: number;
    settleMs?: number;
    killWaitMs?: number;
    pollIntervalMs?: number;
    log?: (message: string) => void;
  },
): Promise<StopServerProcessTreeResult> {
  const startedAt = Date.now();
  const deadline = startedAt + (options.timeoutMs ?? SERVER_TREE_STOP_TIMEOUT_MS);
  const settleMs = options.settleMs ?? SERVER_TREE_SETTLE_MS;
  const killWaitMs = options.killWaitMs ?? SERVER_TREE_KILL_WAIT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const log = options.log ?? (() => undefined);
  const groupLabel = tree.processGroupId !== null
    ? `process group ${tree.processGroupId}`
    : `process ${tree.pid}`;

  let headRunning = true;
  const exited = tree.exited.then(
    (exit) => {
      headRunning = false;
      return exit;
    },
    () => {
      headRunning = false;
      return { code: 1, signal: null } satisfies ServerChildExit;
    },
  );
  const treeAlive = () => isServerProcessTreeAlive(tree, headRunning);
  const waitUntilGone = async (until: number) => {
    while (treeAlive()) {
      if (Date.now() >= until) return false;
      await sleep(pollIntervalMs);
    }
    return true;
  };

  sendSignal(tree.pid, options.signal);
  const headExit = await settleBefore(exited, deadline);
  let exit: ServerChildExit | null = headExit === TIMED_OUT ? null : headExit;
  let outcome: StopServerProcessTreeOutcome = "exited";

  if (exit && tree.processGroupId !== null) {
    if (!(await waitUntilGone(Math.min(deadline, Date.now() + settleMs)))) {
      log(`server process ${tree.pid} exited but left processes in ${groupLabel}; sending ${options.signal} to them`);
      sendSignal(-tree.processGroupId, options.signal);
      outcome = "stragglers_signalled";
      await waitUntilGone(deadline);
    }
  }

  if (!exit || treeAlive()) {
    const waitedSeconds = Math.round((Date.now() - startedAt) / 100) / 10;
    log(`server ${groupLabel} still running ${waitedSeconds}s after ${options.signal}; sending SIGKILL`);
    sendSignal(tree.processGroupId !== null ? -tree.processGroupId : tree.pid, "SIGKILL");
    outcome = "killed";
    const killDeadline = Date.now() + killWaitMs;
    if (!exit) {
      const killedExit = await settleBefore(exited, killDeadline);
      exit = killedExit === TIMED_OUT ? null : killedExit;
    }
    if (!(await waitUntilGone(killDeadline))) {
      log(`server ${groupLabel} is still running after SIGKILL`);
      outcome = "still_running";
    }
  }

  return { exit, outcome, elapsedMs: Date.now() - startedAt };
}

/**
 * Best effort for a runner that is exiting without having stopped its server
 * (an uncaught error, a failed restart, an unexpected child exit). Synchronous,
 * for a `process.on("exit")` hook: asks a running head to stop, or the
 * processes the head left behind. Returns what it signalled.
 */
export function signalServerProcessTreeOnExit(
  tree: ServerProcessTree,
  options: { headRunning: boolean; signal?: NodeJS.Signals },
): "head" | "group" | null {
  const signal = options.signal ?? "SIGTERM";
  if (options.headRunning && sendSignal(tree.pid, signal)) return "head";
  if (tree.processGroupId !== null && isProcessGroupAlive(tree.processGroupId)) {
    return sendSignal(-tree.processGroupId, signal) ? "group" : null;
  }
  return null;
}
