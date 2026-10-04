// Run: node cli/node_modules/tsx/dist/cli.mjs --test scripts/client-instance/status.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { backupStatusLines, releaseStatusLines } from "./status.js";

const base = mkdtempSync(path.join(process.env.GSAM_RUN_SCRATCH_DIR ?? tmpdir(), "status-test-"));
after(() => rmSync(base, { recursive: true, force: true }));

const NOW = Date.parse("2026-10-04T12:00:00Z");
const MIN = 60_000;

function backupsWith(name: string, files: Record<string, number>): string {
  const dir = path.join(base, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, ageMs] of Object.entries(files)) {
    const full = path.join(dir, file);
    writeFileSync(full, "x");
    const when = new Date(NOW - ageMs);
    utimesSync(full, when, when);
  }
  return dir;
}

test("a recent backup gives its name and age, and no warning", () => {
  const dir = backupsWith("recent", {
    "paperclip-old.sql.gz": 5 * 60 * MIN,
    "paperclip-new.sql.gz": 40 * MIN,
    "notes.txt": 1 * MIN,
  });
  assert.deepEqual(backupStatusLines(dir, NOW), ["backup: newest paperclip-new.sql.gz, 40 min old"]);
});

test("a backup older than 2 hours gives a WARNING line", () => {
  const dir = backupsWith("old", { "paperclip-a.sql.gz": 3 * 60 * MIN + 5 * MIN });
  const lines = backupStatusLines(dir, NOW);
  assert.equal(lines[0], "backup: newest paperclip-a.sql.gz, 3 h 5 min old");
  assert.match(lines[1] ?? "", /^WARNING: newest backup is older than 2 h/);
  assert.equal(lines.length, 2);
});

test("no backups folder, or an empty one, gives a WARNING line", () => {
  for (const dir of [path.join(base, "missing"), backupsWith("empty", {})]) {
    const lines = backupStatusLines(dir, NOW);
    assert.equal(lines[0], `backup: none in ${dir}`);
    assert.match(lines[1] ?? "", /^WARNING: no backup found/);
  }
});

test("release lines with no upgrade or restore", () => {
  assert.deepEqual(releaseStatusLines({ release: { tag: "stable-2026-10-01.1", dir: "/r/stable-2026-10-01.1" } }), [
    "release: stable-2026-10-01.1",
    "last upgrade: none",
    "last restore: none",
  ]);
  assert.deepEqual(releaseStatusLines({}), [
    "release: not recorded (no start since GRE-130)",
    "last upgrade: none",
    "last restore: none",
  ]);
});

test("release lines with the last upgrade and restore", () => {
  const from = { tag: null, dir: "/code" };
  const to = { tag: "stable-2026-10-01.1", dir: "/r/stable-2026-10-01.1" };
  assert.deepEqual(
    releaseStatusLines({
      release: from,
      lastUpgrade: { from, to, at: "2026-10-02T20:00:00.000Z" },
      lastRestore: { to: from, at: "2026-10-02T20:30:00.000Z" },
    }),
    [
      "release: untagged (/code)",
      "last upgrade: untagged (/code) -> stable-2026-10-01.1 at 2026-10-02T20:00:00.000Z",
      "last restore: to untagged (/code) at 2026-10-02T20:30:00.000Z",
    ],
  );
});
