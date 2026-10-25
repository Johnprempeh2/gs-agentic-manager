// Tests for scripts/greatstone-release-queue.mjs, the release queue. Each test
// has its own GSAM_ROOT, a dev repo with a local bare origin, a fake live
// server (the task drain and the run counts) and stub step scripts that record
// what the worker asked for, so no real gate, preview or release runs.
//
//   node --test scripts/greatstone-release-queue.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { coveringItem, nextBatch, proposeTitle, refProblem, releasingItem } from "./greatstone-release-queue.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const queueScript = join(scriptsDir, "greatstone-release-queue.mjs");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// The step scripts the worker calls, as stubs. Each appends one line to $CALLS.
const STUBS = {
  // The GitHub gate: $GH_GATE lists "<commit> <exit code>" lines (default 0 = passed).
  "greatstone-github-gate.mjs": `import { appendFileSync, existsSync, readFileSync } from "node:fs";
const [sha, ...rest] = process.argv.slice(2);
const json = rest.includes("--json");
if (!json) appendFileSync(process.env.CALLS, \`github \${sha}\\n\`);
const line = existsSync(process.env.GH_GATE) ? readFileSync(process.env.GH_GATE, "utf8").split("\\n").find((l) => l.startsWith(sha)) : null;
const code = line ? Number(line.split(" ")[1]) : 0;
const seconds = existsSync(process.env.GH_GATE_SECONDS) ? Number(readFileSync(process.env.GH_GATE_SECONDS, "utf8")) : 0;
await new Promise((r) => setTimeout(r, seconds * 1000));
const state = ["passed", "failed", "pending", "unreachable"][code];
const message = { passed: "GitHub: the full test matrix passed on " + sha.slice(0, 9), failed: "GitHub: Fork CI failed on " + sha.slice(0, 9) + ": Tests (server 3/6) (failure)", pending: "GitHub: Fork CI is still running", unreachable: "GitHub could not be asked: offline" }[state];
console.log(json ? JSON.stringify({ state, message, names: state === "failed" ? ["Tests (server 3/6) (failure)"] : [] }) : message);
process.exit(code);
`,
  "greatstone-test-gate.sh": `#!/usr/bin/env bash
echo "gate $1 yield=\${GSAM_TEST_GATE_YIELD:-0}" >>"$CALLS"
trap 'echo "gate-stopped $1" >>"$CALLS"; echo "test-gate: stopped by SIGTERM"; exit 143' TERM
sleep "$(cat "$GATE_SECONDS_FILE" 2>/dev/null || echo "\${GATE_SECONDS:-0}")" & wait $!
if grep -qx "$1" "$FAIL_COMMITS" 2>/dev/null; then
  printf 'FAILED: 1 of 13 lanes failed on %s (%s) after 0m1s:\\n  server-3 (log: x)\\n    FAIL  src/a.test.ts > adds up\\nNo pass marker was written\\n' "$1" "$1"
  exit 1
fi
mkdir -p "$GSAM_TEST_GATE_DIR/passed" && echo "commit=$1" >"$GSAM_TEST_GATE_DIR/passed/$1"
echo "PASSED"
`,
  "greatstone-candidate.mjs": `import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const a = process.argv.slice(2);
const ref = a[a.indexOf("--ref") + 1];
if (a.includes("--print")) {
  console.log(JSON.stringify({ changes: [{ kind: "fix", line: "Fix the clock (#2, GRE-2)" }, { kind: "feature", line: "Add a queue (#1, GRE-1)" }] }));
} else {
  appendFileSync(process.env.CALLS, \`candidate \${a[0]} \${ref} \${a[a.indexOf("--title") + 1]}\\n\`);
  execFileSync("git", ["tag", "-a", a[0], ref, "-m", "t"]);
}
`,
  "greatstone-preview.sh": `#!/usr/bin/env bash
echo "preview $*" >>"$CALLS"
echo "$1 item=\${GSAM_RELEASE_QUEUE_ITEM:-} run=\${GSAM_RUN_ID:-}" >>"$CALLS.preview-env"
[ "$1" != switch-tests ] || [ -z "\${SWITCH_FAIL:-}" ] || { echo "preview: switch test failed"; exit 1; }
`,
  "greatstone-release.sh": `#!/usr/bin/env bash
owner="$(sed -n 's/^pid=//p' "$GSAM_ROOT/locks/release.lock/owner" 2>/dev/null)"
echo "release $* draining=$(curl -s "$GSAM_LIVE_URL/api/instance/task-drain" | sed 's/.*"draining":\\([a-z]*\\).*/\\1/') lock=$([ "$owner" = "$PPID" ] && echo parent || echo "\${owner:-none}") inherited=\${GSAM_RELEASE_LOCK_INHERITED:-0}" >>"$CALLS"
if [ -n "\${RELEASE_FAIL:-}" ]; then echo "release: the live app did not report it"; exit 1; fi
echo "Tagged \${@: -1} as live-2026-10-18.9: title"
echo "Roll back with: scripts/greatstone-release.sh live-2026-10-18.8"
echo "Database backup from before this release: /backups/before.sql.gz"
`,
};

