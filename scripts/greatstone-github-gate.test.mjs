// Tests for scripts/greatstone-github-gate.mjs, the release gate on GitHub.
// A fake GitHub API answers from a table, so nothing reaches GitHub.
//
//   node --test scripts/greatstone-github-gate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FULL_MATRIX, WORKFLOW_PATH, check, checkOnce, judgeJobs, testedCommitFromLog } from "./greatstone-github-gate.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const SHA = "a".repeat(40);
const HEAD = "b".repeat(40);
const MERGE = "c".repeat(40);
const ok = (name) => ({ id: name === "Rebrand and workflow guard" ? 7 : 1, name, status: "completed", conclusion: "success" });
const greenJobs = () => [ok("Rebrand and workflow guard"), ok("Typecheck"), ok("Build"), ...FULL_MATRIX.map(ok), ok("Fork CI"), { name: "Runner Rust tests", status: "completed", conclusion: "skipped" }];
const run = (id, event, extra = {}) => ({ id, event, path: WORKFLOW_PATH, created_at: "2026-10-18T20:00:00Z", html_url: `https://x/runs/${id}`, ...extra });
const fakeApi = (table) => (path) => {
  const value = table[path.replace("{repo}/", "")];
  return typeof value === "function" ? value() : value ?? null;
};

test("judgeJobs: green needs every job that ran to pass and the whole matrix to have run", () => {
  assert.equal(judgeJobs(greenJobs()).state, "passed");
  const failed = judgeJobs([...greenJobs().slice(1), { name: "Tests (server 3/6)", status: "completed", conclusion: "failure" }]);
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.names, ["Tests (server 3/6) (failure)"]);
  assert.equal(judgeJobs([...greenJobs(), { name: "Build", status: "in_progress", conclusion: null }]).state, "pending");
  // The fast lanes only (the old pull request workflow): not a full run.
  const fast = judgeJobs([ok("Typecheck"), ok("Build"), ok("Fork CI")]);
  assert.equal(fast.state, "incomplete");
  assert.equal(fast.names.length, FULL_MATRIX.length);
});

