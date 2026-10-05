// Sandbox tests for scripts/greatstone-live-release.sh and the run count in
// scripts/greatstone-common.sh. Everything lives in a temp folder: GSAM_ROOT,
// the live checkout and the release repository are fakes; nothing under
// ~/GSAM is read or written, and no live server is contacted.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
    tag_live_release "$LIVE_DIR" "$TAG" live-2026-09-27.1 "$(git -C "$LIVE_DIR" rev-parse "$TAG^{commit}")"
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

// An rc tag as scripts/greatstone-candidate.mjs cuts it: a title and a changelog.
const RC_MESSAGE = "Releases page and RAM-aware run limits\n\nFeatures\n- Releases page (#53, GRE-121)\n\nFixes\n- Flag a blocked issue (#41, GRE-72)";
const configure = (dir) => {
  for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"], ["commit.gpgsign", "false"], ["tag.gpgsign", "false"]]) git(dir, "config", k, v);
};

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "gs-live-release-"));
  const live = join(root, "live");
  mkdirSync(live);
  git(live, "init", "--quiet");
  configure(live);
  git(live, "commit", "--quiet", "--allow-empty", "-m", "old");
  git(live, "tag", "live-2026-09-01.1");
  const oldHead = git(live, "rev-parse", "HEAD");
  git(live, "commit", "--quiet", "--allow-empty", "-m", "new");
  git(live, "tag", "-a", "rc-2026-09-27.2", "-m", RC_MESSAGE);
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
  const callsLog = join(box.root, "calls.log");
  const calls = existsSync(callsLog) ? readFileSync(callsLog, "utf8").trim().split("\n") : [];
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
  assert.equal(head, git(box.live, "rev-parse", "rc-2026-09-27.2^{commit}"));
  // The live tag carries the rc title and changelog (GRE-120, GRE-178).
  assert.equal(git(box.live, "for-each-ref", "--format=%(contents)", "refs/tags/live-2026-09-27.1"), RC_MESSAGE);
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

// GRE-180: a leftover .git/index.lock in live made the checkout fail after the
// backup and the tag. The stub's `git checkout` fails the same way while a lock
// is there, so "released" also proves the lock went before the stub ran.
const HOUR_AGO = new Date(Date.now() - 3600_000);
function writeLock(box, { content = "", mtime = HOUR_AGO } = {}) {
  const lock = join(realpathSync(box.live), ".git", "index.lock");
  writeFileSync(lock, content);
  utimesSync(lock, mtime, mtime);
  return lock;
}

// Starts a process group (killed on cleanup) and waits until lsof sees it.
async function holdWith(t, command, args, cwd) {
  const child = spawn(command, args, { cwd, detached: true, stdio: "ignore" });
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} });
  await new Promise((r) => setTimeout(r, 500));
  return child;
}

test("a stale empty index.lock in live is removed before the release script runs", (t) => {
  const box = sandbox();
  t.after(() => rmSync(box.root, { recursive: true, force: true }));
  const lock = writeLock(box);
  const { run, result, calls, head } = launch(box);
  assert.equal(result.outcome, "released");
  assert.equal(existsSync(lock), false);
  assert.match(run.stdout, new RegExp(`Removed a stale ${lock} \\(empty, \\d+s old, no git process\\)`));
  assert.deepEqual(calls, ["rc-2026-09-27.2"]);
  assert.equal(head, git(box.live, "rev-parse", "rc-2026-09-27.2^{commit}"));
});

for (const [name, setup] of [
  ["a fresh index.lock", (t, box) => writeLock(box, { mtime: new Date() })],
  ["a non-empty index.lock", (t, box) => writeLock(box, { content: "DIRC" })],
  ["an index.lock open in a process", async (t, box) => {
    const lock = writeLock(box);
    await holdWith(t, "bash", ["-c", 'exec 3<"$1"; sleep 30', "_", lock]);
    return lock;
  }],
  ["an index.lock with a git process in live", async (t, box) => {
    const lock = writeLock(box);
    await holdWith(t, "git", ["-c", "alias.hold=!sleep 30", "hold"], box.live);
    return lock;
  }],
]) {
  test(`${name} stops the release before any backup or tag and names the file`, async (t) => {
    const box = sandbox();
    t.after(() => rmSync(box.root, { recursive: true, force: true }));
    const lock = await setup(t, box);
    const { result, calls, head } = launch(box);
    assert.equal(result.outcome, "not_released");
    assert.ok(result.message.startsWith(`${lock} `), result.message);
    assert.match(result.message, /Nothing was changed\.$/);
    assert.equal(result.backupFile, null);
    // The release script (backup, tag, checkout) never ran.
    assert.deepEqual(calls, []);
    assert.equal(existsSync(join(box.root, "backups")), false);
    assert.equal(existsSync(lock), true);
    assert.equal(head, box.oldHead);
  });
}

