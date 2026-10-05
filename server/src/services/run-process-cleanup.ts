import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, inArray, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { heartbeatRuns } from "@greatstone/db";
import { processKillGuardPaths } from "@greatstone/adapter-utils/process-kill-guard";
import { redactCommandTextForLogs } from "@greatstone/adapter-utils/server-utils";
import { toLegacyEnvKey } from "@greatstone/shared/legacy-env";
import { logger } from "../middleware/logger.js";
import { liveProcessGuard } from "./live-process-guard.js";
import { listLocalServiceRegistryRecords } from "./local-service-supervisor.js";

/**
 * Stops processes an agent run left behind.
 *
 * An agent's shell tool can start a server in the background (often with
 * `nohup` or `setsid`). When the agent exits, that process is reparented to
 * init and nothing stops it: on 5 Oct 2026 two Storybook dev servers from
 * finished runs had run for 22 and 15 hours (2.5 and 2.2 GB) in worktrees that
 * were already deleted. Every process an agent starts inherits the run's
 * environment, so `GSAM_RUN_ID` (and its legacy alias, which agents also get)
 * names the run that owns it.
 *
 * Two entry points use the same pure selection over a process list:
 * - at the end of a local run, the processes that carry that run's marker;
 * - a periodic sweep (and one at server start) for processes whose marker
 *   names a run of this instance that ended a while ago, and for unmarked
 *   orphans whose working directory is a deleted `.gsam/worktrees/` folder.
 *
 * Never stopped: the server, the processes that started it and every process
 * it still parents (agent processes, warm ACP sessions, plugin workers),
 * anything whose command, executable or working directory lies in the live
 * install, its data, the GSAM root (`~/GSAM`, which holds the preview) or the
 * client instances folder, and workspace runtime services in the registry.
 *
 * Linux only. Where `/proc` or a process environment cannot be read it does
 * nothing. `GSAM_RUN_PROCESS_CLEANUP=false` turns it off.
 */

/** How long a process has between SIGTERM and SIGKILL. */
export const LEFTOVER_PROCESS_GRACE_MS = 5_000;
/** How often the periodic sweep runs (the server ticks more often; this throttles). */
export const LEFTOVER_PROCESS_SWEEP_INTERVAL_MS = 5 * 60_000;
/**
 * The sweep leaves a finished run's processes alone this long after the run
 * ended. The end-of-run cleanup owns that window, and during a hot restart the
 * old server may still be shutting its runs down.
 */
export const LEFTOVER_PROCESS_SWEEP_RUN_ENDED_MIN_AGE_MS = 10 * 60_000;
/** An unmarked orphan in a deleted worktree must be at least this old. */
export const LEFTOVER_PROCESS_DELETED_WORKTREE_MIN_AGE_MS = 10 * 60_000;

const TERMINAL_RUN_STATUSES = ["succeeded", "interrupted", "failed", "cancelled", "timed_out"] as const;
/** While an agent has a run in one of these, the sweep leaves all its markers alone. */
const AGENT_BUSY_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
// The GSAM_* name first, then the legacy alias every agent environment also carries.
const RUN_ID_KEYS: readonly string[] = ["GSAM_RUN_ID", toLegacyEnvKey("GSAM_RUN_ID")];
const API_URL_KEYS: readonly string[] = ["GSAM_API_URL", toLegacyEnvKey("GSAM_API_URL")];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DELETED_SUFFIX = " (deleted)";
const WORKTREE_DIR_RE = /(^|\/)\.gsam\/worktrees\/[^/]+/;
// Linux reports start times in USER_HZ ticks, 100 on every mainstream build.
const CLOCK_TICKS_PER_SECOND = 100;

/** The run marker read from a process environment. The environment itself is never kept. */
export interface RunMarker {
  /** `GSAM_RUN_ID`, else its legacy alias; null when neither is set. */
  runId: string | null;
  /** Both names are set and disagree: the process is left alone. */
  conflicting: boolean;
  /** `GSAM_API_URL`, else its legacy alias: the server the agent talked to. */
  apiUrl: string | null;
}

/** One process as the cleanup sees it. */
export interface ObservedProcess {
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  /** The state letter from `/proc/<pid>/stat` (`Z` is a zombie). */
  state: string;
  hasTty: boolean;
  /** Start time in clock ticks since boot: with the PID, the identity checked before each signal. */
  startTicks: string;
  ageMs: number | null;
  args: string[];
  exe: string | null;
  /** The working directory without the kernel's " (deleted)" suffix. */
  cwd: string | null;
  cwdDeleted: boolean;
  /** Null when the environment could not be read: such a process is never selected. */
  marker: RunMarker | null;
}

