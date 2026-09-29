import { randomUUID } from "node:crypto";
import { openSync, closeSync, promises as fs } from "node:fs";
import path from "node:path";

// A local child writes stdout/stderr to append-only files instead of pipes.
// A pipe dies with the server that owns its read end, so after a hot restart
// the adopted child's result was lost (and its next write could get EPIPE).
// A file outlives the server: the new server reads the result from it.
export const CHILD_OUTPUT_FILES_ENV = "GSAM_CHILD_OUTPUT_FILES";
export const CHILD_OUTPUT_POLL_MS = 100;
const READ_CHUNK_BYTES = 64 * 1024;

export interface ChildOutputCaptureOptions {
  dir: string;
}

export interface ChildOutputCapturePaths {
  stdoutPath: string;
  stderrPath: string;
}

export interface ChildOutputCaptureProgress extends ChildOutputCapturePaths {
  // Bytes whose text has been handed to onLog and whose onLog has resolved.
  // Everything after these offsets was never logged by this server.
  stdoutBytes: number;
  stderrBytes: number;
}

// `GSAM_CHILD_OUTPUT_FILES=0` forces pipes again (rollback switch).
export function childOutputFilesDisabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[CHILD_OUTPUT_FILES_ENV]?.trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "off";
}

export function openChildOutputCaptureFiles(
  dir: string,
  runId: string,
): ChildOutputCapturePaths & { stdoutFd: number; stderrFd: number } {
  const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
  // One run can spawn more than once (session retry), so each spawn gets its
  // own files; onSpawn records which ones belong to the live child.
  const stem = path.join(dir, `${safeRunId}.${Date.now()}-${randomUUID().slice(0, 8)}`);
  const stdoutPath = `${stem}.stdout`;
  const stderrPath = `${stem}.stderr`;
  const stdoutFd = openSync(stdoutPath, "a", 0o600);
  let stderrFd: number;
  try {
    stderrFd = openSync(stderrPath, "a", 0o600);
  } catch (err) {
    closeSync(stdoutFd);
    throw err;
  }
  return { stdoutPath, stderrPath, stdoutFd, stderrFd };
}