// The real greatstone-release.sh (run by hand, or with an older launcher) checks
// too, before its backup and tag. Its release repo is a temp git repo with no
// origin, so a run that gets past the check stops at the fetch.
function releaseRepo(box) {
  const repo = join(box.root, "release");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  for (const f of ["greatstone-release.sh", "greatstone-common.sh"]) copyFileSync(join(scriptsDir, f), join(repo, "scripts", f));
  git(repo, "init", "--quiet");
  git(repo, "add", ".");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "-m", "scripts");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "tag", "-a", "rc-2026-09-27.2", "-m", "Faster board");
  return repo;
}

function runRelease(box, repo) {
  const env = { ...process.env, GSAM_ROOT: box.root, GSAM_LIVE_URL: "http://127.0.0.1:9", GSAM_LIVE_BOARD_KEY_FILE: join(box.root, "no-key") };
  delete env.GSAM_RELEASE_REPO;
  return spawnSync("bash", [join(repo, "scripts", "greatstone-release.sh"), "rc-2026-09-27.2"], { encoding: "utf8", env });
}

test("greatstone-release.sh refuses a fresh index.lock before the backup and the tag", (t) => {
  const box = sandbox();
  t.after(() => rmSync(box.root, { recursive: true, force: true }));
  const repo = releaseRepo(box);
  const lock = writeLock(box, { mtime: new Date() });
  const run = runRelease(box, repo);
  assert.equal(run.status, 1);
  assert.match(run.stderr, new RegExp(`^release: ${lock} is \\d+s old \\(under 600s\\)`, "m"));
  assert.doesNotMatch(run.stdout, /Backed up|Tagged/);
  assert.equal(existsSync(join(box.root, "backups")), false);
  assert.equal(git(repo, "tag", "-l", "live-*"), "");
  assert.equal(existsSync(lock), true);
});

