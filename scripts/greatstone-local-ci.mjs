#!/usr/bin/env node
// Local CI fallback (GRE-201): when GitHub cannot start Fork CI on a pull
// request, run the same fast lanes (guard, typecheck, build) on this Mac and
// post the result as the commit status "local-ci" and a PR comment.
//
//   node scripts/greatstone-local-ci.mjs detect <pr>          could GitHub start Fork CI? exit 0 = no, fallback allowed
//   node scripts/greatstone-local-ci.mjs run <pr> [--dry-run] run the lanes and post "local-ci" (dry run: post nothing)
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
  const info = JSON.parse(gh(["pr", "view", String(pr), "-R", REPO, "--json", "headRefOid,state,commits,isCrossRepository,author"]));
  const last = info.commits?.[info.commits.length - 1];
  return {
    sha: info.headRefOid,
    state: info.state,
    headAt: last?.committedDate ?? null,
    isCrossRepository: info.isCrossRepository,
    author: info.author?.login ?? null,
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

function runCommand(cmd, args, cwd, logFile) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd, env: laneEnv(), stdio: ["ignore", "pipe", "pipe"] });
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
    child.on("close", (code) => done({ code: code ?? 1, log }));
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
    prepareWorktree(repoRoot(), workDir, pr, found.head.sha);
    const logDir = join(base, "logs", `pr-${pr}-${found.head.sha.slice(0, 7)}`);
    rmSync(logDir, { recursive: true, force: true });
    mkdirSync(logDir, { recursive: true });
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
  } finally {
    unlock(lockDir);
  }
}

async function main(argv) {
  const [command, prArg, ...rest] = argv;
  const pr = Number(prArg);
  if (!["detect", "run"].includes(command) || !Number.isInteger(pr) || pr <= 0) {
    process.stderr.write("usage: greatstone-local-ci.mjs detect <pr> | run <pr> [--dry-run]\n");
    return 2;
  }
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
