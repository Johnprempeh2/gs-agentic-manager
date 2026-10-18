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
import { nextBatch, proposeTitle, refProblem } from "./greatstone-release-queue.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const queueScript = join(scriptsDir, "greatstone-release-queue.mjs");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// The step scripts the worker calls, as stubs. Each appends one line to $CALLS.
const STUBS = {
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
[ "$1" != switch-tests ] || [ -z "\${SWITCH_FAIL:-}" ] || { echo "preview: switch test failed"; exit 1; }
`,
  "greatstone-release.sh": `#!/usr/bin/env bash
echo "release $1 draining=$(curl -s "$GSAM_LIVE_URL/api/instance/task-drain" | sed 's/.*"draining":\\([a-z]*\\).*/\\1/')" >>"$CALLS"
if [ -n "\${RELEASE_FAIL:-}" ]; then echo "release: the live app did not report it"; exit 1; fi
echo "Tagged $1 as live-2026-10-18.9: title"
echo "Roll back with: scripts/greatstone-release.sh live-2026-10-18.8"
echo "Database backup from before this release: /backups/before.sql.gz"
`,
};

async function sandbox(t, { running = () => 0 } = {}) {
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
  const merge = (msg) => {
    git(other, "pull", "--quiet", "--ff-only", "origin", "main");
    git(other, "commit", "--quiet", "--allow-empty", "-m", msg);
    git(other, "push", "--quiet", "origin", "HEAD:main");
    return git(other, "rev-parse", "HEAD");
  };

  const fake = { draining: false, events: [], running };
  const server = createServer((req, res) => {
    const send = (v) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(v)); };
    if (req.url === "/api/health") return send({ status: "ok" });
    if (req.url === "/api/instance/task-drain") {
      if (req.method === "POST") { fake.draining = true; fake.events.push("drain"); }
      if (req.method === "DELETE") { fake.draining = false; fake.events.push("lift"); }
      return send({ draining: fake.draining });
    }
    if (req.url === "/api/companies") return send([{ id: "c1" }]);
    if (req.url.startsWith("/api/companies/c1/heartbeat-runs")) {
      return send(Array.from({ length: fake.running() }, (_, i) => ({ id: `r${i}`, status: "running" })));
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
  box.pass(tagged);
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
  // The rc tag first: its gate is skipped (it passed), then preview and release.
  assert.equal(calls.filter((c) => c.startsWith("gate ")).length, 1, calls.join("\n"));
  const releases = calls.filter((c) => c.startsWith("release "));
  assert.equal(releases.length, 2, calls.join("\n"));
  assert.match(releases[0], /^release rc-2026-10-18\.1 /);
  // One release for the three main requests, of the newest main, named by the newest title.
  assert.ok(calls.includes(`gate ${newest} yield=0`), calls.join("\n"));
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

test("cancel: a queued request at once; a running one before its next step, and its gate stops", async (t) => {
  const box = await sandbox(t);
  box.merge("change");
  const a = enqueue(box, "main", "Will run");
  const b = enqueue(box, "abc1234");
  const cancelled = box.cli(["cancel", b.id, "--json", "--by", "user:john"]);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(box.state().items.find((i) => i.id === b.id).status, "cancelled");
  assert.match(box.cli(["cancel", b.id]).stderr, /already cancelled/);

  const w = box.worker({ GATE_SECONDS: "60" });
  await waitFor("the gate to start", () => box.callLines().some((c) => c.startsWith("gate ")));
  assert.equal(box.state().items.find((i) => i.id === a.id).step, "gate");
  assert.equal(box.cli(["cancel", a.id]).status, 0);
  // Then, with nothing queued, it gates main in the background; let that be quick.
  writeFileSync(join(box.root, "gate-seconds"), "0");
  const { code, out } = await w.done;
  assert.equal(code, 0, out);
  const item = box.state().items.find((i) => i.id === a.id);
  assert.equal(item.status, "cancelled", JSON.stringify(item));
  const calls = box.callLines();
  assert.ok(calls.some((c) => c.startsWith("gate-stopped ")), calls.join("\n"));
  assert.ok(!calls.some((c) => c.startsWith("release ") || c.startsWith("candidate ")), calls.join("\n"));
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

test("with nothing queued it gates main in the background, the newest commit only, and records a failure once", async (t) => {
  const box = await sandbox(t);
  const older = box.merge("older");
  const w = box.worker({ GATE_SECONDS: "60" });
  await waitFor("the gate on the older main", () => box.callLines().includes(`gate ${older} yield=1`));
  assert.equal(box.state().main.status, "testing");
  // Main moves while it runs: that gate stops and the newest is tested, never a
  // backlog. The newest one fails at once.
  writeFileSync(join(box.root, "gate-seconds"), "0");
  const newest = box.merge("newest");
  writeFileSync(join(box.root, "fail-commits"), `${newest}\n`);
  const { code, out } = await w.done;
  assert.ok(box.callLines().includes(`gate ${newest} yield=1`), box.callLines().join("\n"));
  assert.ok(box.callLines().includes(`gate-stopped ${older}`));
  assert.equal(code, 0, out);
  const main = box.state().main;
  assert.equal(main.commit, newest);
  assert.equal(main.status, "failing", JSON.stringify(main));
  assert.match(main.summary.join("\n"), /FAIL {2}src\/a\.test\.ts > adds up/);
  assert.equal(existsSync(join(box.root, "test-gate", "passed", older)), false);

  // The same failing commit is not tested again; a passed one is just recorded.
  const before = box.callLines().length;
  assert.equal((await box.worker().done).code, 0);
  assert.equal(box.callLines().length, before);
  const fixed = box.merge("fixed");
  box.pass(fixed);
  assert.equal((await box.worker().done).code, 0);
  assert.deepEqual([box.state().main.commit, box.state().main.status], [fixed, "passed"]);
});

test("a request for main shares the background gate already running on that commit", async (t) => {
  const box = await sandbox(t);
  const head = box.merge("change");
  const w = box.worker({ GATE_SECONDS: "2" });
  await waitFor("the background gate", () => box.callLines().includes(`gate ${head} yield=1`));
  enqueue(box, "main", "Ship it");
  const { code, out } = await w.done;
  assert.equal(code, 0, out);
  const calls = box.callLines();
  assert.equal(calls.filter((c) => c.startsWith("gate ")).length, 1, calls.join("\n"));
  assert.ok(calls.some((c) => c.startsWith("release ")), calls.join("\n"));
});

test("drain: new runs are held while running runs finish, the release runs drained, and runs resume even when it fails", async (t) => {
  let polls = 0;
  const box = await sandbox(t, { running: () => (polls++ < 2 ? 1 : 0) });
  box.merge("change");
  enqueue(box, "main", "Change");
  const { code, out } = await box.worker({ RELEASE_FAIL: "1" }).done;
  assert.equal(code, 0, out);
  const release = box.callLines().find((c) => c.startsWith("release "));
  assert.match(release, /draining=true$/, "the release ran with new runs held");
  assert.deepEqual(box.fake.events, ["drain", "lift"]);
  assert.equal(box.fake.draining, false, "agent runs are back on after the failed release");
  const item = box.state().items[0];
  assert.equal(item.status, "failed");
  assert.match(item.reason, /the live app did not report it/);
});

test("drain: runs still running at the cap are never stopped; it resumes runs, waits, and gives up without releasing", async (t) => {
  const box = await sandbox(t, { running: () => 1 });
  box.merge("change");
  enqueue(box, "main", "Change");
  const { code, out } = await box.worker({
    GSAM_RELEASE_DRAIN_CAP_SECONDS: "0.5",
    GSAM_RELEASE_DRAIN_RETRY_SECONDS: "0.2",
    GSAM_RELEASE_DRAIN_ATTEMPTS: "2",
  }).done;
  assert.equal(code, 0, out);
  assert.deepEqual(box.fake.events, ["drain", "lift", "drain", "lift"]);
  assert.ok(!box.callLines().some((c) => c.startsWith("release ")));
  const item = box.state().items[0];
  assert.equal(item.status, "failed");
  assert.match(item.reason, /still running after 2 waits/);
  // The preview it started is stopped again.
  assert.equal(box.callLines().filter((c) => c === "preview stop").length, 2);
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
