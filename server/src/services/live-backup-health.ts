import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Health of the nightly live backup (scripts/live-backup/live-backup.sh, GRE-1930). The script writes a
// small state file that names the backup folder and the result of its last run. The archives themselves
// are checked here, so a state file that says "ok" cannot hide a missing or old archive.

export type LiveBackupHealthWarningCode =
  | "live_backup_check_failed"
  | "live_backup_last_run_failed"
  | "live_backup_dump_missing"
  | "live_backup_dump_stale"
  | "live_backup_files_missing"
  | "live_backup_files_stale"
  | "live_backup_secrets_key_missing"
  | "live_backup_secrets_key_stale";

export type LiveBackupHealthWarning = {
  code: LiveBackupHealthWarningCode;
  message: string;
};

export type LiveBackupArtifact = {
  name: string;
  path: string;
  mtime: string;
  ageHours: number;
  sizeBytes: number;
};

export type LiveBackupHealthStatus = {
  // not_configured: no state file, so no nightly backup has ever run on this instance.
  status: "ok" | "warning" | "not_configured";
  stateFile: string;
  backupDir: string | null;
  maxAgeHours: number;
  lastRun: { finishedAt: string | null; ok: boolean; failure: string | null } | null;
  databaseDump: LiveBackupArtifact | null;
  filesArchive: LiveBackupArtifact | null;
  secretsKeyArchive: LiveBackupArtifact | null;
  // The off-machine copy (GRE-1929 part 2). Reported as the script records it.
  offsite: { status: string; lastCopyAt: string | null };
  warnings: LiveBackupHealthWarning[];
};

export type InspectLiveBackupHealthOptions = {
  stateFile: string;
  maxAgeHours: number;
  now?: Date;
};

const ARTIFACTS = {
  databaseDump: { prefix: "nightly-", suffix: ".sql.gz", label: "database dump", key: "dump" },
  filesArchive: { prefix: "files-", suffix: ".tar.gz", label: "uploaded files archive", key: "files" },
  secretsKeyArchive: { prefix: "secrets-", suffix: ".tar.enc", label: "secrets key archive", key: "secrets_key" },
} as const;

type StateFile = {
  backupDir?: unknown;
  finishedAt?: unknown;
  ok?: unknown;
  failure?: unknown;
  offsite?: { status?: unknown; lastCopyAt?: unknown } | null;
};

function roundHours(value: number): number {
  return Math.round(value * 10) / 10;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Names carry a sortable stamp (nightly-20261022-023000.sql.gz), so the last name is the newest.
function newestArtifact(names: string[], dir: string, prefix: string, suffix: string, nowMs: number) {
  const name = names.filter((entry) => entry.startsWith(prefix) && entry.endsWith(suffix)).sort().at(-1);
  if (!name) return null;
  const path = join(dir, name);
  const stat = statSync(path);
  return {
    name,
    path,
    mtime: new Date(stat.mtimeMs).toISOString(),
    ageHours: roundHours((nowMs - stat.mtimeMs) / 3_600_000),
    sizeBytes: stat.size,
  };
}

export function inspectLiveBackupHealth(opts: InspectLiveBackupHealthOptions): LiveBackupHealthStatus {
  const now = opts.now ?? new Date();
  const maxAgeHours = Math.max(1, opts.maxAgeHours);
  const result: LiveBackupHealthStatus = {
    status: "ok",
    stateFile: opts.stateFile,
    backupDir: null,
    maxAgeHours,
    lastRun: null,
    databaseDump: null,
    filesArchive: null,
    secretsKeyArchive: null,
    offsite: { status: "not_configured", lastCopyAt: null },
    warnings: [],
  };

  if (!existsSync(opts.stateFile)) {
    result.status = "not_configured";
    return result;
  }

  try {
    const state = JSON.parse(readFileSync(opts.stateFile, "utf8")) as StateFile;
    const backupDir = stringOrNull(state.backupDir);
    result.backupDir = backupDir;
    result.lastRun = {
      finishedAt: stringOrNull(state.finishedAt),
      ok: state.ok === true,
      failure: stringOrNull(state.failure),
    };
    result.offsite = {
      status: stringOrNull(state.offsite?.status) ?? "not_configured",
      lastCopyAt: stringOrNull(state.offsite?.lastCopyAt),
    };
    if (!result.lastRun.ok) {
      result.warnings.push({
        code: "live_backup_last_run_failed",
        message: `Last nightly backup run had a failure: ${result.lastRun.failure ?? "no reason recorded"}.`,
      });
    }
    if (!backupDir) throw new Error(`no backupDir in ${opts.stateFile}`);

    const names = existsSync(backupDir) ? readdirSync(backupDir) : [];
    for (const [field, spec] of Object.entries(ARTIFACTS) as Array<
      [keyof typeof ARTIFACTS, (typeof ARTIFACTS)[keyof typeof ARTIFACTS]]
    >) {
      const artifact = newestArtifact(names, backupDir, spec.prefix, spec.suffix, now.getTime());
      result[field] = artifact;
      if (!artifact) {
        result.warnings.push({
          code: `live_backup_${spec.key}_missing`,
          message: `No nightly ${spec.label} (${spec.prefix}*${spec.suffix}) in ${backupDir}.`,
        });
      } else if (artifact.ageHours > maxAgeHours) {
        result.warnings.push({
          code: `live_backup_${spec.key}_stale`,
          message: `Newest nightly ${spec.label} is ${artifact.ageHours}h old, exceeding ${maxAgeHours}h.`,
        });
      }
    }
  } catch (error) {
    result.warnings.push({
      code: "live_backup_check_failed",
      message: `Nightly backup health check failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  result.status = result.warnings.length > 0 ? "warning" : "ok";
  return result;
}

// /api/health is polled, and the backup folder can be a slow Windows mount. The archives change once a
// night, so a short cache costs nothing.
export function createCachedLiveBackupHealth(
  opts: Omit<InspectLiveBackupHealthOptions, "now">,
  ttlMs = 60_000,
) {
  let cached: { atMs: number; value: LiveBackupHealthStatus } | null = null;
  return (): LiveBackupHealthStatus => {
    const nowMs = Date.now();
    if (!cached || nowMs - cached.atMs >= ttlMs) {
      cached = { atMs: nowMs, value: inspectLiveBackupHealth(opts) };
    }
    return cached.value;
  };
}
