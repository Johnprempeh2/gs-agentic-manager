import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  devRunnerAttachedToTerminal,
  devRunnerHangupAction,
  handleDevRunnerHangups,
  serverChildUsesProcessGroup,
  signalServerProcessTreeOnExit,
  stopServerProcessTree,
  type ServerChildExit,
  type ServerProcessTree,
} from "../../../scripts/dev-runner-process.ts";
import { isProcessGroupAlive } from "../services/local-service-supervisor.ts";

// Real process trees shaped like the dev runner's server child:
//   sh -c "[exec] node relay.mjs server.mjs"   (pnpm's script shell)
//     relay.mjs                                 (pnpm and tsx: pass SIGINT/SIGTERM on)
//       server.mjs                              (the server: listens on a port)
//         db.mjs                                (embedded PostgreSQL)
// On SIGTERM the fake server writes its snapshot, closes its listener, then
// stops its database with SIGINT, the order the real server keeps.

const RELAY = `
import { spawn } from "node:child_process";
const [script, ...args] = process.argv.slice(2);
const child = spawn(process.execPath, [script, ...args], { stdio: "ignore" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
`;

const SERVER = `
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
const [dir, mode] = process.argv.slice(2);
const log = (line) => fs.appendFileSync(path.join(dir, "events.log"), line + "\\n");
const db = spawn(process.execPath, [path.join(dir, "db.mjs"), dir, mode], { stdio: "ignore" });
const listener = net.createServer().listen(0, "127.0.0.1", () => {
  fs.writeFileSync(path.join(dir, "server.json"), JSON.stringify({
    pid: process.pid, dbPid: db.pid, port: listener.address().port,
  }));
});
if (mode === "hang") {
  process.on("SIGTERM", () => log("server ignored SIGTERM"));
} else {
  process.once("SIGTERM", () => {
    log("server SIGTERM");
    log("snapshot written");
    listener.close(() => {
      log("listener closed");
      db.once("exit", () => {
        log("server exit");
        process.exit(0);
      });
      db.kill("SIGINT");
    });
  });
}
setInterval(() => {}, 1000);
`;

const DB = `
import fs from "node:fs";
import path from "node:path";
const [dir, mode] = process.argv.slice(2);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    fs.appendFileSync(path.join(dir, "events.log"), "db " + signal + "\\n");
    if (mode !== "hang") process.exit(0);
  });
}
fs.writeFileSync(path.join(dir, "db.ready"), String(process.pid));
setInterval(() => {}, 1000);
`;

type Mode = "graceful" | "hang";

const tempDirs = new Set<string>();
const startedGroups = new Set<number>();

