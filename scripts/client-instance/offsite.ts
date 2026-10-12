// Off-host backups with restic (GRE-666). Pure helpers, tested without restic
// or a server; client-instance.ts runs the commands.
//
// One client code = one restic repository, one key (password file) and one
// target account (the user in an `sftp:` repository). The config file names
// all three and nothing else; it never holds the key itself.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Keep 30 daily and 12 weekly snapshots (doc "Client hosting options", section 5). */
export const OFFSITE_RETENTION = ["--keep-daily", "30", "--keep-weekly", "12"] as const;

/** Off-host backups run every night; a day and two hours with none is a missed night. */
export const OFFSITE_MAX_AGE_MS = 26 * 60 * 60 * 1000;

/** Instance codes: c001, c002, sandbox codes like c916. Never a client name. */
const CODE_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export function checkCode(code: string): string | null {
  return CODE_PATTERN.test(code) ? null : `instance code "${code}" must be lower-case letters, digits and "-" (for example c001)`;
}

export interface OffsiteConfig {
  repository: string;
  passwordFile: string;
  /** Other RESTIC_* settings passed through as they are (for example RESTIC_CACHE_DIR). */
  extra: Record<string, string>;
}

/** The only keys a config file may set. A key in the file itself (RESTIC_PASSWORD) is refused. */
const ALLOWED_EXTRA = new Set(["RESTIC_CACHE_DIR", "RESTIC_COMPRESSION", "RESTIC_PACK_SIZE"]);

/**
 * Parse an off-host config file (KEY=VALUE lines) for one instance code.
 * Returns the config or the reason it is refused.
 */
export function parseOffsiteConfig(text: string, code: string): OffsiteConfig | { error: string } {
  const values: Record<string, string> = {};
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return { error: `line ${index + 1} is not KEY=VALUE` };
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    if (key === "RESTIC_PASSWORD" || key === "RESTIC_PASSWORD_COMMAND") {
      return { error: `${key} is not allowed; put the key in a file of its own and name it with RESTIC_PASSWORD_FILE` };
    }
    if (key !== "RESTIC_REPOSITORY" && key !== "RESTIC_PASSWORD_FILE" && !ALLOWED_EXTRA.has(key)) {
      return { error: `${key} is not an off-host setting` };
    }
    values[key] = value;
  }
  const repository = values.RESTIC_REPOSITORY;
  const passwordFile = values.RESTIC_PASSWORD_FILE;
  if (!repository) return { error: "RESTIC_REPOSITORY is missing" };
  if (!passwordFile) return { error: "RESTIC_PASSWORD_FILE is missing" };
  if (!path.isAbsolute(passwordFile)) return { error: "RESTIC_PASSWORD_FILE must be an absolute path" };
  const repoError = checkRepositoryForCode(repository, code);
  if (repoError) return { error: repoError };
  const extra: Record<string, string> = {};
  for (const key of ALLOWED_EXTRA) if (values[key]) extra[key] = values[key]!;
  return { repository, passwordFile, extra };
}

/**
 * One repository per code: the repository path must end in the code, so two
 * instances can never share one by a copy-paste slip. Only local folders and
 * `sftp:` targets (the Storage Box) are allowed.
 */
export function checkRepositoryForCode(repository: string, code: string): string | null {
  let repoPath: string;
  if (repository.startsWith("sftp:")) {
    // sftp:user@host:/path or sftp://user@host[:port]//path
    const rest = repository.slice("sftp:".length);
    const match = rest.startsWith("//") ? rest.match(/^\/\/[^/]+(\/.*)$/) : rest.match(/^[^:]+:(.*)$/);
    if (!match) return `RESTIC_REPOSITORY ${repository} is not a valid sftp: target`;
    repoPath = match[1]!;
  } else if (path.isAbsolute(repository)) {
    repoPath = repository;
  } else {
    return "RESTIC_REPOSITORY must be an sftp: target or an absolute local folder";
  }
  const last = repoPath.replace(/\/+$/, "").split("/").pop();
  if (last !== code) return `RESTIC_REPOSITORY must end in /${code} (one repository per instance code)`;
  return null;
}

/** Files holding keys must be readable by their owner only. */
export function checkPrivateFile(file: string, label: string): string | null {
  let mode: number;
  try {
    mode = statSync(file).mode;
  } catch {
    return `${label} ${file} not found`;
  }
  if ((mode & 0o077) !== 0) return `${label} ${file} must be readable by its owner only (chmod 600)`;
  return null;
}

/** Read and check one instance's off-host config file and its key file. */
export function loadOffsiteConfig(file: string, code: string): OffsiteConfig | { error: string } {
  const fileError = checkPrivateFile(file, "off-host config");
  if (fileError) return { error: fileError };
  const parsed = parseOffsiteConfig(readFileSync(file, "utf8"), code);
  if ("error" in parsed) return parsed;
  const keyError = checkPrivateFile(parsed.passwordFile, "RESTIC_PASSWORD_FILE");
  if (keyError) return { error: keyError };
  return parsed;
}

/** The environment restic gets: the config and nothing else from the caller. */
export function resticEnv(config: OffsiteConfig, base: { HOME?: string; PATH?: string; TMPDIR?: string }): Record<string, string> {
  const env: Record<string, string> = {
    RESTIC_REPOSITORY: config.repository,
    RESTIC_PASSWORD_FILE: config.passwordFile,
    ...config.extra,
  };
  for (const key of ["HOME", "PATH", "TMPDIR"] as const) if (base[key]) env[key] = base[key]!;
  return env;
}

/** What one off-host backup copies, relative to the instance root. */
export const OFFSITE_PATHS = ["client-instance.json", path.join("instances", "default", "data", "backups")];

/** The instance root a snapshot was taken from: the folder holding its client-instance.json. */
export function snapshotRoot(paths: string[]): string | null {
  const state = paths.find((p) => path.basename(p) === "client-instance.json");
  return state ? path.dirname(state) : null;
}

export interface OffsiteBackup {
  ok: boolean;
  line: string;
  snapshot: string | null;
  at: string;
}

/** The last off-host backup, and a WARNING line when there is none, it failed, or it is older than 26 h. */
export function offsiteStatusLines(last: OffsiteBackup | undefined, now = Date.now()): string[] {
  if (!last) return ["last off-host backup: none", "WARNING: no off-host backup yet; run offsite-backup"];
  const lines = [`last off-host backup: ${last.line} at ${last.at}`];
  if (!last.ok) lines.push("WARNING: the last off-host backup failed; see the line above");
  else if (now - Date.parse(last.at) > OFFSITE_MAX_AGE_MS) lines.push("WARNING: no off-host backup in the last 26 h; run offsite-backup");
  return lines;
}
