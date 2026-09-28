// Tests for scripts/greatstone-candidate.mjs and the title check in
// scripts/greatstone-release.sh. The repository and GSAM_ROOT are fakes in a
// temp folder; nothing under ~/GSAM is read or written.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { changeKind, cutCandidate, noteLine, tagMessage, titleProblem } from "./greatstone-candidate.mjs";

const scriptsDir = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// main: live tag, then a feature and a fix merged as pull requests.
function fakeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "gs-candidate-"));
  git(dir, "init", "--quiet", "-b", "main");
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"], ["tag.gpgsign", "false"]]) git(dir, "config", k, v);
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
  git(dir, "tag", "-a", "live-2026-09-01.1", "-m", "Old release");
  mergePr(40, "GRE-55-focus", "ui/src/Focus.tsx", "feat(ui): Decisions: Focus mode (GRE-55)");
  mergePr(41, "GRE-72-liveness", "server/src/liveness.ts", "fix(liveness): flag a blocked issue (GRE-72)");
  return dir;
}

test("titleProblem refuses an empty, multi-line or placeholder title", () => {
  assert.match(titleProblem("", "rc-2026-09-02.1"), /title is required/);
  assert.match(titleProblem("  ", "rc-2026-09-02.1"), /title is required/);
  assert.match(titleProblem("a\nb", "rc-2026-09-02.1"), /one line/);
  assert.match(titleProblem("Release candidate rc-2026-09-02.1", "rc-2026-09-02.1"), /not a title/);
  assert.match(titleProblem("rc-2026-09-02.1", "rc-2026-09-02.1"), /not a title/);
  assert.equal(titleProblem("Decisions in the sidebar", "rc-2026-09-02.1"), null);
});

test("sorts fixes from features and writes one line per pull request", () => {
  assert.equal(changeKind("fix(liveness): flag a blocked issue (GRE-72)"), "fixes");
  assert.equal(changeKind("GRE-31: Fix see-through popup"), "fixes");
  assert.equal(changeKind("feat(ui): Focus mode"), "features");
  assert.equal(noteLine({ pr: 41, branch: "GRE-72-x", title: "fix(liveness): flag a blocked issue (GRE-72)" }), "- Flag a blocked issue (#41, GRE-72)");
  assert.equal(noteLine({ pr: null, branch: "", title: "docs: runbook" }), "- Runbook");
  assert.equal(tagMessage("Only fixes", [{ pr: 1, branch: "", title: "fix: a" }]), "Only fixes\n\nFixes\n- A (#1)\n");
});

test("cuts an annotated rc tag with the title and both groups", (t) => {
  const dir = fakeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { since } = cutCandidate(dir, { tag: "rc-2026-09-02.1", title: "Focus mode and a liveness fix", ref: "main" });
  assert.equal(since, "live-2026-09-01.1");
  assert.equal(git(dir, "cat-file", "-t", "rc-2026-09-02.1"), "tag");
  assert.equal(
    git(dir, "for-each-ref", "--format=%(contents)", "refs/tags/rc-2026-09-02.1"),
    "Focus mode and a liveness fix\n\nFeatures\n- Decisions: Focus mode (#40, GRE-55)\n\nFixes\n- Flag a blocked issue (#41, GRE-72)",
  );
  assert.throws(() => cutCandidate(dir, { tag: "rc-2026-09-02.1", title: "Again", ref: "main" }), /already exists/);
});

test("refuses a candidate without a title or without changes", (t) => {
  const dir = fakeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => cutCandidate(dir, { tag: "rc-2026-09-02.1", title: "", ref: "main" }), /title is required/);
  assert.throws(() => cutCandidate(dir, { tag: "rc-2026-09-02.1", title: "Nothing", ref: "live-2026-09-01.1" }), /nothing merged since live-2026-09-01.1/);
  assert.throws(() => git(dir, "rev-parse", "--verify", "--quiet", "refs/tags/rc-2026-09-02.1"));
});

// greatstone-release.sh checks the title before it looks at live at all, so a
// fake repo and a GSAM_ROOT without a live checkout are enough.
function release(dir, tag) {
  const root = mkdtempSync(join(tmpdir(), "gs-release-title-"));
  try {
    return spawnSync("bash", [join(scriptsDir, "greatstone-release.sh"), tag], {
      encoding: "utf8",
      env: { ...process.env, GSAM_ROOT: root, GSAM_RELEASE_REPO: dir, GSAM_LIVE_URL: "http://127.0.0.1:9" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the release refuses an rc tag with no title", (t) => {
  const dir = fakeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "tag", "rc-2026-09-02.1");
  git(dir, "tag", "-a", "rc-2026-09-02.2", "-m", "Release candidate rc-2026-09-02.2");
  git(dir, "tag", "-a", "rc-2026-09-02.3", "-m", "Focus mode");

  const light = release(dir, "rc-2026-09-02.1");
  assert.equal(light.status, 1);
  assert.match(light.stderr, /release: rc-2026-09-02.1 has no title: it is a lightweight tag/);

  const placeholder = release(dir, "rc-2026-09-02.2");
  assert.equal(placeholder.status, 1);
  assert.match(placeholder.stderr, /rc-2026-09-02.2 has no title \(line 1 is "Release candidate rc-2026-09-02.2"\)/);

  // A titled tag passes the check and stops at the next one: no live checkout.
  const titled = release(dir, "rc-2026-09-02.3");
  assert.equal(titled.status, 1);
  assert.match(titled.stderr, /release: no live checkout at/);
});