/** What must never be stopped. */
export interface ProcessProtection {
  /** Only this user's processes are considered. */
  uid: number;
  /** The server: it, the processes above it and every process it still parents. */
  serverPid: number;
  /** Directories of live, its data, the GSAM root and the client instances. */
  protectedPaths: readonly string[];
  /** Workspace runtime services from the registry, and the processes they parent. */
  servicePids?: readonly number[];
  serviceGroupIds?: readonly number[];
}

export type LeftoverReason = "run_ended" | "ended_run_marker" | "deleted_worktree";

export interface LeftoverTarget {
  process: ObservedProcess;
  reason: LeftoverReason;
  runId: string | null;
}

export interface LeftoverSelection {
  targets: LeftoverTarget[];
  /** Processes a rule matched but that were left alone because they are protected. */
  protectedMatches: number;
}

export function runProcessCleanupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.GSAM_RUN_PROCESS_CLEANUP?.trim().toLowerCase();
  return !(raw === "false" || raw === "0" || raw === "off" || raw === "no");
}

/** Reads the run marker from a raw `/proc/<pid>/environ` buffer; nothing else is kept. */
export function parseRunMarker(environ: Buffer | string): RunMarker {
  const text = typeof environ === "string" ? environ : environ.toString("utf8");
  const values = new Map<string, string>();
  for (const entry of text.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    if (RUN_ID_KEYS.includes(key) || API_URL_KEYS.includes(key)) {
      if (!values.has(key)) values.set(key, entry.slice(eq + 1).trim());
    }
  }
  const runIds = [...new Set(RUN_ID_KEYS.map((key) => values.get(key)).filter((value): value is string => !!value))];
  const apiUrl = API_URL_KEYS.map((key) => values.get(key)).find((value): value is string => !!value) ?? null;
  return { runId: runIds[0] ?? null, conflicting: runIds.length > 1, apiUrl };
}

/** The TCP port an API URL points at, or null when it cannot be read. */
export function apiUrlPort(apiUrl: string | null): number | null {
  if (!apiUrl) return null;
  try {
    const url = new URL(apiUrl);
    if (url.port) return Number(url.port);
    if (url.protocol === "https:") return 443;
    if (url.protocol === "http:") return 80;
    return null;
  } catch {
    return null;
  }
}

/**
 * True when `text` mentions `dir` followed by the end of the text or a
 * character that cannot continue a path segment. This mirrors the agent
 * pkill/killall guard (`process-kill-guard.ts`), so both treat the same
 * processes as live's.
 */
export function mentionsPath(text: string, dir: string): boolean {
  if (!dir) return false;
  let from = 0;
  for (;;) {
    const at = text.indexOf(dir, from);
    if (at < 0) return false;
    const next = text.charAt(at + dir.length);
    if (next === "" || !/[A-Za-z0-9._-]/.test(next)) return true;
    from = at + 1;
  }
}

function touchesProtectedPath(proc: ObservedProcess, protectedPaths: readonly string[]): boolean {
  const texts = [...proc.args, proc.exe ?? "", proc.cwd ?? ""].filter(Boolean);
  return protectedPaths.some((dir) => texts.some((text) => mentionsPath(text, dir)));
}

function childrenByParent(processes: readonly ObservedProcess[]): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const proc of processes) {
    const list = children.get(proc.ppid);
    if (list) list.push(proc.pid);
    else children.set(proc.ppid, [proc.pid]);
  }
  return children;
}

function descendantsOf(roots: Iterable<number>, children: Map<number, number[]>): Set<number> {
  const seen = new Set<number>();
  const queue = [...roots];
  while (queue.length > 0) {
    const pid = queue.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) queue.push(child);
  }
  return seen;
}

/** Returns a test for "this process must never be stopped". */
export function protectionTest(
  processes: readonly ObservedProcess[],
  protection: ProcessProtection,
): (proc: ObservedProcess) => boolean {
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const children = childrenByParent(processes);
  const shielded = descendantsOf([protection.serverPid], children);
  // The server's ancestors: the dev runner, pnpm and the shell that started it.
  let cursor = byPid.get(protection.serverPid)?.ppid;
  for (let steps = 0; cursor && cursor > 1 && steps < 64; steps += 1) {
    shielded.add(cursor);
    cursor = byPid.get(cursor)?.ppid;
  }
  for (const pid of descendantsOf(protection.servicePids ?? [], children)) shielded.add(pid);
  const serviceGroups = new Set((protection.serviceGroupIds ?? []).filter((id) => id > 1));
  return (proc) =>
    proc.pid <= 1 ||
    proc.uid !== protection.uid ||
    shielded.has(proc.pid) ||
    serviceGroups.has(proc.pgid) ||
    touchesProtectedPath(proc, protection.protectedPaths);
}