afterEach(() => {
  for (const group of startedGroups) {
    try {
      process.kill(-group, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  startedGroups.clear();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(check: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await sleep(25);
  }
}

/** Alive and not a zombie waiting to be reaped. */
function processRunning(pid: number) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") return true;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[0];
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

function startServerTree(mode: Mode, options: { shellExecs: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dev-runner-process-"));
  tempDirs.add(dir);
  fs.writeFileSync(path.join(dir, "relay.mjs"), RELAY);
  fs.writeFileSync(path.join(dir, "server.mjs"), SERVER);
  fs.writeFileSync(path.join(dir, "db.mjs"), DB);
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const run = [process.execPath, path.join(dir, "relay.mjs"), path.join(dir, "server.mjs"), dir, mode]
    .map(quote)
    .join(" ");
  // `exec` replaces the shell, as the server package scripts now do. Without
  // it, `; true` keeps the shell as the parent on bash and dash alike, which is
  // what dash does to `sh -c "tsx src/index.ts"` on Ubuntu.
  const command = options.shellExecs ? `exec ${run}` : `${run}; true`;
  const head = spawn("/bin/sh", ["-c", command], { detached: true, stdio: "ignore" });
  const exited = new Promise<ServerChildExit>((resolve) => {
    head.on("exit", (code, signal) => resolve({ code: code ?? 0, signal }));
  });
  startedGroups.add(head.pid!);
  const tree: ServerProcessTree = { pid: head.pid!, processGroupId: head.pid!, exited };
  return { dir, tree };
}

async function waitForServer(dir: string) {
  await waitUntil(
    () => fs.existsSync(path.join(dir, "server.json")) && fs.existsSync(path.join(dir, "db.ready")),
    10_000,
  );
  return JSON.parse(fs.readFileSync(path.join(dir, "server.json"), "utf8")) as {
    pid: number;
    dbPid: number;
    port: number;
  };
}

function readEvents(dir: string) {
  const file = path.join(dir, "events.log");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : [];
}

async function portIsFree(port: number) {
  return await new Promise<boolean>((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

describe("serverChildUsesProcessGroup", () => {
  it("uses a process group everywhere except Windows", () => {
    expect(serverChildUsesProcessGroup("linux")).toBe(true);
    expect(serverChildUsesProcessGroup("darwin")).toBe(true);
    expect(serverChildUsesProcessGroup("win32")).toBe(false);
  });
});

describe("dev runner hangups (SIGHUP)", () => {
  it("counts the runner as attached when any standard stream is a terminal", () => {
    const only = (terminalFd: number | null) => (fd: number) => fd === terminalFd;
    expect(devRunnerAttachedToTerminal(only(0))).toBe(true);
    expect(devRunnerAttachedToTerminal(only(1))).toBe(true);
    expect(devRunnerAttachedToTerminal(only(2))).toBe(true);
    // nohup, systemd, or a script with its output in a log (live, 3 Oct 2026).
    expect(devRunnerAttachedToTerminal(only(null))).toBe(false);
  });

  it("stops the server on a hangup only in a terminal", () => {
    expect(devRunnerHangupAction(true)).toBe("stop_server");
    expect(devRunnerHangupAction(false)).toBe("ignore");
  });

  function hangupHarness(attachedToTerminal: boolean) {
    const target = new EventEmitter();
    const stops: number[] = [];
    const logs: string[] = [];
    const action = handleDevRunnerHangups({
      attachedToTerminal,
      stopServer: () => stops.push(Date.now()),
      log: (message) => logs.push(message),
      target: target as unknown as Pick<NodeJS.Process, "on">,
    });
    return { target, stops, logs, action };
  }

  it("in a terminal, stops the server tree when the terminal closes (#274)", () => {
    const { target, stops, logs, action } = hangupHarness(true);
    expect(action).toBe("stop_server");
    target.emit("SIGHUP");
    expect(stops).toHaveLength(1);
    expect(logs).toEqual([]);
  });

  it("with no terminal, keeps a listener that ignores the hangup instead of leaving the default, which would end the runner", () => {
    const { target, stops, logs, action } = hangupHarness(false);
    expect(action).toBe("ignore");
    expect(target.listenerCount("SIGHUP")).toBe(1);
    target.emit("SIGHUP");
    target.emit("SIGHUP");
    expect(stops).toEqual([]);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/ignored SIGHUP/);
  });

  it("leaves SIGINT and SIGTERM to the runner", () => {
    const { target } = hangupHarness(false);
    expect(target.listenerCount("SIGINT")).toBe(0);
    expect(target.listenerCount("SIGTERM")).toBe(0);
  });
});

describe("server package scripts", () => {
  it("exec the command the dev runner starts, so no shell sits between pnpm and the server", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(manifest.scripts.dev).toMatch(/^exec /);
    expect(manifest.scripts["dev:watch"]).toMatch(/^exec /);
  });
});

describe.skipIf(process.platform === "win32")("stopServerProcessTree", () => {
  it("stops the tree through its head and lets the server keep its own shutdown order", async () => {
    const { dir, tree } = startServerTree("graceful", { shellExecs: true });
    const server = await waitForServer(dir);

    const result = await stopServerProcessTree(tree, { signal: "SIGTERM", timeoutMs: 5_000, settleMs: 200 });

    expect(result.outcome).toBe("exited");
    expect(result.exit).toEqual({ code: 0, signal: null });
    // The database got SIGINT from the server after the snapshot, never a
    // signal of its own from the runner.
    expect(readEvents(dir)).toEqual([
      "server SIGTERM",
      "snapshot written",
      "listener closed",
      "db SIGINT",
      "server exit",
    ]);
    // Nothing is left when the stop resolves, so a restart can take the port.
    expect(isProcessGroupAlive(tree.processGroupId)).toBe(false);
    expect(processRunning(server.pid)).toBe(false);
    expect(processRunning(server.dbPid)).toBe(false);
    expect(await portIsFree(server.port)).toBe(true);
  });

  it("does not leave the server running when a shell between the head and the server swallows the signal", async () => {
    const { dir, tree } = startServerTree("graceful", { shellExecs: false });
    const server = await waitForServer(dir);

    // What the runner used to do: signal the head only. The shell dies and the
    // server, now an orphan, keeps its port and its database (2 Oct 2026).
    process.kill(tree.pid, "SIGTERM");
    await tree.exited;
    await sleep(300);
    expect(processRunning(server.pid)).toBe(true);
    expect(processRunning(server.dbPid)).toBe(true);

    const result = await stopServerProcessTree(tree, { signal: "SIGTERM", timeoutMs: 5_000, settleMs: 200 });

    expect(result.outcome).toBe("stragglers_signalled");
    expect(isProcessGroupAlive(tree.processGroupId)).toBe(false);
    expect(processRunning(server.pid)).toBe(false);
    expect(processRunning(server.dbPid)).toBe(false);
    expect(await portIsFree(server.port)).toBe(true);
  });

  it("kills the whole tree, database included, when it is still running at the deadline", async () => {
    const { dir, tree } = startServerTree("hang", { shellExecs: true });
    const server = await waitForServer(dir);
    const startedAt = Date.now();

    const result = await stopServerProcessTree(tree, { signal: "SIGTERM", timeoutMs: 1_500, settleMs: 200 });

    expect(result.outcome).toBe("killed");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_400);
    expect(readEvents(dir)).toContain("server ignored SIGTERM");
    expect(isProcessGroupAlive(tree.processGroupId)).toBe(false);
    expect(processRunning(server.pid)).toBe(false);
    expect(processRunning(server.dbPid)).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("signalServerProcessTreeOnExit", () => {
  it("asks a running head to stop, so the server still shuts down in order", async () => {
    const { dir, tree } = startServerTree("graceful", { shellExecs: true });
    await waitForServer(dir);

    expect(signalServerProcessTreeOnExit(tree, { headRunning: true })).toBe("head");

    await waitUntil(() => !isProcessGroupAlive(tree.processGroupId), 5_000);
    expect(readEvents(dir)).toContain("snapshot written");
  });

  it("signals what the head left behind once the head has gone", async () => {
    const { dir, tree } = startServerTree("graceful", { shellExecs: false });
    const server = await waitForServer(dir);
    process.kill(tree.pid, "SIGTERM");
    await tree.exited;

    expect(signalServerProcessTreeOnExit(tree, { headRunning: false })).toBe("group");

    await waitUntil(() => !isProcessGroupAlive(tree.processGroupId), 5_000);
    expect(processRunning(server.pid)).toBe(false);
    expect(processRunning(server.dbPid)).toBe(false);
  });

  it("does nothing when the tree has already gone", async () => {
    const { dir, tree } = startServerTree("graceful", { shellExecs: true });
    await waitForServer(dir);
    await stopServerProcessTree(tree, { signal: "SIGTERM", timeoutMs: 5_000, settleMs: 200 });

    expect(signalServerProcessTreeOnExit(tree, { headRunning: false })).toBeNull();
  });
});
