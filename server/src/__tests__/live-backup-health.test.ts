import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCachedLiveBackupHealth, inspectLiveBackupHealth } from "../services/live-backup-health.js";

// GRE-1930: the nightly live backup state, as scripts/live-backup/live-backup.sh leaves it.
const NOW = new Date("2026-10-22T09:00:00.000Z");
const NIGHT = new Date("2026-10-22T02:40:00.000Z");
const TWO_DAYS_AGO = new Date("2026-10-20T02:40:00.000Z");

const GOOD_COPY = { status: "ok", dir: "/mnt/d/GSAM-offsite", lastCopyAt: "2026-10-22T03:10:00Z", failure: null };

function setup(
  opts: { ok?: boolean; failure?: string | null; artifacts?: Record<string, Date>; offsite?: Record<string, unknown> } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "live-backup-health-"));
  const backupDir = path.join(root, "GSAM-backups");
  fs.mkdirSync(backupDir);
  for (const [name, mtime] of Object.entries(opts.artifacts ?? {})) {
    const file = path.join(backupDir, name);
    fs.writeFileSync(file, "synthetic");
    fs.utimesSync(file, mtime, mtime);
  }
  const stateFile = path.join(root, "health", "live-backup.json");
  fs.mkdirSync(path.dirname(stateFile));
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1,
    backupDir,
    finishedAt: "2026-10-22T02:41:00Z",
    ok: opts.ok ?? true,
    failure: opts.failure ?? null,
    offsite: opts.offsite ?? GOOD_COPY,
  }));
  return { root, backupDir, stateFile };
}

const fullSet = (when: Date) => ({
  "nightly-20261022-023000.sql.gz": when,
  "files-20261022-023000.tar.gz": when,
  "files-20261022-023000.tar.gz.sha256": when,
  "secrets-20261022-023000.tar.enc": when,
});

function codes(status: ReturnType<typeof inspectLiveBackupHealth>) {
  return status.warnings.map((warning) => warning.code);
}

