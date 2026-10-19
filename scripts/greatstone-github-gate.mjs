#!/usr/bin/env node
// The release gate on GitHub (see doc/GREATSTONE-WAY-OF-WORKING.md, step 3).
//
//   node scripts/greatstone-github-gate.mjs <commit sha> [--wait <seconds>] [--json]
//
// A commit may be released only when Fork CI (.github/workflows/fork-ci.yml),
// with the full test matrix, is green for it on GitHub. Two ways count:
//
//   1. a push or manual run on exactly that commit (every merge to main gets one);
//   2. a pull request run whose tested merge commit has the same tree as this
//      commit (a merge of that pull request into main gives the same files
//      the pull request run tested, so it needs no second run).
//
// Green means: every job of the run that was not skipped succeeded, and all
// the Tests matrix lanes ran (FULL_MATRIX, the lanes of
// scripts/greatstone-test-gate.lanes). Exit codes:
//
//   0 passed   1 failed (names the failing jobs)   2 still running at the end of --wait
//   3 GitHub could not be asked (no gh, no network): use the PC gate instead
//
// GSAM_GITHUB_REPO (default Johnprempeh2/gs-agentic-manager), GSAM_GH_BIN (default gh),
// GSAM_GITHUB_GATE_POLL_SECONDS (default 30).
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The Tests matrix lanes of fork-ci.yml (a test keeps the two in step). */
export const FULL_MATRIX = [
  "server 1/6", "server 2/6", "server 3/6", "server 4/6", "server 5/6", "server 6/6",
  "server chat", "ui and cli", "packages",
  "serialized 1/4", "serialized 2/4", "serialized 3/4", "serialized 4/4",
].map((label) => `Tests (${label})`);
export const WORKFLOW_PATH = ".github/workflows/fork-ci.yml";

class Unreachable extends Error {}

