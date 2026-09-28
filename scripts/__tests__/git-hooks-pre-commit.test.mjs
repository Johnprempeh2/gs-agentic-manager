import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const installer = new URL("../git-hooks/install.sh", import.meta.url).pathname;

const cleanupDirs = [];

test.after(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// Strip every GSAM_* and GIT_* variable so the run's own workspace cannot leak
// into the repo under test.
function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GSAM_") && !key.startsWith("GIT_")) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: os.tmpdir(),
    ...extra,
  };
}

function git(cwd, args, env = cleanEnv()) {
  const identity = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
  return spawnSync("git", [...identity, ...args], { cwd, env, encoding: "utf8" });
}

/** A repo with the guard installed plus a second worktree on branch "other". */
function makeRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gsam-pre-commit-")));
  cleanupDirs.push(root);
  const main = path.join(root, "main");
  fs.mkdirSync(main);
  assert.equal(git(main, ["init", "-q", "-b", "run-branch"]).status, 0);
  assert.equal(git(main, ["commit", "-q", "--allow-empty", "-m", "init"]).status, 0);
  const other = path.join(root, "other");
  assert.equal(git(main, ["worktree", "add", "-q", "-b", "other", other]).status, 0);
  const install = spawnSync("bash", [installer, main], { env: cleanEnv(), encoding: "utf8" });
  assert.equal(install.status, 0, install.stderr);
  return { main, other };
}

function commit(cwd, env) {
  return git(cwd, ["commit", "-q", "--allow-empty", "-m", "work"], cleanEnv(env));
}

test("same branch and worktree: commit allowed", () => {
  const { main } = makeRepo();
  const result = commit(main, { GSAM_WORKSPACE_BRANCH: "run-branch", GSAM_WORKSPACE_WORKTREE_PATH: main });
  assert.equal(result.status, 0, result.stderr);
});

test("other branch: commit refused with a message naming both branches", () => {
  const { main } = makeRepo();
  assert.equal(git(main, ["checkout", "-q", "-b", "someone-else"]).status, 0);
  const result = commit(main, { GSAM_WORKSPACE_BRANCH: "run-branch", GSAM_WORKSPACE_WORKTREE_PATH: main });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /'run-branch'.*'someone-else'/);
  assert.equal(result.stderr.split("\n").filter((line) => line.startsWith("pre-commit:")).length, 1);
});

test("other worktree: commit refused", () => {
  const { main, other } = makeRepo();
  const result = commit(other, { GSAM_WORKSPACE_BRANCH: "other", GSAM_WORKSPACE_WORKTREE_PATH: main });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /worktree is '.*main' but the commit is in '.*other'/);
});

test("detached HEAD: commit refused", () => {
  const { main } = makeRepo();
  assert.equal(git(main, ["checkout", "-q", "--detach"]).status, 0);
  const result = commit(main, { GSAM_WORKSPACE_BRANCH: "run-branch" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /detached HEAD/);
});

test("variable unset: commit allowed on any branch", () => {
  const { other } = makeRepo();
  const result = commit(other, {});
  assert.equal(result.status, 0, result.stderr);
});

test("installer is idempotent and leaves a foreign pre-commit hook alone", () => {
  const { main } = makeRepo();
  const again = spawnSync("bash", [installer, main], { env: cleanEnv(), encoding: "utf8" });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, "");

  const hook = path.join(main, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 0\n");
  const foreign = spawnSync("bash", [installer, main], { env: cleanEnv(), encoding: "utf8" });
  assert.equal(foreign.status, 0);
  assert.match(foreign.stderr, /not the Greatstone guard/);
  assert.equal(fs.readFileSync(hook, "utf8"), "#!/bin/sh\nexit 0\n");
});
