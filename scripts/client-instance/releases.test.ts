// Run: node cli/node_modules/tsx/dist/cli.mjs --test scripts/client-instance/releases.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultReleasesDir, isStableTag, pickReleaseTag, releaseDirFor } from "./releases.js";

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