// liveRuns(fake): the queued and running runs live reports on each poll (by default `running()` runs with no task).
// The worker reads them from heartbeat-runs, where issueId sits in contextSnapshot.
async function sandbox(t, { running = () => 0, liveRuns = null, issues = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gs-release-queue-"));
  const origin = join(root, "origin.git");
  const dev = join(root, "dev");
  const live = join(root, "live");
  const stubs = join(root, "stubs");
  mkdirSync(stubs);
  for (const [name, body] of Object.entries(STUBS)) writeFileSync(join(stubs, name), body, { mode: 0o755 });
  copyFileSync(join(scriptsDir, "greatstone-common.sh"), join(stubs, "greatstone-common.sh"));
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  git(root, "clone", "--quiet", origin, dev);
  for (const [k, v] of [["user.name", "Test"], ["user.email", "test@example.com"]]) git(dev, "config", k, v);
  const commit = (msg) => {
    git(dev, "commit", "--quiet", "--allow-empty", "-m", msg);
    git(dev, "push", "--quiet", "origin", "HEAD:main");
    return git(dev, "rev-parse", "HEAD");
  };
  const first = commit("first");
  git(root, "clone", "--quiet", origin, live);
  // Another clone pushes to main, as a merge on GitHub does.
  const other = join(root, "other");
  git(root, "clone", "--quiet", origin, other);
  for (const [k, v] of [["user.name", "Test"], ["user.email", "test@example.com"]]) git(other, "config", k, v);
  // By default a merge changes a migration, so the release needs the preview.
  const merge = (msg, files = { "packages/db/src/migrations/0001_sandbox.sql": `-- ${msg}\n` }) => {
    git(other, "pull", "--quiet", "--ff-only", "origin", "main");
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(other, path, ".."), { recursive: true });
      writeFileSync(join(other, path), body);
      git(other, "add", path);
    }
    git(other, "commit", "--quiet", "--allow-empty", "-m", msg);
    git(other, "push", "--quiet", "origin", "HEAD:main");
    return git(other, "rev-parse", "HEAD");
  };

  // `calls` records what the worker asked of live, with whether runs were held at the time.
  const fake = { draining: false, events: [], running, issues, cancelled: new Set(), calls: [] };
  const defaultRuns = () => Array.from({ length: fake.running() }, (_, i) => ({ id: `r${i}`, status: "running", agentId: "a1", agentName: "Ann", issueId: null }));
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const send = (v, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(v)); };
    const record = (what, extra = {}) => fake.calls.push({ what, draining: fake.draining, ...extra });
    let m;
    if (req.url === "/api/health") return send({ status: "ok" });
    if (req.url === "/api/instance/task-drain") {
      if (req.method === "POST") { fake.draining = true; fake.events.push("drain"); }
      if (req.method === "DELETE") { fake.draining = false; fake.events.push("lift"); }
      return send({ draining: fake.draining });
    }
    if (req.url === "/api/companies") return send([{ id: "c1" }]);
    // The worker asks for running and queued runs; active_runs in greatstone-common.sh (the
    // worker before GRE-2274) asks for all. A cancelled run is gone, unless it is `slow` to stop.
    if (req.url.startsWith("/api/companies/c1/heartbeat-runs")) {
      const statuses = new URL(req.url, "http://x").searchParams.get("status")?.split(",") ?? null;
      return send((liveRuns ? liveRuns(fake) : defaultRuns())
        .filter((r) => (r.slow || !fake.cancelled.has(r.id)) && (!statuses || statuses.includes(r.status)))
        .map(({ issueId, ...r }) => ({ ...r, contextSnapshot: issueId ? { issueId } : null })));
    }
    if ((m = /^\/api\/heartbeat-runs\/([^/]+)\/cancel$/.exec(req.url)) && req.method === "POST") {
      fake.cancelled.add(m[1]);
      record("cancel", { runId: m[1] });
      return send({ id: m[1], status: "cancelled" });
    }
    if ((m = /^\/api\/issues\/([^/]+)$/.exec(req.url)) && req.method === "GET") {
      return fake.issues[m[1]] ? send({ id: m[1], ...fake.issues[m[1]] }) : send({ error: "not found" }, 404);
    }
    if ((m = /^\/api\/issues\/([^/]+)\/comments$/.exec(req.url)) && req.method === "POST") {
      record("comment", { issueId: m[1], body });
      return send({ id: `comment-${fake.calls.length}` }, 201);
    }
    if ((m = /^\/api\/agents\/([^/]+)\/wakeup$/.exec(req.url)) && req.method === "POST") {
      record("wake", { agentId: m[1], body });
      return send({ id: `run-${fake.calls.length}` });
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.close(); rmSync(root, { recursive: true, force: true }); });

  const calls = join(root, "calls.txt");
  const env = (extra = {}) => {
    const { GSAM_RUN_ID: _r, BASH_ENV: _b, ...rest } = process.env;
    return {
      ...rest,
      GSAM_ROOT: root,
      GSAM_RELEASE_REPO: dev,
      GSAM_RELEASE_QUEUE_SCRIPTS_DIR: stubs,
      GSAM_LIVE_DIR: live,
      GSAM_LIVE_URL: `http://127.0.0.1:${server.address().port}`,
      GSAM_TEST_GATE_DIR: join(root, "test-gate"),
      GSAM_RELEASE_QUEUE_POLL_SECONDS: "0.2",
      GSAM_RELEASE_QUEUE_NICE: "0",
      CALLS: calls,
      FAIL_COMMITS: join(root, "fail-commits"),
      GATE_SECONDS_FILE: join(root, "gate-seconds"),
      GH_GATE: join(root, "gh-gate"),
      GH_GATE_SECONDS: join(root, "gh-gate-seconds"),
      ...extra,
    };
  };
  const cli = (args, extra) => spawnSync(process.execPath, [queueScript, ...args], { cwd: dev, encoding: "utf8", env: env(extra) });
  const worker = (extra) => {
    const child = spawn(process.execPath, [queueScript, "work"], { cwd: dev, env: env(extra), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    return { child, done: new Promise((r) => child.on("exit", (code) => r({ code, out }))) };
  };
  const state = () => JSON.parse(readFileSync(join(root, "release-queue", "queue.json"), "utf8"));
  const callLines = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : []);
  const pass = (sha) => { mkdirSync(join(root, "test-gate", "passed"), { recursive: true }); writeFileSync(join(root, "test-gate", "passed", sha), `commit=${sha}\n`); };
  return { root, dev, live, first, commit, merge, fake, cli, worker, state, callLines, pass, env };
}

