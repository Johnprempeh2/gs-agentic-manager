// Tests for scripts/greatstone-changes.mjs. The repository is a fake in a temp
// folder; gh is not called.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  changeLine, changeList, lastLiveTag, mergedChanges, whatChanged, whereFromBody, whereFromFiles,
} from "./greatstone-changes.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const opts = { previewUrl: "http://localhost:3200", prefix: "GRE", repo: "o/r" };

// main: live tag, then two merged pull requests and one squash merge, then the rc tag.
function fakeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "gs-changes-"));
  git(dir, "init", "--quiet", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "tag.gpgsign", "false");
  const commit = (file, message) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), `${file}\n`);
    git(dir, "add", file);
    git(dir, "commit", "--quiet", "-m", message);
  };
  const mergePr = (n, branch, file, title) => {
    git(dir, "checkout", "--quiet", "-b", branch);
    commit(file, "work");
    git(dir, "checkout", "--quiet", "main");
    git(dir, "merge", "--quiet", "--no-ff", branch, "-m", `Merge pull request #${n} from owner/${branch}`, "-m", title);
  };
  commit("README.md", "start");
  git(dir, "tag", "live-2026-09-01.1");
  mergePr(40, "GRE-55-focus", "ui/src/components/decisions-focus/Focus.tsx", "feat(ui): Decisions: Focus mode (GRE-55)");
  mergePr(41, "GRE-60-update", "server/src/services/liveness.ts", "fix(liveness): flag a blocked issue (GRE-72)");
  commit("scripts/x.sh", "docs: one release card per day (GRE-49) (#42)");
  git(dir, "tag", "rc-2026-09-02.1");
  return dir;
}

test("lists every merge since the last live tag, oldest first, with issue, what and where", () => {
  const dir = fakeRepo();
  try {
    const since = lastLiveTag(dir, "rc-2026-09-02.1");
    assert.equal(since, "live-2026-09-01.1");
    const changes = mergedChanges(dir, since, "rc-2026-09-02.1");
    assert.deepEqual(changes.map((c) => c.pr), [40, 41, 42]);
    const list = changeList(changes, { rc: "rc-2026-09-02.1", since, ...opts }).split("\n");
    assert.match(list[0], /rc-2026-09-02.1 against live-2026-09-01.1; 3 changes/);
    assert.equal(list[1], "- [GRE-55](/GRE/issues/GRE-55) Decisions: Focus mode. Open http://localhost:3200/GRE/decisions; Sidebar → Decisions. ([#40](https://github.com/o/r/pull/40))");
    assert.equal(list[2], "- [GRE-72](/GRE/issues/GRE-72) flag a blocked issue. No visible change. ([#41](https://github.com/o/r/pull/41))");
    assert.equal(list[3], "- [GRE-49](/GRE/issues/GRE-49) one release card per day. No visible change. ([#42](https://github.com/o/r/pull/42))");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no merge since the live tag says so", () => {
  const dir = fakeRepo();
  try {
    const list = changeList(mergedChanges(dir, "rc-2026-09-02.1", "rc-2026-09-02.1"), { rc: "rc-2026-09-02.1", since: "rc-2026-09-02.1", ...opts });
    assert.match(list, /0 changes/);
    assert.match(list, /- No merged change since rc-2026-09-02.1\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the pull request's 'Where to see it' line wins over the file guess", () => {
  const change = { sha: "a".repeat(40), pr: 7, branch: "GRE-9-x", title: "Focus mode (GRE-9)", files: ["server/a.ts"] };
  assert.equal(
    changeLine(change, { ...opts, prBody: "## What Changed\n\n**Where to see it:** Sidebar → Decisions, then the Focus switch (`/decisions`)\n" }),
    "- [GRE-9](/GRE/issues/GRE-9) Focus mode. Open http://localhost:3200/GRE/decisions; Sidebar → Decisions, then the Focus switch. ([#7](https://github.com/o/r/pull/7))",
  );
  assert.deepEqual(whereFromBody("Where to see it: no visible change"), { none: true });
  assert.equal(whereFromBody("Where to see it: <!-- page -->"), null);
  assert.equal(whereFromBody("nothing here"), null);
});

test("file guess: tests only is no visible change; unknown UI files are named", () => {
  assert.deepEqual(whereFromFiles(["ui/src/pages/Inbox.test.tsx", "server/x.ts"]), { none: true });
  const guess = whereFromFiles(["ui/src/components/Weird.tsx"]);
  assert.equal(guess.path, null);
  assert.match(guess.how, /page is not named \(ui\/src\/components\/Weird\.tsx\)/);
  const two = whereFromFiles(["ui/src/pages/Inbox.tsx", "ui/src/components/Sidebar.tsx"]);
  assert.equal(two.path, "/inbox");
  assert.equal(two.also.path, "/dashboard");
});

test("what changed drops the commit type and issue ids", () => {
  assert.equal(whatChanged("feat(metrics): add S1-work (GRE-74)"), "add S1-work.");
  assert.equal(whatChanged("GRE-50: wake issues when their fix goes live"), "wake issues when their fix goes live.");
  assert.equal(whatChanged("Done already."), "Done already.");
});
