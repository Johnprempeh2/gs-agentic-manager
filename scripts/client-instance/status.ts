// Read-only `status` lines for backups and the release (GRE-533).
// Kept apart from client-instance.ts so they can be tested without a server.

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** The server backs up every hour; two hours with no new file means a backup was missed. */
export const BACKUP_MAX_AGE_MS = 2 * 60 * 60 * 1000;

interface ReleaseRef {
  tag: string | null;
  dir: string;
}

export interface ReleaseState {
  release?: ReleaseRef;
  lastUpgrade?: { from: ReleaseRef; to: ReleaseRef; at: string };
  lastRestore?: { to: ReleaseRef; at: string };
}

/** The newest backup file (`.sql` or `.sql.gz`) in dir, by modification time, or null. */
export function newestBackup(dir: string): { file: string; mtimeMs: number } | null {
  if (!existsSync(dir)) return null;
  let newest: { file: string; mtimeMs: number } | null = null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".sql") && !name.endsWith(".sql.gz")) continue;
    const file = path.join(dir, name);
    const stat = statSync(file);
    if (!stat.isFile()) continue;
    if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { file, mtimeMs: stat.mtimeMs };
  }
  return newest;
}

function describeAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} days`;
}

/** One line for the newest backup, and a WARNING line when it is missing or older than two hours. */
export function backupStatusLines(dir: string, now = Date.now()): string[] {
  const newest = newestBackup(dir);
  if (!newest) return [`backup: none in ${dir}`, "WARNING: no backup found; check the server's hourly backup"];
  const age = now - newest.mtimeMs;
  const lines = [`backup: newest ${path.basename(newest.file)}, ${describeAge(age)} old`];
  if (age > BACKUP_MAX_AGE_MS) lines.push(`WARNING: newest backup is older than 2 h; check the server's hourly backup`);
  return lines;
}

/** A restore-check older than this gives a WARNING in `status` (GRE-616). */
export const RESTORE_CHECK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface RestoreCheck {
  ok: boolean;
  /** The line restore-check printed. */
  line: string;
  backupFile: string;
  at: string;
}

/** The last restore-check, and a WARNING line when there is none, it failed, or it is older than 7 days. */
export function restoreCheckStatusLines(check: RestoreCheck | undefined, now = Date.now()): string[] {
  if (!check) return ["last restore-check: none", "WARNING: no restore-check yet; run restore-check to prove the newest backup restores"];
  const lines = [`last restore-check: ${check.line} at ${check.at}`];
  if (!check.ok) lines.push("WARNING: the last restore-check failed; see the line above");
  else if (now - Date.parse(check.at) > RESTORE_CHECK_MAX_AGE_MS) lines.push("WARNING: no restore-check in the last 7 days; run restore-check");
  return lines;
}

const tagOf = (ref: ReleaseRef) => ref.tag ?? `untagged (${ref.dir})`;

/** The current release, and the last upgrade and restore from client-instance.json. */
export function releaseStatusLines(state: ReleaseState): string[] {
  const lines = [`release: ${state.release ? tagOf(state.release) : "not recorded (no start since GRE-130)"}`];
  const up = state.lastUpgrade;
  lines.push(up ? `last upgrade: ${tagOf(up.from)} -> ${tagOf(up.to)} at ${up.at}` : "last upgrade: none");
  const back = state.lastRestore;
  lines.push(back ? `last restore: to ${tagOf(back.to)} at ${back.at}` : "last restore: none");
  return lines;
}