function stoppable(proc: ObservedProcess): boolean {
  return proc.pid > 1 && proc.state !== "Z";
}

/** At the end of a run: the processes that still carry that run's marker. */
export function selectRunEndLeftovers(
  processes: readonly ObservedProcess[],
  input: { runId: string; protection: ProcessProtection },
): LeftoverSelection {
  const isProtected = protectionTest(processes, input.protection);
  const targets: LeftoverTarget[] = [];
  let protectedMatches = 0;
  for (const proc of processes) {
    if (!stoppable(proc) || !proc.marker || proc.marker.conflicting) continue;
    if (proc.marker.runId !== input.runId) continue;
    if (isProtected(proc)) {
      protectedMatches += 1;
      continue;
    }
    targets.push({ process: proc, reason: "run_ended", runId: input.runId });
  }
  return { targets, protectedMatches };
}

/**
 * The periodic sweep. `endedRunIds` holds this instance's runs that ended long
 * enough ago; `apiPort` is the port this server listens on. A marker counts
 * only when its API URL points at that port, so a copy of this database on
 * another instance (a preview or a seeded worktree instance) never claims
 * live's processes.
 */
export function selectSweepLeftovers(
  processes: readonly ObservedProcess[],
  input: {
    endedRunIds: ReadonlySet<string>;
    apiPort: number | null;
    deletedWorktreeMinAgeMs?: number;
    protection: ProcessProtection;
  },
): LeftoverSelection {
  const isProtected = protectionTest(processes, input.protection);
  const minAgeMs = input.deletedWorktreeMinAgeMs ?? LEFTOVER_PROCESS_DELETED_WORKTREE_MIN_AGE_MS;
  const targets: LeftoverTarget[] = [];
  let protectedMatches = 0;

  for (const proc of processes) {
    const marker = proc.marker;
    if (!stoppable(proc) || !marker || marker.conflicting || !marker.runId) continue;
    if (!input.endedRunIds.has(marker.runId)) continue;
    if (input.apiPort === null || apiUrlPort(marker.apiUrl) !== input.apiPort) continue;
    if (isProtected(proc)) {
      protectedMatches += 1;
      continue;
    }
    targets.push({ process: proc, reason: "ended_run_marker", runId: marker.runId });
  }

  // Unmarked orphans in a deleted worktree: no terminal, old enough, and either
  // adopted by init or the child of such an orphan.
  const inDeletedWorktree = (proc: ObservedProcess) =>
    stoppable(proc) &&
    proc.marker !== null &&
    proc.marker.runId === null &&
    !proc.marker.conflicting &&
    proc.cwdDeleted &&
    proc.cwd !== null &&
    WORKTREE_DIR_RE.test(proc.cwd) &&
    !proc.hasTty &&
    proc.ageMs !== null &&
    proc.ageMs >= minAgeMs;
  const candidates = processes.filter(inDeletedWorktree);
  const orphanTree = new Set<number>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const proc of candidates) {
      if (orphanTree.has(proc.pid)) continue;
      if (proc.ppid === 1 || orphanTree.has(proc.ppid)) {
        orphanTree.add(proc.pid);
        changed = true;
      }
    }
  }
  for (const proc of candidates) {
    if (!orphanTree.has(proc.pid)) continue;
    if (isProtected(proc)) {
      protectedMatches += 1;
      continue;
    }
    targets.push({ process: proc, reason: "deleted_worktree", runId: null });
  }
  return { targets, protectedMatches };
}

// ---------------------------------------------------------------------------
// Reading /proc

export type ProcessTable =
  | { supported: true; processes: ObservedProcess[]; unreadableEnvironments: number }
  | { supported: false; reason: string };

interface StatFields {
  state: string;
  ppid: number;
  pgid: number;
  ttyNr: number;
  startTicks: string;
}

