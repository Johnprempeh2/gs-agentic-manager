// Tests for scripts/greatstone-release-note.sh. The repository is a fake in a
// temp folder; curl and gh are fakes on PATH that log each call, so the test
// can check that the script only reads.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = new URL("./greatstone-release-note.sh", import.meta.url).pathname;
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const ISSUES = {
  "GRE-55": "Problem.\n\n**Done when** (added by Everest):\n- Focus mode shows one card.\n- [ ] Works at phone width.\n\n**Risk** low.\n- not an item",
  "GRE-49": "Some text.\nDone when: one release card per day.\n",
  "GRE-60": "No acceptance section here.",
};

// main: live tag, a merged PR with an id, one without, a squash merge whose
// branch only gh knows, a direct commit, and a PR whose issue cannot be read.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "gs-release-note-"));
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  const log = join(dir, "calls.log");
  execFileSync("mkdir", ["-p", repo, bin]);
  git(repo, "init", "--quiet", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "tag.gpgsign", "false");
  let n = 0;
  const commit = (message) => {
    writeFileSync(join(repo, `f${++n}`), "x\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", message);
  };
  const mergePr = (pr, branch, title) => {
    git(repo, "checkout", "--quiet", "-b", branch);
    commit("work");
    git(repo, "checkout", "--quiet", "main");
    git(repo, "merge", "--quiet", "--no-ff", branch, "-m", `Merge pull request #${pr} from owner/${branch}`, "-m", title);
  };
  commit("start");
  git(repo, "tag", "live-2026-09-01.1");
  mergePr(40, "GRE-55-focus", "feat(ui): Decisions: Focus mode");
  mergePr(41, "fix/no-ticket", "fix: something with no issue");
  commit("docs: one release card per day (#42)");
  commit("chore: direct push");
  mergePr(43, "GRE-60-liveness", "fix(liveness): flag a blocked issue (GRE-60)");
  mergePr(44, "GRE-77-missing", "feat: issue the app does not know (GRE-77)");

  writeFileSync(join(dir, "issues.json"), JSON.stringify(ISSUES));
  const fake = (name, body) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\nprintf '%s\\n' "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  fake("curl", `url="\${@: -1}"; id="\${url##*/}"
desc="$(jq -r --arg id "$id" '.[$id] // empty' "${join(dir, "issues.json")}")"
[ -n "$desc" ] || exit 22
jq -n --arg d "$desc" '{description: $d}'`);
  fake("gh", `[ "$1 $2" = "pr view" ] && [ "$3" = 42 ] && echo GRE-49-release-card`);
  return { dir, repo, bin, log };
}

function run(fx, args, env = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    cwd: fx.repo,
    encoding: "utf8",
    // BASH_ENV off: an agent run's BASH_ENV puts its own gh ahead of the fakes.
    env: { ...process.env, BASH_ENV: "", PATH: `${fx.bin}:${process.env.PATH}`, GSAM_API_URL: "http://app.test/api", GSAM_API_KEY: "k", ...env },
  });
}

test("one line per merge, GRE id and Done when, flags missing ids", () => {
  const fx = fixture();
  try {
    const refsBefore = git(fx.repo, "for-each-ref");
    const headBefore = git(fx.repo, "rev-parse", "HEAD");
    const r = run(fx, ["live-2026-09-01.1", "main"]);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trimEnd().split("\n");
    assert.deepEqual(lines, [
      "- #40 GRE-55 feat(ui): Decisions: Focus mode — Done when: Focus mode shows one card.; Works at phone width.",
      "- #41 NO GRE ID fix: something with no issue (branch: fix/no-ticket)",
      "- #42 GRE-49 docs: one release card per day — Done when: one release card per day.",
      `- commit ${lines[3].split(" ")[2]} NO PR chore: direct push`,
      "- #43 GRE-60 fix(liveness): flag a blocked issue (GRE-60) — Done when: (no Done when in issue)",
      "- #44 GRE-77 feat: issue the app does not know (GRE-77) — Done when: (issue not read)",
      "6 merged since live-2026-09-01.1 (to main); 2 flagged.",
    ]);

    // Read-only: no ref moved, curl only GETs, gh only views.
    assert.equal(git(fx.repo, "for-each-ref"), refsBefore);
    assert.equal(git(fx.repo, "rev-parse", "HEAD"), headBefore);
    const calls = readFileSync(fx.log, "utf8").trim().split("\n");
    for (const c of calls.filter((c) => c.startsWith("curl "))) {
      assert.doesNotMatch(c, /\s(-X|--request|-d|--data\S*|-F|--form|-T|--upload-file)\s/, c);
      assert.match(c, /http:\/\/app\.test\/api\/issues\/GRE-\d+$/);
    }
    for (const c of calls.filter((c) => c.startsWith("gh "))) assert.match(c, /^gh pr view \d+ /);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("--no-app --no-gh calls neither curl nor gh", () => {
  const fx = fixture();
  try {
    const r = run(fx, ["live-2026-09-01.1", "main", "--no-app", "--no-gh"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^- #40 GRE-55 .* — Done when: \(app not read\)$/m);
    assert.match(r.stdout, /^- #42 NO GRE ID docs: one release card per day \(branch: unknown\)$/m);
    assert.equal(existsSync(fx.log), false);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("bad arguments exit 2", () => {
  const fx = fixture();
  try {
    assert.equal(run(fx, []).status, 2);
    assert.equal(run(fx, ["no-such-tag", "main"]).status, 2);
    assert.equal(run(fx, ["live-2026-09-01.1", "main", "--push"]).status, 2);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});
