import { chmod, lstat, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Per-run AI homes live in the OS temp folder (GRE-209). Removing a home when
// the run ends is not enough: the Claude CLI flushes MCP logs into
// $HOME/Library/Caches while it exits, which recreates the folder after the
// cleanup `rm`. A server crash also skips the cleanup entirely. So each home
// records its owner, removal is repeated once after the provider exits, and a
// startup/daily sweep removes homes whose owner has no live run.

export const MANAGED_AI_HOME_PREFIX = "paperclip-ai-";
const OWNER_FILE = ".gsam-run-home.json";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
/** Late provider writes land within seconds; one retry after this delay catches them. */
export const LATE_WRITE_RETRY_MS = 60 * 1000;
/** A home without its provider folder is cleanup residue once this old. */
const RESIDUE_GRACE_MS = 10 * 60 * 1000;
/** A home with no owner record (older server builds) counts as stale once this old. */
const UNOWNED_MAX_AGE_MS = ONE_DAY_MS;

/** Test temp folders that older test runs left behind. */
const TEST_TEMP_PREFIXES = [
  "paperclip-worktree-repo",
  "paperclip-worktree-remote",
  "paperclip-worktree-clone",
  "paperclip-vitest-codex-home",
];

const activeHomes = new Set<string>();

export async function claimManagedAiHome(home: string) {
  activeHomes.add(home);
  await writeFile(
    path.join(home, OWNER_FILE),
    JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
}

/** Give the owner write access to every folder under `dir` (symlinks are not followed). */
async function makeTreeWritable(dir: string): Promise<void> {
  const info = await lstat(dir).catch(() => null);
  if (!info?.isDirectory()) return;
  if ((info.mode & 0o700) !== 0o700) await chmod(dir, info.mode | 0o700).catch(() => undefined);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) await makeTreeWritable(path.join(dir, entry.name));
  }
}

/**
 * Remove a folder tree even when it holds read-only folders. Runtime-context
 * bundles are chmod 0o555 (GRE-217), and `rm --force` cannot unlink entries
 * inside a folder without write access.
 */
export async function removeTree(dir: string) {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw error;
    await makeTreeWritable(dir);
    await rm(dir, { recursive: true, force: true });
  }
}

export async function removeManagedAiHome(
  home: string,
  opts: { lateWriteRetryMs?: number } = {},
) {
  activeHomes.delete(home);
  const retryMs = opts.lateWriteRetryMs ?? LATE_WRITE_RETRY_MS;
  if (retryMs > 0) {
    setTimeout(() => {
      // Skip if the path was reused by a new claim (mkdtemp names are random,
      // so this is defensive only).
      if (!activeHomes.has(home)) void removeTree(home).catch(() => undefined);
    }, retryMs).unref();
  }
  await removeTree(home);
}

function pidIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readOwnerPid(home: string): Promise<number | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(home, OWNER_FILE), "utf8"));
    return Number.isInteger(parsed?.pid) ? parsed.pid : null;
  } catch {
    return null;
  }
}

async function exists(target: string) {
  return stat(target).then(() => true, () => false);
}

/** Decide whether a per-run home has no live run and can be removed. */
async function isStaleManagedAiHome(home: string, mtimeMs: number, now: number) {
  if (activeHomes.has(home)) return false;
  const ownerPid = await readOwnerPid(home);
  if (ownerPid !== null) {
    // This process owns every home it created; one not in the active set
    // belongs to a finished run. Another live server keeps its own homes.
    return ownerPid === process.pid || !pidIsAlive(ownerPid);
  }
  const age = now - mtimeMs;
  if (!(await exists(path.join(home, "provider")))) return age > RESIDUE_GRACE_MS;
  return age > UNOWNED_MAX_AGE_MS;
}

export type TempSweepResult = { removed: string[]; failed: string[] };

async function listDirs(tmpDir: string) {
  const entries = await readdir(tmpDir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(tmpDir, entry.name));
}

export async function sweepStaleManagedAiHomes(
  opts: { tmpDir?: string; now?: number } = {},
): Promise<TempSweepResult> {
  const tmpDir = opts.tmpDir ?? os.tmpdir();
  const now = opts.now ?? Date.now();
  const result: TempSweepResult = { removed: [], failed: [] };
  for (const dir of await listDirs(tmpDir)) {
    if (!path.basename(dir).startsWith(MANAGED_AI_HOME_PREFIX)) continue;
    const info = await stat(dir).catch(() => null);
    if (!info || !(await isStaleManagedAiHome(dir, info.mtimeMs, now))) continue;
    await removeTree(dir).then(
      () => result.removed.push(dir),
      () => result.failed.push(dir),
    );
  }
  return result;
}

export async function sweepStaleTestTempDirs(
  opts: { tmpDir?: string; now?: number; maxAgeMs?: number } = {},
): Promise<TempSweepResult> {
  const tmpDir = opts.tmpDir ?? os.tmpdir();
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? ONE_DAY_MS;
  const result: TempSweepResult = { removed: [], failed: [] };
  for (const dir of await listDirs(tmpDir)) {
    const name = path.basename(dir);
    if (!TEST_TEMP_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const info = await stat(dir).catch(() => null);
    if (!info || now - info.mtimeMs <= maxAgeMs) continue;
    await removeTree(dir).then(
      () => result.removed.push(dir),
      () => result.failed.push(dir),
    );
  }
  return result;
}

/** Run both sweeps now and then once a day. Returns a stop function. */
export function startTempFolderSweeper(log: {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}) {
  const run = async () => {
    try {
      const homes = await sweepStaleManagedAiHomes();
      const tests = await sweepStaleTestTempDirs();
      const removed = homes.removed.length + tests.removed.length;
      const failed = homes.failed.length + tests.failed.length;
      if (removed > 0 || failed > 0) {
        log.info(
          { removedHomes: homes.removed.length, removedTestDirs: tests.removed.length, failed },
          "removed stale per-run AI homes and test temp folders",
        );
      }
    } catch (err) {
      log.warn({ err }, "temp folder sweep failed");
    }
  };
  void run();
  const timer = setInterval(() => void run(), ONE_DAY_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export function resetManagedAiHomesForTests() {
  activeHomes.clear();
}
