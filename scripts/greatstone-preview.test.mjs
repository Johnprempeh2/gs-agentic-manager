// Tests for the environment scripts/greatstone-preview.sh gives the preview
// server. Only the variable setup is run: no preview is started, and nothing
// under ~/GSAM is read or written.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";

const scriptsDir = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

// The script up to its command dispatch, then print PREVIEW_ENV one per line.
function previewEnv(env) {
  const dir = mkdtempSync(join(tmpdir(), "gs-preview-env-"));
  try {
    const source = readFileSync(join(scriptsDir, "greatstone-preview.sh"), "utf8");
    const setup = source.slice(0, source.lastIndexOf('case "${1:-}" in'))
      .replace('"$(dirname "${BASH_SOURCE[0]}")/greatstone-common.sh"', JSON.stringify(join(scriptsDir, "greatstone-common.sh")));
    const file = join(dir, "env.sh");
    writeFileSync(file, `${setup}\nprintf '%s\\n' "\${PREVIEW_ENV[@]}"\n`);
    const out = execFileSync("bash", [file], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
    return Object.fromEntries(out.trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an agent's temp HOME does not reach the preview server (GRE-171)", () => {
  const env = previewEnv({ HOME: "/tmp/agent-home" });
  assert.equal(env.HOME, userInfo().homedir);
  assert.equal(env.GSAM_ROOT, join(userInfo().homedir, "GSAM"));
});

test("GSAM_ROOT set by the caller is passed on to the preview server", () => {
  const env = previewEnv({ HOME: "/tmp/agent-home", GSAM_ROOT: "/tmp/fake-gsam" });
  assert.equal(env.GSAM_ROOT, "/tmp/fake-gsam");
  assert.equal(env.PORT, "3200");
});

// The script up to its command dispatch, then <tail>. Returns stdout.
function runSetup(tail, env) {
  const dir = mkdtempSync(join(tmpdir(), "gs-preview-setup-"));
  try {
    const source = readFileSync(join(scriptsDir, "greatstone-preview.sh"), "utf8");
    const setup = source.slice(0, source.lastIndexOf('case "${1:-}" in'))
      .replace('"$(dirname "${BASH_SOURCE[0]}")/greatstone-common.sh"', JSON.stringify(join(scriptsDir, "greatstone-common.sh")));
    const file = join(dir, "setup.sh");
    writeFileSync(file, `${setup}\n${tail}\n`);
    return execFileSync("bash", [file], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A fake GSAM root whose preview state file points at a live process that
// looks like the preview (its command line names the preview data folder).
function withFakePreview(state, fn) {
  const root = mkdtempSync(join(tmpdir(), "gs-preview-root-"));
  const dataDir = join(root, "preview", "data");
  mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", dataDir], { stdio: "ignore" });
  try {
    writeFileSync(join(root, "preview", "preview.state"),
      Object.entries({ tag: "rc-test", commit: "abc", pid: child.pid, port: 1, ...state }).map(([k, v]) => `${k}=${v}\n`).join(""));
    return fn(root);
  } finally {
    child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
}

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString().replace(/\.\d+Z$/, "Z");

function runPreview(args, root, env = {}) {
  try {
    const stdout = execFileSync("bash", [join(scriptsDir, "greatstone-preview.sh"), ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: root, GSAM_ROOT: root, GSAM_PREVIEW_PORT: "1", ...env },
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status, out: `${error.stdout}${error.stderr}` };
  }
}

test("start records the agent run and issue in the preview state (GRE-525)", () => {
  const root = mkdtempSync(join(tmpdir(), "gs-preview-root-"));
  try {
    mkdirSync(join(root, "preview"));
    const read = (env) => {
      runSetup('write_preview_state rc-1 abc 123 /repo', { GSAM_ROOT: root, ...env });
      return readFileSync(join(root, "preview", "preview.state"), "utf8");
    };
    const state = read({ GSAM_RUN_ID: "run-1\nport=9", GSAM_TASK_ID: "issue-1" });
    assert.match(state, /^run_id=run-1port=9$/m);
    assert.match(state, /^issue_id=issue-1$/m);
    assert.match(state, /^port=3200$/m);
    assert.match(state, /^started_at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/m);
    const outside = read({});
    assert.match(outside, /^run_id=$/m);
    assert.match(outside, /^issue_id=$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("start from a run scratch clone leaves release.conf unchanged (GRE-529)", () => {
  const root = mkdtempSync(join(tmpdir(), "gs-preview-root-"));
  const scratch = mkdtempSync(join(tmpdir(), "paperclip-run-test-"));
  try {
    const conf = join(root, "release.conf");
    writeFileSync(conf, "release_repo=/dev/checkout\n");
    const clone = join(scratch, "pr299");
    mkdirSync(clone);
    for (const name of ["GSAM_RUN_SCRATCH_DIR", "GSAM_TASK_SCRATCH_DIR", "GSAM_SCRATCH_DIR", "GSAM_TMPDIR"]) {
      runSetup(`record_release_repo ${JSON.stringify(clone)} 2>/dev/null`, { GSAM_ROOT: root, [name]: `${scratch}/` });
      assert.equal(readFileSync(conf, "utf8"), "release_repo=/dev/checkout\n", name);
    }
    // A repo outside the scratch folder is still recorded, in or out of a run.
    runSetup(`record_release_repo ${JSON.stringify(root)}`, { GSAM_ROOT: root, GSAM_RUN_SCRATCH_DIR: scratch });
    assert.equal(readFileSync(conf, "utf8"), `release_repo=${root}\n`);
    runSetup(`record_release_repo ${JSON.stringify(clone)}`, { GSAM_ROOT: root });
    assert.equal(readFileSync(conf, "utf8"), `release_repo=${clone}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a second start names the run, issue and age of the running preview (GRE-525)", () => {
  withFakePreview({ started_at: hoursAgo(3.1), run_id: "run-1", issue_id: "issue-1" }, (root) => {
    const { code, out } = runPreview(["start", "rc-other"], root);
    assert.equal(code, 1);
    assert.match(out, /a preview of rc-test is already running \(started 3h ago by run run-1 for issue issue-1\); run 'greatstone-preview\.sh stop' first\./);
  });
});

test("status shows the origin, and old state files without run or issue still work (GRE-525)", () => {
  withFakePreview({ started_at: hoursAgo(0.5), run_id: "run-2", issue_id: "issue-2" }, (root) => {
    assert.match(runPreview(["status"], root).out, /origin: +started 30m ago by run run-2 for issue issue-2/);
  });
  withFakePreview({ started_at: hoursAgo(50) }, (root) => {
    const status = runPreview(["status"], root);
    assert.equal(status.code, 0);
    assert.match(status.out, /origin: +started 2d ago by run unknown for issue unknown/);
    assert.match(runPreview(["start", "rc-other"], root).out, /already running \(started 2d ago by run unknown for issue unknown\)/);
  });
  withFakePreview({}, (root) => {
    assert.match(runPreview(["status"], root).out, /origin: +started at an unknown time by run unknown for issue unknown/);
  });
});
