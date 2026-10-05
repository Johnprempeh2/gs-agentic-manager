// Tests for scripts/upstream-pending.sh. The repository is a fake in a temp
// folder: a fork point, an "upstream" branch and a "main" that took some of it.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = new URL("./upstream-pending.sh", import.meta.url).pathname;
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// upstream: taken (trailer), partial (trailer), skipped (skip file), backfilled
// (taken file), cherry-picked as-is, one security fix and one plain fix.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "gs-upstream-pending-"));
  git(dir, "init", "--quiet", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  const commit = (file, message) => {
    writeFileSync(join(dir, file), `${file}\n`);
    git(dir, "add", file);
    git(dir, "commit", "--quiet", "-m", message);
    return git(dir, "rev-parse", "HEAD");
  };
  const base = commit("base", "fork point");
  git(dir, "checkout", "--quiet", "-b", "upstream");
  const up = {
    taken: commit("a", "fix: taken by trailer (#1)"),
    partial: commit("b", "fix(agents): partly taken (#2)"),
    skipped: commit("c", "docs: upstream release notes (#3)"),
    backfilled: commit("d", "fix: taken before the rule (#4)"),
    picked: commit("e", "fix: plain cherry-pick (#5)"),
    security: commit("f", "fix(tool-access): enforce stored grant restrictions (#6)"),
    plain: commit("g", "fix(ui): keep pickers in view (#7)"),
  };
  git(dir, "update-ref", "refs/upstream/master", "upstream");
  git(dir, "checkout", "--quiet", "main");
  git(dir, "cherry-pick", up.picked);
  commit("ours-a", `fix: port a\n\nUpstream-Commit: ${up.taken.slice(0, 9)} taken`);
  commit("ours-b", `fix: port part of b\n\nCo-Authored-By: x <x@example.com>\nUpstream-Commit: ${up.partial} partial`);
  mkdirSync(join(dir, "doc"));
  writeFileSync(join(dir, "doc/upstream-skipped.txt"), `# comment\n\n${up.skipped.slice(0, 9)} upstream release notes\n`);
  writeFileSync(join(dir, "doc/upstream-taken.txt"), `# comment\n${up.backfilled.slice(0, 9)} taken abc1234 PR #9\n`);
  git(dir, "add", "doc");
  git(dir, "commit", "--quiet", "-m", "docs: upstream lists");
  return { dir, base, up };
}