test("greatstone-release.sh removes a stale empty index.lock before the backup and the tag", (t) => {
  const box = sandbox();
  t.after(() => rmSync(box.root, { recursive: true, force: true }));
  const repo = releaseRepo(box);
  const lock = writeLock(box);
  const run = runRelease(box, repo);
  assert.match(run.stdout, new RegExp(`^Removed a stale ${lock} `, "m"));
  assert.equal(existsSync(lock), false);
  // No origin in the sandbox: it stops at the fetch, still before backup and tag.
  assert.notEqual(run.status, 0);
  assert.doesNotMatch(run.stdout, /Backed up|Tagged/);
  assert.equal(git(repo, "tag", "-l", "live-*"), "");
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

// active_runs: queued runs count unless a task drain holds them. With
// requireKey, the fake acts like login mode: every route but /api/health
// answers 403 unless the request carries that board key (GRE-136).
function fakeLive(draining, requireKey = null) {
  const server = http.createServer((req, res) => {
    if (requireKey && req.url !== "/api/health" && req.headers.authorization !== `Bearer ${requireKey}`) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Board access required" }));
      return;
    }
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
// keyFile defaults to a path that does not exist, so a real ~/GSAM key is never read.
async function activeRuns(url, keyFile = join(tmpdir(), "gre-136-no-such-key")) {
  const { stdout } = await promisify(execFile)("bash", ["-c", `source "${scriptsDir}/greatstone-common.sh"; active_runs "$1"`, "_", url], {
    encoding: "utf8",
    env: { ...process.env, GSAM_LIVE_BOARD_KEY_FILE: keyFile },
  });
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

test("active_runs sends the board key from the key file in login mode", async (t) => {
  const server = await fakeLive(false, "pcp_board_test");
  const dir = mkdtempSync(join(tmpdir(), "gre-136-"));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  const keyFile = join(dir, "release-board-key");
  writeFileSync(keyFile, "pcp_board_test\n", { mode: 0o600 });
  assert.equal(await activeRuns(`http://127.0.0.1:${server.address().port}`, keyFile), "3");
});

test("active_runs fails with the reason when login mode refuses it", async (t) => {
  const server = await fakeLive(false, "pcp_board_test");
  t.after(() => server.close());
  await assert.rejects(activeRuns(`http://127.0.0.1:${server.address().port}`), (err) => {
    assert.match(err.stderr, /GET \/api\/companies answered 403/);
    assert.equal(err.stdout.trim(), "");
    return true;
  });
});

test("live_board_key_check accepts no file and a 0600 file, refuses a 0644 or empty file", () => {
  const dir = mkdtempSync(join(tmpdir(), "gre-136-"));
  try {
    const keyFile = join(dir, "release-board-key");
    const check = () => spawnSync("bash", ["-c", `source "${scriptsDir}/greatstone-common.sh"; live_board_key_check`], {
      encoding: "utf8",
      env: { ...process.env, GSAM_LIVE_BOARD_KEY_FILE: keyFile },
    });
    assert.equal(check().status, 0);
    writeFileSync(keyFile, "pcp_board_test\n", { mode: 0o600 });
    assert.equal(check().status, 0);
    chmodSync(keyFile, 0o644);
    const loose = check();
    assert.equal(loose.status, 1);
    assert.match(loose.stdout, /mode 644; run: chmod 600/);
    writeFileSync(keyFile, "\n");
    chmodSync(keyFile, 0o600);
    assert.match(check().stdout, /is empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A release by hand (GRE-178): John runs scripts/greatstone-release.sh from the
// dev checkout, with no app and no launcher. origin is a bare repo in the
// sandbox; "other" pushes a newer release script the dev checkout has not pulled.
function manualSandbox() {
  const root = mkdtempSync(join(tmpdir(), "gs-manual-release-"));
  const origin = join(root, "origin.git");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  const dev = join(root, "dev");
  git(root, "clone", "--quiet", origin, dev);
  configure(dev);
  mkdirSync(join(dev, "scripts"));
  writeFileSync(join(dev, "scripts", "greatstone-release.sh"), "# v1\n");
  git(dev, "add", "scripts/greatstone-release.sh");
  git(dev, "commit", "--quiet", "-m", "v1");
  git(dev, "tag", "-a", "rc-2026-09-29.1", "-m", RC_MESSAGE);
  git(dev, "push", "--quiet", "origin", "HEAD:main", "rc-2026-09-29.1");
  git(root, "clone", "--quiet", origin, join(root, "live"));
  const release = () =>
    spawnSync("bash", [join(scriptsDir, "greatstone-release.sh"), "rc-2026-09-29.1"], {
      encoding: "utf8",
      env: { ...process.env, GSAM_ROOT: root, GSAM_RELEASE_REPO: dev, GSAM_LIVE_URL: "http://127.0.0.1:9", GSAM_RELEASE_FROM_APP: "" },
    });
  const pushNewerScript = () => {
    const other = join(root, "other");
    git(root, "clone", "--quiet", origin, other);
    configure(other);
    writeFileSync(join(other, "scripts", "greatstone-release.sh"), "# v2: copies the rc notes\n");
    git(other, "commit", "--quiet", "-am", "v2");
    git(other, "push", "--quiet", "origin", "HEAD:main");
  };
  const liveTags = () => git(dev, "tag", "--list", "live-*");
  return { root, dev, release, pushNewerScript, liveTags };
}

test("a release by hand copies the rc title and changelog to the live tag", (t) => {
  const box = manualSandbox();
  t.after(() => rmSync(box.root, { recursive: true, force: true }));
  const commit = git(box.dev, "rev-parse", "rc-2026-09-29.1^{commit}");
  const run = spawnSync("bash", ["-c", `source "${scriptsDir}/greatstone-common.sh"; tag_live_release "$@"`, "_", box.dev, "rc-2026-09-29.1", "live-2026-09-29.1", commit], {
    encoding: "utf8",
    env: { ...process.env, GSAM_ROOT: box.root, GSAM_RELEASE_FROM_APP: "" },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(git(box.dev, "cat-file", "-t", "refs/tags/live-2026-09-29.1"), "tag");
  assert.equal(git(box.dev, "rev-parse", "live-2026-09-29.1^{commit}"), commit);
  assert.equal(git(box.dev, "for-each-ref", "--format=%(contents)", "refs/tags/live-2026-09-29.1"), RC_MESSAGE);
  // greatstone-release.sh makes its live tag with this function, by hand and from the app.
  assert.match(readFileSync(join(scriptsDir, "greatstone-release.sh"), "utf8"), /^\s*tag_live_release "\$RELEASE_REPO" "\$TAG" "\$LIVE_TAG" "\$TARGET"$/m);
});

test("a release by hand refuses release scripts older than origin/main and makes no tag", (t) => {
  const box = manualSandbox();
  t.after(() => rmSync(box.root, { recursive: true, force: true }));
  // Current scripts pass the check and stop at the next one (live is on the rc commit).
  const current = box.release();
  assert.equal(current.status, 1);
  assert.match(current.stderr, /release: live is already on rc-2026-09-29.1/);

  box.pushNewerScript();
  const stale = box.release();
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /release: the release scripts in .*dev are not the ones on origin\/main \(scripts\/greatstone-release.sh\); run: git -C .*dev pull --ff-only origin main/);
  assert.equal(box.liveTags(), "");
  assert.equal(readFileSync(join(box.dev, "scripts", "greatstone-release.sh"), "utf8"), "# v1\n");
});

// GRE-239: a release that fails after it tags must not leave a live-* tag for a
// version that never ran. The real greatstone-release.sh runs from a dev clone
// whose scripts match origin/main; the backup tool is a stub. `pnpm install`
// fails after the live checkout moved (live has no lockfile; where the script
// finds no pnpm of its own, a stub fails).
// An empty workspace: greatstone-common.sh puts its own node (and pnpm) first
// on PATH, so with these files the real `pnpm install` passes offline.
const EMPTY_WORKSPACE = {
  ".gitignore": "node_modules/\n",
  "package.json": '{ "name": "sandbox", "private": true }\n',
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n",
};

// greatstone-release.sh names a new live tag after today's local date.
const pad2 = (n) => String(n).padStart(2, "0");
const TODAY_TAG = (() => { const d = new Date(); return `live-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}.1`; })();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// base: files the old release has; rc: files the rc commit adds on top.
function releaseSandbox(t, pnpmScript, { base = {}, rc = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gs-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  const dev = join(root, "dev");
  git(root, "clone", "--quiet", origin, dev);
  configure(dev);
  mkdirSync(join(dev, "scripts"));
  for (const f of ["greatstone-release.sh", "greatstone-common.sh", "greatstone-live-release.sh", "greatstone-preview.sh"]) {
    copyFileSync(join(scriptsDir, f), join(dev, "scripts", f));
  }
  const addFiles = (files) => {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(dev, path, ".."), { recursive: true });
      writeFileSync(join(dev, path), body);
      git(dev, "add", path);
    }
  };
  git(dev, "add", "scripts");
  addFiles(base);
  git(dev, "commit", "--quiet", "-m", "old");
  git(dev, "tag", "-a", "live-2026-09-01.1", "-m", "Old release");
  addFiles(rc);
  git(dev, "commit", "--quiet", "--allow-empty", "-m", "new");
  git(dev, "tag", "-a", "rc-2026-09-29.1", "-m", RC_MESSAGE);
  git(dev, "push", "--quiet", "origin", "HEAD:main", "live-2026-09-01.1");
  // Not tracked, so the release scripts still match origin/main.
  mkdirSync(join(dev, "cli", "node_modules", "tsx", "dist"), { recursive: true });
  writeFileSync(
    join(dev, "cli", "node_modules", "tsx", "dist", "cli.mjs"),
    `import fs from "node:fs"; const a = process.argv;
fs.appendFileSync(${JSON.stringify(join(root, "gs-db.log"))}, JSON.stringify({ args: a.slice(3), pgpassword: process.env.PGPASSWORD ?? null }) + "\\n");
if (a.includes("restore-legacy-password")) process.exit(0);
const dir = a[a.indexOf("--dir") + 1];
fs.mkdirSync(dir, { recursive: true }); const f = dir + "/" + a[a.indexOf("--prefix") + 1] + ".sql.gz"; fs.writeFileSync(f, "x"); console.log(f);\n`,
  );
  const live = join(root, "live");
  git(root, "clone", "--quiet", origin, live);
  git(live, "checkout", "--quiet", "--detach", "live-2026-09-01.1");
  const db = join(root, "data", "instances", "default", "db");
  mkdirSync(db, { recursive: true });
  writeFileSync(join(db, "postmaster.pid"), `${process.pid}\n/x\n0\n5432\n`);

  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "pnpm"), pnpmScript, { mode: 0o755 });
  const env = (liveUrl) => ({
    ...process.env,
    GSAM_ROOT: root,
    GSAM_RELEASE_REPO: dev,
    GSAM_LIVE_URL: liveUrl,
    GSAM_LIVE_BOARD_KEY_FILE: join(root, "no-key"),
    GSAM_RELEASE_FROM_APP: "1",
    GSAM_RELEASE_POLL_SECONDS: "0.05",
    PATH: `${bin}:${process.env.PATH}`,
  });
  return { root, origin, dev, live, env };
}

test("a release that fails after tagging pushes no live tag and deletes the local one", (t) => {
  const { origin, dev, live, env } = releaseSandbox(t, "#!/bin/sh\necho 'pnpm: install failed' >&2\nexit 1\n");
  const run = spawnSync("bash", [join(dev, "scripts", "greatstone-release.sh"), "rc-2026-09-29.1"], {
    encoding: "utf8",
    env: env("http://127.0.0.1:9"),
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stdout, new RegExp(`^Tagged rc-2026-09-29\\.1 as ${esc(TODAY_TAG)}:`, "m"));
  assert.match(run.stdout, new RegExp(`^Live checkout is on ${esc(TODAY_TAG)} `, "m"));
  assert.match(run.stderr, new RegExp(`Deleted the unpushed tag ${esc(TODAY_TAG)}`));
  assert.equal(git(dev, "tag", "--list", TODAY_TAG), "");
  assert.equal(git(live, "tag", "--list", TODAY_TAG), "");
  assert.equal(git(origin, "tag", "--list", "live-*"), "live-2026-09-01.1");
  assert.equal(git(origin, "tag", "--list", "rc-*"), "");
});

// GRE-839: with several candidates open, releasing one cut before live would
// silently take live back. Live here is on the rc-2026-09-29.1 commit. A check
// that passes stops later, at the failing `pnpm install`.
test("a release refuses a candidate older than live; a newer candidate and a rollback pass", (t) => {
  const { dev, live, env } = releaseSandbox(t, "#!/bin/sh\necho 'pnpm: install failed' >&2\nexit 1\n");
  git(dev, "tag", "-a", "live-2026-09-29.1", "-m", "Current release", "rc-2026-09-29.1^{commit}");
  git(dev, "tag", "-a", "rc-2026-09-28.1", "-m", "Older candidate", "live-2026-09-01.1^{commit}");
  git(dev, "commit", "--quiet", "--allow-empty", "-m", "newer");
  git(dev, "tag", "-a", "rc-2026-09-30.1", "-m", "Newer candidate");
  git(dev, "push", "--quiet", "origin", "HEAD:main", "live-2026-09-29.1");
  git(live, "fetch", "--quiet", "--tags", "origin");
  git(live, "checkout", "--quiet", "--detach", "live-2026-09-29.1");
  const release = (tag) => spawnSync("bash", [join(dev, "scripts", "greatstone-release.sh"), tag], { encoding: "utf8", env: env("http://127.0.0.1:9") });

  const older = release("rc-2026-09-28.1");
  assert.equal(older.status, 1);
  assert.match(older.stderr, /^release: rc-2026-09-28\.1 is older than live \(live-2026-09-29\.1\); to go back, use the rollback form with a live-\* tag\./m);
  assert.doesNotMatch(older.stdout, /Backed up|Tagged/);
  assert.equal(git(live, "describe", "--tags", "--exact-match", "HEAD"), "live-2026-09-29.1");

  const newer = release("rc-2026-09-30.1");
  assert.doesNotMatch(newer.stderr, /older than live/);
  assert.match(newer.stdout, /^Tagged rc-2026-09-30\.1 as /m);

  // The failed install left files in the sandbox live checkout.
  git(live, "clean", "--quiet", "-fdx");
  git(live, "checkout", "--quiet", "--detach", "live-2026-09-29.1");
  const rollback = release("live-2026-09-01.1");
  assert.doesNotMatch(rollback.stderr, /older than live/, rollback.stderr);
  assert.match(rollback.stdout, /^Live checkout is on live-2026-09-01\.1 /m, rollback.stderr);
});

// GRE-930: the live database has a random password. The backup gets it as
// PGPASSWORD (never in a process list), and a rollback to a release from
// before GRE-930 first puts the role back on the old password it uses.
test("a rollback to a release before the random database password restores the old password first", (t) => {
  const { root, dev, live, env } = releaseSandbox(t, "#!/bin/sh\necho 'pnpm: install failed' >&2\nexit 1\n", {
    rc: { "packages/db/src/embedded-postgres-password.ts": "// GRE-930\n" },
  });
  git(dev, "tag", "-a", "live-2026-09-29.1", "-m", "Current release", "rc-2026-09-29.1^{commit}");
  git(dev, "push", "--quiet", "origin", "live-2026-09-29.1");
  git(live, "fetch", "--quiet", "--tags", "origin");
  git(live, "checkout", "--quiet", "--detach", "live-2026-09-29.1");
  const secrets = join(root, "data", "instances", "default", "secrets");
  mkdirSync(secrets, { recursive: true });
  writeFileSync(join(secrets, "embedded-postgres.password"), "random-live-password\n", { mode: 0o600 });
  const calls = () => readFileSync(join(root, "gs-db.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

  const rollback = spawnSync("bash", [join(dev, "scripts", "greatstone-release.sh"), "live-2026-09-01.1"], { encoding: "utf8", env: env("http://127.0.0.1:9") });
  assert.match(rollback.stdout, /^Live checkout is on live-2026-09-01\.1 /m, rollback.stderr);
  const [backup, restore] = calls();
  assert.equal(backup.args[0], "backup");
  assert.equal(backup.pgpassword, "random-live-password");
  assert.doesNotMatch(backup.args.join(" "), /random-live-password/);
  assert.deepEqual(restore.args, ["restore-legacy-password", "--data-dir", join(root, "data", "instances", "default", "db")]);

  // A rollback to a release that has the random password leaves it alone.
  rmSync(join(root, "gs-db.log"));
  git(live, "clean", "--quiet", "-fdx");
  git(live, "checkout", "--quiet", "--detach", "live-2026-09-29.1");
  git(dev, "tag", "-a", "live-2026-09-29.2", "-m", "Same code", "rc-2026-09-29.1^{commit}");
  git(dev, "push", "--quiet", "origin", "live-2026-09-29.2");
  git(live, "checkout", "--quiet", "--detach", "live-2026-09-01.1");
  const forward = spawnSync("bash", [join(dev, "scripts", "greatstone-release.sh"), "live-2026-09-29.2"], { encoding: "utf8", env: env("http://127.0.0.1:9") });
  assert.match(forward.stdout, /^Live checkout is on live-2026-09-29\.2 /m, forward.stderr);
  assert.deepEqual(calls().map((call) => call.args[0]), ["backup"]);
});

// GRE-243: a release of only doc/ (or ui/) changes no file dev-runner watches,
// so the live server answers every restart with restart_not_required. Its
// "commit" follows the live checkout, like the real one.
function fakeRestartNotRequired(live) {
  const seen = { restarts: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/health/dev-server/restart") {
      seen.restarts += 1;
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "restart_not_required" }));
      return;
    }
    if (req.url === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", commit: git(live, "rev-parse", "HEAD"), serverInfo: { processStartedAt: "2026-09-29T08:00:00.000Z" } }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

// Async: the fake server answers from this process.
function runAsync(args, env) {
  return new Promise((resolve) => {
    const child = spawn("bash", args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("a docs-only release and its rollback end healthy with no restart", async (t) => {
  const box = releaseSandbox(t, "#!/bin/sh\nexit 0\n", { base: EMPTY_WORKSPACE, rc: { "doc/NOTES.md": "Only docs change.\n" } });
  const fake = await fakeRestartNotRequired(box.live);
  t.after(() => fake.server.close());
  const script = join(box.dev, "scripts", "greatstone-release.sh");

  const release = await runAsync([script, "rc-2026-09-29.1"], box.env(fake.url));
  assert.equal(release.status, 0, release.stderr);
  assert.match(release.stdout, new RegExp(`^The live server needs no restart: ${esc(TODAY_TAG)} changes no file the server runs from`, "m"));
  assert.match(release.stdout, new RegExp(`^Live app at .* is running ${esc(TODAY_TAG)} `, "m"));
  assert.equal(git(box.live, "rev-parse", "HEAD"), git(box.dev, "rev-parse", "rc-2026-09-29.1^{commit}"));
  // Healthy, so the tags are pushed and History may offer the version.
  assert.equal(git(box.origin, "tag", "--list", TODAY_TAG), TODAY_TAG);
  assert.equal(git(box.origin, "tag", "--list", "rc-*"), "rc-2026-09-29.1");

  // Live serves the dev UI here (no ui/dist), so nothing is built.
  assert.doesNotMatch(release.stdout, /Rebuilt the UI/);

  const rollback = await runAsync([script, "live-2026-09-01.1"], box.env(fake.url));
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.match(rollback.stdout, /^The live server needs no restart: live-2026-09-01.1 /m);
  assert.equal(git(box.live, "rev-parse", "HEAD"), git(box.dev, "rev-parse", "live-2026-09-01.1^{commit}"));
  assert.equal(fake.seen.restarts, 30);
});

test("drop_unpushed_live_tag keeps a live tag origin already has", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gs-drop-tag-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  const dev = join(root, "dev");
  git(root, "clone", "--quiet", origin, dev);
  configure(dev);
  git(dev, "commit", "--quiet", "--allow-empty", "-m", "one");
  git(dev, "tag", "live-2026-09-29.1");
  git(dev, "push", "--quiet", "origin", "HEAD:main", "live-2026-09-29.1");
  git(dev, "tag", "live-2026-09-29.2");
  const drop = (tag) =>
    spawnSync("bash", ["-c", `source "${scriptsDir}/greatstone-common.sh"; drop_unpushed_live_tag "$@"`, "_", dev, join(root, "none"), tag], {
      encoding: "utf8",
      env: { ...process.env, GSAM_ROOT: root },
    });
  assert.equal(drop("live-2026-09-29.1").status, 0);
  assert.equal(drop("live-2026-09-29.2").status, 0);
  assert.equal(git(dev, "tag", "--list", "live-*"), "live-2026-09-29.1");
});

// Live serves the built UI (ui/dist) so a phone over Tailscale can load it. The
// server reads ui/dist from disk, so a UI-only release (no server restart) is
// only live once the release rebuilds it.
const UI_WORKSPACE = {
  ".gitignore": "node_modules/\nui/dist/\n",
  "package.json": '{ "name": "sandbox", "private": true }\n',
  "pnpm-workspace.yaml": "packages:\n  - ui\n",
  "ui/package.json": '{ "name": "@greatstone/ui", "private": true, "scripts": { "build": "node build.mjs" } }\n',
  "ui/build.mjs": 'import fs from "node:fs"; fs.mkdirSync("dist", { recursive: true }); fs.writeFileSync("dist/index.html", "built " + fs.readFileSync("VERSION", "utf8"));\n',
  "ui/VERSION": "old",
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n\n  ui: {}\n",
};

// This fake pnpm runs the UI build the way the real one does, so the test does
// not need a real pnpm. On the Mac, greatstone-common.sh puts
// /opt/homebrew/opt/node@24/bin, with the real pnpm, ahead of the fake. On
// Linux the fake runs, and a fake that only exits 0 never built the UI.
const UI_BUILD_PNPM = '#!/bin/sh\nif [ "$1" = --filter ] && [ "$2" = @greatstone/ui ] && [ "$3" = build ]; then cd ui && exec node build.mjs; fi\nexit 0\n';

test("a UI-only release rebuilds the built UI that live serves", async (t) => {
  const box = releaseSandbox(t, UI_BUILD_PNPM, { base: UI_WORKSPACE, rc: { "ui/VERSION": "new" } });
  mkdirSync(join(box.live, "ui", "dist"), { recursive: true });
  writeFileSync(join(box.live, "ui", "dist", "index.html"), "built old");
  const fake = await fakeRestartNotRequired(box.live);
  t.after(() => fake.server.close());

  const release = await runAsync([join(box.dev, "scripts", "greatstone-release.sh"), "rc-2026-09-29.1"], box.env(fake.url));
  assert.equal(release.status, 0, release.stderr);
  assert.match(release.stdout, /^Rebuilt the UI for live-\d{4}-\d{2}-\d{2}\.1$/m);
  assert.equal(readFileSync(join(box.live, "ui", "dist", "index.html"), "utf8"), "built new");
});

// GRE-442: --full-restart stops all of live and starts it with start-live.sh.
// The fake live is the 2 Oct case on Linux: the runner exits on SIGTERM and
// leaves its server (tsx) and the database running. Each is a real process
// with its working folder in the fake live checkout, as pids_in_dir finds them.
const FAKE_SERVER = `import http from "node:http"; import { execFileSync } from "node:child_process"; import fs from "node:fs";
const root = process.env.GSAM_ROOT; const startedAt = new Date().toISOString();
fs.writeFileSync(root + "/server.pid", String(process.pid));
const server = http.createServer((req, res) => {
  const body = { "/api/health": { status: "ok", commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), serverInfo: { processStartedAt: startedAt } }, "/api/companies": [] }[req.url];
  res.writeHead(body ? 200 : 404, { "content-type": "application/json" }); res.end(JSON.stringify(body ?? {}));
});
server.listen(Number(process.env.FAKE_PORT), "127.0.0.1");
process.on("SIGTERM", () => { fs.appendFileSync(root + "/server-stopped", startedAt + "\\n"); process.exit(0); });
`;

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function fullRestartSandbox(t) {
  const box = releaseSandbox(t, "#!/bin/sh\nexit 0\n", { base: { ...EMPTY_WORKSPACE, "server/VERSION": "old" }, rc: { "server/VERSION": "new" } });
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const serverDir = join(box.live, "server");
  const fakeTsx = join(box.root, "fake", "tsx", "dist", "cli.mjs");
  mkdirSync(join(fakeTsx, ".."), { recursive: true });
  writeFileSync(fakeTsx, FAKE_SERVER);
  const env = { ...box.env(url), GSAM_RELEASE_FROM_APP: "", FAKE_PORT: String(port) };
  const pids = [];
  const start = (args) => { const p = spawn(args[0], args.slice(1), { cwd: serverDir, env, detached: true, stdio: "ignore" }); p.unref(); pids.push(p.pid); return p.pid; };
  // releaseSandbox removes box.root in an earlier after hook, so server.pid is
  // gone by now; find the server start-live.sh started by its unique path.
  t.after(() => {
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
    spawnSync("pkill", ["-KILL", "-f", fakeTsx]);
  });
  const runner = start(["node", "-e", "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);", "dev-runner.ts", "dev"]);
  start(["node", fakeTsx, "src/index.ts"]);
  const db = start(["sleep", "600"]);
  writeFileSync(join(box.root, "data", "instances", "default", "db", "postmaster.pid"), `${db}\n/x\n0\n5432\n`);
  writeFileSync(join(box.root, "start-live.sh"), `#!/bin/sh\necho started >> "$GSAM_ROOT/start-live.log"\nread -r stat < /proc/$$/stat\necho "$$ $stat" > "$GSAM_ROOT/start-live.session"\ncd "$GSAM_ROOT/live/server" && nohup node "${fakeTsx}" src/index.ts >/dev/null 2>&1 &\n`, { mode: 0o755 });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${url}/api/health`); break; } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  return { ...box, env, url, runner, db };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// "<pid> <contents of /proc/<pid>/stat>" as the fake start-live.sh writes it.
function startLiveSession(file) {
  const line = readFileSync(file, "utf8").trim();
  const pid = Number(line.slice(0, line.indexOf(" ")));
  const [, , , sid] = line.slice(line.lastIndexOf(")") + 2).split(" ");
  return { pid, sid: Number(sid) };
}

test("--full-restart stops the runner, the server it leaves and the database, then starts live on the new tag", { skip: process.platform !== "linux" && "reads /proc" }, async (t) => {
  const box = await fullRestartSandbox(t);
  const release = await runAsync([join(box.dev, "scripts", "greatstone-release.sh"), "--full-restart", "rc-2026-09-29.1"], box.env);
  assert.equal(release.status, 0, release.stdout + release.stderr);
  assert.match(release.stdout, /^Stopping the live dev runner \(pid \d+\)/m);
  assert.match(release.stdout, /^Stopping the live server left by the runner \(tsx pid \d+\)/m);
  assert.match(release.stdout, /^Stopping the live database \(pid \d+\)/m);
  assert.match(release.stdout, /^Live is stopped:/m);
  assert.match(release.stdout, /^Started the live server$/m);
  assert.match(release.stdout, new RegExp(`^Live app at .* is running ${esc(TODAY_TAG)} `, "m"));
  assert.match(release.stdout, /^Roll back with: scripts\/greatstone-release\.sh --full-restart live-2026-09-01\.1$/m);
  assert.doesNotMatch(release.stdout, /Asked the live server to restart/);
  // The old server got SIGTERM (so it could write its snapshot); nothing old is left.
  assert.equal(readFileSync(join(box.root, "server-stopped"), "utf8").trim().split("\n").length, 1);
  assert.equal(alive(box.runner), false);
  assert.equal(alive(box.db), false);
  assert.equal(readFileSync(join(box.root, "start-live.log"), "utf8"), "started\n");
  // start-live.sh led a session of its own, so the end of the session that ran
  // the release cannot hang up the live server it started (3 Oct 2026).
  const session = startLiveSession(join(box.root, "start-live.session"));
  assert.equal(session.sid, session.pid);
  assert.equal(git(box.origin, "tag", "--list", TODAY_TAG), TODAY_TAG);
});

test("--full-restart still fails with the rollback hint when start-live.sh fails", { skip: process.platform !== "linux" && "reads /proc" }, async (t) => {
  const box = await fullRestartSandbox(t);
  writeFileSync(join(box.root, "start-live.sh"), '#!/bin/sh\necho started >> "$GSAM_ROOT/start-live.log"\nexit 3\n', { mode: 0o755 });
  const release = await runAsync([join(box.dev, "scripts", "greatstone-release.sh"), "--full-restart", "rc-2026-09-29.1"], box.env);
  assert.notEqual(release.status, 0);
  assert.match(release.stderr, /^release: the live server did not start on live-\d{4}-\d{2}-\d{2}\.1; see ~\/GSAM\/logs\/live\.log\. Roll back with: scripts\/greatstone-release\.sh --full-restart live-2026-09-01\.1$/m);
  assert.doesNotMatch(release.stdout, /^Started the live server$/m);
  assert.equal(readFileSync(join(box.root, "start-live.log"), "utf8"), "started\n");
});

// start_live_server on its own: a session of its own where setsid exists, and a
// direct call where it does not (macOS). Either way the exit status of
// start-live.sh comes back, so the release can die with the rollback hint.
test("start_live_server gives start-live.sh its own session and keeps its exit status, with or without setsid", { skip: process.platform !== "linux" && "reads /proc" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "gs-start-live-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Builtins only, so it also runs with PATH emptied below.
  writeFileSync(join(root, "start-live.sh"), '#!/bin/sh\nread -r stat < /proc/$$/stat\necho "$$ $stat" > "$GSAM_ROOT/start-live.session"\nexit 3\n', { mode: 0o755 });
  const run = (pathOverride) => spawnSync("bash", ["-c", `source "${scriptsDir}/greatstone-common.sh"; ${pathOverride}start_live_server`], {
    encoding: "utf8",
    env: { ...process.env, GSAM_ROOT: root },
  });

  const withSetsid = run("");
  assert.equal(withSetsid.status, 3, withSetsid.stderr);
  const own = startLiveSession(join(root, "start-live.session"));
  assert.equal(own.sid, own.pid);

  const withoutSetsid = run("PATH=/nonexistent; ");
  assert.equal(withoutSetsid.status, 3, withoutSetsid.stderr);
  const shared = startLiveSession(join(root, "start-live.session"));
  assert.notEqual(shared.sid, shared.pid);
});

test("--full-restart refuses to run from the app before anything moves", (t) => {
  const box = releaseSandbox(t, "#!/bin/sh\nexit 0\n", { base: EMPTY_WORKSPACE });
  const run = spawnSync("bash", [join(box.dev, "scripts", "greatstone-release.sh"), "--full-restart", "rc-2026-09-29.1"], {
    encoding: "utf8",
    env: box.env("http://127.0.0.1:9"),
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /--full-restart stops the live server, so it cannot run from the app/);
  assert.equal(git(box.dev, "tag", "--list", "live-*"), "live-2026-09-01.1");
  assert.equal(git(box.live, "describe", "--tags"), "live-2026-09-01.1");
});
