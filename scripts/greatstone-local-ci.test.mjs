// Tests for scripts/greatstone-local-ci.mjs (GRE-201). The `gh run view`
// samples in scripts/fixtures/local-ci are real: PR #63 during the 28-29 Sep
// billing stop, and PR #42 whose guard lane failed. The end-to-end test uses a
// throwaway repository and fake `gh` and `pnpm` on PATH; nothing is posted to
// GitHub and nothing under ~/GSAM is read or written.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LANES,
  classifyRunView,
  decideFallback,
  parseVmStatAvailableBytes,
  ramGuard,
  runLanes,
  summarize,
  tryLock,
  unlock,
} from "./greatstone-local-ci.mjs";

const scriptsDir = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const fixture = (name) => readFileSync(join(scriptsDir, "fixtures", "local-ci", name), "utf8");
const billingStop = fixture("run-view-billing-stop.txt");
const testFailure = fixture("run-view-test-failure.txt");
const now = new Date("2026-09-29T12:00:00Z");
const ago = (min) => new Date(now.getTime() - min * 60_000).toISOString();
const run = (status, conclusion, createdAt) => ({ databaseId: 1, status, conclusion, createdAt, event: "pull_request" });

test("the billing-stop sample means GitHub could not start the job", () => {
  assert.deepEqual(classifyRunView(billingStop), { notStarted: true, reason: "billing" });
  const d = decideFallback({ runs: [run("completed", "failure", ago(60))], viewText: billingStop, now });
  assert.equal(d.fallback, true);
  assert.match(d.reason, /billing stop/);
});

test("a normal lane failure does NOT trigger the fallback", () => {
  assert.deepEqual(classifyRunView(testFailure), { notStarted: false, reason: null });
  const d = decideFallback({ runs: [run("completed", "failure", ago(600))], viewText: testFailure, now });
  assert.equal(d.fallback, false);
  assert.equal(d.reason, "Fork CI ran: failure");
});

test("a green run does not trigger the fallback", () => {
  assert.equal(decideFallback({ runs: [run("completed", "success", ago(60))], viewText: "✓ Build", now }).fallback, false);
});

test("the newest run decides: a later real run beats an earlier billing stop", () => {
  const runs = [run("completed", "failure", ago(120)), { ...run("completed", "success", ago(10)), databaseId: 2 }];
  // viewText belongs to the newest run, which ran.
  assert.equal(decideFallback({ runs, viewText: "✓ Typecheck", now }).fallback, false);
});

test("no job started within 15 minutes triggers the fallback; sooner does not", () => {
  assert.equal(decideFallback({ runs: [], headAt: ago(20), now }).fallback, true);
  assert.equal(decideFallback({ runs: [], headAt: ago(5), now }).fallback, false);
  assert.equal(decideFallback({ runs: [], headAt: null, now }).fallback, false);
  assert.equal(decideFallback({ runs: [run("queued", "", ago(16))], now }).fallback, true);
  assert.equal(decideFallback({ runs: [run("queued", "", ago(3))], now }).fallback, false);
  // A job that started is running, however long it takes.
  assert.equal(decideFallback({ runs: [run("in_progress", "", ago(40))], now }).fallback, false);
});

test("RAM guard: busy below 2 GB or at warn/critical pressure, fails open when unread", () => {
  const vm = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:  100000.\nPages inactive:  50000.\nPages purgeable:  10.\n";
  assert.equal(parseVmStatAvailableBytes(vm), 150010 * 16384);
  assert.equal(parseVmStatAvailableBytes("garbage"), null);
  const gb = 1024 ** 3;
  assert.equal(ramGuard({ availableBytes: 8 * gb, pressureLevel: "1\n" }).busy, false);
  assert.equal(ramGuard({ availableBytes: 1 * gb, pressureLevel: "1" }).busy, true);
  assert.equal(ramGuard({ availableBytes: 8 * gb, pressureLevel: "2" }).busy, true);
  assert.equal(ramGuard({ availableBytes: 8 * gb, pressureLevel: "4" }).busy, true);
  assert.equal(ramGuard({ availableBytes: null, pressureLevel: "" }).busy, false);
});

