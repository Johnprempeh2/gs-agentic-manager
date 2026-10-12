// Run: node cli/node_modules/tsx/dist/cli.mjs --test scripts/client-instance/releases.test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultReleasesDir, isStableTag, pickReleaseTag, releaseDirFor, releaseFolderLines, releaseFolders } from "./releases.js";

test("only stable-YYYY-MM-DD.N tags are stable tags", () => {
  assert.equal(isStableTag("stable-2026-09-29.1"), true);
  assert.equal(isStableTag("stable-2026-12-31.12"), true);
  for (const tag of [
    "live-2026-09-29.1",
    "stable-2026-09-29",
    "stable-2026-09-29.0",
    "stable-2026-13-01.1",
    "stable-2026-02-30.1",
    "stable-2026-09-29.1-rc",
    "stable-2026-09-29.1/../x",
    "v1.0.0",
    "",
  ]) {
    assert.equal(isStableTag(tag), false, tag);
  }
});

test("a release folder is <releases>/<tag>, and only for a stable tag", () => {
  assert.equal(releaseDirFor("/srv/instances/releases", "stable-2026-09-29.1"), "/srv/instances/releases/stable-2026-09-29.1");
  assert.throws(() => releaseDirFor("/srv/instances/releases", "../stable-2026-09-29.1"));
  assert.throws(() => releaseDirFor("/srv/instances/releases", "live-2026-09-29.1"));
  assert.equal(defaultReleasesDir("/srv/instances/c001"), "/srv/instances/releases");
});

test("the release tag of a folder prefers stable, then live", () => {
  assert.equal(pickReleaseTag(["live-2026-09-29.3", "stable-2026-09-29.1", "stable-2026-09-28.2"]), "stable-2026-09-29.1");
  assert.equal(pickReleaseTag(["live-2026-09-29.2", "live-2026-09-29.3", "v1"]), "live-2026-09-29.3");
  assert.equal(pickReleaseTag(["v1"]), "v1");
  assert.equal(pickReleaseTag(["", " "]), null);
});

test("releases marks each folder runs, restore needs it, or not used, and writes nothing (GRE-833)", () => {
  const top = realpathSync(mkdtempSync(path.join(tmpdir(), "releases-test-")));
  try {
    const rel = path.join(top, "releases");
    const [a, b, c] = ["stable-2026-09-20.1", "stable-2026-09-29.1", "stable-2026-10-01.1"].map((tag) => path.join(rel, tag));
    for (const dir of [a!, b!, c!]) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(a!, "file"), "x".repeat(4096));
    const instance = (name: string, state: object) => {
      mkdirSync(path.join(top, name));
      writeFileSync(path.join(top, name, "client-instance.json"), JSON.stringify(state));
    };
    // c001 upgraded from b to c; c002 still runs b. Nothing uses a.
    instance("c001", { release: { tag: "stable-2026-10-01.1", dir: c }, lastUpgrade: { from: { tag: "stable-2026-09-29.1", dir: b }, to: { dir: c } } });
    instance("c002", { release: { tag: "stable-2026-09-29.1", dir: b } });
    const before = JSON.stringify(readdirSync(top, { recursive: true }).sort()) + statSync(path.join(top, "c001", "client-instance.json")).mtimeMs;

    const folders = releaseFolders(top, rel);
    assert.deepEqual(
      folders.map((f) => [path.basename(f.dir), f.uses.map((u) => `${u.instance} ${u.mark}`)]),
      [
        ["stable-2026-09-20.1", []],
        ["stable-2026-09-29.1", ["c001 restore needs it", "c002 runs"]],
        ["stable-2026-10-01.1", ["c001 runs"]],
      ],
    );
    assert.ok((folders[0]!.sizeKb ?? 0) >= 4, "size of the folder is read");
    const lines = releaseFolderLines(folders);
    assert.match(lines[0]!, /stable-2026-09-20\.1 {2}\d+ KB {2}not used$/);
    assert.match(lines[1]!, /runs: c002; restore needs it: c001$/);
    assert.match(lines[2]!, /runs: c001$/);

    const after = JSON.stringify(readdirSync(top, { recursive: true }).sort()) + statSync(path.join(top, "c001", "client-instance.json")).mtimeMs;
    assert.equal(after, before, "nothing written or deleted");
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});