const waitFor = async (what, check, ms = 20_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const enqueue = (box, ...args) => JSON.parse(box.cli(["enqueue", ...args, "--json"]).stdout).item;

test("nextBatch: the first open request, plus the main requests waiting right behind it", () => {
  const i = (id, ref, status = "queued") => ({ id, ref, status });
  assert.equal(nextBatch([]), null);
  const batch = nextBatch([i("a", "main", "released"), i("b", "main"), i("c", "main"), i("d", "rc-2026-10-18.1"), i("e", "main")]);
  assert.deepEqual([batch.head.id, batch.merged.map((x) => x.id)], ["b", ["c"]]);
  assert.deepEqual(nextBatch([i("d", "rc-2026-10-18.1"), i("e", "main")]).merged, []);
  // A request the worker had started stays first.
  assert.equal(nextBatch([i("b", "main"), i("r", "abc1234", "running")]).head.id, "r");
  assert.equal(refProblem("main"), null);
  assert.match(refProblem("feature/x; rm -rf /"), /not something the queue can release/);
  assert.equal(proposeTitle([{ kind: "fix", line: "Fix a (#2)" }, { kind: "feature", line: "Add b (#1)" }]), "Add b; Fix a");
});

test("requests run in order, main requests collapse into one release of the newest main, and the state survives", async (t) => {
  const box = await sandbox(t);
  // An rc tag that already passed the gate, then three requests for main.
  const tagged = box.merge("tagged");
  git(box.dev, "fetch", "--quiet", "origin");
  git(box.dev, "tag", "-a", "rc-2026-10-18.1", tagged, "-m", "Tagged one");
  const rc = enqueue(box, "rc-2026-10-18.1");
  const m1 = enqueue(box, "main", "First title");
  box.merge("later");
  const m2 = enqueue(box, "main");
  const m3 = enqueue(box, "main", "Newest title");
  const newest = box.merge("newest");
  // Persistence: another process reads the queue back.
  const status = JSON.parse(box.cli(["status", "--json"]).stdout);
  assert.deepEqual(status.queued.map((i) => i.id), [rc.id, m1.id, m2.id, m3.id]);

  const { code, out } = await box.worker().done;
  assert.equal(code, 0, out);
  const calls = box.callLines();
  // The gate is GitHub's: no test runs on the PC.
  assert.equal(calls.filter((c) => c.startsWith("gate ")).length, 0, calls.join("\n"));
  assert.deepEqual(calls.filter((c) => c.startsWith("github ")), [`github ${tagged}`, `github ${newest}`]);
  const releases = calls.filter((c) => c.startsWith("release "));
  assert.equal(releases.length, 2, calls.join("\n"));
  // The rc tag first, then one release for the three main requests, of the
  // newest main, named by the newest title.
  assert.match(releases[0], /^release rc-2026-10-18\.1 /);
  const cut = calls.find((c) => c.startsWith("candidate "));
  assert.match(cut, new RegExp(`^candidate rc-\\d{4}-\\d\\d-\\d\\d\\.\\d+ ${newest} Newest title$`));
  assert.ok(calls.indexOf("preview switch-tests") < calls.indexOf(releases[1]));
  const byId = Object.fromEntries(box.state().items.map((i) => [i.id, i]));
  assert.equal(byId[rc.id].status, "released");
  assert.equal(byId[m1.id].status, "released");
  assert.equal(byId[m1.id].commit, newest);
  assert.equal(byId[m1.id].rollback, "scripts/greatstone-release.sh live-2026-10-18.8");
  assert.equal(byId[m1.id].liveTag, "live-2026-10-18.9");
  assert.deepEqual([byId[m2.id].status, byId[m2.id].mergedInto], ["merged", m1.id]);
  assert.deepEqual([byId[m3.id].status, byId[m3.id].mergedInto], ["merged", m1.id]);
  assert.equal(box.state().main.status, "passed");
});

test("cancel: a queued request at once; a running one before its next step, and its GitHub wait stops", async (t) => {
  const box = await sandbox(t);
  box.merge("change");
  const a = enqueue(box, "main", "Will run");
  const b = enqueue(box, "abc1234");
  const cancelled = box.cli(["cancel", b.id, "--json", "--by", "user:john"]);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(box.state().items.find((i) => i.id === b.id).status, "cancelled");
  assert.match(box.cli(["cancel", b.id]).stderr, /already cancelled/);

  // GitHub's Fork CI is still running: the request waits on it.
  writeFileSync(join(box.root, "gh-gate-seconds"), "60");
  const w = box.worker();
  await waitFor("the GitHub check to start", () => box.callLines().some((c) => c.startsWith("github ")));
  assert.equal(box.state().items.find((i) => i.id === a.id).step, "gate");
  assert.equal(box.cli(["cancel", a.id]).status, 0);
  writeFileSync(join(box.root, "gh-gate-seconds"), "0");
  const { code, out } = await w.done;
  assert.equal(code, 0, out);
  const item = box.state().items.find((i) => i.id === a.id);
  assert.equal(item.status, "cancelled", JSON.stringify(item));
  const calls = box.callLines();
  assert.ok(!calls.some((c) => c.startsWith("release ") || c.startsWith("candidate ") || c.startsWith("gate ")), calls.join("\n"));
});

test("only one worker runs; a request left running by a stopped worker starts again, or fails after the release began", async (t) => {
  const box = await sandbox(t);
  // The worker lock held by a live process: a second worker leaves at once.
  mkdirSync(join(box.root, "locks", "release-queue-worker.lock"), { recursive: true });
  writeFileSync(join(box.root, "locks", "release-queue-worker.lock", "owner"), `pid=${process.pid}\n`);
  const a = enqueue(box, "main", "Change");
  box.merge("change");
  assert.equal((await box.worker().done).code, 0);
  assert.equal(box.callLines().length, 0, "the busy worker did nothing");
  rmSync(join(box.root, "locks", "release-queue-worker.lock"), { recursive: true });

  // Stopped during its gate: it runs again. Stopped while releasing: failed, for a person to check.
  const s = box.state();
  s.items[0] = { ...s.items[0], status: "running", step: "gate" };
  s.items.push({ ...s.items[0], id: "rq-dead00", status: "running", step: "releasing" });
  writeFileSync(join(box.root, "release-queue", "queue.json"), JSON.stringify(s));
  assert.equal((await box.worker().done).code, 0);
  const byId = Object.fromEntries(box.state().items.map((i) => [i.id, i]));
  assert.equal(byId[a.id].status, "released");
  assert.equal(byId["rq-dead00"].status, "failed");
  assert.match(byId["rq-dead00"].reason, /the worker stopped during releasing; check live/);
});

test("with nothing queued it runs no tests and records what GitHub says about main", async (t) => {
  const box = await sandbox(t);
  const head = box.merge("change");
  writeFileSync(join(box.root, "gh-gate"), `${head} 1\n`);
  assert.equal((await box.worker().done).code, 0);
  assert.deepEqual(box.callLines(), [], "no PC gate, no release");
  const main = box.state().main;
  assert.deepEqual([main.commit, main.status, main.source], [head, "failing", "github"]);
  assert.deepEqual(main.summary, ["Tests (server 3/6) (failure)"]);
  writeFileSync(join(box.root, "gh-gate"), "");
  assert.equal((await box.worker().done).code, 0);
  assert.equal(box.state().main.status, "passed");
});

test("GitHub red refuses with the failing jobs; GitHub out of reach fails without touching the PC; --pc-gate asks for it", async (t) => {
  const box = await sandbox(t);
  const red = box.merge("red");
  writeFileSync(join(box.root, "gh-gate"), `${red} 1\n`);
  const a = enqueue(box, "main", "Red");
  assert.equal((await box.worker().done).code, 0);
  let item = box.state().items.find((i) => i.id === a.id);
  assert.equal(item.status, "failed");
  assert.match(item.reason, /^GitHub: Fork CI failed on [0-9a-f]{9}: Tests \(server 3\/6\) \(failure\)$/);
  assert.ok(!box.callLines().some((c) => c.startsWith("gate ") || c.startsWith("release ")));

  const offline = box.merge("offline");
  writeFileSync(join(box.root, "gh-gate"), `${offline} 3\n`);
  const b = enqueue(box, "main", "Offline");
  assert.equal((await box.worker().done).code, 0);
  item = box.state().items.find((i) => i.id === b.id);
  assert.equal(item.status, "failed", JSON.stringify(item));
  assert.match(item.reason, /GitHub could not be asked, so nothing was released/);
  const calls = box.callLines();
  // Never the PC suite on its own (18 Oct: three PC test runs at once corrupted the WSL disk).
  assert.ok(!calls.includes(`gate ${offline} yield=0`), calls.join("\n"));
  assert.ok(!calls.some((c) => c.startsWith("release ")), "no release without a gate");

  const pcAsked = box.merge("pc asked");
  writeFileSync(join(box.root, "gh-gate"), "");
  const cli = box.cli(["enqueue", "--pc-gate", "--json", "--", "main", "On the PC"]);
  assert.equal(JSON.parse(cli.stdout).item.pcGate, true);
  assert.equal((await box.worker().done).code, 0);
  assert.ok(box.callLines().includes(`gate ${pcAsked} yield=0`));
  assert.ok(!box.callLines().includes(`github ${pcAsked}`));
});

test("a GitHub check still running at the cap fails the request without releasing", async (t) => {
  const box = await sandbox(t);
  const head = box.merge("slow");
  writeFileSync(join(box.root, "gh-gate"), `${head} 2\n`);
  enqueue(box, "main", "Slow");
  assert.equal((await box.worker({ GSAM_GITHUB_GATE_WAIT_SECONDS: "60" }).done).code, 0);
  const item = box.state().items[0];
  assert.equal(item.status, "failed");
  assert.match(item.reason, /still running after 1 min of waiting$/);
});

test("drain: new runs are held while running runs finish, the release runs drained, and runs resume even when it fails", async (t) => {
  let polls = 0;
  const box = await sandbox(t, { running: () => (polls++ < 2 ? 1 : 0) });
  box.merge("change");
  enqueue(box, "main", "Change");
  const { code, out } = await box.worker({ RELEASE_FAIL: "1" }).done;
  assert.equal(code, 0, out);
  const release = box.callLines().find((c) => c.startsWith("release "));
  assert.match(release, /draining=true /, "the release ran with new runs held");
  // The worker holds the release lock for the release script, which inherits it.
  assert.match(release, / lock=parent inherited=1$/);
  assert.equal(existsSync(join(box.root, "locks", "release.lock")), false, "the lock is freed after a failed release");
  assert.deepEqual(box.fake.events, ["drain", "lift"]);
  assert.equal(box.fake.draining, false, "agent runs are back on after the failed release");
  const item = box.state().items[0];
  assert.equal(item.status, "failed");
  assert.match(item.reason, /the live app did not report it/);
});

// GRE-2274 (24 Oct): the drain lifted between tries, new runs started in the
// gap, and four releases stalled. Now runs stay held for the whole window; a run
// that does not finish is asked to stop, then cancelled; and every stopped or
// held task is woken again with a comment once runs are back on.
test("drain: with runs that keep arriving and runs that never finish, it still releases, and wakes every paused task", async (t) => {
  let arrivals = 0;
  const arrived = [];
  const box = await sandbox(t, {
    issues: {
      i1: { identifier: "GRE-1", status: "in_progress", assigneeAgentId: "keystone" },
      i2: { identifier: "GRE-2", status: "in_review", assigneeAgentId: "ridge" },
      i3: { identifier: "GRE-3", status: "todo", assigneeAgentId: "summit" },
      i4: { identifier: "GRE-4", status: "done", assigneeAgentId: "flint" },
    },
    liveRuns: (fake) => {
      // A new wake on every poll: held as a queued run while runs are paused, else it starts.
      arrivals += 1;
      arrived.push({ id: `new${arrivals}`, status: fake.draining ? "queued" : "running", agentId: "summit", agentName: "Summit", issueId: "i3" });
      return [
        // Neither finishes on its own: Keystone works on its task, Flint reviews Ridge's.
        { id: "stuck", status: "running", agentId: "keystone", agentName: "Keystone", issueId: "i1" },
        { id: "review", status: "running", agentId: "flint", agentName: "Flint", issueId: "i2" },
        { id: "late", status: "queued", agentId: "flint", agentName: "Flint", issueId: "i4" },
        ...arrived,
      ];
    },
  });
  box.merge("change");
  enqueue(box, "main", "Change");
  // The old settings too, so the worker from before GRE-2274 fails here as it did on live (it lifted the pause between tries).
  const { code, out } = await box.worker({
    GSAM_RELEASE_DRAIN_GRACE_SECONDS: "0.4",
    GSAM_RELEASE_DRAIN_STOP_SECONDS: "0.4",
    GSAM_RELEASE_DRAIN_CAP_SECONDS: "0.4",
    GSAM_RELEASE_DRAIN_RETRY_SECONDS: "0.2",
    GSAM_RELEASE_DRAIN_ATTEMPTS: "2",
  }).done;
  assert.equal(code, 0, out);

  // Paused once, for the whole window, and released with runs paused.
  assert.deepEqual(box.fake.events, ["drain", "lift"]);
  assert.match(box.callLines().find((c) => c.startsWith("release ")), /draining=true /);
  assert.ok(arrived.every((r) => r.status === "queued"), "no new run started during the drain");
  const item = box.state().items[0];
  assert.equal(item.status, "released", item.reason);

  const calls = box.fake.calls;
  const comments = (issueId) => calls.filter((c) => c.what === "comment" && c.issueId === issueId);
  // The assignee's run is asked on its task to save its work, while runs are held; the reviewer's is not (that would wake Ridge).
  const ask = comments("i1")[0];
  assert.match(ask.body.body, /^Release rc-\S+ is waiting for this run\. Please save your work/);
  assert.equal(ask.draining, true);
  assert.equal(comments("i2").filter((c) => c.draining).length, 0);
  // Then both are cancelled, and recorded with their task.
  assert.deepEqual(calls.filter((c) => c.what === "cancel").map((c) => c.runId).sort(), ["review", "stuck"]);
  assert.ok(calls.indexOf(ask) < calls.findIndex((c) => c.what === "cancel"));
  const paused = Object.fromEntries(item.paused.map((p) => [p.runId, p]));
  assert.deepEqual([paused.stuck.how, paused.stuck.issueId, paused.review.how, paused.review.issueId], ["stopped", "i1", "stopped", "i2"]);

  // After the switch, with runs back on, every paused task is woken, once.
  const after = calls.filter((c) => !c.draining);
  const resumed = (issueId) => after.filter((c) => c.what === "comment" && c.issueId === issueId);
  assert.equal(resumed("i1").length, 1);
  assert.deepEqual(resumed("i1")[0].body, { body: "Paused for release live-2026-10-18.9; resuming.", resume: true });
  // The reviewer: a comment on the task, and a wake for the reviewer itself.
  assert.deepEqual(resumed("i2").map((c) => c.body), [{ body: "Paused for release live-2026-10-18.9; resuming." }]);
  const wake = after.find((c) => c.what === "wake");
  assert.equal(wake.agentId, "flint");
  assert.deepEqual(wake.body.payload, { issueId: "i2", taskId: "i2", resumeIntent: true, interruptedRunId: "review" });
  assert.equal(wake.body.idempotencyKey, "release-resume:review");
  // The held wakes on GRE-3 (its assignee's): one comment for the task, not one per wake.
  assert.equal(resumed("i3").length, 1);
  assert.equal(resumed("i3")[0].body.resume, undefined);
  // A held run on a finished task: nothing to say.
  assert.equal(resumed("i4").length, 0);
  assert.ok(item.paused.every((p) => p.resumedAt), JSON.stringify(item.paused));
  assert.ok(calls.filter((c) => c.what === "comment" || c.what === "wake").length === 5, JSON.stringify(calls));
});

test("drain: a request cancelled while it drains lifts the pause and still wakes the task it stopped", async (t) => {
  const box = await sandbox(t, {
    issues: { i1: { identifier: "GRE-1", status: "in_progress", assigneeAgentId: "keystone" } },
    liveRuns: () => [{ id: "stuck", status: "running", agentId: "keystone", agentName: "Keystone", issueId: "i1", slow: true }],
  });
  box.merge("change");
  const a = enqueue(box, "main", "Change");
  const w = box.worker({ GSAM_RELEASE_DRAIN_GRACE_SECONDS: "0", GSAM_RELEASE_DRAIN_STOP_SECONDS: "0" });
  await waitFor("the run to be stopped", () => box.fake.calls.some((c) => c.what === "cancel"));
  assert.equal(box.cli(["cancel", a.id]).status, 0);
  const { code, out } = await w.done;
  assert.equal(code, 0, out);
  const item = box.state().items[0];
  assert.equal(item.status, "cancelled", JSON.stringify(item));
  assert.deepEqual(box.fake.events, ["drain", "lift"]);
  assert.ok(!box.callLines().some((c) => c.startsWith("release ")));
  const resumed = box.fake.calls.filter((c) => c.what === "comment" && !c.draining);
  assert.equal(resumed.length, 1);
  assert.match(resumed[0].body.body, /^Paused for release rc-\S+; resuming\.$/);
});

test("a failed switch test stops the request before any run is held, and the cut tag is deleted", async (t) => {
  const box = await sandbox(t);
  box.merge("change");
  enqueue(box, "main", "Change");
  assert.equal((await box.worker({ SWITCH_FAIL: "1" }).done).code, 0);
  const item = box.state().items[0];
  assert.equal(item.status, "failed");
  assert.match(item.reason, /switch tests failed/);
  assert.deepEqual(box.fake.events, []);
  assert.equal(git(box.dev, "tag", "--list", item.tag), "");
});

test("enqueue refuses a ref it cannot release and a placeholder title", async (t) => {
  const box = await sandbox(t);
  assert.match(box.cli(["enqueue", "some-branch"]).stderr, /not something the queue can release/);
  assert.match(box.cli(["enqueue", "main", "Release candidate rc-2026-10-18.1"]).stderr, /is not a title/);
  assert.equal(existsSync(join(box.root, "release-queue", "queue.json")), false);
});

test("a release by hand holding the release lock: the worker waits, without pausing runs, then releases", async (t) => {
  const box = await sandbox(t);
  box.merge("change");
  enqueue(box, "main", "Change");
  // A release by hand (a live process) holds the lock.
  const lock = join(box.root, "locks", "release.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner"), `pid=${process.pid}\ncommand=greatstone-release.sh rc-2026-10-18.4\n`);
  const w = box.worker();
  await waitFor("the worker to wait for the lock", () => /waiting: another release runs \(pid=/.test(box.state().items[0].detail ?? ""));
  assert.deepEqual(box.fake.events, [], "no run is held while it waits");
  rmSync(lock, { recursive: true });
  const { code, out } = await w.done;
  assert.equal(code, 0, out);
  assert.equal(box.state().items[0].status, "released");
  assert.deepEqual(box.fake.events, ["drain", "lift"]);
});

// 19 Oct 2026 (John): releases must be fast. A release that changes nothing in
// the database goes gate, candidate, drain, release: no preview.
test("a release with no database change skips the preview step and says so", async (t) => {
  const box = await sandbox(t);
  const head = box.merge("ui only", { "ui/src/App.tsx": "new\n" });
  const a = enqueue(box, "main", "UI only");
  const { code, out } = await box.worker().done;
  assert.equal(code, 0, out);
  const calls = box.callLines();
  assert.deepEqual(calls.map((c) => c.split(" ")[0]), ["github", "candidate", "release"], calls.join("\n"));
  const item = box.state().items.find((i) => i.id === a.id);
  assert.equal(item.status, "released");
  const log = readFileSync(item.log, "utf8");
  assert.match(log, new RegExp(`preview: preview skipped: no database changes between ${box.first.slice(0, 9)} and ${head.slice(0, 9)}`));
});

test("a release with a database change still runs the preview and its switch tests", async (t) => {
  const box = await sandbox(t);
  box.merge("migration");
  enqueue(box, "main", "Migration");
  assert.equal((await box.worker().done).code, 0);
  const calls = box.callLines();
  assert.deepEqual(calls.map((c) => c.split(" ").slice(0, 2).join(" ")).filter((c) => c.startsWith("preview")), ["preview stop", "preview start", "preview switch-tests"]);
  assert.match(readFileSync(box.state().items[0].log, "utf8"), /preview: starting rc-\S+ on a copy of the live data \(the database changes between [0-9a-f]{9} and [0-9a-f]{9}: packages\/db\/src\/migrations\/0001_sandbox\.sql\)/);
});

// GRE-2486: an agent's preview start (Flint's daily-candidate check) holds the preview lock.
function agentPreviewLock(box, t, { lifeMs = 60_000 } = {}) {
  const agent = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${lifeMs})`], { stdio: "ignore" });
  t.after(() => agent.kill("SIGKILL"));
  const dir = join(box.root, "locks", "preview.lock");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "owner"), `pid=${agent.pid}\ncommand=greatstone-preview.sh start rc-2026-10-25.9\nrun_id=run-flint\nissue_id=issue-2466\ntakeovers=0\n`);
  return { agent, ended: new Promise((r) => agent.on("exit", (_code, signal) => r(signal ?? "exited"))) };
}

test("an agent's preview in the way gets a grace period, is then stopped and recorded, and its task is told and woken (GRE-2486)", async (t) => {
  const box = await sandbox(t);
  box.merge("migration");
  const { ended } = agentPreviewLock(box, t);
  const a = enqueue(box, "main", "Migration");
  const { code, out } = await box.worker({ GSAM_RELEASE_QUEUE_PREVIEW_GRACE_SECONDS: "0.5", GSAM_RUN_ID: "run-of-whoever-started-the-worker" }).done;
  assert.equal(code, 0, out);
  assert.equal(await ended, "SIGTERM");
  const item = box.state().items.find((i) => i.id === a.id);
  assert.equal(item.status, "released");
  assert.deepEqual(item.previewStopped.map(({ runId, issueId, what }) => ({ runId, issueId, what })), [{ runId: "run-flint", issueId: "issue-2466", what: "greatstone-preview.sh start rc-2026-10-25.9" }]);
  assert.match(item.previewStopped[0].note, /^stopped; the task was told and woken$/);
  const comment = box.fake.calls.find((c) => c.what === "comment" && c.issueId === "issue-2466");
  assert.equal(comment.body.resume, true);
  assert.match(comment.body.body, new RegExp(`^The release queue stopped this task's preview \\(greatstone-preview\\.sh start rc-2026-10-25\\.9, run run-flint\\) after 1 s, so release ${a.id} of [0-9a-f]{9} \\(rc-\\S+\\) can run its own preview\\. Do not start the preview again`));
  // It was stopped before the queue's own preview started; every queue preview step is the queue's, with no run.
  const calls = box.callLines().filter((c) => c.startsWith("preview"));
  assert.deepEqual(calls.map((c) => c.split(" ")[1]), ["stop", "stop", "start", "switch-tests"], calls.join("\n"));
  const envs = readFileSync(`${join(box.root, "calls.txt")}.preview-env`, "utf8").trim().split("\n");
  assert.deepEqual(envs.map((l) => l.split(" ").slice(1).join(" ")), Array(4).fill(`item=${a.id} run=`));
  assert.match(readFileSync(item.log, "utf8"), /preview: an agent's preview is in the way \(greatstone-preview\.sh start rc-2026-10-25\.9, run run-flint, task issue-2466\)/);
});