test("only one local check at a time; a dead holder's lock is taken over", () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-local-ci-lock-"));
  const lock = join(dir, "lock");
  try {
    assert.deepEqual(tryLock(lock), { ok: true });
    const second = tryLock(lock, 999_999);
    assert.equal(second.ok, false);
    assert.equal(second.holder, process.pid);
    unlock(lock);
    assert.equal(tryLock(lock).ok, true);
    // A holder that exited without unlocking.
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    writeFileSync(join(lock, "pid"), dead.stdout);
    assert.equal(tryLock(lock).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lanes stop at the first failure and the summary says failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-local-ci-lanes-"));
  try {
    const ok = { name: "a", commands: [["node", "-e", "0"]] };
    const bad = { name: "b", commands: [["node", "-e", "console.log('boom'); process.exit(4)"]] };
    const never = { name: "c", commands: [["node", "-e", "0"]] };
    const results = await runLanes(dir, { lanes: [ok, bad, never] });
    assert.deepEqual(results.map((r) => [r.name, r.ok]), [["a", true], ["b", false]]);
    assert.equal(results[1].failed.code, 4);
    assert.match(results[1].failed.tail, /boom/);
    const out = summarize(results, "abcdef1234", "GitHub did not start the jobs (billing stop)");
    assert.equal(out.state, "failure");
    assert.match(out.body, /FAIL b/);
    // Every lane passing is the only success.
    const all = LANES.map((l) => ({ name: l.name, ok: true, seconds: 1, failed: null }));
    assert.equal(summarize(all, "abcdef1234", "x").state, "success");
    assert.equal(summarize(all.slice(0, 2), "abcdef1234", "x").state, "failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A repository with origin, PR #7 under refs/pull/7/head, and fake gh/pnpm.
function fakeWorld({ runView }) {
  const dir = mkdtempSync(join(tmpdir(), "gs-local-ci-e2e-"));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const origin = join(dir, "origin.git");
  const clone = join(dir, "clone");
  git(dir, "init", "--quiet", "--bare", origin);
  git(dir, "init", "--quiet", "-b", "main", clone);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"], ["core.hooksPath", "/dev/null"]]) git(clone, "config", k, v);
  mkdirSync(join(clone, "scripts"));
  writeFileSync(join(clone, "scripts", "greatstone-rebrand.mjs"), "process.exit(0)\n");
  writeFileSync(join(clone, "scripts", "check-fork-workflows.mjs"), "process.exit(0)\n");
  writeFileSync(join(clone, "README.md"), "pr\n");
  git(clone, "add", ".");
  git(clone, "commit", "--quiet", "-m", "pr head");
  const sha = git(clone, "rev-parse", "HEAD");
  git(clone, "remote", "add", "origin", origin);
  git(clone, "push", "--quiet", "--no-verify", "origin", `HEAD:refs/pull/7/head`);

  const bin = join(dir, "bin");
  const calls = join(dir, "calls.log");
  mkdirSync(bin);
  writeFileSync(join(dir, "run-view.txt"), runView);
  const fakeGh = `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a) + "\\n");
if (a[0] === "pr" && a[1] === "view") console.log(JSON.stringify({ headRefOid: ${JSON.stringify(sha)}, state: "OPEN", commits: [{ committedDate: "2026-09-28T23:00:00Z" }] }));
else if (a[0] === "run" && a[1] === "list") console.log(JSON.stringify([{ databaseId: 55, status: "completed", conclusion: "failure", createdAt: "2026-09-28T23:01:00Z", event: "pull_request" }]));
else if (a[0] === "run" && a[1] === "view") process.stdout.write(fs.readFileSync(${JSON.stringify(join(dir, "run-view.txt"))}, "utf8"));
`;
  writeFileSync(join(bin, "gh"), fakeGh);
  // pnpm must not see agent or GitHub tokens.
  writeFileSync(join(bin, "pnpm"), `#!/bin/sh\nenv | grep -E '^(GSAM_|GH_TOKEN|GITHUB_TOKEN)' | grep -v '^GSAM_TELEMETRY_DISABLED=' && exit 9\nexit 0\n`);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "pnpm"), 0o755);
  const cli = (...args) =>
    spawnSync(process.execPath, [join(scriptsDir, "greatstone-local-ci.mjs"), ...args], {
      cwd: clone,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GSAM_API_KEY: "secret", GH_TOKEN: "secret" },
    });
  const ghCalls = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { dir, clone, sha, cli, ghCalls };
}

test("run on a billing-stopped PR runs the lanes and sets commit status local-ci", () => {
  const w = fakeWorld({ runView: billingStop });
  try {
    assert.equal(w.cli("detect", "7").status, 0);
    const r = w.cli("run", "7");
    assert.equal(r.status, 0, r.stderr);
    const calls = w.ghCalls();
    const status = calls.find((c) => c[0] === "api");
    assert.ok(status, "a commit status was posted");
    assert.equal(status[3], `repos/Johnprempeh2/gs-agentic-manager/statuses/${w.sha}`);
    assert.ok(status.includes("state=success"));
    assert.ok(status.includes("context=local-ci"));
    assert.ok(calls.some((c) => c[0] === "pr" && c[1] === "comment" && c[2] === "7"));
    assert.equal(existsSync(join(w.clone, ".gsam", "local-ci", "lock")), false, "lock released");
    assert.equal(execFileSync("git", ["-C", join(w.clone, ".gsam", "local-ci", "work"), "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), w.sha);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test("run refuses a PR whose Fork CI ran and failed; dry run posts nothing", () => {
  const w = fakeWorld({ runView: testFailure });
  try {
    assert.equal(w.cli("detect", "7").status, 1);
    const r = w.cli("run", "7");
    assert.equal(r.status, 3);
    assert.match(r.stderr, /fallback refused: Fork CI ran: failure/);
    const dry = w.cli("run", "7", "--dry-run");
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /context=local-ci/);
    assert.equal(w.ghCalls().some((c) => c[0] === "api" || c[1] === "comment"), false);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});