/** One GitHub API call through gh; null on an HTTP error (GitHub answered), Unreachable otherwise. */
export function makeApi({ gh = process.env.GSAM_GH_BIN || "gh", repo = process.env.GSAM_GITHUB_REPO || "Johnprempeh2/gs-agentic-manager" } = {}) {
  return (path, { raw = false } = {}) => {
    const call = (extra) => spawnSync(gh, ["api", ...extra, path.replaceAll("{repo}", repo)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    let r = call([]);
    // Newer gh refuses output with terminal escape sequences (job logs have colour codes) unless
    // told to allow them; older gh has no such flag, so only ask when gh says it needs it.
    if (r.status !== 0 && /--allow-escape-sequences/.test(`${r.stderr}${r.stdout}`)) r = call(["--allow-escape-sequences"]);
    if (r.error) throw new Unreachable(`${gh}: ${r.error.message}`);
    if (r.status !== 0) {
      const why = `${r.stderr || r.stdout}`.trim().split("\n")[0] ?? "";
      if (/HTTP \d{3}/.test(why)) return null;
      throw new Unreachable(why || `${gh} api exited ${r.status}`);
    }
    if (raw) return r.stdout;
    try { return JSON.parse(r.stdout); } catch { throw new Unreachable(`${gh} api ${path}: not JSON`); }
  };
}

/** passed | failed | pending, with the failing or missing job names. Pure. */
export function judgeJobs(jobs) {
  const ran = jobs.filter((j) => !(j.status === "completed" && j.conclusion === "skipped"));
  const running = ran.filter((j) => j.status !== "completed").map((j) => j.name);
  const failing = ran.filter((j) => j.status === "completed" && j.conclusion !== "success").map((j) => `${j.name} (${j.conclusion})`);
  const missing = FULL_MATRIX.filter((name) => !ran.some((j) => j.name === name));
  if (failing.length) return { state: "failed", names: failing };
  if (running.length) return { state: "pending", names: running };
  if (missing.length) return { state: "incomplete", names: missing };
  return { state: "passed", names: [] };
}

const forkCiRuns = (api, sha, events) =>
  (api(`repos/{repo}/actions/runs?head_sha=${sha}&per_page=50`)?.workflow_runs ?? [])
    .filter((r) => r.path === WORKFLOW_PATH && events.includes(r.event))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

const runJobs = (api, run) => api(`repos/{repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`)?.jobs ?? [];

/** The merge commit a pull request run tested, read from its checkout step. */
export function testedCommitFromLog(log) {
  return /fetch .* origin \+([0-9a-f]{40}):refs\/remotes\/pull\/\d+\/merge/.exec(log)?.[1] ?? null;
}

/** One look at GitHub: { state, message, names }. */
export function checkOnce(api, sha) {
  // 1. A run on exactly this commit.
  const direct = forkCiRuns(api, sha, ["push", "workflow_dispatch"]);
  let pending = null;
  for (const run of direct) {
    const verdict = judgeJobs(runJobs(api, run));
    if (verdict.state === "passed") return { state: "passed", message: `GitHub: the full test matrix passed on ${sha.slice(0, 9)} (${run.event} run ${run.html_url ?? run.id})`, names: [] };
    if (verdict.state === "failed") return { state: "failed", message: `GitHub: Fork CI failed on ${sha.slice(0, 9)} (${run.html_url ?? run.id}): ${verdict.names.join(", ")}`, names: verdict.names };
    if (verdict.state === "pending") pending ??= { run, names: verdict.names };
  }
  // 2. A pull request run that tested the same tree.
  const tree = api(`repos/{repo}/git/commits/${sha}`)?.tree?.sha ?? null;
  if (tree) {
    for (const pr of api(`repos/{repo}/commits/${sha}/pulls`) ?? []) {
      const head = pr.head?.sha;
      if (!head) continue;
      for (const run of forkCiRuns(api, head, ["pull_request"])) {
        const jobs = runJobs(api, run);
        const verdict = judgeJobs(jobs);
        if (verdict.state !== "passed") {
          if (verdict.state === "pending") pending ??= { run, names: verdict.names };
          continue;
        }
        // A job that checked the code out (the result job does not); the guard's log is the smallest.
        const job = jobs.find((j) => j.name === "Rebrand and workflow guard") ?? jobs.find((j) => FULL_MATRIX.includes(j.name));
        const tested = job ? testedCommitFromLog(api(`repos/{repo}/actions/jobs/${job.id}/logs`, { raw: true }) ?? "") : null;
        if (tested && api(`repos/{repo}/git/commits/${tested}`)?.tree?.sha === tree) {
          return {
            state: "passed",
            message: `GitHub: the full test matrix passed on pull request #${pr.number} (run ${run.html_url ?? run.id}), whose tested merge ${tested.slice(0, 9)} has the same files as ${sha.slice(0, 9)}`,
            names: [],
          };
        }
      }
    }
  }
  if (pending) return { state: "pending", message: `GitHub: Fork CI is still running for ${sha.slice(0, 9)} (${pending.run.html_url ?? pending.run.id}): ${pending.names.join(", ")}`, names: pending.names };
  return { state: "pending", message: `GitHub: no full Fork CI run has passed on ${sha.slice(0, 9)} or on a pull request with the same files yet`, names: [] };
}

/** Waits up to `waitMs` for a verdict. */
export async function check(api, sha, { waitMs = 0, pollMs = 30_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = {}) {
  const deadline = now() + waitMs;
  for (;;) {
    let result;
    try {
      result = checkOnce(api, sha);
    } catch (error) {
      if (error instanceof Unreachable) return { state: "unreachable", message: `GitHub could not be asked: ${error.message}`, names: [] };
      throw error;
    }
    if (result.state !== "pending" || now() >= deadline) return result;
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}

const EXIT = { passed: 0, failed: 1, pending: 2, unreachable: 3 };

async function main(argv) {
  const args = [...argv];
  const opt = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
  const waitSeconds = Number(opt("--wait") ?? 0);
  const json = args.includes("--json") && args.splice(args.indexOf("--json"), 1);
  const sha = args[0] ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha) || args.length !== 1) {
    process.stderr.write("usage: greatstone-github-gate.mjs <full commit sha> [--wait <seconds>] [--json]\n");
    return 64;
  }
  const result = await check(makeApi(), sha, { waitMs: waitSeconds * 1000, pollMs: Number(process.env.GSAM_GITHUB_GATE_POLL_SECONDS || 30) * 1000 });
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${result.message}\n`);
  return EXIT[result.state];
}

// realpath: on macOS a temp path under /var is /private/var to import.meta.url.
const invokedAs = (() => { try { return pathToFileURL(realpathSync(process.argv[1] ?? "")).href; } catch { return ""; } })();
if (import.meta.url === invokedAs) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    process.stderr.write(`github-gate: ${error.message}\n`);
    process.exit(3);
  });
}
