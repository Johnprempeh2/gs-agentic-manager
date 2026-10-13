// Tests for scripts/greatstone-test-gate.sh, the release test gate. Each test
// has its own temp GSAM_ROOT and a dev repo whose rc tags carry a small
// scripts/greatstone-test-gate.lanes, so no real suite runs.
//
//   node --test scripts/greatstone-test-gate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "gs-test-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dev = join(root, "dev");
  mkdirSync(join(dev, "scripts"), { recursive: true });
  git(dev, "init", "--quiet", "-b", "main");
  git(dev, "config", "user.name", "Test");
  git(dev, "config", "user.email", "test@example.com");
  for (const f of ["greatstone-common.sh", "greatstone-test-gate.sh"]) copyFileSync(join(scriptsDir, f), join(dev, "scripts", f));
  // Commits <lanes> as the lanes file and tags it.
  const candidate = (tag, lanes) => {
    if (lanes === null) rmSync(join(dev, "scripts", "greatstone-test-gate.lanes"), { force: true });
    else writeFileSync(join(dev, "scripts", "greatstone-test-gate.lanes"), lanes);
    git(dev, "add", "-A");
    git(dev, "commit", "--quiet", "--allow-empty", "-m", tag);
    git(dev, "tag", "-a", tag, "-m", `Candidate ${tag}`);
    return git(dev, "rev-parse", "HEAD");
  };
  const gate = (args, extraEnv = {}) =>
    spawnSync("bash", [join(dev, "scripts", "greatstone-test-gate.sh"), ...args], {
      encoding: "utf8",
      env: { ...process.env, GSAM_ROOT: root, GSAM_RELEASE_REPO: dev, ...extraEnv },
    });
  return { root, dev, candidate, gate, gateDir: join(root, "test-gate") };
}

test("a candidate whose lanes all pass gets a pass marker for its exact commit", (t) => {
  const box = sandbox(t);
  const commit = box.candidate("rc-2026-10-13.1", [
    "# comment",
    "setup: echo ready > setup.txt",
    "after-setup: test -f setup.txt",
    // Nothing from the caller reaches a lane, but the account home and PATH do.
    "clean-env: test -z \"${DATABASE_URL:-}\" && test -n \"$HOME\" && command -v git",
    "ci: test \"$CI\" = true",
    "",
  ].join("\n"));

  assert.equal(box.gate(["--check", "rc-2026-10-13.1"]).status, 1);

  const run = box.gate(["rc-2026-10-13.1"], { DATABASE_URL: "postgres://agent-secret" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^Running 3 lanes, 3 at a time\.\.\.$/m);
  assert.match(run.stdout, new RegExp(`^PASSED: all 3 lanes on rc-2026-10-13\\.1 \\(${commit}\\) in \\d+m\\d+s\\.`, "m"));
  const marker = readFileSync(join(box.gateDir, "passed", commit), "utf8");
  assert.match(marker, new RegExp(`^commit=${commit}$`, "m"));
  assert.match(marker, /^tag=rc-2026-10-13\.1$/m);
  assert.match(marker, /^passed_at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/m);
  assert.ok(existsSync(join(box.gateDir, "logs", commit, "after-setup.log")));
  // It runs in its own clone, never in the dev checkout, and frees its lock.
  assert.equal(existsSync(join(box.dev, "setup.txt")), false);
  assert.equal(existsSync(join(box.gateDir, "lock")), false);

  const check = box.gate(["--check", "rc-2026-10-13.1"]);
  assert.equal(check.status, 0);
  assert.match(check.stdout, /^the full test suite passed on rc-2026-10-13\.1/);
});

test("a failing lane names the lane and its failing tests and writes no marker", (t) => {
  const box = sandbox(t);
  const commit = box.candidate("rc-2026-10-13.1", [
    "ok: true",
    // Vitest colours the FAIL label, as in a real log.
    "broken: printf '  ✓ fine\\n\\033[41m FAIL \\033[49m src/a.test.ts > adds up\\n'; exit 3",
  ].join("\n"));
  const run = box.gate(["rc-2026-10-13.1"]);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /^FAILED: 1 of 2 lanes failed on rc-2026-10-13\.1/m);
  assert.match(run.stdout, /^ {2}broken \(log: .*broken\.log\)$/m);
  assert.match(run.stdout, /^ {4}FAIL {2}src\/a\.test\.ts > adds up$/m);
  assert.equal(existsSync(join(box.gateDir, "passed", commit)), false);

  const check = box.gate(["--check", "rc-2026-10-13.1"]);
  assert.equal(check.status, 1);
  assert.match(check.stderr, /^test-gate: the full test suite has not passed on rc-2026-10-13\.1 .*Run it first: scripts\/greatstone-test-gate\.sh rc-2026-10-13\.1/m);
});

test("a failing setup stops the gate before any lane", (t) => {
  const box = sandbox(t);
  box.candidate("rc-2026-10-13.1", "setup: exit 1\nlane: touch ran\n");
  const run = box.gate(["rc-2026-10-13.1"]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^test-gate: setup failed on rc-2026-10-13\.1: exit 1 /m);
  assert.equal(existsSync(join(box.gateDir, "code", "ran")), false);
});

test("the clone is cleaned between runs, and the gate refuses a tag with no lanes or a second gate", (t) => {
  const box = sandbox(t);
  box.candidate("rc-2026-10-13.1", "leave: touch leftover\n");
  assert.equal(box.gate(["rc-2026-10-13.1"]).status, 0);
  assert.ok(existsSync(join(box.gateDir, "code", "leftover")));
  const second = box.candidate("rc-2026-10-13.2", "clean: test ! -e leftover\n");
  const run = box.gate(["rc-2026-10-13.2"]);
  assert.equal(run.status, 0, run.stdout);
  assert.ok(existsSync(join(box.gateDir, "passed", second)));

  box.candidate("rc-2026-10-13.3", null);
  assert.match(box.gate(["rc-2026-10-13.3"]).stderr, /has no scripts\/greatstone-test-gate\.lanes/);

  mkdirSync(join(box.gateDir, "lock"));
  writeFileSync(join(box.gateDir, "lock", "owner"), "pid 1, rc-2026-10-13.2\n");
  const locked = box.gate(["rc-2026-10-13.2"]);
  assert.equal(locked.status, 1);
  assert.match(locked.stderr, /another test gate runs \(pid 1, rc-2026-10-13\.2\)/);
  assert.ok(existsSync(join(box.gateDir, "lock")), "another gate's lock is left alone");

  assert.match(box.gate(["rc-2099-01-01.1"]).stderr, /^test-gate: unknown tag rc-2099-01-01\.1$/m);
});