describe("inspectLiveBackupHealth", () => {
  it("is not_configured with no warning when the job has never run here", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "live-backup-health-"));
    const status = inspectLiveBackupHealth({ stateFile: path.join(root, "live-backup.json"), maxAgeHours: 30, now: NOW });
    expect(status).toMatchObject({ status: "not_configured", backupDir: null, warnings: [] });
  });

  it("warns for every kind when the job ran but there is no backup", () => {
    const { stateFile, backupDir } = setup({ ok: false, failure: "failed: database dump, files archive, secrets key archive" });
    const status = inspectLiveBackupHealth({ stateFile, maxAgeHours: 30, now: NOW });
    expect(status.status).toBe("warning");
    expect(status.backupDir).toBe(backupDir);
    expect(codes(status)).toEqual([
      "live_backup_last_run_failed",
      "live_backup_dump_missing",
      "live_backup_files_missing",
      "live_backup_secrets_key_missing",
    ]);
    expect(status.warnings[0]!.message).toContain("failed: database dump, files archive, secrets key archive");
  });

  it("is ok for a fresh backup and names the newest of each kind", () => {
    const { stateFile, backupDir } = setup({
      artifacts: {
        ...fullSet(NIGHT),
        "nightly-20261021-023000.sql.gz": TWO_DAYS_AGO,
        "files-20261021-023000.tar.gz": TWO_DAYS_AGO,
      },
    });
    const status = inspectLiveBackupHealth({ stateFile, maxAgeHours: 30, now: NOW });
    expect(status).toMatchObject({
      status: "ok",
      warnings: [],
      lastRun: { ok: true, failure: null, finishedAt: "2026-10-22T02:41:00Z" },
      databaseDump: { name: "nightly-20261022-023000.sql.gz", path: path.join(backupDir, "nightly-20261022-023000.sql.gz"), ageHours: 6.3 },
      filesArchive: { name: "files-20261022-023000.tar.gz", sizeBytes: 9 },
      secretsKeyArchive: { name: "secrets-20261022-023000.tar.enc" },
      offsite: {
        status: "ok",
        dir: "/mnt/d/GSAM-offsite",
        lastCopyAt: "2026-10-22T03:10:00Z",
        lastCopyAgeHours: 5.8,
        failure: null,
        maxAgeHours: 48,
      },
    });
  });

  it("warns when the backup is stale, even if the state file says ok", () => {
    const { stateFile } = setup({ artifacts: fullSet(TWO_DAYS_AGO) });
    const status = inspectLiveBackupHealth({ stateFile, maxAgeHours: 30, now: NOW });
    expect(status.status).toBe("warning");
    expect(codes(status)).toEqual([
      "live_backup_dump_stale",
      "live_backup_files_stale",
      "live_backup_secrets_key_stale",
    ]);
    expect(status.warnings[0]!.message).toBe("Newest nightly database dump is 54.3h old, exceeding 30h.");
  });

  it("warns when the files archive is missing but the dump is fresh", () => {
    const { stateFile } = setup({
      artifacts: {
        "nightly-20261022-023000.sql.gz": NIGHT,
        "secrets-20261022-023000.tar.enc": NIGHT,
      },
    });
    const status = inspectLiveBackupHealth({ stateFile, maxAgeHours: 30, now: NOW });
    expect(status.status).toBe("warning");
    expect(codes(status)).toEqual(["live_backup_files_missing"]);
    expect(status.databaseDump?.name).toBe("nightly-20261022-023000.sql.gz");
    expect(status.filesArchive).toBeNull();
  });

  it("warns when the backup folder named in the state file is gone", () => {
    const { stateFile, backupDir } = setup({ artifacts: fullSet(NIGHT) });
    fs.rmSync(backupDir, { recursive: true });
    const status = inspectLiveBackupHealth({ stateFile, maxAgeHours: 30, now: NOW });
    expect(codes(status)).toEqual([
      "live_backup_dump_missing",
      "live_backup_files_missing",
      "live_backup_secrets_key_missing",
    ]);
  });

  it("reports a broken state file as a failed check", () => {
    const { stateFile } = setup();
    fs.writeFileSync(stateFile, "{ not json");
    const status = inspectLiveBackupHealth({ stateFile, maxAgeHours: 30, now: NOW });
    expect(codes(status)).toEqual(["live_backup_check_failed"]);
  });

  // GRE-1950: the off-machine copy to the USB drive.
  it("stays ok when last night's copy failed but a good copy is under 48h old", () => {
    const { stateFile } = setup({
      artifacts: fullSet(NIGHT),
      offsite: { status: "failed", dir: "/mnt/d/GSAM-offsite", lastCopyAt: "2026-10-21T03:10:00Z", failure: "USB drive not found" },
    });
    const status = inspectLiveBackupHealth({ stateFile, maxAgeHours: 30, now: NOW });
    expect(status.status).toBe("ok");
    expect(status.offsite).toMatchObject({ status: "failed", lastCopyAgeHours: 29.8, failure: "USB drive not found" });
  });

  it("warns after 48h without a good off-machine copy, with the last failure", () => {
    const { stateFile } = setup({
      artifacts: fullSet(NIGHT),
      offsite: { status: "failed", dir: "/mnt/d/GSAM-offsite", lastCopyAt: "2026-10-20T03:10:00Z", failure: "USB drive not found" },
    });
    const status = inspectLiveBackupHealth({ stateFile, maxAgeHours: 30, now: NOW });
    expect(status.status).toBe("warning");
    expect(codes(status)).toEqual(["live_backup_offsite_stale"]);
    expect(status.warnings[0]!.message).toBe(
      "Last good off-machine backup copy is 53.8h old, exceeding 48h. Last attempt: USB drive not found.",
    );
  });

  it("warns when there has never been a good off-machine copy", () => {
    const { stateFile } = setup({
      artifacts: fullSet(NIGHT),
      offsite: { status: "failed", dir: "/mnt/d/GSAM-offsite", lastCopyAt: null, failure: "USB drive not found" },
    });
    const status = inspectLiveBackupHealth({ stateFile, maxAgeHours: 30, now: NOW });
    expect(codes(status)).toEqual(["live_backup_offsite_missing"]);
    expect(status.warnings[0]!.message).toContain("USB drive not found");
  });

  it("warns when the script has no off-machine copy at all (installed before GRE-1950)", () => {
    const { stateFile } = setup({ artifacts: fullSet(NIGHT), offsite: { status: "not_configured" } });
    const status = inspectLiveBackupHealth({ stateFile, maxAgeHours: 30, now: NOW });
    expect(status.status).toBe("warning");
    expect(codes(status)).toEqual(["live_backup_offsite_missing"]);
    expect(status.offsite).toMatchObject({ status: "not_configured", lastCopyAt: null, lastCopyAgeHours: null });
  });

  it("warns when the off-machine copy is turned off", () => {
    const { stateFile } = setup({ artifacts: fullSet(NIGHT), offsite: { status: "off", lastCopyAt: null } });
    const status = inspectLiveBackupHealth({ stateFile, maxAgeHours: 30, now: NOW });
    expect(codes(status)).toEqual(["live_backup_offsite_missing"]);
  });

  it("uses the configured off-machine age limit", () => {
    const { stateFile } = setup({ artifacts: fullSet(NIGHT) });
    const status = inspectLiveBackupHealth({ stateFile, maxAgeHours: 30, offsiteMaxAgeHours: 4, now: NOW });
    expect(codes(status)).toEqual(["live_backup_offsite_stale"]);
  });
});

describe("createCachedLiveBackupHealth", () => {
  it("reads the folder once per ttl", () => {
    const { stateFile, backupDir } = setup({ artifacts: fullSet(new Date()) });
    const inspect = createCachedLiveBackupHealth({ stateFile, maxAgeHours: 30 }, 60_000);
    expect(inspect().status).toBe("ok");
    fs.rmSync(path.join(backupDir, "files-20261022-023000.tar.gz"));
    expect(inspect().status).toBe("ok");
    const uncached = createCachedLiveBackupHealth({ stateFile, maxAgeHours: 30 }, 0);
    expect(uncached().warnings.map((warning) => warning.code)).toEqual(["live_backup_files_missing"]);
  });
});
