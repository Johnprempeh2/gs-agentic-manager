import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// GRE-383: a git `index.lock` left in a worktree used to stop the run at once
// and move the task to `blocked`, even when the lock was minutes old and no git
// process was alive. A lock that no git process holds and that is older than
// STALE_AFTER_MS is removed; a held (or still young) lock is waited on for up
// to WAIT_TIMEOUT_MS.
export const GIT_INDEX_LOCK_STALE_AFTER_MS = 2 * 60 * 1000;
export const GIT_INDEX_LOCK_WAIT_TIMEOUT_MS = 2 * 60 * 1000;
const GIT_INDEX_LOCK_POLL_MS = 2_000;
const LSOF_TIMEOUT_MS = 10_000;

/** true = a process holds it; false = nobody does; null = could not check. */
export type GitIndexLockHolderProbe = (input: { lockPath: string; worktreePath: string }) => Promise<boolean | null>;

export type GitIndexLockOutcome =
  | { status: "absent" }
  | { status: "cleared"; waitedMs: number }
  | { status: "removed_stale"; lockAgeMs: number; waitedMs: number }
  | { status: "held"; waitedMs: number; heldByProcess: boolean | null };

function runLsof(args: string[]): Promise<{ code: number; stdout: string } | null> {
  return new Promise((resolve) => {
    execFile("lsof", args, { timeout: LSOF_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (!error) return resolve({ code: 0, stdout: String(stdout) });
      const code: unknown = (error as { code?: unknown }).code;
      // lsof exits 1 when nothing matches. Anything else (missing binary,
      // timeout, signal) means we could not tell.
      if (code === 1) return resolve({ code: 1, stdout: String(stdout ?? "") });
      resolve(null);
    });
  });
}

/**
 * A git process "uses" the lock when it has the lock file open, or when any
 * `git` process has its cwd inside the worktree (git may close the lock fd
 * before it renames the file).
 */
export const probeGitIndexLockHolder: GitIndexLockHolderProbe = async ({ lockPath, worktreePath }) => {
  const openers = await runLsof(["-w", "-t", "--", lockPath]);
  if (!openers) return null;
  if (openers.code === 0 && openers.stdout.trim().length > 0) return true;

  const gitCwds = await runLsof(["-w", "-a", "-c", "git", "-d", "cwd", "-Fn"]);
  if (!gitCwds) return null;
  const worktreeRoot = await fs.realpath(worktreePath).catch(() => path.resolve(worktreePath));
  return gitCwds.stdout
    .split("\n")
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1))
    .some((cwd) => cwd === worktreeRoot || cwd.startsWith(`${worktreeRoot}${path.sep}`));
};

async function readLockAgeMs(lockPath: string, now: number): Promise<number | null> {
  const stat = await fs.stat(lockPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return stat ? Math.max(0, now - stat.mtimeMs) : null;
}

/**
 * Wait for `lockPath` to go away, removing it when it is stale. Never throws
 * for a held lock; the caller decides what to do with `held`.
 */
export async function waitForGitIndexLock(input: {
  lockPath: string;
  worktreePath: string;
  staleAfterMs?: number;
  timeoutMs?: number;
  pollMs?: number;
  probe?: GitIndexLockHolderProbe;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}): Promise<GitIndexLockOutcome> {
  const staleAfterMs = input.staleAfterMs ?? GIT_INDEX_LOCK_STALE_AFTER_MS;
  const timeoutMs = input.timeoutMs ?? GIT_INDEX_LOCK_WAIT_TIMEOUT_MS;
  const pollMs = input.pollMs ?? GIT_INDEX_LOCK_POLL_MS;
  const probe = input.probe ?? probeGitIndexLockHolder;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? delay;

  const startedAt = now();
  let lastHeld: boolean | null = null;
  for (let first = true; ; first = false) {
    const checkedAt = now();
    const waitedMs = checkedAt - startedAt;
    const lockAgeMs = await readLockAgeMs(input.lockPath, checkedAt);
    if (lockAgeMs === null) return first ? { status: "absent" } : { status: "cleared", waitedMs };

    lastHeld = await probe({ lockPath: input.lockPath, worktreePath: input.worktreePath });
    if (lastHeld === false && lockAgeMs >= staleAfterMs) {
      await fs.rm(input.lockPath, { force: true });
      return { status: "removed_stale", lockAgeMs, waitedMs };
    }
    if (waitedMs >= timeoutMs) return { status: "held", waitedMs, heldByProcess: lastHeld };
    await sleep(Math.min(pollMs, Math.max(1, timeoutMs - waitedMs)));
  }
}

export async function resolveGitIndexLockPath(
  worktreePath: string,
  runGit: (args: string[], cwd: string) => Promise<string>,
): Promise<string | null> {
  return runGit(["rev-parse", "--git-path", "index.lock"], worktreePath)
    .then((lockPath) => path.resolve(worktreePath, lockPath))
    .catch(() => null);
}
