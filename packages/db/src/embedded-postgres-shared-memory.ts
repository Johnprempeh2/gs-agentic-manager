import { execFileSync } from "node:child_process";
import os from "node:os";

// Embedded PostgreSQL leaves one small SysV shared-memory segment behind when
// its postmaster is killed instead of stopped (a sandbox or vitest run that is
// interrupted, a SIGKILLed dev:once). macOS allows only 32 segments
// (`kern.sysv.shmmni`), so after enough leaks every new cluster fails with
// `could not create shared memory segment: No space left on device`.
//
// Before a cluster starts we remove only segments that cannot belong to a live
// cluster: owned by this OS user, with no attachments, and whose creator
// process has exited. A running postmaster is the creator of its own segment
// and keeps it attached, so its segment is never touched.

export interface SharedMemorySegment {
  id: string;
  owner: string;
  attachments: number;
  creatorPid: number;
}

// Parses `ipcs -m -a` output (macOS/BSD column order):
// T ID KEY MODE OWNER GROUP CREATOR CGROUP NATTCH SEGSZ CPID LPID ...
export function parseIpcsSharedMemory(output: string): SharedMemorySegment[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== "m" || fields.length < 11) return [];
    const attachments = Number(fields[8]);
    const creatorPid = Number(fields[10]);
    if (!Number.isInteger(attachments) || !Number.isInteger(creatorPid) || creatorPid <= 0) {
      return [];
    }
    return [{ id: fields[1]!, owner: fields[4]!, attachments, creatorPid }];
  });
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

export function selectOrphanedSharedMemorySegments(
  segments: SharedMemorySegment[],
  opts: { owner: string; isAlive: (pid: number) => boolean },
): SharedMemorySegment[] {
  return segments.filter(
    (segment) =>
      segment.owner === opts.owner &&
      segment.attachments === 0 &&
      !opts.isAlive(segment.creatorPid),
  );
}

export type ReapSharedMemoryDeps = {
  platform?: NodeJS.Platform;
  owner?: string;
  listSegments?: () => string;
  removeSegment?: (id: string) => void;
  isAlive?: (pid: number) => boolean;
};

// Best effort: never throws. Returns the ids it removed.
export function reapOrphanedEmbeddedPostgresSharedMemory(deps: ReapSharedMemoryDeps = {}): string[] {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") return [];
  let segments: SharedMemorySegment[];
  let owner: string;
  try {
    owner = deps.owner ?? os.userInfo().username;
    const listSegments =
      deps.listSegments ?? (() => execFileSync("ipcs", ["-m", "-a"], { encoding: "utf8" }));
    segments = parseIpcsSharedMemory(listSegments());
  } catch {
    return [];
  }
  const removeSegment =
    deps.removeSegment ?? ((id: string) => execFileSync("ipcrm", ["-m", id], { stdio: "ignore" }));
  const removed: string[] = [];
  for (const segment of selectOrphanedSharedMemorySegments(segments, {
    owner,
    isAlive: deps.isAlive ?? isProcessAlive,
  })) {
    try {
      removeSegment(segment.id);
      removed.push(segment.id);
    } catch {
      // Already gone or not ours to remove; Postgres reports any real shortage.
    }
  }
  return removed;
}
