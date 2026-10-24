#!/usr/bin/env node
// The release queue (see doc/GREATSTONE-WAY-OF-WORKING.md, "The release queue").
// One queue on the PC that every release request feeds: the Releases page in
// the app, Claude sessions over SSH and agents (Keystone, through the same API).
// One worker works through it in order, and keeps every safety step:
//
//   gate       Fork CI's full test matrix green on GitHub for the exact commit,
//              or for the pull request run that tested the same files
//              (scripts/greatstone-github-gate.mjs); it waits while CI runs.
//              The PC test gate (scripts/greatstone-test-gate.sh) runs instead
//              only for a request made with --pc-gate (never on its own: 18 Oct crash).
//   candidate  an rc-* tag with a title and changelog (scripts/greatstone-candidate.mjs)
//   preview    the candidate on a copy of the live data, then its switch tests;
//              skipped when the release changes nothing in the database
//              (db_change_check in greatstone-common.sh; when unsure it runs)
//   draining   new agent runs are held (the task drain) for the whole release
//              window; it is never lifted between tries (GRE-2274: runs started
//              in that gap and the drain never finished). Running runs get
//              GSAM_RELEASE_DRAIN_GRACE_SECONDS (5 min) to finish, are then asked
//              on their task to save their work and stop, and after
//              GSAM_RELEASE_DRAIN_STOP_SECONDS (3 min) more are cancelled. Each
//              stopped run is recorded on the request with its task.
//   releasing  scripts/greatstone-release.sh <rc-tag>: backup, tag, switch, restart.
//              The worker holds the release lock (~/GSAM/locks/release.lock)
//              from before the drain to the end, so a release by hand never overlaps.
//              The drain is lifted afterwards, also when the release fails or
//              is cancelled, and every stopped or held task is woken again
//              with a comment ("Paused for release live-…; resuming").
//
// Requests for main that wait next to each other become one release of the
// newest main. With nothing queued, the worker records what GitHub says about
// origin/main for the Releases page; it runs no tests itself.
//
//   node scripts/greatstone-release-queue.mjs enqueue [main | <rc-tag> | <sha>] ["<title>"] [--pc-gate] [--by <who>] [--json]
//   node scripts/greatstone-release-queue.mjs status [--json]
//   node scripts/greatstone-release-queue.mjs cancel <id> [--by <who>] [--json]
//   (options may also come first, then "--" and the arguments)
//   node scripts/greatstone-release-queue.mjs tick     start the worker in the background unless it runs
//                                                      (the PC's watchdog calls this every minute)
//   node scripts/greatstone-release-queue.mjs work     run the worker here until there is nothing to do
//
// State: $GSAM_ROOT/release-queue/queue.json (written whole and renamed, under
// the "release-queue-state" lock), one log per request in logs/<id>.log. The
// live server reads queue.json for the Releases page and calls this script
// to enqueue or cancel, so there is one writer implementation.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, realpathSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { takeLock, titleProblem } from "./greatstone-candidate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const num = (name, fallback) => (Number.isFinite(Number(env[name])) && env[name] !== "" ? Number(env[name]) : fallback);

export function config() {
  const root = env.GSAM_ROOT || join(userInfo().homedir, "GSAM");
  const dir = env.GSAM_RELEASE_QUEUE_DIR || join(root, "release-queue");
  return {
    root,
    dir,
    file: join(dir, "queue.json"),
    logs: join(dir, "logs"),
    repo: env.GSAM_RELEASE_REPO || resolve(here, ".."),
    scripts: env.GSAM_RELEASE_QUEUE_SCRIPTS_DIR || here,
    testGateDir: env.GSAM_TEST_GATE_DIR || join(root, "test-gate"),
    liveDir: env.GSAM_LIVE_DIR || join(root, "live"),
    liveUrl: env.GSAM_LIVE_URL || "http://localhost:3100",
    keyFile: env.GSAM_LIVE_BOARD_KEY_FILE || join(root, "release-board-key"),
    pollMs: num("GSAM_RELEASE_QUEUE_POLL_SECONDS", 30) * 1000,
    drainGraceMs: num("GSAM_RELEASE_DRAIN_GRACE_SECONDS", 300) * 1000,
    drainStopMs: num("GSAM_RELEASE_DRAIN_STOP_SECONDS", 180) * 1000,
    stepWaitMs: num("GSAM_RELEASE_QUEUE_STEP_WAIT_SECONDS", 3600) * 1000,
    githubWaitMs: num("GSAM_GITHUB_GATE_WAIT_SECONDS", 1800) * 1000,
    nice: num("GSAM_RELEASE_QUEUE_NICE", 15),
  };
}

const KEEP_FINISHED = 20;
export const FINAL = new Set(["released", "failed", "cancelled", "merged", "skipped"]);
const RC_TAG = /^rc-\d{4}-\d{2}-\d{2}\.\d+$/;
const SHA = /^[0-9a-f]{7,40}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const oneLine = (v) => String(v ?? "").replace(/[\r\n]+/g, " ").trim();
const LIVE_TAG_LINE = /^Tagged \S+ as (live-\S+?):/m;
/** After the drain's runs are cancelled, how long they may take to show as stopped. */
const STOP_CONFIRM_MS = 60_000;
/** How many times a paused task is tried before the worker leaves it in the log. */
const RESUME_ATTEMPTS = 5;

// ── State ──────────────────────────────────────────────────────────────────

export function load(cfg) {
  try {
    const s = JSON.parse(readFileSync(cfg.file, "utf8"));
    return { items: Array.isArray(s.items) ? s.items : [], main: s.main ?? null, worker: s.worker ?? null, updatedAt: s.updatedAt ?? null };
  } catch {
    return { items: [], main: null, worker: null, updatedAt: null };
  }
}

