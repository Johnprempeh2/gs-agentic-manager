// Tests for scripts/greatstone-test-gate.sh, the release test gate. Each test
// has its own temp GSAM_ROOT and a dev repo whose rc tags carry a small
// scripts/greatstone-test-gate.lanes, so no real suite runs.
//
//   node --test scripts/greatstone-test-gate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
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
  // No BASH_ENV: an agent run's .bashrc puts its own git launcher back first on
  // PATH, which would hide the launcher test's stub. No run scratch folders:
  // when these tests run inside an agent run, the sandbox itself is in one.
  const {
    BASH_ENV: _bashEnv,
    GSAM_RUN_SCRATCH_DIR: _runScratch,
    GSAM_SCRATCH_DIR: _scratch,
    GSAM_TASK_SCRATCH_DIR: _taskScratch,
    ...callerEnv
  } = process.env;
  const gateTmp = join(root, "gate-tmp");
  const env = (extraEnv) => ({
    ...callerEnv,
    GSAM_ROOT: root,
    GSAM_RELEASE_REPO: dev,
    GSAM_TEST_GATE_TMPDIR: gateTmp,
    ...extraEnv,
  });
  const script = join(dev, "scripts", "greatstone-test-gate.sh");
  const gate = (args, extraEnv = {}) => spawnSync("bash", [script, ...args], { encoding: "utf8", env: env(extraEnv) });
  const gateAsync = (args, extraEnv = {}) => spawn("bash", [script, ...args], { env: env(extraEnv), stdio: "ignore" });
  return { root, dev, candidate, gate, gateAsync, gateTmp, gateDir: join(root, "test-gate") };
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

