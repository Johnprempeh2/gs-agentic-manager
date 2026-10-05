#!/usr/bin/env node
// Local CI fallback (GRE-201): when GitHub cannot start Fork CI on a pull
// request, run the same fast lanes (guard, typecheck, build) on this Mac and
// post the result as the commit status "local-ci" and a PR comment.
//
//   node scripts/greatstone-local-ci.mjs detect <pr>          could GitHub start Fork CI? exit 0 = no, fallback allowed
//   node scripts/greatstone-local-ci.mjs run <pr> [--dry-run] run the lanes and post "local-ci" (dry run: post nothing)
//   node scripts/greatstone-local-ci.mjs ready <pr>           Keystone's ready check (GRE-605): print a 5-line draft verdict
//
// `ready` reads Fork CI, reruns the PR body's "Tests run" commands, runs the
// S2 page-load check when `pnpm metrics:s2-needed` says yes, and flags "big
// change" triggers in the diff. It only reads from GitHub: it posts, merges
// and changes nothing. Keystone reads the draft and decides.
//
// "Could not start" means the Fork CI run for the PR head has the GitHub
// "job was not started" annotation (the billing stop of 28-29 Sep), or no job
// started within 15 minutes. A run that started and failed is a real result:
// the fallback is refused and the author fixes the branch.
//
// One check at a time: a lock under <repo>/.gsam/local-ci (shared by every
// worktree) makes a second caller wait. Before the lanes start, the host must
// pass the RAM guard of the run admission (at least 2 GB available and no
// warn/critical memory pressure); otherwise the script waits.
//
// The lanes run in one reused worktree, <repo>/.gsam/local-ci/work, detached at
// the PR head, with a small environment: no GSAM_* variables, no tokens.
// Nothing under ~/GSAM is read or written.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const REPO = process.env.GS_LOCAL_CI_REPO || "Johnprempeh2/gs-agentic-manager";
export const STATUS_CONTEXT = "local-ci";
export const WORKFLOW_FILE = "fork-ci.yml";
export const NO_START_MINUTES = 15;
export const MIN_FREE_MB = Number(process.env.GS_LOCAL_CI_MIN_FREE_MB || 2048);
const WAIT_POLL_MS = 30_000;
const MAX_WAIT_MS = Number(process.env.GS_LOCAL_CI_MAX_WAIT_MINUTES || 60) * 60_000;

// Same order and commands as the fast lanes in .github/workflows/fork-ci.yml.
export const LANES = [
  { name: "guard", commands: [["node", "scripts/greatstone-rebrand.mjs", "--check"], ["node", "scripts/check-fork-workflows.mjs"]] },
  { name: "install", commands: [["pnpm", "install", "--frozen-lockfile", "--config.confirm-modules-purge=false"]] },
  { name: "typecheck", commands: [["pnpm", "typecheck"]] },
  { name: "build", commands: [["pnpm", "build"]] },
];

// GitHub's annotation when a job never got a runner (billing stop, spending limit).
const NOT_STARTED = /The job was not started because/i;
const BILLING = /recent account payments have failed|spending limit needs to be increased/i;

/** Reads `gh run view` text: did GitHub refuse to start the jobs? */
export function classifyRunView(text) {
  if (!NOT_STARTED.test(text)) return { notStarted: false, reason: null };
  return { notStarted: true, reason: BILLING.test(text) ? "billing" : "not-started" };
}

/**
 * Decides whether the fallback may run for one PR head.
 *   runs      Fork CI runs for the head commit ({ databaseId, status, conclusion, createdAt })
 *   viewText  `gh run view` of the newest run (only needed when it completed)
 *   headAt    when the head commit reached GitHub (ISO), used when no run exists
 */
export function decideFallback({ runs, viewText = "", headAt, now = new Date() }) {
  const minutes = (iso) => (now.getTime() - new Date(iso).getTime()) / 60_000;
  const newest = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!newest) {
    if (headAt && minutes(headAt) >= NO_START_MINUTES) {
      return { fallback: true, reason: `no Fork CI run ${NO_START_MINUTES}+ minutes after the push` };
    }
    return { fallback: false, reason: "no Fork CI run yet; wait 15 minutes" };
  }
  if (newest.status === "completed") {
    const seen = classifyRunView(viewText);
    if (seen.notStarted) {
      return { fallback: true, reason: seen.reason === "billing" ? "GitHub did not start the jobs (billing stop)" : "GitHub did not start the jobs" };
    }
    return { fallback: false, reason: `Fork CI ran: ${newest.conclusion}` };
  }
  if (["queued", "waiting", "pending", "requested"].includes(newest.status) && minutes(newest.createdAt) >= NO_START_MINUTES) {
    return { fallback: true, reason: `Fork CI still ${newest.status} after ${NO_START_MINUTES}+ minutes` };
  }
  return { fallback: false, reason: `Fork CI is ${newest.status}; wait for it` };
}