test("an agent's preview that ends within the grace period is left alone (GRE-2486)", async (t) => {
  const box = await sandbox(t);
  box.merge("migration");
  const { agent, ended } = agentPreviewLock(box, t);
  const a = enqueue(box, "main", "Migration");
  const run = box.worker({ GSAM_RELEASE_QUEUE_PREVIEW_GRACE_SECONDS: "20" });
  await waitFor("the queue to wait for the agent's preview", () => /in the way/.test(box.state().items[0]?.detail ?? ""));
  agent.kill("SIGKILL"); // the agent's start ends by itself, as far as the queue knows
  const { code, out } = await run.done;
  assert.equal(code, 0, out);
  assert.equal(await ended, "SIGKILL", "the queue sent no signal");
  const item = box.state().items.find((i) => i.id === a.id);
  assert.equal(item.status, "released");
  assert.equal(item.previewStopped, undefined);
  assert.equal(box.fake.calls.some((c) => c.what === "comment" && c.issueId === "issue-2466"), false);
  assert.match(readFileSync(item.log, "utf8"), /preview: the agent's preview ended on its own/);
});

test("releasing and covers: what the preview guard and the daily candidate ask the queue (GRE-2486)", async (t) => {
  assert.equal(releasingItem([{ id: "a", status: "queued" }, { id: "b", status: "released" }]), null);
  assert.equal(releasingItem([{ id: "a", status: "queued" }, { id: "b", status: "running" }]).id, "b");
  const history = { c1: [], c2: ["c1"], c3: ["c1", "c2"] };
  const anc = (a, b) => history[b]?.includes(a) ?? false;
  const items = [{ id: "r1", status: "released", commit: "c2" }, { id: "f", status: "failed", commit: "c3" }];
  assert.equal(coveringItem(items, "c1", anc).id, "r1", "a newer main released");
  assert.equal(coveringItem(items, "c2", anc).id, "r1", "the same commit released");
  assert.equal(coveringItem(items, "c3", anc), null, "a failed release covers nothing");
  assert.equal(coveringItem([{ id: "q", status: "running", commit: "c3" }], "c2", anc).id, "q", "a newer main releasing");

  const box = await sandbox(t);
  const older = box.merge("older");
  git(box.dev, "fetch", "--quiet", "origin");
  git(box.dev, "tag", "-a", "rc-2026-10-25.9", older, "-m", "daily");
  const newer = box.merge("newer");
  git(box.dev, "fetch", "--quiet", "origin");
  const notReleasing = box.cli(["releasing"]);
  assert.deepEqual([notReleasing.status, notReleasing.stdout], [1, ""]);
  const uncovered = box.cli(["covers", "rc-2026-10-25.9"]);
  assert.equal(uncovered.status, 1);
  assert.match(uncovered.stdout, /^Not covered: the queue has not released or started releasing rc-2026-10-25\.9/);
  const a = enqueue(box, "main");
  const file = join(box.root, "release-queue", "queue.json");
  const s = JSON.parse(readFileSync(file, "utf8"));
  Object.assign(s.items.find((i) => i.id === a.id), { status: "running", step: "preview", commit: newer, tag: "rc-2026-10-25.10" });
  writeFileSync(file, JSON.stringify(s));
  const releasing = box.cli(["releasing"]);
  assert.deepEqual([releasing.status, releasing.stdout.trim()], [0, `${newer.slice(0, 9)} (${a.id}, rc-2026-10-25.10)`]);
  const covered = box.cli(["covers", "rc-2026-10-25.9"]);
  assert.equal(covered.status, 0, covered.stderr);
  assert.equal(covered.stdout.trim(), `Covered: ${a.id} is releasing ${newer.slice(0, 9)} (rc-2026-10-25.10), which includes rc-2026-10-25.9 (${older.slice(0, 9)}). The queue's preview covers it; skip this preview.`);
});