function save(cfg, state) {
  mkdirSync(cfg.dir, { recursive: true });
  // Keep every open item and the newest finished ones.
  const finished = state.items.filter((i) => FINAL.has(i.status));
  const drop = new Set(finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED)).map((i) => i.id));
  state.items = state.items.filter((i) => !drop.has(i.id));
  state.updatedAt = nowIso();
  const tmp = `${cfg.file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, cfg.file);
}

/** Read, change and write queue.json under its lock; returns what `change` returns. */
export function mutate(cfg, change) {
  const deadline = Date.now() + 10_000;
  let free;
  for (;;) {
    try {
      free = takeLock(cfg.root, "release-queue-state", "greatstone-release-queue.mjs");
      break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    const state = load(cfg);
    const out = change(state);
    save(cfg, state);
    return out;
  } finally {
    free();
  }
}

const patchItem = (cfg, id, patch) =>
  mutate(cfg, (s) => {
    const item = s.items.find((i) => i.id === id);
    if (item) Object.assign(item, patch);
    return item ? { ...item } : null;
  });

// ── Requests ───────────────────────────────────────────────────────────────

export function refProblem(ref) {
  if (ref === "main" || RC_TAG.test(ref) || SHA.test(ref)) return null;
  return `"${oneLine(ref)}" is not something the queue can release: give main, an rc-YYYY-MM-DD.N tag or a commit sha on main`;
}

export function enqueue(cfg, { ref = "main", title = null, by = null, pcGate = false }) {
  const problem = refProblem(ref) ?? (title ? titleProblem(title, ref) : null) ?? (title && title.trim().length > 120 ? "the title must be at most 120 characters" : null);
  if (problem) throw new Error(problem);
  return mutate(cfg, (s) => {
    const item = {
      id: `rq-${randomBytes(3).toString("hex")}`,
      ref,
      title: title ? title.trim() : null,
      requestedBy: by ? oneLine(by) : null,
      pcGate: pcGate === true,
      requestedAt: nowIso(),
      status: "queued",
      step: null,
      detail: null,
      commit: null,
      tag: null,
      liveTag: null,
      reason: null,
      rollback: null,
      backupFile: null,
      mergedInto: null,
      cancelRequested: false,
      startedAt: null,
      finishedAt: null,
    };
    item.log = join(cfg.logs, `${item.id}.log`);
    s.items.push(item);
    return item;
  });
}

/** A queued request is cancelled at once; a running one stops before its next step (never during the release). */
export function cancel(cfg, id, by = null) {
  return mutate(cfg, (s) => {
    const item = s.items.find((i) => i.id === id);
    if (!item) throw new Error(`no request ${oneLine(id)} in the queue`);
    if (FINAL.has(item.status)) throw new Error(`${id} is already ${item.status}`);
    if (item.status === "queued") {
      Object.assign(item, { status: "cancelled", reason: `cancelled by ${oneLine(by) || "someone"}`, finishedAt: nowIso() });
    } else {
      if (item.step === "releasing") throw new Error(`${id} is releasing now; it cannot be stopped. Roll back afterwards if needed.`);
      Object.assign(item, { cancelRequested: true, reason: `cancel asked by ${oneLine(by) || "someone"}` });
    }
    return { ...item };
  });
}

/**
 * The next batch: the first open request, and when it is for main, every
 * queued request for main right behind it (they become one release of the
 * newest main). Pure, for the tests.
 */
export function nextBatch(items) {
  const open = items.filter((i) => i.status === "queued" || i.status === "running");
  const head = open.find((i) => i.status === "running") ?? open[0];
  if (!head) return null;
  const merged = [];
  if (head.ref === "main") {
    for (const i of open.slice(open.indexOf(head) + 1)) {
      if (i.status !== "queued" || i.ref !== "main") break;
      merged.push(i);
    }
  }
  return { head, merged };
}

// ── Git and processes ──────────────────────────────────────────────────────

const git = (cfg, ...args) => {
  const r = spawnSync("git", args, { cwd: cfg.repo, encoding: "utf8", env: { ...env, GIT_TERMINAL_PROMPT: "0" } });
  return r.status === 0 ? r.stdout.trim() : null;
};
const originMain = (cfg) => git(cfg, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{commit}");
const passed = (cfg, commit) => !!commit && existsSync(join(cfg.testGateDir, "passed", commit));
const liveHead = (cfg) => {
  const r = spawnSync("git", ["-C", cfg.liveDir, "rev-parse", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};

/** Runs a command with its output appended to `log`; resolves to { code, out } (out = this run's output). */
function run(cfg, cmd, args, { log, extraEnv = {}, onSpawn } = {}) {
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, "a");
  const from = statSync(log).size;
  const child = spawn(cmd, args, { cwd: cfg.repo, stdio: ["ignore", fd, fd], env: { ...env, GSAM_RELEASE_REPO: cfg.repo, ...extraEnv } });
  closeSync(fd);
  onSpawn?.(child);
  return new Promise((done) => {
    const finish = (code) => {
      let out = "";
      try {
        const size = statSync(log).size - from;
        const buf = Buffer.alloc(Math.max(0, size));
        const rfd = openSync(log, "r");
        readSync(rfd, buf, 0, buf.length, from);
        closeSync(rfd);
        out = buf.toString("utf8");
      } catch {}
      done({ code, out });
    };
    child.on("error", (e) => {
      writeFileSync(log, `${e.message}\n`, { flag: "a" });
      finish(127);
    });
    child.on("exit", (code, signal) => finish(code ?? (signal ? 128 + 15 : 1)));
  });
}

const logLine = (log, text) => {
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, `[${nowIso()}] ${text}\n`, { flag: "a" });
};
const LOCKED = /another (test gate|[a-z-]+ step) runs[^\n]*/;
const lastLine = (out, prefix) => {
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  const hit = prefix ? lines.filter((l) => l.startsWith(prefix)).pop() : null;
  return (hit ?? lines.pop() ?? "").slice(0, 400);
};

/** The FAILED block the gate prints: the failing lanes and their failing tests. */
export function gateSummary(out) {
  const lines = out.split("\n");
  const start = lines.findIndex((l) => l.startsWith("FAILED:"));
  if (start < 0) return [lastLine(out)];
  const block = [];
  for (const l of lines.slice(start)) {
    if (l.startsWith("No pass marker")) break;
    block.push(l.trimEnd());
  }
  return block.slice(0, 40);
}

// ── Live server: the task drain ────────────────────────────────────────────

async function liveApi(cfg, method, path, body) {
  let key = "";
  try { key = readFileSync(cfg.keyFile, "utf8").trim(); } catch {}
  const headers = { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { "content-type": "application/json" } : {}) };
  const res = await fetch(cfg.liveUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

const liveJson = async (cfg, method, path, body) => {
  const r = await liveApi(cfg, method, path, body).catch((e) => ({ ok: false, status: 0, text: e.message }));
  let json = null;
  try { json = JSON.parse(r.text); } catch {}
  return { ...r, json };
};

/**
 * Queued and running agent runs on live, each with its task (issueId may be
 * null); [] when live is down (as active_runs in greatstone-common.sh counts),
 * null when it cannot tell.
 */
async function liveRunList(cfg) {
  try { await fetch(`${cfg.liveUrl}/api/health`, { signal: AbortSignal.timeout(15_000) }); } catch { return []; }
  const companies = await liveJson(cfg, "GET", "/api/companies");
  if (!companies.ok || !Array.isArray(companies.json)) return null;
  const runs = [];
  for (const company of companies.json) {
    // Filtered by status, so held wakes cannot push an older running run past the limit.
    const list = await liveJson(cfg, "GET", `/api/companies/${encodeURIComponent(company.id)}/heartbeat-runs?status=running,queued&summary=true&limit=1000`);
    if (!list.ok || !Array.isArray(list.json)) return null;
    for (const r of list.json) {
      if (r.status !== "running" && r.status !== "queued") continue;
      runs.push({ runId: r.id, status: r.status, agentId: r.agentId, agentName: r.agentName ?? null, issueId: r.contextSnapshot?.issueId ?? null, companyId: company.id });
    }
  }
  return runs;
}

/**
 * Does releasing `commit` over live's `liveCommit` change the database?
 * db_change_check in greatstone-common.sh decides, the same check
 * greatstone-release.sh makes; when it cannot tell, it says it changes.
 */
function dbChange(cfg, liveCommit, commit) {
  const r = spawnSync("bash", ["-c", 'source "$0/greatstone-common.sh" && db_change_check "$1" "$2"', cfg.scripts, liveCommit ?? "", commit], {
    encoding: "utf8",
    env: { ...env, GSAM_RELEASE_REPO: cfg.repo },
  });
  return { changed: r.status !== 0, note: lastLine(`${r.stdout}\n${r.stderr}`) };
}

// ── The worker ─────────────────────────────────────────────────────────────

/**
 * Runs a command while a request waits on it, and stops it (SIGTERM) when the
 * request is cancelled. Resolves to { code, out }.
 */
async function runCancellable(cfg, cmd, args, { log, extraEnv, cancelAsked, onPoll }) {
  let child = null;
  const exit = run(cfg, cmd, args, { log, extraEnv, onSpawn: (c) => { child = c; } });
  for (;;) {
    const result = await Promise.race([exit, sleep(cfg.pollMs).then(() => null)]);
    if (result) return result;
    onPoll?.();
    if (cancelAsked()) {
      try { child?.kill("SIGTERM"); } catch {}
      await exit;
      return { code: null, out: "", cancelled: true };
    }
  }
}

/** The PC test gate, at low priority for CPU and disk so live stays responsive. */
function pcGateCommand(cfg, commit) {
  const args = [join(cfg.scripts, "greatstone-test-gate.sh"), commit];
  if (cfg.nice <= 0) return ["bash", args];
  const pre = process.platform === "linux" && existsSync("/usr/bin/ionice") ? ["ionice", "-c2", "-n7", "nice", "-n", String(cfg.nice)] : ["nice", "-n", String(cfg.nice)];
  return [pre[0], [...pre.slice(1), "bash", ...args]];
}

/** origin/main as GitHub's Fork CI sees it, for the Releases page. One look, no wait. */
function recordMainFromGitHub(cfg) {
  const commit = originMain(cfg);
  if (!commit) return;
  const r = spawnSync(process.execPath, [join(cfg.scripts, "greatstone-github-gate.mjs"), commit, "--json"], { encoding: "utf8", env });
  let verdict = null;
  try { verdict = JSON.parse(r.stdout.trim().split("\n").pop()); } catch {}
  if (!verdict || verdict.state === "unreachable") return;
  const status = { passed: "passed", failed: "failing", pending: verdict.names?.length ? "testing" : "untested" }[verdict.state] ?? "untested";
  mutate(cfg, (s) => {
    s.main = { commit, status, source: "github", startedAt: null, finishedAt: nowIso(), summary: status === "failing" ? verdict.names : [], detail: verdict.message };
  });
}

function heartbeat(cfg) {
  mutate(cfg, (s) => { s.worker = { pid: process.pid, seenAt: nowIso() }; });
}

/** Must match proposeTitle in server/src/services/live-release.ts. */
export function proposeTitle(changes) {
  const ordered = [...changes.filter((c) => c.kind === "feature"), ...changes.filter((c) => c.kind !== "feature")];
  const heads = ordered.slice(0, 2).map((c) => c.line.replace(/\s*\([^()]*\)\s*$/, ""));
  const more = ordered.length - heads.length;
  const title = `${heads.join("; ")}${more > 0 ? ` and ${more} more` : ""}`;
  return title.length > 120 ? `${title.slice(0, 119)}…` : title;
}

function nextTagName(cfg) {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const have = new Set((git(cfg, "tag", "--list", `rc-${day}.*`) ?? "").split("\n"));
  let n = 1;
  while (have.has(`rc-${day}.${n}`)) n += 1;
  return `rc-${day}.${n}`;
}

class Stop extends Error {
  constructor(status, reason) { super(reason); this.status = status; }
}

function createWorker(cfg) {
  const cancelAsked = (id) => load(cfg).items.find((i) => i.id === id)?.cancelRequested === true;
  const checkCancel = (item) => { if (cancelAsked(item.id)) throw new Stop("cancelled", load(cfg).items.find((i) => i.id === item.id)?.reason ?? "cancelled"); };
  const step = (item, name, detail) => { logLine(item.log, `${name}: ${detail}`); patchItem(cfg, item.id, { step: name, detail }); };

  /** Runs a step's command; while another holder has its lock, waits (at most stepWaitMs). */
  const runStep = async (item, name, cmd, args) => {
    const deadline = Date.now() + cfg.stepWaitMs;
    for (;;) {
      const result = await run(cfg, cmd, args, { log: item.log });
      const locked = result.code === 0 ? null : LOCKED.exec(result.out)?.[0];
      if (!locked) return result;
      if (Date.now() > deadline) throw new Stop("failed", `${name}: ${locked}`);
      patchItem(cfg, item.id, { detail: `waiting: ${locked}` });
      await sleep(cfg.pollMs);
      checkCancel(item);
    }
  };

  /** The PC test gate on `commit` (the fallback); waits while another gate holds the PC gate's lock. */
  const runPcGate = async (item, commit) => {
    if (passed(cfg, commit)) {
      step(item, "gate", `the PC test gate already passed on ${commit.slice(0, 9)}; skipped`);
      return;
    }
    step(item, "gate", `running the PC test gate on ${commit.slice(0, 9)}`);
    const deadline = Date.now() + cfg.stepWaitMs;
    for (;;) {
      if (passed(cfg, commit)) return; // another gate passed it meanwhile
      const [cmd, args] = pcGateCommand(cfg, commit);
      const result = await runCancellable(cfg, cmd, args, { log: item.log, cancelAsked: () => cancelAsked(item.id), onPoll: () => heartbeat(cfg) });
      if (result.cancelled) checkCancel(item);
      if (result.code === 0) return;
      const locked = LOCKED.exec(result.out)?.[0];
      if (locked && Date.now() < deadline) {
        patchItem(cfg, item.id, { detail: `waiting: ${locked}` });
        await sleep(cfg.pollMs);
        checkCancel(item);
        continue;
      }
      throw new Stop("failed", `the PC test gate failed on ${commit.slice(0, 9)}: ${gateSummary(result.out).join(" | ").slice(0, 600)}`);
    }
  };

  /**
   * The release gate: Fork CI's full test matrix green on GitHub for `commit`
   * (or for the pull request run that tested the same files), waiting while it
   * runs (at most githubWaitMs). The PC gate runs only with an explicit --pc-gate;
   * if GitHub cannot be asked the request fails. Returns "github" or "pc".
   */
  const runGate = async (item, commit) => {
    if (!item.pcGate) {
      step(item, "gate", `GitHub: checking Fork CI's full test matrix on ${commit.slice(0, 9)}`);
      const result = await runCancellable(cfg, process.execPath, [join(cfg.scripts, "greatstone-github-gate.mjs"), commit, "--wait", String(Math.round(cfg.githubWaitMs / 1000))], {
        log: item.log,
        cancelAsked: () => cancelAsked(item.id),
        onPoll: () => heartbeat(cfg),
      });
      if (result.cancelled) checkCancel(item);
      const message = lastLine(result.out);
      if (result.code === 0) {
        step(item, "gate", message);
        return "github";
      }
      if (result.code !== 3) throw new Stop("failed", result.code === 2 ? `${message} after ${Math.round(cfg.githubWaitMs / 60000)} min of waiting` : message);
      // Never fall back to the PC suite on its own: on 18 Oct three full test runs on the
      // PC at once corrupted the WSL disk and took live down. Only an explicit --pc-gate runs it.
      throw new Stop("failed", `${message}; GitHub could not be asked, so nothing was released. Retry later, or enqueue with --pc-gate to run the full suite on the PC (about 30 minutes of heavy load).`);
    }
    await runPcGate(item, commit);
    return "pc";
  };

  /**
   * The release lock (gs_lock "release", as greatstone-release.sh takes it), held
   * from before the drain to the end of the release, so a release by hand never
   * overlaps. Waits while someone else holds it (at most stepWaitMs).
   */
  const takeReleaseLock = async (item) => {
    const deadline = Date.now() + cfg.stepWaitMs;
    for (;;) {
      try {
        return takeLock(cfg.root, "release", `greatstone-release-queue.mjs ${item.id}`);
      } catch (error) {
        const held = oneLine(error.message).replace("another release step runs", "another release runs");
        if (Date.now() > deadline) throw new Stop("failed", `the release lock: ${held}`);
        patchItem(cfg, item.id, { step: "draining", detail: `waiting: ${held}` });
        await sleep(cfg.pollMs);
        checkCancel(item);
      }
    }
  };

  /** Adds runs to the request's paused list, once per run, so they are woken again after the release. */
  const recordPaused = (item, runs, how) => {
    if (runs.length === 0) return;
    mutate(cfg, (s) => {
      const it = s.items.find((i) => i.id === item.id);
      if (!it) return;
      it.paused ??= [];
      for (const r of runs) {
        if (it.paused.some((p) => p.runId === r.runId)) continue;
        it.paused.push({ runId: r.runId, how, agentId: r.agentId, agentName: r.agentName, issueId: r.issueId, companyId: r.companyId, at: nowIso(), commentedAt: null, resumedAt: null, attempts: 0, note: null });
      }
    });
  };

  /** Asks a running run, on its own task, to save its work before it is stopped. Only the task's assignee is asked, so no one else is woken. */
  const askToStop = async (item, r, tag) => {
    if (!r.issueId) return;
    const issue = await liveJson(cfg, "GET", `/api/issues/${encodeURIComponent(r.issueId)}`);
    if (!issue.ok || issue.json?.assigneeAgentId !== r.agentId || ["done", "cancelled"].includes(issue.json?.status)) return;
    const body = `Release ${tag} is waiting for this run. Please save your work and leave a short note on this task now: the run is stopped in about ${Math.max(1, Math.round(cfg.drainStopMs / 60000))} min and woken again after the release.`;
    const posted = await liveJson(cfg, "POST", `/api/issues/${encodeURIComponent(r.issueId)}/comments`, { body });
    logLine(item.log, `asked run ${r.runId} (${r.agentName ?? r.agentId}) on ${issue.json.identifier ?? r.issueId} to stop${posted.ok ? "" : `: the comment failed (${posted.status})`}`);
  };

  /**
   * Waits, with new runs held, until no agent run runs: a grace period for runs
   * to finish, then each is asked on its task to save its work and stop, then
   * the ones left are cancelled and recorded with their task. Bounded: a minute
   * past the stop deadline with runs still running it fails the request.
   */
  const drainRuns = async (item, tag) => {
    const graceEnd = Date.now() + cfg.drainGraceMs;
    const stopAt = graceEnd + cfg.drainStopMs;
    const giveUpAt = stopAt + STOP_CONFIRM_MS;
    const asked = new Set();
    const cancelled = new Set();
    const min = (ms) => Math.max(1, Math.round(ms / 60000));
    for (;;) {
      const runs = await liveRunList(cfg);
      // A wake that arrives now is held as a queued run; its task is told why it waited.
      if (runs) recordPaused(item, runs.filter((r) => r.status === "queued" && r.issueId), "held");
      const running = runs ? runs.filter((r) => r.status === "running") : null;
      if (running && running.length === 0) return;
      const now = Date.now();
      if (now >= giveUpAt) {
        throw new Stop("failed", running
          ? `${running.length} agent run(s) still running after they were cancelled (${running.map((r) => r.runId).join(", ")}); nothing was released`
          : `could not count the agent runs on ${cfg.liveUrl}; nothing was released`);
      }
      if (running && now >= stopAt) {
        for (const r of running.filter((x) => !cancelled.has(x.runId))) {
          const res = await liveJson(cfg, "POST", `/api/heartbeat-runs/${encodeURIComponent(r.runId)}/cancel`, {});
          if (!res.ok) {
            logLine(item.log, `could not stop run ${r.runId} (${res.status} ${res.text.slice(0, 200)}); trying again`);
            continue;
          }
          cancelled.add(r.runId);
          recordPaused(item, [r], "stopped");
          logLine(item.log, `stopped run ${r.runId} (${r.agentName ?? r.agentId}) on ${r.issueId ? `task ${r.issueId}` : "no task"}`);
        }
        step(item, "draining", `Releasing: new agent runs paused. Stopped ${cancelled.size} run(s) that did not finish in ${min(cfg.drainGraceMs + cfg.drainStopMs)} min; their tasks are woken again after the release.`);
      } else if (running && now >= graceEnd) {
        for (const r of running.filter((x) => !asked.has(x.runId))) {
          asked.add(r.runId);
          await askToStop(item, r, tag);
        }
        step(item, "draining", `Releasing: new agent runs paused. ${running.length} run(s) still running after ${min(cfg.drainGraceMs)} min were asked to save their work; they are stopped in ${min(stopAt - now)} min.`);
      } else {
        step(item, "draining", `Releasing: new agent runs paused. Waiting for ${running?.length ?? "an unknown number of"} running run(s) to finish (${min(Math.max(0, graceEnd - now))} min, then they are asked to stop).`);
      }
      await sleep(Math.min(cfg.pollMs, 15_000));
      if (cancelAsked(item.id)) checkCancel(item);
    }
  };

  /**
   * The paused runs of one task, woken again: one comment on the task (with
   * resume: true when a stopped run was its assignee's, which wakes it), and a
   * wake for each stopped run of another agent (a reviewer) or with no task.
   * A held run starts on its own once runs are back on; the comment only says
   * why it waited, so it is posted for a held run only when it is the
   * assignee's (a comment wakes the assignee; that wake joins the held run).
   * Returns { ok, note } per run; a retry skips a comment already posted.
   */
  const resumeTask = async (entries, label) => {
    const all = (ok, note) => entries.map(() => ({ ok, note }));
    const issueId = entries[0].issueId;
    let issue = null;
    if (issueId) {
      const got = await liveJson(cfg, "GET", `/api/issues/${encodeURIComponent(issueId)}`);
      if (got.status === 404) return all(true, "the task is gone");
      if (!got.ok || !got.json) return all(false, `could not read the task (${got.status})`);
      issue = got.json;
      if (["done", "cancelled"].includes(issue.status)) return all(true, `the task is ${issue.status}`);
    }
    const name = issue?.identifier ?? issueId;
    const isAssignee = (p) => issue?.assigneeAgentId === p.agentId;
    if (issue && entries.some((p) => p.how === "stopped" || isAssignee(p)) && !entries.some((p) => p.commentedAt)) {
      const wake = entries.some((p) => p.how === "stopped" && isAssignee(p));
      const c = await liveJson(cfg, "POST", `/api/issues/${encodeURIComponent(issueId)}/comments`, { body: `Paused for release ${label}; resuming.`, ...(wake ? { resume: true } : {}) });
      if (!c.ok) return all(false, `the comment on ${name} failed (${c.status})`);
      for (const p of entries) p.commentedAt = nowIso();
    }
    const out = [];
    for (const p of entries) {
      if (p.how === "held") out.push({ ok: true, note: isAssignee(p) ? `commented on ${name}; the held run starts now` : "the held run starts on its own" });
      else if (isAssignee(p)) out.push({ ok: true, note: `commented on ${name}; ${p.agentName ?? "its agent"} is woken` });
      else {
        const w = await liveJson(cfg, "POST", `/api/agents/${encodeURIComponent(p.agentId)}/wakeup`, {
          source: "automation",
          triggerDetail: "system",
          reason: "release_resumed",
          payload: p.issueId ? { issueId: p.issueId, taskId: p.issueId, resumeIntent: true, interruptedRunId: p.runId } : { interruptedRunId: p.runId },
          idempotencyKey: `release-resume:${p.runId}`,
        });
        out.push(w.ok ? { ok: true, note: `${issue ? `commented on ${name}; ` : ""}${p.agentName ?? "its agent"} is woken` } : { ok: false, note: `could not wake ${p.agentName ?? p.agentId} (${w.status})` });
      }
    }
    return out;
  };

  /**
   * Wakes every stopped or held task of a request again, after the drain is
   * lifted. Each run once; a failure is tried again by the next worker (the
   * watchdog starts one every minute), at most RESUME_ATTEMPTS times.
   */
  const resumePaused = async (id, label) => {
    const item = load(cfg).items.find((i) => i.id === id);
    const tasks = new Map();
    for (const p of item?.paused ?? []) {
      if (p.resumedAt || p.attempts >= RESUME_ATTEMPTS) continue;
      const key = p.issueId ?? `run:${p.runId}`;
      tasks.set(key, [...(tasks.get(key) ?? []), p]);
    }
    for (const entries of tasks.values()) {
      const results = await resumeTask(entries, label).catch((e) => entries.map(() => ({ ok: false, note: oneLine(e.message) })));
      mutate(cfg, (s) => {
        const paused = s.items.find((i) => i.id === id)?.paused ?? [];
        entries.forEach((p, n) => {
          const q = paused.find((x) => x.runId === p.runId);
          if (q) Object.assign(q, { attempts: q.attempts + 1, commentedAt: p.commentedAt, note: results[n].note, ...(results[n].ok ? { resumedAt: nowIso() } : {}) });
        });
      });
      entries.forEach((p, n) => logLine(item.log, `${p.how} run ${p.runId}: ${results[n].ok ? "" : "not woken yet: "}${results[n].note}`));
    }
  };

  const drainAndRelease = async (item, tag, releaseArgs) => {
    const freeLock = await takeReleaseLock(item);
    let result = null;
    try {
      result = await drainAndReleaseLocked(item, tag, releaseArgs);
      return result;
    } finally {
      freeLock();
      // Runs are back on (the drain is lifted, or the restart cleared it): wake the paused tasks.
      const liveTag = result?.code === 0 ? LIVE_TAG_LINE.exec(result.out)?.[1] : null;
      await resumePaused(item.id, liveTag ?? tag);
    }
  };

  /** New runs stay held from here to the end of the release, also between checks (GRE-2274). */
  const drainAndReleaseLocked = async (item, tag, releaseArgs) => {
    checkCancel(item);
    const ttlMs = cfg.drainGraceMs + cfg.drainStopMs + STOP_CONFIRM_MS + 30 * 60_000;
    const held = await liveApi(cfg, "POST", "/api/instance/task-drain", { ttlMs }).catch((e) => ({ ok: false, status: 0, text: e.message }));
    if (!held.ok) throw new Stop("failed", `could not pause new agent runs on ${cfg.liveUrl} (${held.status} ${held.text.slice(0, 200)}); nothing was released`);
    try {
      await drainRuns(item, tag);
      checkCancel(item);
      step(item, "releasing", `Releasing ${tag}: new agent runs paused`);
      return await run(cfg, "bash", [join(cfg.scripts, "greatstone-release.sh"), ...releaseArgs, tag], { log: item.log, extraEnv: { GSAM_RELEASE_LOCK_INHERITED: "1" } });
    } finally {
      for (let i = 0; ; i += 1) {
        const r = await liveApi(cfg, "DELETE", "/api/instance/task-drain").catch(() => null);
        if (r?.ok) break;
        if (i === 4) {
          logLine(item.log, "could not lift the task drain; it lapses on its own when its time runs out");
          break;
        }
        await sleep(3000);
      }
    }
  };

  const processItem = async (head, mergedIds) => {
    const item = patchItem(cfg, head.id, { status: "running", startedAt: head.startedAt ?? nowIso(), step: null, detail: null }) ?? head;
    logLine(item.log, `request ${item.id}: ${item.ref}${item.title ? ` "${item.title}"` : ""} by ${item.requestedBy ?? "unknown"}`);
    let cutTag = null;
    try {
      // The dev checkout runs the release scripts; release.sh refuses them when they are older than origin/main.
      const branch = git(cfg, "symbolic-ref", "--short", "HEAD");
      if (branch !== "main") throw new Stop("failed", `the release repo ${cfg.repo} is on ${branch ?? "a detached HEAD"}, not main`);
      const pull = await run(cfg, "git", ["pull", "--ff-only", "--quiet", "origin", "main"], { log: item.log });
      if (pull.code !== 0) throw new Stop("failed", `the release repo cannot fast-forward main: ${lastLine(pull.out)}`);
      await run(cfg, "git", ["fetch", "--quiet", "--tags", "origin"], { log: item.log });

      let commit;
      let tag = null;
      if (item.ref === "main") commit = originMain(cfg);
      else if (RC_TAG.test(item.ref)) {
        tag = item.ref;
        commit = git(cfg, "rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`);
        if (!commit) throw new Stop("failed", `unknown tag ${tag}`);
      } else commit = git(cfg, "rev-parse", "--verify", "--quiet", `${item.ref}^{commit}`);
      if (!commit) throw new Stop("failed", `cannot resolve ${item.ref}`);
      if (git(cfg, "merge-base", "--is-ancestor", commit, "refs/remotes/origin/main") === null) {
        throw new Stop("failed", `${item.ref} (${commit.slice(0, 9)}) is not on origin/main; only merged code is released`);
      }
      // A batch of main requests is one release; the newest request names it.
      const title = [item, ...mergedIds.map((id) => load(cfg).items.find((i) => i.id === id))].map((i) => i?.title).filter(Boolean).pop() ?? null;
      for (const id of mergedIds) {
        patchItem(cfg, id, { status: "merged", mergedInto: item.id, commit, finishedAt: nowIso(), reason: `released together with ${item.id}` });
      }
      patchItem(cfg, item.id, { commit, ...(title ? { title } : {}) });
      if (commit === liveHead(cfg)) throw new Stop("skipped", `live already runs ${commit.slice(0, 9)}; nothing to release`);

      const gateUsed = await runGate(item, commit);
      checkCancel(item);

      if (!tag) {
        let t = title;
        if (!t) {
          const print = await run(cfg, process.execPath, [join(cfg.scripts, "greatstone-candidate.mjs"), "rc-0000-00-00.0", "--title", "Next", "--ref", commit, "--print", "--json"], { log: join(cfg.logs, `${item.id}.print.log`) });
          try { t = proposeTitle(JSON.parse(print.out.trim().split("\n").pop()).changes ?? []); } catch {}
          if (!t) throw new Stop("failed", `could not read the changes for a title: ${lastLine(print.out)}`);
        }
        tag = nextTagName(cfg);
        step(item, "candidate", `cutting ${tag} on ${commit.slice(0, 9)}: ${t}`);
        const cut = await runStep(item, "candidate", process.execPath, [join(cfg.scripts, "greatstone-candidate.mjs"), tag, "--title", t, "--ref", commit, "--no-test-gate"]);
        if (cut.code !== 0) throw new Stop("failed", `could not cut a candidate: ${lastLine(cut.out, "candidate:")}`);
        cutTag = tag;
        patchItem(cfg, item.id, { tag, title: t });
      } else patchItem(cfg, item.id, { tag });
      checkCancel(item);

      // The preview (a copy of the live database, 8 to 12 minutes) proves the
      // migrations; a release that changes nothing in the database skips it,
      // and greatstone-release.sh rolls it back on its own if live does not come up.
      const db = dbChange(cfg, liveHead(cfg), commit);
      if (!db.changed) {
        step(item, "preview", `preview skipped: ${db.note}`);
      } else {
        const preview = join(cfg.scripts, "greatstone-preview.sh");
        step(item, "preview", `starting ${tag} on a copy of the live data (${db.note})`);
        await run(cfg, "bash", [preview, "stop"], { log: item.log });
        const started = await runStep(item, "preview", "bash", [preview, "start", tag]);
        if (started.code !== 0) throw new Stop("failed", `the preview of ${tag} did not start: ${lastLine(started.out, "preview:")}`);
        step(item, "preview", `running the switch tests on the preview of ${tag}`);
        const switches = await runStep(item, "preview", "bash", [preview, "switch-tests"]);
        if (switches.code !== 0) throw new Stop("failed", `the switch tests failed on the preview of ${tag}: ${lastLine(switches.out, "preview:")}`);
      }
      checkCancel(item);

      const result = await drainAndRelease(item, tag, gateUsed === "pc" ? ["--pc-gate"] : []);
      const rollback = /^Roll back with: (.+)$/m.exec(result.out)?.[1]?.trim() ?? null;
      const backupFile = /^Database backup from before this release: (.+)$/m.exec(result.out)?.[1]?.trim() ?? null;
      const liveTag = LIVE_TAG_LINE.exec(result.out)?.[1] ?? null;
      if (result.code !== 0) {
        cutTag = null; // the release script owns the tags once it ran
        throw Object.assign(new Stop("failed", lastLine(result.out, "release:").replace(/^release: /, "")), { rollback, backupFile });
      }
      patchItem(cfg, item.id, { status: "released", step: null, detail: null, liveTag, rollback, backupFile, finishedAt: nowIso() });
      logLine(item.log, `released ${tag} as ${liveTag ?? "a live tag"}. ${rollback ? `Roll back with: ${rollback}` : ""}`);
    } catch (error) {
      const status = error instanceof Stop ? error.status : "failed";
      const reason = oneLine(error.message);
      logLine(item.log, `${status}: ${reason}`);
      if (cutTag && !git(cfg, "ls-remote", "--tags", "origin", `refs/tags/${cutTag}`)) git(cfg, "tag", "-d", cutTag);
      if (["preview", "draining"].includes(load(cfg).items.find((i) => i.id === item.id)?.step)) {
        await run(cfg, "bash", [join(cfg.scripts, "greatstone-preview.sh"), "stop"], { log: item.log });
      }
      patchItem(cfg, item.id, { status, reason, finishedAt: nowIso(), ...(error.rollback ? { rollback: error.rollback } : {}), ...(error.backupFile ? { backupFile: error.backupFile } : {}) });
    }
  };

  const work = async () => {
    const free = (() => {
      try { return takeLock(cfg.root, "release-queue-worker", "greatstone-release-queue.mjs work"); } catch { return null; }
    })();
    if (!free) return "busy";
    const stopOnSignal = () => process.exit(143);
    process.on("SIGTERM", stopOnSignal);
    process.on("SIGINT", stopOnSignal);
    try {
      // A request left running by a worker that stopped: from before the release
      // steps it starts again; later, it is failed so a person looks at live.
      mutate(cfg, (s) => {
        for (const i of s.items.filter((x) => x.status === "running")) {
          if (!i.step || i.step === "gate" || i.step === "candidate") Object.assign(i, { status: "queued", step: null, detail: "the worker stopped; starting again" });
          else Object.assign(i, { status: "failed", reason: `the worker stopped during ${i.step}; check live (curl ${cfg.liveUrl}/api/health) and the log ${i.log}`, finishedAt: nowIso() });
        }
      });
      // Paused tasks a past request could not wake yet (live was down, or the worker stopped).
      for (const i of load(cfg).items.filter((x) => FINAL.has(x.status) && x.paused?.some((p) => !p.resumedAt && p.attempts < RESUME_ATTEMPTS))) {
        await resumePaused(i.id, i.liveTag ?? i.tag ?? i.ref);
      }
      for (;;) {
        heartbeat(cfg);
        git(cfg, "fetch", "--quiet", "origin", "main");
        const batch = nextBatch(load(cfg).items);
        if (batch) {
          await processItem(batch.head, batch.merged.map((i) => i.id));
          continue;
        }
        recordMainFromGitHub(cfg);
        break;
      }
      return "done";
    } finally {
      free();
    }
  };
  return { work };
}