test("FULL_MATRIX is the Tests matrix of fork-ci.yml", () => {
  const yml = readFileSync(join(scriptsDir, "..", ".github", "workflows", "fork-ci.yml"), "utf8");
  const labels = [...yml.matchAll(/- \{ label: "([^"]+)", mode:/g)].map((m) => `Tests (${m[1]})`);
  assert.deepEqual(labels, FULL_MATRIX);
});

test("a green push run on exactly the commit passes; a failed one refuses with the failing jobs", () => {
  const api = fakeApi({
    [`repos/actions/runs?head_sha=${SHA}&per_page=50`]: { workflow_runs: [run(1, "push")] },
    "repos/actions/runs/1/jobs?filter=latest&per_page=100": { jobs: greenJobs() },
  });
  assert.match(checkOnce(api, SHA).message, /^GitHub: the full test matrix passed on aaaaaaaaa \(push run https:\/\/x\/runs\/1\)$/);
  const failing = fakeApi({
    [`repos/actions/runs?head_sha=${SHA}&per_page=50`]: { workflow_runs: [run(1, "push"), run(9, "push", { path: ".github/workflows/metric-budgets.yml" })] },
    "repos/actions/runs/1/jobs?filter=latest&per_page=100": { jobs: [...greenJobs(), { name: "Tests (packages)", status: "completed", conclusion: "failure" }] },
  });
  const result = checkOnce(failing, SHA);
  assert.equal(result.state, "failed");
  assert.match(result.message, /Fork CI failed on aaaaaaaaa .*: Tests \(packages\) \(failure\)$/);
});

test("a commit with the same files as a pull request's green tested merge passes; other files do not", () => {
  const table = {
    [`repos/actions/runs?head_sha=${SHA}&per_page=50`]: { workflow_runs: [] },
    [`repos/git/commits/${SHA}`]: { tree: { sha: "tree-1" } },
    [`repos/commits/${SHA}/pulls`]: [{ number: 853, head: { sha: HEAD } }],
    [`repos/actions/runs?head_sha=${HEAD}&per_page=50`]: { workflow_runs: [run(2, "pull_request")] },
    "repos/actions/runs/2/jobs?filter=latest&per_page=100": { jobs: greenJobs() },
    "repos/actions/jobs/7/logs": `2026-10-18T20:30:07Z [command]/usr/bin/git -c protocol.version=2 fetch --no-tags --prune --no-recurse-submodules --depth=1 origin +${MERGE}:refs/remotes/pull/853/merge\n`,
    [`repos/git/commits/${MERGE}`]: { tree: { sha: "tree-1" } },
  };
  assert.match(checkOnce(fakeApi(table), SHA).message, /passed on pull request #853 \(run https:\/\/x\/runs\/2\), whose tested merge ccccccccc has the same files as aaaaaaaaa$/);
  table[`repos/git/commits/${MERGE}`] = { tree: { sha: "tree-2" } };
  assert.equal(checkOnce(fakeApi(table), SHA).state, "pending");
});

test("check waits while Fork CI runs, up to the cap", async () => {
  let polls = 0;
  const api = fakeApi({
    [`repos/actions/runs?head_sha=${SHA}&per_page=50`]: { workflow_runs: [run(1, "push")] },
    "repos/actions/runs/1/jobs?filter=latest&per_page=100": () => ({ jobs: polls++ < 2 ? [...greenJobs().slice(0, -2), { name: "Fork CI", status: "queued", conclusion: null }] : greenJobs() }),
  });
  let t = 0;
  const clock = { now: () => t, sleep: async (ms) => { t += ms; } };
  assert.equal((await check(api, SHA, { waitMs: 120_000, pollMs: 30_000, ...clock })).state, "passed");
  polls = -100;
  t = 0;
  const capped = await check(api, SHA, { waitMs: 60_000, pollMs: 30_000, ...clock });
  assert.equal(capped.state, "pending");
  assert.match(capped.message, /still running .*Fork CI/);
  assert.equal(t, 60_000);
});

test("the CLI: exit 0, 1, 2, and 3 when GitHub cannot be asked", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gs-github-gate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const gh = join(dir, "gh");
  // Answers like gh: JSON for a known path, "HTTP 404" for others, no network when OFFLINE is set.
  writeFileSync(gh, `#!/usr/bin/env node
const p = process.argv[process.argv.length - 1];
if (process.env.OFFLINE) { console.error("error connecting to api.github.com"); process.exit(1); }
// Like gh 2.102+: output with escape sequences needs --allow-escape-sequences.
if (process.env.ESCAPES && !process.argv.includes("--allow-escape-sequences")) { console.error("the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway"); process.exit(1); }
const t = JSON.parse(require("node:fs").readFileSync(process.env.TABLE, "utf8"));
const k = Object.keys(t).find((k) => p.endsWith(k));
if (!k) { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
console.log(typeof t[k] === "string" ? t[k] : JSON.stringify(t[k]));
`, { mode: 0o755 });
  const tableFile = join(dir, "table.json");
  const cli = (extra = {}, ...args) => spawnSync(process.execPath, [join(scriptsDir, "greatstone-github-gate.mjs"), SHA, ...args], { encoding: "utf8", env: { ...process.env, GSAM_GH_BIN: gh, TABLE: tableFile, ...extra } });
  writeFileSync(tableFile, JSON.stringify({ [`runs?head_sha=${SHA}&per_page=50`]: { workflow_runs: [run(1, "push")] }, "runs/1/jobs?filter=latest&per_page=100": { jobs: greenJobs() } }));
  assert.equal(cli().status, 0);
  assert.equal(cli({ ESCAPES: "1" }).status, 0, "retries with --allow-escape-sequences when gh asks for it");
  writeFileSync(tableFile, JSON.stringify({ [`runs?head_sha=${SHA}&per_page=50`]: { workflow_runs: [run(1, "push")] }, "runs/1/jobs?filter=latest&per_page=100": { jobs: [{ name: "Build", status: "completed", conclusion: "failure" }] } }));
  assert.equal(cli().status, 1);
  writeFileSync(tableFile, JSON.stringify({}));
  const none = cli({}, "--wait", "0");
  assert.equal(none.status, 2);
  const offline = cli({ OFFLINE: "1" });
  assert.equal(offline.status, 3);
  assert.match(offline.stdout, /^GitHub could not be asked: error connecting to api\.github\.com$/m);
  assert.equal(cli({ GSAM_GH_BIN: join(dir, "no-such-gh") }).status, 3);
  assert.match(testedCommitFromLog("nothing here") ?? "none", /none/);
});
