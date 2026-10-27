import { access, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Git writes hold lock files; rebase and merge state must also settle before cancellation. */
export async function isGitWriteInProgress(cwd: string): Promise<boolean> {
  try {
    const dotGit = join(cwd, ".git");
    const gitFile = await readFile(dotGit, "utf8").catch(() => null);
    const gitDir = gitFile?.startsWith("gitdir: ")
      ? resolve(cwd, gitFile.slice(8).trim())
      : dotGit;
    for (const name of ["index.lock", "HEAD.lock", "packed-refs.lock", "config.lock", "rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"]) {
      if (await access(join(gitDir, name)).then(() => true, () => false)) return true;
    }
    const hasRefLock = async (dir: string): Promise<boolean> => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (entry.isFile() && entry.name.endsWith(".lock")) return true;
        if (entry.isDirectory() && await hasRefLock(join(dir, entry.name))) return true;
      }
      return false;
    };
    return hasRefLock(join(gitDir, "refs"));
  } catch {
    // An unreadable workspace is not evidence that cancellation is safe.
    return true;
  }
}

/** Inspect the run's local process tree for a database migration. */
export async function isMigrationInProgress(processPid: number | null): Promise<boolean> {
  if (!processPid || processPid <= 0) return false;
  try {
    const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "command="], { timeout: 2_000 });
    return migrationInProcessTree(stdout, processPid);
  } catch {
    return true;
  }
}

export function migrationInProcessTree(processTable: string, processPid: number): boolean {
    const rows = processTable.split("\n").map((line) => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)).filter((row): row is RegExpExecArray => !!row);
    const descendants = new Set([processPid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) if (descendants.has(Number(row[2])) && !descendants.has(Number(row[1]))) {
        descendants.add(Number(row[1])); changed = true;
      }
    }
    return rows.some((row) => descendants.has(Number(row[1])) && /(?:\bdb:migrate\b|\bdrizzle-kit\s+migrate\b)/.test(row[3]!));
}

/** Wait for protected operations, bounded to two minutes. */
export async function waitForCorrectionSafePoint(input: {
  isProtected: () => boolean | Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxWaitMs?: number;
}) {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (input.maxWaitMs ?? 120_000);
  while (await input.isProtected()) {
    const remaining = deadline - now();
    if (remaining <= 0) return "timed_out" as const;
    await sleep(Math.min(1_000, remaining));
  }
  return "safe" as const;
}
