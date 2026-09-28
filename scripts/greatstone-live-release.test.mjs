// Sandbox tests for scripts/greatstone-live-release.sh and the run count in
// scripts/greatstone-common.sh. Everything lives in a temp folder: GSAM_ROOT,
// the live checkout and the release repository are fakes; nothing under
// ~/GSAM is read or written, and no live server is contacted.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const scriptsDir = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// A stub greatstone-release.sh. It moves the fake live checkout like the real
// script and prints the same lines, then fails the way $STUB_<mode> says.
const STUB_RELEASE = `#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "\${BASH_SOURCE[0]}")/greatstone-common.sh"
TAG="$1"
echo "$TAG" >> "$GSAM_ROOT/calls.log"
echo "from_app=\${GSAM_RELEASE_FROM_APP:-} phase_file=\${GSAM_RELEASE_PHASE_FILE:-}" >> "$GSAM_ROOT/env.log"
release_phase switching
case "$TAG" in
  rc-*)
    [ "\${STUB_RC:-ok}" = refuse ] && { echo "release: 1 agent run(s) are active; release again when the agents are idle." >&2; exit 1; }
    echo "Backed up the live database (on live-2026-09-01.1) to $GSAM_ROOT/backups/before-$TAG.sql.gz"
    echo "Tagged $TAG as live-2026-09-27.1"
    git -C "$LIVE_DIR" checkout --quiet --detach "$TAG"
    [ "\${STUB_RC:-ok}" = health ] && { echo "release: the live app did not report live-2026-09-27.1 within 3 minutes; check the server log." >&2; exit 1; }
    exit 0 ;;
  live-*)
    [ "\${STUB_ROLLBACK:-ok}" = fail ] && { echo "release: the live database is not running; cannot back it up. Nothing was changed." >&2; exit 1; }
    echo "keep=\${GSAM_RELEASE_EXISTING_BACKUP:-}" >> "$GSAM_ROOT/calls.log"
    git -C "$LIVE_DIR" checkout --quiet --detach "$TAG"
    exit 0 ;;
esac
`;

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "gs-live-release-"));
  const live = join(root, "live");
  mkdirSync(live);
  git(live, "init", "--quiet");
  git(live, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "--allow-empty", "-m", "old");
  git(live, "tag", "live-2026-09-01.1");
  const oldHead = git(live, "rev-parse", "HEAD");
  git(live, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "--allow-empty", "-m", "new");
  git(live, "tag", "rc-2026-09-27.2");
  git(live, "checkout", "--quiet", "--detach", "live-2026-09-01.1");

  const repo = join(root, "dev");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  copyFileSync(join(scriptsDir, "greatstone-common.sh"), join(repo, "scripts", "greatstone-common.sh"));
  writeFileSync(join(repo, "scripts", "greatstone-release.sh"), STUB_RELEASE, { mode: 0o755 });
  const job = join(root, "job");
  mkdirSync(job);
  return { root, live, repo, job, oldHead };
}

function launch(box, env = {}) {
  const run = spawnSync("bash", [join(scriptsDir, "greatstone-live-release.sh"), box.job, "rc-2026-09-27.2", box.repo], {
    encoding: "utf8",
    env: {
      ...process.env,
      GSAM_ROOT: box.root,
      GSAM_LIVE_URL: "http://127.0.0.1:9", // nothing listens: health reads are empty
      GSAM_LIVE_RELEASE_FOREGROUND: "1",
      ...env,
    },
  });
  const result = JSON.parse(readFileSync(join(box.job, "result.json"), "utf8"));
  const calls = readFileSync(join(box.root, "calls.log"), "utf8").trim().split("\n");
  return { run, result, calls, head: git(box.live, "rev-parse", "HEAD") };
}

test("a release that comes up reports released", (t) => {
  const box = sandbox();
  t.after(() => rmSync(box.root, { recursive: true, force: true }));
  const { result, calls, head } = launch(box);
  assert.equal(result.outcome, "released");
  assert.equal(result.liveTag, "live-2026-09-27.1");
  assert.equal(result.previousTag, "live-2026-09-01.1");
  assert.deepEqual(calls, ["rc-2026-09-27.2"]);
  assert.equal(head, git(box.live, "rev-parse", "rc-2026-09-27.2"));
  // App mode (hot restart, no preview check) and the phase file for the server.
  assert.equal(readFileSync(join(box.root, "env.log"), "utf8").trim(), `from_app=1 phase_file=${join(box.job, "phase")}`);
  assert.equal(readFileSync(join(box.job, "phase"), "utf8").trim(), "switching");
});

