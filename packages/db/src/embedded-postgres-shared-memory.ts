import { execFileSync } from "node:child_process";
import os from "node:os";

// PostgreSQL's SysV segment holds only PGShmemHeader; the real shared buffers
// live in anonymous mmap memory. On 64-bit macOS that header is 56 bytes.
const POSTGRES_SYSV_SEGMENT_BYTES = 56;

export interface DarwinSharedMemorySegment {
  id: string;
  owner: string;
  attachments: number;
  sizeBytes: number;
  creatorPid: number;
}

export interface OrphanedSharedMemoryReaperDeps {
  platform?: NodeJS.Platform;
  owner?: string;
  listSegments?: () => string;
  isProcessAlive?: (pid: number) => boolean;
  removeSegment?: (id: string) => void;
}

export function parseDarwinSharedMemory(output: string): DarwinSharedMemorySegment[] {
  return output.split(/\r?\n/).flatMap((line) => {
    // T ID KEY MODE OWNER GROUP CREATOR CGROUP NATTCH SEGSZ CPID LPID ...
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== "m" || fields.length < 11) return [];
    const attachments = Number(fields[8]);
    const sizeBytes = Number(fields[9]);
    const creatorPid = Number(fields[10]);
    if (![attachments, sizeBytes, creatorPid].every(Number.isInteger)) return [];
    return [{ id: fields[1]!, owner: fields[4]!, attachments, sizeBytes, creatorPid }];
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists under another user; treat anything but ESRCH as alive.
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

/**
 * A Postgres cluster that is killed instead of stopped leaves its SysV segment
 * behind. macOS allows only 32 segment ids (kern.sysv.shmmni), so after enough
 * killed sandbox or test clusters every new cluster fails with
 * `could not create shared memory segment ... shmget(size=56)`.
 *
 * Before a new cluster starts, remove only segments that are certainly orphaned
 * Postgres segments: owned by this OS user, Postgres-sized, no attachments, and
 * whose creating postmaster has exited. A running cluster always keeps its
 * postmaster attached, so it is never touched. Best effort: never throws.
 */
export function reapOrphanedPostgresSharedMemory(
  deps: OrphanedSharedMemoryReaperDeps = {},
): string[] {
  if ((deps.platform ?? process.platform) !== "darwin") return [];
  const isAlive = deps.isProcessAlive ?? processIsAlive;
  const remove =
    deps.removeSegment ??
    ((id: string) => execFileSync("ipcrm", ["-m", id], { stdio: "ignore" }));
  let segments: DarwinSharedMemorySegment[];
  let owner: string;
  try {
    owner = deps.owner ?? os.userInfo().username;
    segments = parseDarwinSharedMemory(
      deps.listSegments?.() ?? execFileSync("ipcs", ["-m", "-a"], { encoding: "utf8" }),
    );
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const segment of segments) {
    if (
      segment.owner !== owner ||
      segment.sizeBytes !== POSTGRES_SYSV_SEGMENT_BYTES ||
      segment.attachments !== 0 ||
      segment.creatorPid <= 0 ||
      isAlive(segment.creatorPid)
    ) {
      continue;
    }
    try {
      remove(segment.id);
      removed.push(segment.id);
    } catch {
      // Already gone or not ours to remove; the start error still explains it.
    }
  }
  return removed;
}