/** available = free + inactive + purgeable pages, as in server/src/services/run-admission.ts. */
export function parseVmStatAvailableBytes(output) {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
  const pages = (label) => {
    const m = new RegExp(`^Pages ${label}:\\s+(\\d+)`, "m").exec(output);
    return m ? Number(m[1]) : null;
  };
  const free = pages("free");
  const inactive = pages("inactive");
  if (free === null || inactive === null) return null;
  return (free + inactive + (pages("purgeable") ?? 0)) * pageSize;
}

/** The RAM guard: busy below the floor or at warn/critical pressure. Fails open when memory cannot be read. */
export function ramGuard({ availableBytes, pressureLevel, minFreeMb = MIN_FREE_MB }) {
  const level = String(pressureLevel ?? "").trim();
  if (level === "2" || level === "4") return { busy: true, message: `memory pressure ${level === "2" ? "warn" : "critical"}` };
  if (availableBytes != null && availableBytes < minFreeMb * 1024 * 1024) {
    return { busy: true, message: `${(availableBytes / 1024 ** 3).toFixed(1)} GB available, floor ${(minFreeMb / 1024).toFixed(1)} GB` };
  }
  return { busy: false, message: "memory ok" };
}

function readRamGuard() {
  if (process.platform !== "darwin") return ramGuard({ availableBytes: os.freemem() });
  const text = (cmd, args) => {
    try {
      return execFileSync(cmd, args, { encoding: "utf8", timeout: 2000 });
    } catch {
      return "";
    }
  };
  return ramGuard({
    availableBytes: parseVmStatAvailableBytes(text("vm_stat", [])),
    pressureLevel: text("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** One check at a time. mkdir is atomic; a lock whose process is gone is taken over. */
export function tryLock(lockDir, pid = process.pid) {
  try {
    mkdirSync(lockDir);
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    let holder = 0;
    try {
      holder = Number(readFileSync(join(lockDir, "pid"), "utf8").trim());
    } catch {}
    if (holder && pidAlive(holder)) return { ok: false, holder };
    // No pid yet: another caller made the lock a moment ago and is writing it.
    if (!holder && Date.now() - statSync(lockDir).mtimeMs < 10_000) return { ok: false, holder: "starting" };
    rmSync(lockDir, { recursive: true, force: true });
    return tryLock(lockDir, pid);
  }
  writeFileSync(join(lockDir, "pid"), String(pid));
  return { ok: true };
}

export function unlock(lockDir) {
  rmSync(lockDir, { recursive: true, force: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (msg) => process.stderr.write(`local-ci: ${msg}\n`);

async function waitFor(what, check) {
  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    const result = check();
    if (result.ok) return;
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}: ${result.message}`);
    say(`waiting for ${what}: ${result.message}`);
    await sleep(WAIT_POLL_MS);
  }
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function prHead(pr) {
  const info = JSON.parse(gh(["pr", "view", String(pr), "-R", REPO, "--json", "headRefOid,baseRefOid,state,commits,isCrossRepository,author,body"]));
  const last = info.commits?.[info.commits.length - 1];
  return {
    sha: info.headRefOid,
    baseSha: info.baseRefOid ?? null,
    state: info.state,
    headAt: last?.committedDate ?? null,
    isCrossRepository: info.isCrossRepository,
    author: info.author?.login ?? null,
    body: info.body ?? "",
  };
}

// The repo is public and the lanes run `pnpm install` on the host of the live
// app with HOME set, so only branches on REPO itself (agent PRs) may run here.
// Fails closed: anything but an explicit `false` is refused.
export function sameRepoCheck(head) {
  if (head.isCrossRepository === false) return { ok: true, reason: null };
  const who = head.author ? ` by ${head.author}` : "";
  const why = head.isCrossRepository === true ? `head is on a fork${who}` : "GitHub did not say where the head is";
  return { ok: false, reason: `${why}; local-ci only runs PRs from branches on ${REPO}` };
}

export function detect(pr, { now = new Date() } = {}) {
  const head = prHead(pr);
  const runs = JSON.parse(
    gh(["run", "list", "-R", REPO, "--workflow", WORKFLOW_FILE, "--commit", head.sha, "--json", "databaseId,status,conclusion,createdAt,event"]),
  );
  const newest = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const viewText = newest?.status === "completed" ? gh(["run", "view", String(newest.databaseId), "-R", REPO]) : "";
  return { head, run: newest ?? null, ...decideFallback({ runs, viewText, headAt: head.headAt, now }) };
}

// Only what the build needs; the PR code never sees agent or GitHub tokens.
function laneEnv() {
  const keep = ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "LANG", "TMPDIR", "CARGO_HOME", "RUSTUP_HOME"];
  const env = { CI: "true", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", GSAM_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" };
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return env;
}

function runCommand(cmd, args, cwd, logFile, { timeoutMs } = {}) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd, env: laneEnv(), stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
    let log = "";
    const add = (chunk) => {
      log += chunk;
      if (logFile) writeFileSync(logFile, chunk, { flag: "a" });
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    child.on("error", (err) => {
      add(`${err.message}\n`);
      done({ code: 127, log });
    });
    child.on("close", (code, signal) => {
      if (signal) add(`stopped by ${signal}${timeoutMs ? ` (time limit ${Math.round(timeoutMs / 60_000)} min)` : ""}\n`);
      done({ code: code ?? 1, log });
    });
  });
}

export async function runLanes(workDir, { lanes = LANES, logDir } = {}) {
  const results = [];
  for (const lane of lanes) {
    const started = Date.now();
    let failed = null;
    for (const [cmd, ...args] of lane.commands) {
      say(`${lane.name}: ${cmd} ${args.join(" ")}`);
      const { code, log } = await runCommand(cmd, args, workDir, logDir ? join(logDir, `${lane.name}.log`) : null);
      if (code !== 0) {
        failed = { command: `${cmd} ${args.join(" ")}`, code, tail: log.split("\n").slice(-30).join("\n") };
        break;
      }
    }
    results.push({ name: lane.name, ok: !failed, seconds: Math.round((Date.now() - started) / 1000), failed });
    if (failed) break; // later lanes need the install; stop at the first failure
  }
  return results;
}

export function summarize(results, sha, reason) {
  const ok = results.length === LANES.length && results.every((r) => r.ok);
  const short = sha.slice(0, 7);
  const lines = results.map((r) => `- ${r.ok ? "pass" : "FAIL"} ${r.name} (${r.seconds}s)`);
  const failed = results.find((r) => !r.ok)?.failed;
  const body = [
    `**local-ci: ${ok ? "success" : "failure"}** on \`${short}\``,
    "",
    `GitHub could not run Fork CI (${reason}), so the fast lanes ran on the Mac (scripts/greatstone-local-ci.mjs, GRE-201).`,
    "",
    ...lines,
    ...(failed ? ["", `\`${failed.command}\` exited ${failed.code}. Last lines:`, "", "```", failed.tail, "```"] : []),
  ].join("\n");
  return {
    state: ok ? "success" : "failure",
    description: ok ? `guard, typecheck, build pass on the Mac (${reason})`.slice(0, 140) : `${failed?.command ?? "lanes"} failed`.slice(0, 140),
    body,
  };
}

function repoRoot() {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
  return resolve(common, "..");
}

function prepareWorktree(root, workDir, pr, sha) {
  execFileSync("git", ["-C", root, "fetch", "--quiet", "origin", `+refs/pull/${pr}/head:refs/local-ci/pr-${pr}`]);
  if (!existsSync(join(workDir, ".git"))) {
    execFileSync("git", ["-C", root, "worktree", "add", "--quiet", "--detach", workDir, sha]);
  } else {
    execFileSync("git", ["-C", workDir, "checkout", "--quiet", "--force", "--detach", sha]);
  }
  const at = execFileSync("git", ["-C", workDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (at !== sha) throw new Error(`worktree is at ${at}, expected ${sha}`);
}

async function cmdRun(pr, { dryRun }) {
  const found = detect(pr);
  say(`PR #${pr} head ${found.head.sha.slice(0, 7)} (${found.head.state}): ${found.reason}`);
  if (found.head.state !== "OPEN") throw new Error(`PR #${pr} is ${found.head.state}`);
  const origin = sameRepoCheck(found.head);
  if (!origin.ok) throw new Error(`refused: ${origin.reason}.`); // also with --dry-run
  if (!found.fallback && !dryRun) {
    throw new Error(`fallback refused: ${found.reason}. local-ci only runs when GitHub could not start Fork CI.`);
  }
  const reason = found.fallback ? found.reason : `dry run; ${found.reason}`;

  return inWorkTree(pr, found.head.sha, async ({ workDir, logDir }) => {
    say(`lanes run in ${workDir}; logs in ${logDir}`);
    const results = await runLanes(workDir, { logDir });
    const out = summarize(results, found.head.sha, reason);
    const statusArgs = ["api", "-X", "POST", `repos/${REPO}/statuses/${found.head.sha}`, "-f", `state=${out.state}`, "-f", `context=${STATUS_CONTEXT}`, "-f", `description=${out.description}`];
    if (dryRun) {
      say("dry run: nothing posted. Would run:");
      process.stdout.write(`gh ${statusArgs.map((a) => JSON.stringify(a)).join(" ")}\n\n${out.body}\n`);
    } else {
      gh(statusArgs);
      gh(["pr", "comment", String(pr), "-R", REPO, "--body", out.body]);
      process.stdout.write(`${out.body}\n`);
    }
    return out.state === "success" ? 0 : 1;
  });
}

// The lock, the RAM guard and the reused worktree at the PR head, shared by `run` and `ready`.
async function inWorkTree(pr, sha, fn, { logName = "" } = {}) {
  const base = join(repoRoot(), ".gsam", "local-ci");
  mkdirSync(base, { recursive: true });
  const lockDir = join(base, "lock");
  await waitFor("the other local check", () => {
    const lock = tryLock(lockDir);
    return { ok: lock.ok, message: `pid ${lock.holder} holds ${lockDir}` };
  });
  try {
    await waitFor("free memory (RAM guard)", () => {
      const g = readRamGuard();
      return { ok: !g.busy, message: g.message };
    });
    const workDir = join(base, "work");
    prepareWorktree(repoRoot(), workDir, pr, sha);
    const logDir = join(base, "logs", `pr-${pr}-${sha.slice(0, 7)}${logName}`);
    rmSync(logDir, { recursive: true, force: true });
    mkdirSync(logDir, { recursive: true });
    return await fn({ workDir, logDir });
  } finally {
    unlock(lockDir);
  }
}

// ---- ready <pr>: Keystone's ready check (GRE-605) -------------------------

// Programs a "Tests run" line may start with. vitest/tsc/playwright run through `pnpm exec`.
const TEST_RUNNERS = new Set(["pnpm", "npx", "node", "npm"]);
const VIA_PNPM_EXEC = new Set(["vitest", "tsc", "playwright"]);
// Shell syntax is not run: the commands run without a shell. `*` and `?` pass as-is.
const SHELL_SYNTAX = /[$`|;&<>()]/;
const TEST_TIMEOUT_MS = Number(process.env.GS_LOCAL_CI_TEST_TIMEOUT_MINUTES || 20) * 60_000;

function splitWords(text) {
  const words = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m; (m = re.exec(text)); ) words.push(m[1] ?? m[2] ?? m[3]);
  return words;
}

/** Why a "Tests run" command is not rerun, or null when it is. */
function skipReason(argv) {
  const [cmd, sub] = argv;
  if (cmd === "pnpm" && /^(dev|start|install|i|add)(:|$)/.test(sub ?? "")) return "starts a server or installs";
  if (cmd === "pnpm" && /^(metrics:s2-needed|test:metrics:s2)$/.test(sub ?? "")) return "the S2 step runs it";
  if (argv.some((a) => /greatstone-local-ci\.mjs$/.test(a))) return "this script";
  return null;
}

/**
 * Reads the "Tests run" section of a PR body. Each list item's first code span
 * that starts with a test runner is one command. `dir: cmd` and `cd dir && cmd`
 * run in that directory. Returns { found, commands: [{ text, cwd, argv } | { text, skip }] }.
 */
export function parseTestsRun(body) {
  const lines = String(body ?? "").split(/\r?\n/);
  const start = lines.findIndex(
    (l) => /^\s*(#{1,6}\s*|\*\*)\s*(tests?(\s+(run|ran))?|testing|verification)\b/i.test(l) || /^\s*tests?\s+(run|ran)\b/i.test(l),
  );
  if (start === -1) return { found: false, commands: [] };
  const commands = [];
  const seen = new Set();
  for (const line of lines.slice(start + 1)) {
    if (/^\s*#{1,6}\s/.test(line) || /^\s*\*\*[^*]+\*\*:?\s*$/.test(line)) break;
    if (!/^\s*([-*+]|\d+\.)\s/.test(line)) continue;
    for (const [, span] of line.matchAll(/`([^`]+)`/g)) {
      let text = span.trim();
      let cwd = ".";
      const cd = /^cd\s+([\w@.\/-]+)\s*&&\s*(.+)$/.exec(text);
      const prefix = /^([\w@.\/-]+):\s+(.+)$/.exec(text);
      if (cd) [cwd, text] = [cd[1], cd[2].trim()];
      else if (prefix) [cwd, text] = [prefix[1], prefix[2].trim()];
      const first = text.split(/\s+/)[0];
      if (!TEST_RUNNERS.has(first) && !VIA_PNPM_EXEC.has(first)) continue;
      const key = `${cwd}\0${text}`;
      if (seen.has(key)) break;
      seen.add(key);
      const shown = cwd === "." ? text : `${cwd}: ${text}`;
      if (cwd.startsWith("/") || cwd.split("/").includes("..")) commands.push({ text: shown, skip: "directory is outside the checkout" });
      else if (SHELL_SYNTAX.test(text)) commands.push({ text: shown, skip: "uses shell syntax" });
      else {
        const argv = splitWords(text);
        if (VIA_PNPM_EXEC.has(argv[0])) argv.unshift("pnpm", "exec");
        const skip = skipReason(argv);
        commands.push(skip ? { text: shown, skip } : { text: shown, cwd, argv });
      }
      break; // one command per list item
    }
  }
  return { found: true, commands };
}

const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(\/__tests__\/)|(^tests\/)|(\/fixtures?\/)|(\/__fixtures__\/)/;
const LOCKFILE = /(^|\/)pnpm-lock\.yaml$/;
export const BIG_CHANGE_LINES = 1000;

// "Big change" triggers (doc/GREATSTONE-WAY-OF-WORKING.md, merge rule): Flint checks these before merge.
export const BIG_CHANGE_RULES = [
  { name: "migrations", test: (f) => /(^|\/)migrations\//.test(f) },
  { name: "auth/permissions", test: (f) => !TEST_FILE.test(f) && /^(server|packages)\//.test(f) && /(^|[\/_.-])(\w*auth\w*|permissions?|access|grants?|jwt)([\/_.-]|$)/i.test(f) },
  { name: "release scripts", test: (f) => !TEST_FILE.test(f) && /^scripts\/greatstone-/.test(f) },
  { name: "CI files", test: (f) => /^\.github\/(workflows|actions)\//.test(f) },
];

/** Parses `git diff --numstat` output into { file, lines }. Binary files count 0 lines. */
export function parseNumstat(text) {
  return String(text)
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [added, deleted, ...rest] = l.split("\t");
      return { file: rest.join("\t"), lines: (Number(added) || 0) + (Number(deleted) || 0) };
    });
}

/** Which big-change triggers a diff hits. Lines outside tests leave out the lockfile. */
export function bigChange(files) {
  const triggers = [];
  for (const rule of BIG_CHANGE_RULES) {
    const hit = files.filter((f) => rule.test(f.file)).map((f) => f.file);
    if (hit.length) triggers.push({ name: rule.name, files: hit });
  }
  const outsideTests = files.filter((f) => !TEST_FILE.test(f.file) && !LOCKFILE.test(f.file)).reduce((n, f) => n + f.lines, 0);
  if (outsideTests > BIG_CHANGE_LINES) triggers.push({ name: `${outsideTests} changed lines outside tests (> ${BIG_CHANGE_LINES})`, files: [] });
  return { big: triggers.length > 0, triggers, outsideTests };
}

// Added lines that need a human look: the live app's paths and secret-shaped strings.
const DIFF_FLAGS = [
  { name: "~/GSAM path", re: /~\/GSAM\b|\/GSAM\/(live|data)\b/ },
  { name: "secret-shaped string", re: /\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

/** Scans the added lines of a unified diff; returns [{ name, file }] once per flag and file. */
export function scanDiff(diffText) {
  const hits = [];
  let file = null;
  for (const line of String(diffText).split("\n")) {
    if (line.startsWith("+++ ")) file = line.replace(/^\+\+\+ (b\/)?/, "");
    else if (line.startsWith("+") && file && !TEST_FILE.test(file)) {
      for (const flag of DIFF_FLAGS) {
        if (flag.re.test(line) && !hits.some((h) => h.name === flag.name && h.file === file)) hits.push({ name: flag.name, file });
      }
    }
  }
  return hits;
}

/** Fork CI (or local-ci when GitHub could not start it) for the head commit. */
export function ciState({ runs = [], localCi = null }) {
  const newest = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const fork = !newest ? "no run" : newest.status === "completed" ? newest.conclusion : newest.status;
  const ok = fork === "success" || localCi === "success";
  const text = `Fork CI ${fork}${newest ? ` (run ${newest.databaseId})` : ""}${localCi ? `; local-ci ${localCi}` : ""}`;
  return { ok, text };
}

const list = (items, n = 3) => (items.length > n ? `${items.slice(0, n).join(", ")} +${items.length - n} more` : items.join(", "));

/**
 * The 5-line draft. tests = { found, results: [{ text, ok?, skip? }] };
 * s2 = { needed, ok, text }; big = bigChange(); flags = scanDiff().
 */
export function draftVerdict({ pr, sha, ci, tests, s2, big, flags }) {
  const ran = tests.results.filter((r) => !r.skip);
  const failed = ran.filter((r) => !r.ok);
  const skipped = tests.results.filter((r) => r.skip);
  const why = [];
  if (!ci.ok) why.push(`CI is not green (${ci.text})`);
  if (!tests.found) why.push('the PR body has no "Tests run" section');
  else if (!ran.length) why.push("the PR names no test command this check can rerun");
  if (failed.length) why.push(`${failed.length} named test command(s) failed: ${list(failed.map((r) => `\`${r.text}\``), 2)}`);
  if (s2.needed && !s2.ok) why.push(`the S2 page-load check did not pass (${s2.text})`);
  const testsLine = !tests.found
    ? 'no "Tests run" section in the PR body'
    : `${ran.length - failed.length} of ${ran.length} rerun commands pass${failed.length ? `; FAIL: ${list(failed.map((r) => `\`${r.text}\``), 2)}` : ""}${skipped.length ? `; ${skipped.length} not rerun (${list([...new Set(skipped.map((r) => r.skip))])})` : ""}`;
  const bigLine = big.big ? `yes: ${big.triggers.map((t) => (t.files.length ? `${t.name} (${list(t.files, 2)})` : t.name)).join("; ")}` : `no (${big.outsideTests} changed lines outside tests)`;
  const flagLine = flags.length ? `; check by hand: ${list(flags.map((f) => `${f.name} in ${f.file}`), 3)}` : "";
  const verdict = why.length ? `Not ready, because ${why.join("; ")}` : big.big ? "Ready to merge after Flint's checks (big change)" : "Ready to merge";
  return [
    `1. CI (PR #${pr} at ${sha.slice(0, 7)}): ${ci.ok ? "green" : "NOT green"}; ${ci.text}`,
    `2. Tests run: ${testsLine}`,
    `3. S2 page-load: ${s2.needed ? `${s2.ok ? "pass" : "FAIL"}; ${s2.text}` : `not needed; ${s2.text}`}`,
    `4. Big change: ${bigLine}${flagLine}`,
    `5. Draft verdict: ${verdict}. Keystone also checks the issue's "Done when" list.`,
  ];
}

const tail = (log, n) => log.trim().split("\n").slice(-n).join("\n");

async function cmdReady(pr) {
  const head = prHead(pr);
  say(`PR #${pr} head ${head.sha.slice(0, 7)} (${head.state})`);
  const origin = sameRepoCheck(head);
  if (!origin.ok) throw new Error(`refused: ${origin.reason}.`);
  const runs = JSON.parse(gh(["run", "list", "-R", REPO, "--workflow", WORKFLOW_FILE, "--commit", head.sha, "--json", "databaseId,status,conclusion,createdAt,event"]));
  const statuses = JSON.parse(gh(["api", `repos/${REPO}/commits/${head.sha}/statuses`]));
  const localCi = statuses.find((s) => s.context === STATUS_CONTEXT)?.state ?? null; // newest first
  const ci = ciState({ runs, localCi });
  const parsed = parseTestsRun(head.body);

  return inWorkTree(pr, head.sha, async ({ workDir, logDir }) => {
    const git = (...args) => execFileSync("git", ["-C", workDir, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (!head.baseSha) throw new Error("GitHub did not give the PR base commit");
    git("fetch", "--quiet", "origin", head.baseSha);
    const mergeBase = git("merge-base", head.baseSha, head.sha).trim();
    const files = parseNumstat(git("diff", "--numstat", "--no-renames", mergeBase, head.sha));
    const big = bigChange(files);
    const flags = scanDiff(git("diff", "--no-renames", "--unified=0", mergeBase, head.sha));
    say(`diff ${mergeBase.slice(0, 7)}..${head.sha.slice(0, 7)}: ${files.length} files; logs in ${logDir}`);

    const install = await runLanes(workDir, { lanes: [LANES.find((l) => l.name === "install")], logDir });
    const results = [];
    for (const c of parsed.commands) {
      if (c.skip) {
        say(`not rerun (${c.skip}): ${c.text}`);
        results.push({ text: c.text, skip: c.skip });
        continue;
      }
      if (!install[0].ok) {
        results.push({ text: c.text, ok: false });
        continue;
      }
      const cwd = resolve(workDir, c.cwd);
      if (!existsSync(cwd)) {
        say(`FAIL ${c.text}: no directory ${c.cwd}`);
        results.push({ text: c.text, ok: false });
        continue;
      }
      say(`rerun: ${c.text}`);
      const [cmd, ...args] = c.argv;
      const { code, log } = await runCommand(cmd, args, cwd, join(logDir, "tests.log"), { timeoutMs: TEST_TIMEOUT_MS });
      if (code !== 0) say(`FAIL (exit ${code}) ${c.text}\n${tail(log, 20)}`);
      results.push({ text: c.text, ok: code === 0 });
    }

    let s2 = { needed: false, ok: true, text: "pnpm metrics:s2-needed could not run" };
    if (install[0].ok) {
      const needed = await runCommand("pnpm", ["metrics:s2-needed", "--base", mergeBase], workDir, join(logDir, "s2.log"));
      const answer = /S2 page-load check needed: (yes|no)/.exec(needed.log)?.[1];
      if (!answer) s2 = { needed: true, ok: false, text: `pnpm metrics:s2-needed gave no answer (exit ${needed.code})` };
      else if (answer === "no") s2 = { needed: false, ok: true, text: "pnpm metrics:s2-needed says no" };
      else {
        // The machine is shared, so one slow run can be noise: a FAIL is run once more.
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          say(`S2 page-load check, attempt ${attempt}: pnpm test:metrics:s2`);
          const run = await runCommand("pnpm", ["test:metrics:s2"], workDir, join(logDir, "s2.log"), { timeoutMs: TEST_TIMEOUT_MS });
          process.stderr.write(`${tail(run.log, 8)}\n`);
          const verdictLine = run.log.split("\n").findLast((l) => /S2 page-load check: (PASS|FAIL)/.test(l))?.trim();
          s2 = { needed: true, ok: run.code === 0, text: `${verdictLine ?? `pnpm test:metrics:s2 exit ${run.code}`}${attempt > 1 ? " (second run)" : ""}` };
          if (s2.ok) break;
        }
      }
    } else {
      s2 = { needed: true, ok: false, text: "pnpm install failed, so nothing ran" };
    }

    const lines = draftVerdict({ pr, sha: head.sha, ci, tests: { found: parsed.found, results }, s2, big, flags });
    process.stdout.write(`${lines.join("\n")}\n`);
    return lines[4].includes("Not ready") ? 1 : 0;
  }, { logName: "-ready" });
}

async function main(argv) {
  const [command, prArg, ...rest] = argv;
  const pr = Number(prArg);
  if (!["detect", "run", "ready"].includes(command) || !Number.isInteger(pr) || pr <= 0) {
    process.stderr.write("usage: greatstone-local-ci.mjs detect <pr> | run <pr> [--dry-run] | ready <pr>\n");
    return 2;
  }
  if (command === "ready") return cmdReady(pr);
  if (command === "detect") {
    const found = detect(pr);
    process.stdout.write(`${JSON.stringify({ pr, sha: found.head.sha, run: found.run?.databaseId ?? null, fallback: found.fallback, reason: found.reason })}\n`);
    return found.fallback ? 0 : 1;
  }
  return cmdRun(pr, { dryRun: rest.includes("--dry-run") });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      say(err.message);
      process.exit(3);
    },
  );
}