// Split off an incomplete UTF-8 sequence at the end of `buf`, so a read that
// ends inside a multi-byte character does not decode it as U+FFFD.
export function splitCompleteUtf8(buf: Buffer): [Buffer, Buffer] {
  const len = buf.length;
  for (let back = 1; back <= Math.min(3, len); back += 1) {
    const byte = buf[len - back]!;
    if ((byte & 0xc0) === 0x80) continue; // continuation byte
    const needed =
      (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : (byte & 0xf8) === 0xf0 ? 4 : 1;
    if (needed > back) return [buf.subarray(0, len - back), buf.subarray(len - back)];
    break;
  }
  return [buf, Buffer.alloc(0)];
}

export class CapturedOutputTailer {
  private offset = 0;
  private carry: Buffer = Buffer.alloc(0);
  private committed = 0;
  private stopRequested = false;
  private finalDrain = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(
    readonly filePath: string,
    private readonly onText: (text: string) => Promise<void>,
    private readonly pollMs = CHILD_OUTPUT_POLL_MS,
  ) {}

  get committedBytes() {
    return this.committed;
  }

  start() {
    if (!this.loop) this.loop = this.run().finally(() => (this.loop = null));
  }

  // Stop reading. After this resolves no more onText calls happen, so
  // committedBytes is exactly what was logged.
  async freeze() {
    this.stopRequested = true;
    this.wake?.();
    await this.loop;
  }

  // Read to EOF (resuming after a freeze if needed), then stop.
  async drainToEnd() {
    this.finalDrain = true;
    this.stopRequested = false;
    this.wake?.();
    if (!this.loop) this.start();
    await this.loop;
  }

  private async run() {
    const handle = await fs.open(this.filePath, "r");
    const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    try {
      for (;;) {
        if (this.stopRequested) return;
        const { bytesRead } = await handle.read(buf, 0, buf.length, this.offset);
        if (bytesRead > 0) {
          this.offset += bytesRead;
          const joined = Buffer.concat([this.carry, buf.subarray(0, bytesRead)]);
          const [complete, rest] = splitCompleteUtf8(joined);
          this.carry = Buffer.from(rest);
          if (complete.length > 0) {
            await this.onText(complete.toString("utf8"));
            this.committed = this.offset - this.carry.length;
          }
          continue;
        }
        if (this.finalDrain) {
          if (this.carry.length > 0) {
            const tail = this.carry;
            this.carry = Buffer.alloc(0);
            await this.onText(tail.toString("utf8"));
            this.committed = this.offset;
          }
          return;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, this.pollMs);
          function done() {
            clearTimeout(timer);
            resolve();
          }
          this.wake = done;
        });
        this.wake = null;
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}

// Live captures of this server, so a hot-restart shutdown can freeze them and
// record exactly how much of each file reached the run log.
const activeCaptures = new Map<
  string,
  { paths: ChildOutputCapturePaths; stdout: CapturedOutputTailer; stderr: CapturedOutputTailer }
>();

export function registerActiveOutputCapture(
  runId: string,
  entry: { paths: ChildOutputCapturePaths; stdout: CapturedOutputTailer; stderr: CapturedOutputTailer },
) {
  activeCaptures.set(runId, entry);
}

export function unregisterActiveOutputCapture(runId: string, stdout: CapturedOutputTailer) {
  if (activeCaptures.get(runId)?.stdout === stdout) activeCaptures.delete(runId);
}

export async function freezeRunOutputCapture(
  runId: string,
): Promise<ChildOutputCaptureProgress | null> {
  const entry = activeCaptures.get(runId);
  if (!entry) return null;
  await Promise.all([entry.stdout.freeze(), entry.stderr.freeze()]);
  return {
    ...entry.paths,
    stdoutBytes: entry.stdout.committedBytes,
    stderrBytes: entry.stderr.committedBytes,
  };
}

export async function removeChildOutputCaptureFiles(paths: ChildOutputCapturePaths) {
  await Promise.all([
    fs.rm(paths.stdoutPath, { force: true }),
    fs.rm(paths.stderrPath, { force: true }),
  ]).catch(() => undefined);
}

export interface CapturedOutputRead {
  text: string;
  sizeBytes: number;
  mtimeMs: number;
  truncated: boolean;
}

// Read a capture file for result recovery. A large file keeps its head (the
// claude `init` event carries the session id) and its tail (the `result`).
export async function readCapturedOutputFile(
  filePath: string,
  opts: { fromOffset?: number; headBytes?: number; tailBytes?: number } = {},
): Promise<CapturedOutputRead | null> {
  const headBytes = opts.headBytes ?? 256 * 1024;
  const tailBytes = opts.tailBytes ?? 8 * 1024 * 1024;
  const fromOffset = Math.max(0, opts.fromOffset ?? 0);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    const size = stat.size;
    const readRange = async (start: number, end: number) => {
      const length = Math.max(0, end - start);
      const buf = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const { bytesRead } = await handle.read(buf, read, length - read, start + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      return buf.subarray(0, read);
    };
    const available = size - Math.min(fromOffset, size);
    if (available <= headBytes + tailBytes) {
      const text = (await readRange(Math.min(fromOffset, size), size)).toString("utf8");
      return { text, sizeBytes: size, mtimeMs: stat.mtimeMs, truncated: false };
    }
    const head = (await readRange(fromOffset, fromOffset + headBytes)).toString("utf8");
    const tail = (await readRange(size - tailBytes, size)).toString("utf8");
    // Keep whole lines only: drop the partial line at each cut.
    const headLines = head.slice(0, Math.max(0, head.lastIndexOf("\n") + 1));
    const tailLines = tail.slice(tail.indexOf("\n") + 1);
    return {
      text: `${headLines}${tailLines}`,
      sizeBytes: size,
      mtimeMs: stat.mtimeMs,
      truncated: true,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