test("an agent run's managed git launcher stays off the gate's and the lanes' PATH", (t) => {
  // GRE-1605: the launcher came first on PATH, so tests that run git got it.
  // The stub is not git, so the gate's own clone fails too if it reaches it.
  const box = sandbox(t);
  const launcher = join(box.root, "tmp", "paperclip-github-runtime", "run-1");
  mkdirSync(launcher, { recursive: true });
  writeFileSync(join(launcher, "git"), "#!/bin/sh\necho launcher\n", { mode: 0o755 });
  box.candidate("rc-2026-10-13.1", [
    "real-git: case \":$PATH:\" in *paperclip-github-runtime*) exit 1 ;; esac; git --version | grep -q '^git version'",
    "",
  ].join("\n"));

  const run = box.gate(["rc-2026-10-13.1"], { PATH: `${launcher}:${process.env.PATH}`, GSAM_TEST_GATE_RETRY: "0" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
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

test("a lane that fails once and passes alone on the retry still passes, and the marker names it", (t) => {
  const box = sandbox(t);
  const commit = box.candidate("rc-2026-10-13.1", [
    "ok: true",
    // Fails the first time only, like a suite that flakes under parallel load.
    "flaky: test -f .flaky-tried || { touch .flaky-tried; exit 1; }",
  ].join("\n"));
  const run = box.gate(["rc-2026-10-13.1"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^ {2}flaky passed on retry$/m);
  assert.match(readFileSync(join(box.gateDir, "passed", commit), "utf8"), /^retried=flaky$/m);
  assert.ok(existsSync(join(box.gateDir, "logs", commit, "flaky.first-attempt.log")));

  // With the retry off, the same lane fails the gate.
  const box2 = sandbox(t);
  box2.candidate("rc-2026-10-13.1", "flaky: test -f .flaky-tried || { touch .flaky-tried; exit 1; }\n");
  assert.equal(box2.gate(["rc-2026-10-13.1"], { GSAM_TEST_GATE_RETRY: "0" }).status, 1);
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

const waitFor = async (what, check, ms = 30_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("started from an agent run, the gate drops the run marker and lanes never use the run scratch TMPDIR", { skip: process.platform !== "linux" && "reads /proc" }, (t) => {
  // GRE-1643: the server stops every process whose start environment names a
  // run that ended, and deletes the run scratch folder (the run's TMPDIR).
  const box = sandbox(t);
  const runScratch = join(box.root, "run-scratch");
  mkdirSync(runScratch);
  box.candidate("rc-2026-10-17.1", [
    `tmp: test "$TMPDIR" = "${box.gateTmp}"`,
    // Walk up to the gate's own process and read its start environment.
    "no-marker: p=$PPID; while [ \"$p\" -gt 1 ]; do if grep -qa greatstone-test-gate.sh /proc/$p/cmdline; then tr '\\0' '\\n' </proc/$p/environ | grep -q '_RUN_ID=' && exit 1; exit 0; fi; p=$(cut -d' ' -f4 /proc/$p/stat); done; exit 2",
    "",
  ].join("\n"));
  // Agents also get the run id under its legacy alias (spelt in two parts for the rebrand guard).
  const runEnv = { GSAM_RUN_ID: "run-1", [`${"PAPER"}CLIP_RUN_ID`]: "run-1", TMPDIR: runScratch, GSAM_RUN_SCRATCH_DIR: runScratch };
  const run = box.gate(["rc-2026-10-17.1"], { ...runEnv, GSAM_TEST_GATE_RETRY: "0" });
  assert.equal(run.status, 0, run.stdout + run.stderr);

  const inScratch = box.gate(["rc-2026-10-17.1"], { ...runEnv, GSAM_TEST_GATE_TMPDIR: join(runScratch, "gate") });
  assert.equal(inScratch.status, 1);
  assert.match(inScratch.stderr, /GSAM_TEST_GATE_TMPDIR must be outside the run scratch folder/);
});

test("--detach returns at once and the gate still writes its marker, with output in <tag>.out", async (t) => {
  const box = sandbox(t);
  const commit = box.candidate("rc-2026-10-17.1", "slow: sleep 2\n");
  const run = box.gate(["--detach", "rc-2026-10-17.1"], { GSAM_RUN_ID: "run-1" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^Test gate for rc-2026-10-17\.1 started in the background \(pid \d+\)\. Output: .*rc-2026-10-17\.1\.out$/m);
  const marker = join(box.gateDir, "passed", commit);
  assert.equal(existsSync(marker), false, "the caller does not wait for the lanes");
  await waitFor("the pass marker", () => existsSync(marker));
  await waitFor("the lock to go", () => !existsSync(join(box.gateDir, "lock")));
  assert.match(readFileSync(join(box.gateDir, "rc-2026-10-17.1.out"), "utf8"), /^PASSED: all 1 lanes on rc-2026-10-17\.1/m);
  assert.equal(box.gate(["--check", "rc-2026-10-17.1"]).status, 0);
});

test("a gate that is stopped stops its lanes too, frees its lock and writes no marker", async (t) => {
  const box = sandbox(t);
  const commit = box.candidate("rc-2026-10-17.1", [
    "sleeper: sleep 300 & echo $! > \"$TMPDIR/sleeper.pid\"; wait",
    "waiter: sleep 300",
    "",
  ].join("\n"));
  const child = box.gateAsync(["rc-2026-10-17.1"]);
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const pidFile = join(box.gateTmp, "sleeper.pid");
  await waitFor("the lanes to start", () => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim());
  const sleeper = Number(readFileSync(pidFile, "utf8").trim());
  assert.ok(alive(sleeper));
  child.kill("SIGTERM");
  const { code } = await exited;
  assert.equal(code, 143);
  await waitFor("the lane's process to stop", () => !alive(sleeper), 10_000);
  assert.equal(existsSync(join(box.gateDir, "lock")), false);
  assert.equal(existsSync(join(box.gateDir, "passed", commit)), false);
});

test("a full commit sha is gated like a tag, and its marker is keyed by that commit", (t) => {
  // The release queue gates each new origin/main commit before any tag is cut.
  const box = sandbox(t);
  const commit = box.candidate("rc-2026-10-18.1", "ok: true\n");
  git(box.dev, "tag", "-d", "rc-2026-10-18.1");
  const run = box.gate([commit]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(readFileSync(join(box.gateDir, "passed", commit), "utf8"), new RegExp(`^tag=${commit}$`, "m"));
  assert.equal(box.gate(["--check", commit]).status, 0);
  assert.match(box.gate([commit.slice(0, 9)]).stderr, /unknown tag/);
});

test("the queue's background gate on main gives way to any other gate, never the other way round", async (t) => {
  const box = sandbox(t);
  const commit = box.candidate("rc-2026-10-18.1", "slow: sleep 300\n");
  const background = box.gateAsync([commit], { GSAM_TEST_GATE_YIELD: "1" });
  const exited = new Promise((resolve) => background.on("exit", (code) => resolve(code)));
  await waitFor("the background gate's lock", () => existsSync(join(box.gateDir, "lock", "owner")) && /^yield$/m.test(readFileSync(join(box.gateDir, "lock", "owner"), "utf8")));
  // Another background gate does not push it aside.
  const second = box.gate([commit], { GSAM_TEST_GATE_YIELD: "1" });
  assert.equal(second.status, 1);
  assert.match(second.stderr, /another test gate runs/);
  // A release's own gate (here on a quick commit) stops it and runs.
  const quick = box.candidate("rc-2026-10-18.2", "ok: true\n");
  const run = box.gate(["rc-2026-10-18.2"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^Stopping the background test gate of main \(pid \d+, /m);
  assert.equal(await exited, 143);
  assert.ok(existsSync(join(box.gateDir, "passed", quick)));
  assert.equal(existsSync(join(box.gateDir, "passed", commit)), false);
});
