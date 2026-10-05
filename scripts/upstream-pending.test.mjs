// Tests for scripts/upstream-pending.sh. The repository is a fake in a temp
// folder: a fork point, an "upstream" branch and a "main" that took some of it.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  return runEnv(dir, process.env, ...args);
}

function runEnv(dir, env, ...args) {
  const r = spawnSync("bash", [SCRIPT, ...args], { cwd: dir, encoding: "utf8", env });
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

test("drops upstream commits that a sync merge brought into main and names the sync point", () => {
  const { dir, base, up } = fixture();
  try {
    const short = (sha) => sha.slice(0, 7);
    assert.match(run(dir, "--base", base, "--main", "main"), new RegExp(`^Synced to: ${short(base)}$`, "m"));
    // A sync merge takes upstream up to the security fix; only up.plain is left.
    git(dir, "merge", "--quiet", "--no-edit", up.security);
    const out = run(dir, "--base", base, "--main", "main");
    assert.match(out, new RegExp(`^Synced to: ${short(up.security)}$`, "m"));
    assert.match(out, /Upstream commits: 7\. Pending: 1\. Partial: 0\./);
    const lists = out.slice(out.indexOf("## "));
    for (const key of ["taken", "partial", "skipped", "backfilled", "picked", "security"]) {
      assert.ok(!lists.includes(short(up[key])), `${key} is in main and should not be listed:\n${out}`);
    }
    assert.match(out, new RegExp(`## Other \\(1\\)\\n${short(up.plain)} `));
    assert.equal(run(dir, "--base", base, "--main", "main", "--count").trim(), "1");
    const clashOut = run(dir, "--base", base, "--main", "main", "--clash");
    assert.match(clashOut, /Pending: 1\./);
    assert.ok(!clashOut.includes(short(up.security) + " "), clashOut);
    // An advisory naming the merged fix does not bring it back.
    const env = stubGh(dir, [advisory("GHSA-ffff-ffff-ffff", "2026-04-16T00:00:00Z", "Grants", "Fixed by #6")]);
    const advOut = runEnv(dir, env, "--base", base, "--main", "main", "--advisories");
    assert.match(advOut, /## Security-looking \(0\)\n/);
    assert.ok(!advOut.includes(short(up.security) + " "), advOut);
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

// A fake `gh` on PATH that prints the given advisories for `gh api`.
function stubGh(dir, advisories) {
  const bin = join(dir, ".bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "advisories.json"), JSON.stringify(advisories));
  writeFileSync(join(bin, "args.txt"), "");
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash\necho "$*" >> "${bin}/args.txt"\ncat "${bin}/advisories.json"\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  // BASH_ENV can put another gh first on PATH (the agent runtime does).
  const { BASH_ENV: _, ...env } = process.env;
  return { ...env, PATH: `${bin}:${process.env.PATH}` };
}

const advisory = (id, updatedAt, summary, description = "") => ({
  ghsa_id: id,
  severity: "high",
  updated_at: updatedAt,
  summary,
  description,
});

test("--advisories prints NEW, CHANGED and OPEN and lists named commits as security", () => {
  const { dir, base, up } = fixture();
  try {
    writeFileSync(
      join(dir, "doc/upstream-advisories.txt"),
      [
        "# comment",
        "GHSA-aaaa-aaaa-aaaa high 2026-04-16T00:00:00Z in-base patched in 2026.416.0",
        "GHSA-bbbb-bbbb-bbbb high 2026-04-16T00:00:00Z n/a: we have no such route",
        "GHSA-cccc-cccc-cccc high 2026-04-16T00:00:00Z check may be exposed",
        "",
      ].join("\n"),
    );
    git(dir, "add", "doc");
    git(dir, "commit", "--quiet", "-m", "docs: advisories");
    const env = stubGh(dir, [
      advisory("GHSA-aaaa-aaaa-aaaa", "2026-04-16T00:00:00Z", "Same as before"),
      advisory("GHSA-bbbb-bbbb-bbbb", "2026-07-01T00:00:00Z", "Moved", `Fixed in ${up.plain.slice(0, 10)}.`),
      advisory("GHSA-cccc-cccc-cccc", "2026-04-16T00:00:00Z", "Still open"),
      advisory("GHSA-dddd-dddd-dddd", "2026-10-01T00:00:00Z", "Brand new", "See github.com/paperclipai/paperclip/pull/5 and #3."),
    ]);
    const plainOut = runEnv(dir, env, "--base", base, "--main", "main");
    assert.ok(!/Advisories/.test(plainOut), "no advisories without the flag");
    const r = spawnSync("bash", [SCRIPT, "--base", base, "--main", "main", "--advisories"], {
      cwd: dir,
      encoding: "utf8",
      env,
    });
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout;
    assert.match(out, /^## Advisories \(4 upstream: 1 new, 1 changed, 1 open\)$/m);
    assert.match(out, /^NEW GHSA-dddd-dddd-dddd high 2026-10-01T00:00:00Z Brand new$/m);
    assert.match(out, /^CHANGED GHSA-bbbb-bbbb-bbbb high 2026-07-01T00:00:00Z \(was 2026-04-16T00:00:00Z\) Moved$/m);
    assert.match(out, /^OPEN GHSA-cccc-cccc-cccc high 2026-04-16T00:00:00Z Still open$/m);
    assert.ok(!/GHSA-aaaa/.test(out), out);
    // up.plain is named by sha; it now leads the security list with its GHSA id.
    const short = (sha) => sha.slice(0, 7);
    assert.match(out, /## Security-looking \(2\)\n/);
    assert.match(out, new RegExp(`^${short(up.plain)} .*\\(#7\\)  \\[GHSA-bbbb-bbbb-bbbb\\]$`, "m"));
    // #3 is skipped and #5 cherry-picked, so the PR numbers match no pending commit.
    assert.match(out, /Pending: 2\./);
    assert.match(readArgs(dir), /^api repos\/paperclipai\/paperclip\/security-advisories/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--advisories matches a pending commit by its PR number and flags a bad verdict", () => {
  const { dir, base, up } = fixture();
  try {
    writeFileSync(join(dir, "doc/upstream-advisories.txt"), "GHSA-eeee-eeee-eeee low 2026-04-16T00:00:00Z maybe\n");
    git(dir, "add", "doc");
    git(dir, "commit", "--quiet", "-m", "docs: advisories");
    const env = stubGh(dir, [
      advisory("GHSA-eeee-eeee-eeee", "2026-04-16T00:00:00Z", "Pickers", "Fixed by https://github.com/paperclipai/paperclip/pull/7"),
    ]);
    const out = runEnv(dir, env, "--base", base, "--main", "main", "--advisories");
    assert.match(out, new RegExp(`^${up.plain.slice(0, 7)} .*\\(#7\\)  \\[GHSA-eeee-eeee-eeee\\]$`, "m"));
    assert.match(out, /^BAD GHSA-eeee-eeee-eeee has verdict "maybe"$/m);
    assert.equal(runEnv(dir, env, "--base", base, "--main", "main", "--advisories", "--count").trim(), "2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function readArgs(dir) {
  return execFileSync("cat", [join(dir, ".bin/args.txt")], { encoding: "utf8" });
}