function parseStat(text: string): StatFields | null {
  // The command name sits in parentheses and may contain spaces or ")".
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  const fields = text.slice(close + 2).trim().split(/\s+/);
  // fields[0] is field 3 (state); field 22 (starttime) is fields[19].
  if (fields.length < 20) return null;
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const ttyNr = Number(fields[4]);
  if (!Number.isInteger(ppid) || !Number.isInteger(pgid) || !Number.isFinite(ttyNr)) return null;
  return { state: fields[0] ?? "", ppid, pgid, ttyNr, startTicks: fields[19] ?? "" };
}

async function readStat(pid: number): Promise<StatFields | null> {
  try {
    return parseStat(await fs.readFile(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

async function readUptimeSeconds(): Promise<number | null> {
  try {
    const value = Number((await fs.readFile("/proc/uptime", "utf8")).split(/\s+/)[0]);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function readProcess(pid: number, uid: number, uptimeSeconds: number | null): Promise<ObservedProcess | null> {
  const dir = `/proc/${pid}`;
  let owner: number;
  try {
    owner = (await fs.stat(dir)).uid;
  } catch {
    return null;
  }
  if (owner !== uid) return null;
  const stat = await readStat(pid);
  if (!stat) return null;
  const [environ, cmdline, exe, cwdRaw] = await Promise.all([
    fs.readFile(`${dir}/environ`).catch(() => null),
    fs.readFile(`${dir}/cmdline`).catch(() => null),
    fs.readlink(`${dir}/exe`).catch(() => null),
    fs.readlink(`${dir}/cwd`).catch(() => null),
  ]);
  let cwd = cwdRaw;
  let cwdDeleted = false;
  if (cwd && cwd.endsWith(DELETED_SUFFIX)) {
    const stripped = cwd.slice(0, -DELETED_SUFFIX.length);
    // A directory really named "... (deleted)" still exists; only a gone one counts.
    if (!existsSync(stripped)) {
      cwd = stripped;
      cwdDeleted = true;
    }
  }
  const startSeconds = Number(stat.startTicks) / CLOCK_TICKS_PER_SECOND;
  const ageMs = uptimeSeconds !== null && Number.isFinite(startSeconds)
    ? Math.max(0, (uptimeSeconds - startSeconds) * 1000)
    : null;
  return {
    pid,
    ppid: stat.ppid,
    pgid: stat.pgid,
    uid: owner,
    state: stat.state,
    hasTty: stat.ttyNr !== 0,
    startTicks: stat.startTicks,
    ageMs,
    args: cmdline ? cmdline.toString("utf8").split("\0").filter((arg) => arg.length > 0) : [],
    exe,
    cwd,
    cwdDeleted,
    marker: environ ? parseRunMarker(environ) : null,
  };
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** This user's processes from `/proc`, or why they cannot be read here. */
export async function readProcessTable(): Promise<ProcessTable> {
  if (process.platform !== "linux") return { supported: false, reason: `no /proc on ${process.platform}` };
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) return { supported: false, reason: "the user id is unknown" };
  try {
    // A server that cannot read its own environment cannot read anyone's.
    await fs.readFile("/proc/self/environ");
  } catch (err) {
    return { supported: false, reason: `cannot read /proc/self/environ (${(err as NodeJS.ErrnoException).code ?? "error"})` };
  }
  let names: string[];
  try {
    names = await fs.readdir("/proc");
  } catch (err) {
    return { supported: false, reason: `cannot list /proc (${(err as NodeJS.ErrnoException).code ?? "error"})` };
  }
  const pids = names.filter((name) => /^\d+$/.test(name)).map(Number);
  const uptime = await readUptimeSeconds();
  const read = await mapLimit(pids, 32, (pid) => readProcess(pid, uid, uptime));
  const processes = read.filter((proc): proc is ObservedProcess => proc !== null);
  const unreadableEnvironments = processes.filter((proc) => proc.marker === null && proc.state !== "Z").length;
  return { supported: true, processes, unreadableEnvironments };
}

// ---------------------------------------------------------------------------
// Stopping

export type StopOutcome = "terminated" | "killed" | "gone" | "failed";

export interface StoppedProcess {
  pid: number;
  command: string;
  reason: LeftoverReason;
  runId: string | null;
  outcome: StopOutcome;
}

/** A short, redacted command line for logs and the run log. */
export function shortCommand(args: readonly string[]): string {
  const text = redactCommandTextForLogs(args.join(" ").replace(/\s+/g, " ").trim());
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/** Still the same process (same start time) and not yet a zombie. */
async function sameProcessAlive(pid: number, startTicks: string): Promise<boolean> {
  const stat = await readStat(pid);
  return !!stat && stat.startTicks === startTicks && stat.state !== "Z";
}

function sendSignal(pid: number, signal: NodeJS.Signals): "sent" | "gone" | "failed" {
  try {
    process.kill(pid, signal);
    return "sent";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "failed";
  }
}

/**
 * SIGTERM each target, wait up to `graceMs`, then SIGKILL what is left. Each
 * PID is checked against its recorded start time before every signal, so a
 * reused PID is never signalled.
 */
export async function stopLeftoverProcesses(
  targets: readonly LeftoverTarget[],
  options: { graceMs?: number; pollMs?: number } = {},
): Promise<StoppedProcess[]> {
  const graceMs = options.graceMs ?? LEFTOVER_PROCESS_GRACE_MS;
  const pollMs = options.pollMs ?? 200;
  const results = new Map<number, StoppedProcess>();
  const waiting: LeftoverTarget[] = [];
  for (const target of targets) {
    const { pid, startTicks, args } = target.process;
    const record: StoppedProcess = {
      pid,
      command: shortCommand(args),
      reason: target.reason,
      runId: target.runId,
      outcome: "gone",
    };
    results.set(pid, record);
    if (!(await sameProcessAlive(pid, startTicks))) continue;
    const sent = sendSignal(pid, "SIGTERM");
    if (sent === "sent") waiting.push(target);
    else record.outcome = sent;
  }
  const deadline = Date.now() + graceMs;
  let remaining = waiting;
  while (remaining.length > 0) {
    const still: LeftoverTarget[] = [];
    for (const target of remaining) {
      if (await sameProcessAlive(target.process.pid, target.process.startTicks)) still.push(target);
      else results.get(target.process.pid)!.outcome = "terminated";
    }
    remaining = still;
    if (remaining.length === 0 || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  for (const target of remaining) {
    const record = results.get(target.process.pid)!;
    if (!(await sameProcessAlive(target.process.pid, target.process.startTicks))) {
      record.outcome = "terminated";
      continue;
    }
    const sent = sendSignal(target.process.pid, "SIGKILL");
    record.outcome = sent === "sent" ? "killed" : sent === "gone" ? "terminated" : "failed";
  }
  return [...results.values()];
}

// ---------------------------------------------------------------------------
// Entry points

function accountHomeDir(): string {
  try {
    return os.userInfo().homedir || os.homedir();
  } catch {
    return os.homedir();
  }
}

/** Live's install and data (as the agent pkill guard protects them), the GSAM root and client instances. */
export async function defaultProcessProtection(): Promise<ProcessProtection> {
  const guard = liveProcessGuard();
  const home = accountHomeDir();
  const gsamRoot = process.env.GSAM_ROOT?.trim() || path.join(home, "GSAM");
  const { protectedPaths } = processKillGuardPaths(
    {
      ...guard,
      protectedPaths: [...guard.protectedPaths, gsamRoot, path.join(home, "gsam-client-instances")],
    },
    home,
  );
  const services = await listLocalServiceRegistryRecords().catch(() => []);
  return {
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
    serverPid: guard.serverPid,
    protectedPaths,
    servicePids: services.map((service) => service.pid),
    serviceGroupIds: services.flatMap((service) => (service.processGroupId ? [service.processGroupId] : [])),
  };
}

let unsupportedLogged = false;
function logUnsupportedOnce(reason: string) {
  if (unsupportedLogged) return;
  unsupportedLogged = true;
  logger.info({ reason }, "leftover run process cleanup is inactive: process environments cannot be read here");
}

export type LeftoverCleanupResult =
  | { status: "disabled" }
  | { status: "unsupported"; reason: string }
  | { status: "done"; stopped: StoppedProcess[]; protectedMatches: number };

function logStopped(stopped: readonly StoppedProcess[]) {
  for (const entry of stopped) {
    if (entry.outcome === "gone") continue;
    // `processId`, not `pid`: the log formatter drops a `pid` field as its own.
    logger.info(
      { processId: entry.pid, command: entry.command, runId: entry.runId, reason: entry.reason, outcome: entry.outcome },
      "stopped a leftover process from an agent run",
    );
  }
}

/** Counts by outcome, for summaries and the run log. */
export function summarizeStopped(stopped: readonly StoppedProcess[]) {
  return {
    terminated: stopped.filter((entry) => entry.outcome === "terminated").length,
    killed: stopped.filter((entry) => entry.outcome === "killed").length,
    failed: stopped.filter((entry) => entry.outcome === "failed").length,
  };
}

/** End of a local run: stop what still carries this run's marker. */
export async function cleanupRunLeftoverProcesses(input: {
  runId: string;
  graceMs?: number;
}): Promise<LeftoverCleanupResult> {
  if (!runProcessCleanupEnabled()) return { status: "disabled" };
  const table = await readProcessTable();
  if (!table.supported) {
    logUnsupportedOnce(table.reason);
    return { status: "unsupported", reason: table.reason };
  }
  const protection = await defaultProcessProtection();
  const selection = selectRunEndLeftovers(table.processes, { runId: input.runId, protection });
  if (selection.targets.length === 0) {
    return { status: "done", stopped: [], protectedMatches: selection.protectedMatches };
  }
  const stopped = await stopLeftoverProcesses(selection.targets, { graceMs: input.graceMs });
  logStopped(stopped);
  logger.info(
    { runId: input.runId, ...summarizeStopped(stopped), leftAlone: selection.protectedMatches },
    "stopped leftover processes at the end of an agent run",
  );
  return { status: "done", stopped, protectedMatches: selection.protectedMatches };
}

/**
 * Runs of this instance, among `runIds`, that ended at least `minAgeMs` ago
 * and whose agent has no queued, running or scheduled-retry run.
 *
 * The agent check is for warm ACP sessions (`warmHandleIdleMs` above 0): a
 * warm session keeps the environment of the run that started it, so a
 * process the session starts during a later run still carries the first
 * run's id. While the agent has a live run, that marker may belong to it.
 */
async function endedRunIds(db: Db, runIds: readonly string[], now: Date, minAgeMs: number): Promise<Set<string>> {
  const ids = runIds.filter((id) => UUID_RE.test(id));
  if (ids.length === 0) return new Set();
  const cutoff = new Date(now.getTime() - minAgeMs);
  const rows = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(
      inArray(heartbeatRuns.id, ids),
      inArray(heartbeatRuns.status, [...TERMINAL_RUN_STATUSES]),
      sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt}) <= ${cutoff.toISOString()}::timestamptz`,
      sql`not exists (
        select 1 from heartbeat_runs agent_run
        where agent_run.agent_id = "heartbeat_runs"."agent_id"
          and agent_run.status in (${sql.join(AGENT_BUSY_RUN_STATUSES.map((status) => sql`${status}`), sql`, `)})
      )`,
    ));
  return new Set(rows.map((row) => row.id));
}

/** The periodic sweep (also run once at server start). */
export async function sweepLeftoverRunProcesses(input: {
  db: Db;
  apiPort: number | null;
  now?: Date;
  graceMs?: number;
  /** Tests pass Infinity so the deleted-worktree rule never touches the host's other processes. */
  deletedWorktreeMinAgeMs?: number;
}): Promise<LeftoverCleanupResult> {
  if (!runProcessCleanupEnabled()) return { status: "disabled" };
  const table = await readProcessTable();
  if (!table.supported) {
    logUnsupportedOnce(table.reason);
    return { status: "unsupported", reason: table.reason };
  }
  const markedRunIds = [
    ...new Set(
      table.processes.flatMap((proc) =>
        proc.marker?.runId && !proc.marker.conflicting ? [proc.marker.runId] : []),
    ),
  ];
  const ended = await endedRunIds(
    input.db,
    markedRunIds,
    input.now ?? new Date(),
    LEFTOVER_PROCESS_SWEEP_RUN_ENDED_MIN_AGE_MS,
  );
  const protection = await defaultProcessProtection();
  const selection = selectSweepLeftovers(table.processes, {
    endedRunIds: ended,
    apiPort: input.apiPort,
    deletedWorktreeMinAgeMs: input.deletedWorktreeMinAgeMs,
    protection,
  });
  if (selection.targets.length === 0) {
    return { status: "done", stopped: [], protectedMatches: selection.protectedMatches };
  }
  const stopped = await stopLeftoverProcesses(selection.targets, { graceMs: input.graceMs });
  logStopped(stopped);
  logger.info(
    {
      ...summarizeStopped(stopped),
      runIds: [...new Set(stopped.flatMap((entry) => (entry.runId ? [entry.runId] : [])))],
      deletedWorktree: stopped.filter((entry) => entry.reason === "deleted_worktree").length,
      leftAlone: selection.protectedMatches,
    },
    "leftover run process sweep stopped processes",
  );
  return { status: "done", stopped, protectedMatches: selection.protectedMatches };
}