// ── View ───────────────────────────────────────────────────────────────────

/** What `status` prints and the Releases page shows. */
export function view(state) {
  const running = state.items.find((i) => i.status === "running") ?? null;
  return {
    running,
    queued: state.items.filter((i) => i.status === "queued"),
    recent: state.items.filter((i) => FINAL.has(i.status)).slice(-10).reverse(),
    main: state.main,
    worker: state.worker,
    updatedAt: state.updatedAt,
  };
}

function printStatus(v) {
  const short = (s) => (s ? s.slice(0, 9) : "?");
  const m = v.main;
  console.log(m ? `main at ${short(m.commit)}: ${m.status}${m.status === "failing" && m.summary?.length ? `\n  ${m.summary.join("\n  ")}` : ""}` : "main: not tested by the queue yet");
  console.log(`worker: ${v.worker ? `last seen ${v.worker.seenAt} (pid ${v.worker.pid})` : "has not run yet"}`);
  if (v.running) console.log(`running: ${v.running.id} ${v.running.ref} ${v.running.tag ?? ""} step ${v.running.step ?? "starting"}: ${v.running.detail ?? ""}\n  log: ${v.running.log}`);
  for (const i of v.queued) console.log(`queued:  ${i.id} ${i.ref}${i.title ? ` "${i.title}"` : ""} (by ${i.requestedBy ?? "?"}, ${i.requestedAt})`);
  for (const i of v.recent) console.log(`${i.status.padEnd(9)}${i.id} ${i.tag ?? i.ref}${i.liveTag ? ` as ${i.liveTag}` : ""}${i.reason ? `: ${i.reason}` : ""}${i.rollback ? `\n  roll back: ${i.rollback}` : ""}`);
}

