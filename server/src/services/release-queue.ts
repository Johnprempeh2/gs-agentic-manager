// The release queue on the Releases page (scripts/greatstone-release-queue.mjs).
// The worker on the PC owns the queue; this server only reads its state file
// and asks the same script to enqueue or cancel, so there is one writer.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ReleaseQueueStatus = "queued" | "running" | "released" | "failed" | "cancelled" | "merged" | "skipped";
export type ReleaseQueueStep = "gate" | "candidate" | "preview" | "draining" | "releasing";

export interface ReleaseQueueItem {
  id: string;
  ref: string;
  title: string | null;
  requestedBy: string | null;
  requestedAt: string;
  status: ReleaseQueueStatus;
  step: ReleaseQueueStep | null;
  detail: string | null;
  commit: string | null;
  tag: string | null;
  liveTag: string | null;
  reason: string | null;
  rollback: string | null;
  backupFile: string | null;
  mergedInto: string | null;
  cancelRequested: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  log?: string;
}

/** The test gate on origin/main, as the worker last saw it. */
export interface ReleaseQueueMain {
  commit: string;
  status: "testing" | "passed" | "failing" | "untested";
  startedAt: string | null;
  finishedAt: string | null;
  /** For a failing main: the failing lanes and tests, as the gate printed them. */
  summary: string[];
}

export interface ReleaseQueueView {
  running: (Omit<ReleaseQueueItem, "log"> & { logTail: string[] }) | null;
  queued: Array<Omit<ReleaseQueueItem, "log">>;
  recent: Array<Omit<ReleaseQueueItem, "log">>;
  main: ReleaseQueueMain | null;
  /** When the worker last wrote; null when it has never run (not installed on this host). */
  workerSeenAt: string | null;
}

export type QueueActionResult =
  | { ok: true; item: Omit<ReleaseQueueItem, "log"> }
  | { ok: false; status: 404 | 409 | 422; error: string };

const FINAL = new Set<ReleaseQueueStatus>(["released", "failed", "cancelled", "merged", "skipped"]);
/** What the script accepts (refProblem in greatstone-release-queue.mjs). */
export const QUEUE_REF_RE = /^(main|rc-\d{4}-\d{2}-\d{2}\.\d+|[0-9a-f]{7,40})$/;
export const QUEUE_ITEM_ID_RE = /^rq-[0-9a-f]{6}$/;
const LOG_TAIL_LINES = 20;

function withoutLog({ log: _log, ...item }: ReleaseQueueItem) {
  return item;
}

/** The last lines of `file`, without colour codes; only for a log inside `dir`. */
export function logTail(dir: string, file: string | undefined, lines = LOG_TAIL_LINES): string[] {
  if (!file) return [];
  const resolved = path.resolve(file);
  if (!resolved.startsWith(path.resolve(dir) + path.sep)) return [];
  try {
    const fd = fs.openSync(resolved, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const length = Math.min(size, 16 * 1024);
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, size - length);
      // eslint-disable-next-line no-control-regex
      return buf.toString("utf8").replace(/\u001b\[[0-9;]*m/g, "").split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-lines);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

/** queue.json as the page shows it. Same split as view() in the script. */
export function readReleaseQueue(dir: string): ReleaseQueueView {
  let raw: { items?: ReleaseQueueItem[]; main?: ReleaseQueueMain | null; worker?: { seenAt?: string } | null } = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, "queue.json"), "utf8"));
  } catch {
    // No queue yet: the worker has never run here.
  }
  const items = Array.isArray(raw.items) ? raw.items : [];
  const running = items.find((i) => i.status === "running") ?? null;
  return {
    running: running ? { ...withoutLog(running), logTail: logTail(dir, running.log) } : null,
    queued: items.filter((i) => i.status === "queued").map(withoutLog),
    recent: items.filter((i) => FINAL.has(i.status)).slice(-10).reverse().map(withoutLog),
    main: raw.main ?? null,
    workerSeenAt: raw.worker?.seenAt ?? null,
  };
}

export function releaseQueueService(env: NodeJS.ProcessEnv = process.env) {
  // Same defaults as scripts/greatstone-release-queue.mjs.
  const gsamRoot = env.GSAM_ROOT?.trim() || path.join(os.homedir(), "GSAM");
  const dir = env.GSAM_RELEASE_QUEUE_DIR?.trim() || path.join(gsamRoot, "release-queue");

  const runScript = async (repo: string, args: string[]): Promise<QueueActionResult> => {
    try {
      const { stdout } = await execFileAsync(process.execPath, [path.join(repo, "scripts", "greatstone-release-queue.mjs"), ...args], {
        cwd: repo,
        encoding: "utf8",
        timeout: 20_000,
        env: { ...env, GSAM_ROOT: gsamRoot, GSAM_RELEASE_QUEUE_DIR: dir },
      });
      return { ok: true, item: JSON.parse(stdout).item };
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const message = (e.stderr || e.message || String(err)).trim().split("\n")[0]?.replace(/^release-queue: /, "") ?? "";
      return { ok: false, status: /^no request /.test(message) ? 404 : 422, error: message };
    }
  };

  return {
    dir,
    view: () => readReleaseQueue(dir),
    /** Arguments go after `--`, so a title cannot be read as an option. */
    enqueue: (repo: string, input: { ref: string; title: string | null; by: string }) =>
      runScript(repo, ["enqueue", "--by", input.by, "--json", "--", input.ref, ...(input.title ? [input.title] : [])]),
    cancel: (repo: string, input: { id: string; by: string }) =>
      runScript(repo, ["cancel", "--by", input.by, "--json", "--", input.id]),
  };
}
