// Run: node cli/node_modules/tsx/dist/cli.mjs --test scripts/client-instance/offsite.test.ts
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  OFFSITE_RETENTION,
  checkCode,
  checkRepositoryForCode,
  loadOffsiteConfig,
  offsiteStatusLines,
  parseOffsiteConfig,
  resticEnv,
  snapshotRoot,
} from "./offsite.js";

const base = mkdtempSync(path.join(process.env.GSAM_RUN_SCRATCH_DIR ?? tmpdir(), "offsite-test-"));
after(() => rmSync(base, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-04T12:00:00Z");
const HOUR = 60 * 60 * 1000;

test("retention is 30 daily and 12 weekly", () => {
  assert.deepEqual([...OFFSITE_RETENTION], ["--keep-daily", "30", "--keep-weekly", "12"]);
});

test("instance codes are codes, not names", () => {
  assert.equal(checkCode("c001"), null);
  assert.equal(checkCode("pilot01"), null);
  assert.match(checkCode("Acme Ltd")!, /lower-case/);
  assert.match(checkCode("../c001")!, /lower-case/);
});

test("one repository per code: the repository path must end in the code", () => {
  assert.equal(checkRepositoryForCode("sftp:u123-sub1@u123.example.net:/home/c001", "c001"), null);
  assert.equal(checkRepositoryForCode("sftp://u123-sub1@u123.example.net:23//home/c001/", "c001"), null);
  assert.equal(checkRepositoryForCode("/srv/offsite/c001", "c001"), null);
  assert.match(checkRepositoryForCode("sftp:u123-sub1@u123.example.net:/home/c002", "c001")!, /must end in \/c001/);
  assert.match(checkRepositoryForCode("/srv/offsite", "c001")!, /must end in \/c001/);
  assert.match(checkRepositoryForCode("s3:s3.amazonaws.com/bucket/c001", "c001")!, /sftp: target or an absolute local folder/);
  assert.match(checkRepositoryForCode("relative/c001", "c001")!, /sftp: target or an absolute local folder/);
});

test("the config names the key file and never holds the key", () => {
  const ok = parseOffsiteConfig("# c001\nRESTIC_REPOSITORY=/srv/offsite/c001\nRESTIC_PASSWORD_FILE='/etc/gsam/c001.key'\n", "c001");
  assert.deepEqual(ok, { repository: "/srv/offsite/c001", passwordFile: "/etc/gsam/c001.key", extra: {} });
  assert.match((parseOffsiteConfig("RESTIC_REPOSITORY=/srv/c001\nRESTIC_PASSWORD=x\n", "c001") as { error: string }).error, /not allowed/);
  assert.match((parseOffsiteConfig("RESTIC_REPOSITORY=/srv/c001\nRESTIC_PASSWORD_COMMAND=cat x\n", "c001") as { error: string }).error, /not allowed/);
  assert.match((parseOffsiteConfig("RESTIC_REPOSITORY=/srv/c001\n", "c001") as { error: string }).error, /RESTIC_PASSWORD_FILE is missing/);
  assert.match((parseOffsiteConfig("RESTIC_REPOSITORY=/srv/c001\nRESTIC_PASSWORD_FILE=key\n", "c001") as { error: string }).error, /absolute/);
  assert.match((parseOffsiteConfig("AWS_SECRET_ACCESS_KEY=x\n", "c001") as { error: string }).error, /not an off-host setting/);
});

test("config and key files must be private", () => {
  const key = path.join(base, "c001.key");
  const config = path.join(base, "c001.env");
  writeFileSync(key, "sandbox-key\n");
  writeFileSync(config, `RESTIC_REPOSITORY=${base}/repo/c001\nRESTIC_PASSWORD_FILE=${key}\n`);
  chmodSync(config, 0o644);
  chmodSync(key, 0o600);
  assert.match((loadOffsiteConfig(config, "c001") as { error: string }).error, /chmod 600/);
  chmodSync(config, 0o600);
  chmodSync(key, 0o640);
  assert.match((loadOffsiteConfig(config, "c001") as { error: string }).error, /^RESTIC_PASSWORD_FILE .*\(chmod 600\)$/);
  chmodSync(key, 0o600);
  assert.equal((loadOffsiteConfig(config, "c001") as { repository: string }).repository, `${base}/repo/c001`);
});

test("restic gets the repository, the key file and nothing else from the caller", () => {
  const env = resticEnv({ repository: "/srv/c001", passwordFile: "/k", extra: {} }, { HOME: "/home/x", PATH: "/bin", GSAM_API_KEY: "secret" } as never);
  assert.deepEqual(env, { RESTIC_REPOSITORY: "/srv/c001", RESTIC_PASSWORD_FILE: "/k", HOME: "/home/x", PATH: "/bin" });
});

test("the snapshot's instance root is the folder of its client-instance.json", () => {
  assert.equal(snapshotRoot(["/srv/i/c001/client-instance.json", "/srv/i/c001/instances/default/data/backups"]), "/srv/i/c001");
  assert.equal(snapshotRoot(["/srv/i/c001/instances/default/data/backups"]), null);
});

test("status warns when there is no off-host backup, it failed, or it is older than 26 h", () => {
  assert.deepEqual(offsiteStatusLines(undefined, NOW), ["last off-host backup: none", "WARNING: no off-host backup yet; run offsite-backup"]);
  const ok = { ok: true, line: "offsite-backup OK: snapshot abcd1234, 3 files", snapshot: "abcd1234", at: new Date(NOW - 2 * HOUR).toISOString() };
  assert.deepEqual(offsiteStatusLines(ok, NOW), [`last off-host backup: ${ok.line} at ${ok.at}`]);
  const old = { ...ok, at: new Date(NOW - 27 * HOUR).toISOString() };
  assert.match(offsiteStatusLines(old, NOW)[1]!, /no off-host backup in the last 26 h/);
  const failed = { ok: false, line: "offsite-backup FAILED: x", snapshot: null, at: ok.at };
  assert.match(offsiteStatusLines(failed, NOW)[1]!, /the last off-host backup failed/);
});