test("a failed health check rolls back to the previous live tag and keeps the backup path", (t) => {
  const box = sandbox();
  t.after(() => rmSync(box.root, { recursive: true, force: true }));
  const { result, calls, head } = launch(box, { STUB_RC: "health" });
  assert.equal(result.outcome, "rolled_back");
  assert.equal(result.previousTag, "live-2026-09-01.1");
  assert.equal(result.backupFile, join(box.root, "backups", "before-rc-2026-09-27.2.sql.gz"));
  assert.match(result.message, /did not report live-2026-09-27.1 within 3 minutes/);
  assert.deepEqual(calls, ["rc-2026-09-27.2", "live-2026-09-01.1", `keep=${result.backupFile}`]);
  assert.equal(head, box.oldHead);
});

test("a refusal before live moves is not released and does not roll back", (t) => {
  const box = sandbox();
  t.after(() => rmSync(box.root, { recursive: true, force: true }));
  const { result, calls, head } = launch(box, { STUB_RC: "refuse" });
  assert.equal(result.outcome, "not_released");
  assert.match(result.message, /agent run\(s\) are active/);
  assert.deepEqual(calls, ["rc-2026-09-27.2"]);
  assert.equal(head, box.oldHead);
});

test("a failed rollback says so", (t) => {
  const box = sandbox();
  t.after(() => rmSync(box.root, { recursive: true, force: true }));
  const { result } = launch(box, { STUB_RC: "health", STUB_ROLLBACK: "fail" });
  assert.equal(result.outcome, "rollback_failed");
  assert.match(result.message, /rollback: the live database is not running/);
});

test("without the foreground flag it detaches and records its pid", async (t) => {
  const box = sandbox();
  t.after(() => rmSync(box.root, { recursive: true, force: true }));
  const env = { ...process.env, GSAM_ROOT: box.root, GSAM_LIVE_URL: "http://127.0.0.1:9" };
  delete env.GSAM_LIVE_RELEASE_FOREGROUND;
  execFileSync("bash", [join(scriptsDir, "greatstone-live-release.sh"), box.job, "rc-2026-09-27.2", box.repo], { env });
  assert.match(readFileSync(join(box.job, "launcher.pid"), "utf8"), /^\d+\n$/);
  for (let i = 0; i < 100; i++) {
    try {
      assert.equal(JSON.parse(readFileSync(join(box.job, "result.json"), "utf8")).outcome, "released");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  assert.fail("the detached launcher wrote no result");
});

// active_runs: queued runs count unless a task drain holds them.
function fakeLive(draining) {
  const server = http.createServer((req, res) => {
    const body = {
      "/api/health": { status: "ok" },
      "/api/instance/task-drain": { draining },
      "/api/companies": [{ id: "c1" }],
      "/api/companies/c1/heartbeat-runs?limit=50": [{ status: "running" }, { status: "queued" }, { status: "queued" }, { status: "succeeded" }],
    }[req.url];
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? {}));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// Async: the fake server answers from this process, so a sync call would deadlock.
async function activeRuns(url) {
  const { stdout } = await promisify(execFile)("bash", ["-c", `source "${scriptsDir}/greatstone-common.sh"; active_runs "$1"`, "_", url], { encoding: "utf8" });
  return stdout.trim();
}

test("active_runs counts queued runs when no drain holds them", async (t) => {
  const server = await fakeLive(false);
  t.after(() => server.close());
  assert.equal(await activeRuns(`http://127.0.0.1:${server.address().port}`), "3");
});

test("active_runs counts only running runs while a drain holds new runs", async (t) => {
  const server = await fakeLive(true);
  t.after(() => server.close());
  assert.equal(await activeRuns(`http://127.0.0.1:${server.address().port}`), "1");
});

test("active_runs is 0 when the live server does not answer", async () => {
  assert.equal(await activeRuns("http://127.0.0.1:9"), "0");
});
