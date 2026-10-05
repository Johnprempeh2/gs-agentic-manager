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
  BIG_CHANGE_LINES,
  LANES,
  bigChange,
  ciState,
  classifyRunView,
  decideFallback,
  draftVerdict,
  parseNumstat,
  parseTestsRun,
  scanDiff,
  parseVmStatAvailableBytes,
  ramGuard,
  runLanes,
  sameRepoCheck,
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

test("only PRs from branches on the repo itself may run; unknown is refused", () => {
  assert.equal(sameRepoCheck({ isCrossRepository: false, author: "app/gsam" }).ok, true);
  const fork = sameRepoCheck({ isCrossRepository: true, author: "stranger" });
  assert.equal(fork.ok, false);
  assert.match(fork.reason, /fork by stranger/);
  assert.equal(sameRepoCheck({ isCrossRepository: undefined, author: null }).ok, false);
});

// A repository with origin, PR #7 under refs/pull/7/head, and fake gh/pnpm.
function fakeWorld({ runView, isCrossRepository = false, prFiles = {}, body = "" }) {
  const dir = mkdtempSync(join(tmpdir(), "gs-local-ci-e2e-"));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const origin = join(dir, "origin.git");
  const clone = join(dir, "clone");
  git(dir, "init", "--quiet", "--bare", origin);
  git(dir, "init", "--quiet", "-b", "main", clone);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"], ["core.hooksPath", "/dev/null"]]) git(clone, "config", k, v);
  writeFileSync(join(clone, "BASE.md"), "base\n");
  git(clone, "add", ".");
  git(clone, "commit", "--quiet", "-m", "base");
  const baseSha = git(clone, "rev-parse", "HEAD");
  mkdirSync(join(clone, "scripts"));
  for (const [path, text] of Object.entries(prFiles)) {
    mkdirSync(join(clone, path, ".."), { recursive: true });
    writeFileSync(join(clone, path), text);
  }
  writeFileSync(join(clone, "scripts", "greatstone-rebrand.mjs"), "process.exit(0)\n");
  writeFileSync(join(clone, "scripts", "check-fork-workflows.mjs"), "process.exit(0)\n");
  writeFileSync(join(clone, "README.md"), "pr\n");
  git(clone, "add", ".");
  git(clone, "commit", "--quiet", "-m", "pr head");
  const sha = git(clone, "rev-parse", "HEAD");
  git(clone, "remote", "add", "origin", origin);
  git(clone, "push", "--quiet", "--no-verify", "origin", `HEAD:refs/pull/7/head`, `${baseSha}:refs/heads/main`);

  const bin = join(dir, "bin");
  const calls = join(dir, "calls.log");
  mkdirSync(bin);
  writeFileSync(join(dir, "run-view.txt"), runView);
  const bodyFile = join(dir, "body.md");
  writeFileSync(bodyFile, body);
  const fakeGh = `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a) + "\\n");
if (a[0] === "pr" && a[1] === "view") console.log(JSON.stringify({ headRefOid: ${JSON.stringify(sha)}, baseRefOid: ${JSON.stringify(baseSha)}, body: fs.readFileSync(${JSON.stringify(bodyFile)}, "utf8"), state: "OPEN", commits: [{ committedDate: "2026-09-28T23:00:00Z" }], isCrossRepository: ${JSON.stringify(isCrossRepository)}, author: { login: "someone" } }));
else if (a[0] === "run" && a[1] === "list") console.log(JSON.stringify([{ databaseId: 55, status: "completed", conclusion: "failure", createdAt: "2026-09-28T23:01:00Z", event: "pull_request" }]));
else if (a[0] === "api" && a.length === 2 && a[1].endsWith("/statuses")) console.log("[]");
else if (a[0] === "run" && a[1] === "view") process.stdout.write(fs.readFileSync(${JSON.stringify(join(dir, "run-view.txt"))}, "utf8"));
`;
  writeFileSync(join(bin, "gh"), fakeGh);
  // pnpm must not see agent or GitHub tokens.
  writeFileSync(join(bin, "pnpm"), `#!/bin/sh\nenv | grep -E '^(GSAM_|GH_TOKEN|GITHUB_TOKEN)' | grep -v '^GSAM_TELEMETRY_DISABLED=' && exit 9\n[ "$1" = metrics:s2-needed ] && echo 'S2 page-load check needed: no'\nexit 0\n`);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "pnpm"), 0o755);
  const cli = (...args) =>
    spawnSync(process.execPath, [join(scriptsDir, "greatstone-local-ci.mjs"), ...args], {
      cwd: clone,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GSAM_API_KEY: "secret", GH_TOKEN: "secret" },
    });
  const ghCalls = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const setBody = (text) => writeFileSync(bodyFile, text);
  return { dir, clone, sha, cli, ghCalls, setBody };
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