// ── CLI ────────────────────────────────────────────────────────────────────

async function main(argv) {
  const cfg = config();
  // Options come before "--"; everything after it is positional (the server
  // puts the ref and the title there, so a title cannot pass for an option).
  const dd = argv.indexOf("--");
  const args = dd < 0 ? [...argv] : argv.slice(0, dd);
  const tail = dd < 0 ? [] : argv.slice(dd + 1);
  const flag = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
  const opt = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v ?? null; };
  const json = flag("--json");
  const pcGate = flag("--pc-gate");
  const by = opt("--by") ?? `cli:${userInfo().username}`;
  const out = (value, text) => (json ? console.log(JSON.stringify(value)) : console.log(text));
  const [cmd, ...rest] = [...args, ...tail];
  switch (cmd) {
    case "enqueue": {
      const item = enqueue(cfg, { ref: rest[0] || "main", title: rest[1] || null, by, pcGate });
      const ahead = view(load(cfg)).queued.length - 1 + (view(load(cfg)).running ? 1 : 0);
      return out({ item }, `Queued ${item.id}: release ${item.ref}${item.title ? ` "${item.title}"` : ""} (${ahead} ahead). The worker starts within a minute; follow it with: node scripts/greatstone-release-queue.mjs status`);
    }
    case "cancel":
      if (!rest[0]) throw new Error("usage: greatstone-release-queue.mjs cancel <id>");
      return out({ item: cancel(cfg, rest[0], by) }, `Cancel noted for ${rest[0]}.`);
    case "status": {
      const v = view(load(cfg));
      return json ? console.log(JSON.stringify(v)) : printStatus(v);
    }
    case "tick": {
      // A new session and its own log, so the watchdog's end cannot stop it.
      mkdirSync(cfg.dir, { recursive: true });
      const fd = openSync(join(cfg.dir, "worker.log"), "a");
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "work"], { cwd: cfg.repo, detached: true, stdio: ["ignore", fd, fd], env });
      child.unref();
      return;
    }
    case "work":
      await createWorker(cfg).work();
      return;
    default:
      throw new Error("usage: greatstone-release-queue.mjs enqueue [main|<rc-tag>|<sha>] [\"<title>\"] | status | cancel <id> | tick | work  [--by <who>] [--json]");
  }
}

// realpath: on macOS a temp path under /var is /private/var to import.meta.url.
const invokedAs = (() => { try { return pathToFileURL(realpathSync(process.argv[1] ?? "")).href; } catch { return ""; } })();
if (import.meta.url === invokedAs) {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (error) => {
      process.stderr.write(`release-queue: ${error.message}\n`);
      process.exit(1);
    },
  );
}