function run(dir, ...args) {
  const r = spawnSync("bash", [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test("drops taken, partial, skipped, backfilled and cherry-picked commits; security first", () => {
  const { dir, base, up } = fixture();
  try {
    const before = git(dir, "status", "--porcelain");
    const refsBefore = git(dir, "show-ref");
    const out = run(dir, "--base", base, "--main", "main");
    const short = (sha) => sha.slice(0, 7);
    // Skip the header: it names the upstream tip, which is up.plain.
    const lists = out.slice(out.indexOf("## "));
    const pendingPart = lists.split("## Partial")[0];
    for (const key of ["taken", "partial", "skipped", "backfilled", "picked"]) {
      assert.ok(!pendingPart.includes(short(up[key])), `${key} should not be pending:\n${out}`);
    }
    assert.match(out, /Upstream commits: 7\. Pending: 2\. Partial: 1\./);
    assert.ok(pendingPart.includes(short(up.plain)), out);
    assert.ok(pendingPart.indexOf(short(up.security)) < pendingPart.indexOf(short(up.plain)), "security first");
    assert.match(out, /## Security-looking \(1\)\n\S+ \S+ fix\(tool-access\)/);
    assert.match(out, new RegExp(`## Partial[^\\n]*\\(1\\)\\n${short(up.partial)}`));
    assert.equal(run(dir, "--base", base, "--main", "main", "--count").trim(), "2");
    assert.equal(git(dir, "status", "--porcelain"), before, "working tree unchanged");
    assert.equal(git(dir, "show-ref"), refsBefore, "refs unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a later taken line closes a partial", () => {
  const { dir, base, up } = fixture();
  try {
    writeFileSync(join(dir, "z"), "z\n");
    git(dir, "add", "z");
    git(dir, "commit", "--quiet", "-m", `fix: rest of b\n\nUpstream-Commit: ${up.partial.slice(0, 12)} taken`);
    assert.match(run(dir, "--base", base, "--main", "main"), /Pending: 2\. Partial: 0\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--clash marks each pending commit clean or conflict and writes nothing", () => {
  const { dir, base, up } = fixture();
  try {
    // main writes its own g, so upstream's g clashes; f touches nothing of ours.
    writeFileSync(join(dir, "g"), "ours\n");
    git(dir, "add", "g");
    git(dir, "commit", "--quiet", "-m", "feat: our own g");
    const plainOut = run(dir, "--base", base, "--main", "main");
    assert.ok(!/clean|conflict/.test(plainOut), `no marks without --clash:\n${plainOut}`);
    const before = git(dir, "status", "--porcelain");
    const refsBefore = git(dir, "show-ref");
    const out = run(dir, "--base", base, "--main", "main", "--clash");
    const short = (sha) => sha.slice(0, 7);
    assert.match(out, new RegExp(`^${short(up.security)} .*  \\[clean\\]$`, "m"));
    assert.match(out, new RegExp(`^${short(up.plain)} .*  \\[conflict: g\\]$`, "m"));
    assert.equal(out.replace(/  \[[^\]]*\]$/gm, ""), plainOut, "same lines as without --clash");
    assert.equal(run(dir, "--base", base, "--main", "main", "--count", "--clash").trim(), "2");
    assert.equal(git(dir, "status", "--porcelain"), before, "working tree unchanged");
    assert.equal(git(dir, "show-ref"), refsBefore, "refs unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tags commits that add a migration with clash or free numbers", () => {
  const { dir, base } = fixture();
  try {
    const mig = "packages/db/src/migrations";
    const addFiles = (files, message) => {
      for (const [file, body] of Object.entries(files)) {
        mkdirSync(join(dir, file, ".."), { recursive: true });
        writeFileSync(join(dir, file), body);
        git(dir, "add", file);
      }
      git(dir, "commit", "--quiet", "-m", message);
      return git(dir, "rev-parse", "--short=7", "HEAD");
    };
    // Both sides used 0001 after the fork; upstream also adds 0002, which we do not have.
    addFiles({ [`${mig}/0001_ours.sql`]: "ours\n" }, "feat: our migration");
    git(dir, "checkout", "--quiet", "upstream");
    const clashing = addFiles(
      { [`${mig}/0001_theirs.sql`]: "a\n", [`${mig}/meta/0001_snapshot.json`]: "{}\n" },
      "fix(gateway): bound discovery memory (#8)",
    );
    const mixed = addFiles({ [`${mig}/0001_more.sql`]: "b\n", [`${mig}/0002_next.sql`]: "c\n" }, "feat: two migrations (#9)");
    const touchOnly = addFiles({ [`${mig}/0001_theirs.sql`]: "a2\n" }, "fix: edit a migration (#10)");
    git(dir, "update-ref", "refs/upstream/master", "upstream");
    git(dir, "checkout", "--quiet", "main");

    const out = run(dir, "--base", base, "--main", "main");
    assert.match(out, new RegExp(`^${clashing} .*\\(#8\\)  \\[migration: 0001 clash\\]$`, "m"));
    assert.match(out, new RegExp(`^${mixed} .*\\(#9\\)  \\[migration: 0001 clash, 0002 free\\]$`, "m"));
    assert.match(out, new RegExp(`^${touchOnly} .*\\(#10\\)$`, "m"), "an edit is not an added migration");
    assert.match(out, /fix\(ui\): keep pickers in view \(#7\)$/m, "no tag without a migration");
    const clashOut = run(dir, "--base", base, "--main", "main", "--clash");
    assert.match(clashOut, new RegExp(`^${clashing} .*  \\[migration: 0001 clash\\]  \\[clean\\]$`, "m"));
    assert.equal(run(dir, "--base", base, "--main", "main", "--count").trim(), "5");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails with the fetch command when the upstream ref is missing", () => {
  const { dir, base } = fixture();
  try {
    const r = spawnSync("bash", [SCRIPT, "--base", base, "--main", "main", "--upstream", "refs/upstream/nope"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /git fetch https:\/\/github\.com\/paperclipai\/paperclip\.git master:refs\/upstream\/nope/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