test("run refuses a PR from a fork, also with --dry-run, before any code is fetched or run", () => {
  const w = fakeWorld({ runView: billingStop, isCrossRepository: true });
  try {
    for (const args of [["run", "7"], ["run", "7", "--dry-run"]]) {
      const r = w.cli(...args);
      assert.equal(r.status, 3, r.stderr);
      assert.match(r.stderr, /refused: head is on a fork by someone; local-ci only runs PRs from branches on/);
      assert.doesNotMatch(r.stdout, /context=local-ci/);
    }
    assert.equal(existsSync(join(w.clone, ".gsam", "local-ci", "work")), false, "no worktree, no lanes");
    assert.equal(w.ghCalls().some((c) => c[0] === "api" || c[1] === "comment"), false);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

// ---- ready <pr> (GRE-605) ----------------------------------------------------

// The "Tests run" section of PR #323 (GRE-601), cut down, plus the other forms PR bodies use.
const pr323Body = `### What changed
- \`npx vitest run not-a-test.ts\` is in prose here and must not run.

### Tests run
- \`server: npx vitest run src/__tests__/permission-grant-requests.test.ts src/__tests__/decisions-feed.test.ts\`: **3 files, 59 passed**.
  - a nested note with \`code\` that is not a command
- \`server: npx vitest run $(attention*/*approval* tests) src/__tests__/error-handler.test.ts\`: all passed.
- \`ui: npx vitest run AttentionQueueRow Inbox*\`: **8 files, 117 passed**.
- \`tsc --noEmit\`: shared and ui are clean.
- **Sandbox (\`pnpm dev:once --data-dir ./tmp/sandbox\`):** two calls, one item.
- \`cd packages/db && pnpm test -- --run "schema check"\`
- \`node --test scripts/greatstone-local-ci.test.mjs\` (19 pass); then \`pnpm metrics:s2-needed --pr 323\`
- \`node scripts/greatstone-local-ci.mjs ready 323\`
- \`../evil: node x.mjs\`
- \`server: npx vitest run src/__tests__/permission-grant-requests.test.ts src/__tests__/decisions-feed.test.ts\` again

### Screenshots
- \`node not-a-test.mjs\`
`;

test("PR-body parser: reads the Tests run list, one command per item, and refuses shell syntax", () => {
  const { found, commands } = parseTestsRun(pr323Body);
  assert.equal(found, true);
  assert.deepEqual(commands, [
    { text: "server: npx vitest run src/__tests__/permission-grant-requests.test.ts src/__tests__/decisions-feed.test.ts", cwd: "server", argv: ["npx", "vitest", "run", "src/__tests__/permission-grant-requests.test.ts", "src/__tests__/decisions-feed.test.ts"] },
    { text: "server: npx vitest run $(attention*/*approval* tests) src/__tests__/error-handler.test.ts", skip: "uses shell syntax" },
    { text: "ui: npx vitest run AttentionQueueRow Inbox*", cwd: "ui", argv: ["npx", "vitest", "run", "AttentionQueueRow", "Inbox*"] },
    { text: "tsc --noEmit", cwd: ".", argv: ["pnpm", "exec", "tsc", "--noEmit"] },
    { text: "pnpm dev:once --data-dir ./tmp/sandbox", skip: "starts a server or installs" },
    { text: 'packages/db: pnpm test -- --run "schema check"', cwd: "packages/db", argv: ["pnpm", "test", "--", "--run", "schema check"] },
    { text: "node --test scripts/greatstone-local-ci.test.mjs", cwd: ".", argv: ["node", "--test", "scripts/greatstone-local-ci.test.mjs"] },
    { text: "node scripts/greatstone-local-ci.mjs ready 323", skip: "this script" },
    { text: "../evil: node x.mjs", skip: "directory is outside the checkout" },
  ]);
});

test("PR-body parser: bold heading, no section, and the S2 commands left to the S2 step", () => {
  assert.deepEqual(parseTestsRun("## Summary\n- `pnpm test`\n"), { found: false, commands: [] });
  assert.deepEqual(parseTestsRun(null), { found: false, commands: [] });
  // PR #320 says "## Tests" and uses `cd ui && ...`.
  assert.deepEqual(parseTestsRun("## Tests\n- Rerun: `cd ui && npx vitest run src/A.test.tsx` → 3 passed.\n").commands, [
    { text: "ui: npx vitest run src/A.test.tsx", cwd: "ui", argv: ["npx", "vitest", "run", "src/A.test.tsx"] },
  ]);
  assert.equal(parseTestsRun("Tests run: see below\n- `pnpm test`\n").commands.length, 1);
  const bold = parseTestsRun("**Tests run**\n1. `pnpm test:metrics:s2`\n2. `pnpm -r typecheck`\n**Roll back**\n- `node revert.mjs`\n");
  assert.deepEqual(bold.commands, [
    { text: "pnpm test:metrics:s2", skip: "the S2 step runs it" },
    { text: "pnpm -r typecheck", cwd: ".", argv: ["pnpm", "-r", "typecheck"] },
  ]);
});

const files = (...pairs) => pairs.map(([file, lines]) => ({ file, lines }));
const triggerNames = (list) => bigChange(list).triggers.map((t) => t.name);

test("big change: each trigger fires on its own", () => {
  assert.deepEqual(triggerNames(files(["packages/db/src/migrations/0294_x.sql", 10])), ["migrations"]);
  assert.deepEqual(triggerNames(files(["packages/db/src/migrations/meta/_journal.json", 3])), ["migrations"]);
  for (const f of ["server/src/middleware/auth.ts", "server/src/routes/authz.ts", "server/src/services/access.ts", "packages/db/src/schema/principal_permission_grants.ts", "server/src/agent-auth-jwt.ts", "server/src/routes/release-reauth.ts"]) {
    assert.deepEqual(triggerNames(files([f, 5])), ["auth/permissions"], f);
  }
  assert.deepEqual(triggerNames(files(["scripts/greatstone-release.sh", 5])), ["release scripts"]);
  assert.deepEqual(triggerNames(files([".github/workflows/fork-ci.yml", 2])), ["CI files"]);
  assert.deepEqual(triggerNames(files([".github/actions/fork-setup/action.yml", 2])), ["CI files"]);
  const big = bigChange(files(["server/src/services/issues.ts", 700], ["ui/src/pages/Board.tsx", BIG_CHANGE_LINES - 699]));
  assert.equal(big.big, true);
  assert.deepEqual(big.triggers.map((t) => t.name), [`${BIG_CHANGE_LINES + 1} changed lines outside tests (> ${BIG_CHANGE_LINES})`]);
});

test("big change: none for a normal PR; tests, fixtures, docs and the lockfile do not count", () => {
  const normal = bigChange(
    files(
      ["server/src/services/issues.ts", 400],
      ["ui/src/pages/Board.tsx", 300],
      ["server/src/__tests__/permission-grant-requests.test.ts", 5000],
      ["scripts/greatstone-local-ci.test.mjs", 900],
      ["scripts/fixtures/local-ci/run-view.txt", 900],
      ["tests/perf/issue-detail/run.mjs", 900],
      ["pnpm-lock.yaml", 4000],
      [".github/PULL_REQUEST_TEMPLATE.md", 4],
      ["ui/src/components/AccessibleLabel.tsx", 10],
    ),
  );
  assert.deepEqual(normal, { big: false, triggers: [], outsideTests: 714 });
  assert.equal(bigChange(files(["server/src/services/issues.ts", BIG_CHANGE_LINES])).big, false, "exactly the limit is not big");
  assert.deepEqual(parseNumstat("3\t1\tserver/a.ts\n-\t-\tui/logo.png\n"), [{ file: "server/a.ts", lines: 4 }, { file: "ui/logo.png", lines: 0 }]);
});

test("diff scan flags ~/GSAM paths and secret-shaped strings in added non-test lines", () => {
  const diff = [
    "+++ b/server/src/config.ts",
    "+const live = `${home}/GSAM/live`;",
    "+const p = '~/GSAM/data';",
    "-const old = '~/GSAM/old';",
    "+++ b/server/src/__tests__/x.test.ts",
    "+const tok = 'ghp_" + "a".repeat(36) + "';",
    "+++ b/scripts/deploy.sh",
    "+TOKEN=sk-ant-" + "b".repeat(30),
  ].join("\n");
  assert.deepEqual(scanDiff(diff), [
    { name: "~/GSAM path", file: "server/src/config.ts" },
    { name: "secret-shaped string", file: "scripts/deploy.sh" },
  ]);
  assert.deepEqual(scanDiff("+++ b/ui/a.ts\n+const x = 1;\n"), []);
});

test("draft verdict: five lines; ready, big change, and not-ready reasons", () => {
  const green = ciState({ runs: [run("completed", "success", ago(10))] });
  assert.equal(green.ok, true);
  assert.equal(ciState({ runs: [run("completed", "failure", ago(10))], localCi: "success" }).ok, true);
  assert.equal(ciState({ runs: [] }).ok, false);
  const passing = { found: true, results: [{ text: "pnpm test", ok: true }, { text: "pnpm dev", skip: "starts a server or installs" }] };
  const s2no = { needed: false, ok: true, text: "pnpm metrics:s2-needed says no" };
  const small = bigChange(files(["ui/a.ts", 10]));
  const base = { pr: 323, sha: "1efc3307078db882", ci: green, tests: passing, s2: s2no, big: small, flags: [] };

  const ready = draftVerdict(base);
  assert.equal(ready.length, 5);
  assert.equal(ready[0], "1. CI (PR #323 at 1efc330): green; Fork CI success (run 1)");
  assert.equal(ready[1], "2. Tests run: 1 of 1 rerun commands pass; 1 not rerun (starts a server or installs)");
  assert.match(ready[4], /^5\. Draft verdict: Ready to merge\. /);

  const big = draftVerdict({ ...base, big: bigChange(files(["packages/db/src/migrations/0294_x.sql", 3])) });
  assert.match(big[3], /^4\. Big change: yes: migrations \(packages\/db\/src\/migrations\/0294_x\.sql\)$/);
  assert.match(big[4], /Ready to merge after Flint's checks \(big change\)/);

  const bad = draftVerdict({
    ...base,
    ci: ciState({ runs: [run("completed", "failure", ago(10))] }),
    tests: { found: true, results: [{ text: "pnpm test", ok: false }] },
    s2: { needed: true, ok: false, text: "S2 page-load check: FAIL - over budget (second run)" },
    flags: [{ name: "~/GSAM path", file: "server/src/config.ts" }],
  });
  assert.equal(bad.length, 5);
  assert.match(bad[3], /check by hand: ~\/GSAM path in server\/src\/config\.ts/);
  assert.match(bad[4], /Not ready, because CI is not green .*; 1 named test command\(s\) failed: `pnpm test`; the S2 page-load check did not pass/);
  assert.match(draftVerdict({ ...base, tests: { found: false, results: [] } })[4], /Not ready, because the PR body has no "Tests run" section/);
  assert.match(draftVerdict({ ...base, tests: { found: true, results: [{ text: "x", skip: "uses shell syntax" }] } })[4], /no test command this check can rerun/);
});

const readyBody = "### Tests run\n- `node pass.mjs`: ok\n- `sub: node pass.mjs`: ok\n- `node fail.mjs`\n";

test("ready prints the 5-line draft, reruns the named tests, and makes no write call to GitHub", () => {
  const w = fakeWorld({
    runView: "",
    body: readyBody,
    prFiles: {
      "pass.mjs": "process.exit(0)\n",
      "sub/pass.mjs": "process.exit(0)\n",
      "fail.mjs": "console.log('boom'); process.exit(1)\n",
      "packages/db/src/migrations/0001_x.sql": "select 1;\n",
    },
  });
  try {
    const r = w.cli("ready", "7");
    assert.equal(r.status, 1, r.stderr);
    const lines = r.stdout.trim().split("\n");
    assert.equal(lines.length, 5, r.stdout);
    assert.match(lines[0], new RegExp(`^1\\. CI \\(PR #7 at ${w.sha.slice(0, 7)}\\): NOT green; Fork CI failure \\(run 55\\)`));
    assert.equal(lines[1], "2. Tests run: 2 of 3 rerun commands pass; FAIL: `node fail.mjs`");
    assert.equal(lines[2], "3. S2 page-load: not needed; pnpm metrics:s2-needed says no");
    assert.match(lines[3], /^4\. Big change: yes: migrations \(packages\/db\/src\/migrations\/0001_x\.sql\)/);
    assert.match(lines[4], /Not ready, because CI is not green.*`node fail\.mjs`/);
    assert.match(r.stderr, /boom/);

    // Only reads: pr view, run list, and a GET of the commit statuses.
    const calls = w.ghCalls();
    assert.deepEqual(calls.map((c) => c.slice(0, 2)), [["pr", "view"], ["run", "list"], ["api", `repos/Johnprempeh2/gs-agentic-manager/commits/${w.sha}/statuses`]]);
    assert.equal(calls.some((c) => c.includes("-X") || c.includes("--method") || c.includes("-f") || ["comment", "merge", "edit", "review", "close"].includes(c[1])), false);
    assert.equal(existsSync(join(w.clone, ".gsam", "local-ci", "lock")), false, "lock released");

    // With the failing command gone the draft is ready, after Flint (migration).
    w.setBody("### Tests run\n- `node pass.mjs`\n");
    const again = w.cli("ready", "7");
    assert.match(again.stdout.split("\n")[1], /^2\. Tests run: 1 of 1 rerun commands pass$/);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test("ready refuses a PR from a fork before any code is fetched or run", () => {
  const w = fakeWorld({ runView: "", isCrossRepository: true, body: readyBody });
  try {
    const r = w.cli("ready", "7");
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /refused: head is on a fork by someone/);
    assert.equal(r.stdout, "");
    assert.equal(existsSync(join(w.clone, ".gsam", "local-ci", "work")), false, "no worktree, no tests");
    assert.deepEqual(w.ghCalls().map((c) => c.slice(0, 2)), [["pr", "view"]]);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});
