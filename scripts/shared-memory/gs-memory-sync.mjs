#!/usr/bin/env node
// Shared memory sync for John's Mac (GRE-2668). Every 30 minutes (launchd) it
// sends new Claude Code and Codex turns (John's messages and the final
// answers) and changed memory files to GSAM, which keeps them in John's own
// memory bank (`greatstone-john`). Redaction runs here first (redact.mjs).
//
//   node gs-memory-sync.mjs run [--dry-run]   send what is new (dry run: count only, send nothing)
//   node gs-memory-sync.mjs status            what was sent, today's count, last error
//   node gs-memory-sync.mjs check             config, tokens (present or not), GSAM reachable, bank name
//   node gs-memory-sync.mjs recall "<query>" [--as claude|codex]   ask the shared memory
//   node gs-memory-sync.mjs handoff           the live handoff (from GSAM, or NOW.md when GSAM is down)
//
// The live handoff (John, 26 Oct): each run also mirrors the handoff in GSAM
// to NOW.md in the memory folder and sends NOW.md edits back. GSAM is the
// source of truth when it can be reached; NOW.md is the fallback when it
// cannot, and the next run reconciles (GSAM merges per section, newest wins,
// and records any clash).
//
// Idempotent and resumable: state is saved after every accepted batch, and the
// server skips any entry whose text it already has. Tokens are read from the
// macOS Keychain by reference; they are never written to a file or a log.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { batchTurns, claudeTurns, codexTurns, dayLabel, isTrivialTurn, renderTurn } from "./extract.mjs";
import { isNeverStoreFile, redact } from "./redact.mjs";

const HOME = os.homedir();
const MAX_ENTRIES_PER_CALL = 25; // MEMORY_SYNC_MAX_ENTRIES on the server
const MEMORY_FILE_MAX_CHARS = 18_000;
const IDLE_MS = 10 * 60 * 1000;

export const DEFAULT_CONFIG = {
  gsamUrl: "https://gsam.tail83d26c.ts.net:3100",
  companyId: "",
  /** Keychain items (`security add-generic-password -s <service> -a gsam -w`). */
  tokens: { claude_code: "keychain:gs-memory-claude-code", codex: "keychain:gs-memory-codex" },
  memoryDir: path.join(HOME, ".claude/projects/-Users-johnprempeh-Desktop-Code/memory"),
  claudeProjectsDir: path.join(HOME, ".claude/projects"),
  codexSessionsDir: path.join(HOME, ".codex/sessions"),
  /** First run only: how far back to send. Fixed in the state file on that run. */
  backfillDays: 14,
  /** Cost guard: most entries per run and per UTC day from this Mac (the server cap is 300 a day). */
  maxEntriesPerRun: 40,
  dailyCap: 250,
};

export function configDir(env = process.env) {
  return env.GS_MEMORY_SYNC_HOME ?? path.join(HOME, ".config", "gs-memory-sync");
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function loadConfig(env = process.env) {
  const file = path.join(configDir(env), "config.json");
  const user = readJson(file, {});
  return { ...DEFAULT_CONFIG, ...user, tokens: { ...DEFAULT_CONFIG.tokens, ...(user.tokens ?? {}) } };
}

/** The tailnet only: `*.ts.net`, a Tailscale 100.64.0.0/10 address, or this machine. Never Funnel's public name on 443. */
export function tailnetUrlProblem(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "gsamUrl is not a URL";
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return null;
  const v4 = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (v4 && Number(v4[1]) >= 64 && Number(v4[1]) <= 127) return null;
  if (host.endsWith(".ts.net")) {
    // Funnel publishes the bare https name on 443; GSAM's tailnet-only listener is on :3100.
    if (parsed.protocol === "https:" && (parsed.port === "" || parsed.port === "443")) {
      return "gsamUrl uses port 443 of the ts.net name, which is the Funnel (public) listener; use :3100";
    }
    return null;
  }
  return "gsamUrl must be a tailnet address (*.ts.net or 100.x), never a public one";
}

/** `keychain:<service>` → the macOS Keychain; `env:<NAME>` → an environment variable (tests). */
export function readToken(ref, env = process.env) {
  if (typeof ref !== "string") return null;
  if (ref.startsWith("env:")) return env[ref.slice(4)]?.trim() || null;
  if (ref.startsWith("keychain:")) {
    try {
      return execFileSync("security", ["find-generic-password", "-s", ref.slice(9), "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null;
    } catch {
      return null;
    }
  }
  return null;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function listFiles(root, match, depth = 6) {
  const out = [];
  const walk = (dir, level) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (level < depth && !entry.name.startsWith(".") && entry.name !== "node_modules") walk(full, level + 1);
      } else if (entry.isFile() && match(full)) {
        out.push(full);
      }
    }
  };
  walk(root, 0);
  return out;
}

function notify(message) {
  if (process.platform !== "darwin") return;
  try {
    execFileSync("osascript", ["-e", `display notification ${JSON.stringify(message)} with title "GS shared memory"`], { stdio: "ignore" });
  } catch {
    // A notification is a courtesy; the log line below is the record.
  }
}

/** One lock per Mac so two runs never send the same batch at once. A dead holder's lock is taken over. */
function takeLock(dir) {
  const file = path.join(dir, "sync.lock");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch {
    const holder = Number(fs.readFileSync(file, "utf8"));
    let alive = false;
    try {
      process.kill(holder, 0);
      alive = holder !== process.pid;
    } catch {
      alive = false;
    }
    if (alive) return null;
    fs.writeFileSync(file, String(process.pid), { mode: 0o600 });
  }
  return () => fs.rmSync(file, { force: true });
}

/** Builds the entries a source file adds since the last run. Pure apart from reading the file. */
export function sessionEntries(file, source, state, { now = Date.now(), backfillFrom } = {}) {
  const info = fs.statSync(file);
  const seen = state.files[file];
  if (seen && seen.size === info.size && seen.mtimeMs === info.mtimeMs) return { entries: [], advance: null };
  if (!seen && info.mtimeMs < backfillFrom) return { entries: [], advance: null };
  const text = fs.readFileSync(file, "utf8");
  const idle = now - info.mtimeMs > IDLE_MS;
  const turns = (source === "claude_code" ? claudeTurns : codexTurns)(text, { idle });
  const done = seen?.turns ?? 0;
  const ready = turns.slice(done).filter((turn) => turn.complete);
  const assistant = source === "claude_code" ? "Claude" : "Codex (ChatGPT)";
  const kept = [];
  const found = new Set();
  // Complete turns are a prefix (only the last can still be open), so turn i of `ready` is turn done+i+1 of the file.
  for (const [index, turn] of ready.entries()) {
    const user = redact(turn.user);
    const answer = redact(turn.answer);
    [...user.found, ...answer.found].forEach((type) => found.add(type));
    const clean = { ...turn, user: user.text, answer: answer.text, ordinal: done + index + 1 };
    if (!isTrivialTurn(clean)) kept.push(clean);
  }
  const render = (turn) => renderTurn(turn, assistant);
  const entries = batchTurns(kept, render).map((batch) => {
    const first = batch[0];
    const sessionId = first.sessionId ?? path.basename(file, ".jsonl");
    const project = first.cwd ? path.basename(first.cwd) : null;
    const app = source === "claude_code" ? "Claude Code" : "Codex (ChatGPT)";
    const header =
      `${app} session ${sessionId}${project ? ` in ${project}` : ""}` +
      `${first.gitBranch ? ` (branch ${first.gitBranch})` : ""}, ${dayLabel(first.at)}.`;
    return {
      source,
      sourceId: `${source === "claude_code" ? "claude" : "codex"}:${sessionId}:${first.id}`.slice(0, 200),
      title: `${app}, ${dayLabel(first.at)}${project ? `, ${project}` : ""}: ${first.user.replace(/\s+/g, " ").slice(0, 80)}`.slice(0, 200),
      content: [header, ...batch.map(render)].join("\n\n").slice(0, 20_000),
      occurredAt: first.at ?? new Date(info.mtimeMs).toISOString(),
      origin: { app: source, sessionId: String(sessionId).slice(0, 120), ...(first.cwd ? { project: first.cwd.slice(0, 300) } : {}), path: file.replace(HOME, "~").slice(0, 500) },
      turnsThrough: batch.at(-1).ordinal,
    };
  });
  // Every complete turn is accounted for, sent or skipped as trivial.
  const completeCount = done + ready.length;
  return { entries, advance: { file, size: info.size, mtimeMs: info.mtimeMs, turns: completeCount }, found: [...found] };
}

/** NOW.md is the handoff's mirror: it reaches GSAM as the handoff record, not as a memory file. */
export const HANDOFF_FILE = "NOW.md";

export function memoryFileEntries(dir, state) {
  const entries = [];
  const found = new Set();
  for (const file of listFiles(dir, (full) => /\.(md|txt)$/i.test(full), 2).sort()) {
    const rel = path.relative(dir, file);
    if (isNeverStoreFile(rel) || rel === HANDOFF_FILE) continue;
    const info = fs.statSync(file);
    if (info.size > 200_000) continue;
    const raw = fs.readFileSync(file, "utf8");
    const { text, found: types } = redact(raw);
    types.forEach((type) => found.add(type));
    const parts = [];
    for (let at = 0; at < text.length; at += MEMORY_FILE_MAX_CHARS) parts.push(text.slice(at, at + MEMORY_FILE_MAX_CHARS));
    parts.forEach((part, index) => {
      if (!part.trim()) return;
      const sourceId = `memory:${rel}${parts.length > 1 ? `#${index + 1}` : ""}`.slice(0, 200);
      const hash = sha256(part);
      if (state.memory[sourceId] === hash) return;
      const description = /^description:\s*(.+)$/m.exec(part)?.[1]?.trim();
      entries.push({
        source: "memory_file",
        sourceId,
        title: `Memory file ${rel}${description ? `: ${description}` : ""}`.slice(0, 200),
        content: `Shared memory file ${rel} (used by Claude Code and Codex), last changed ${new Date(info.mtimeMs).toISOString()}.\n\n${part}`,
        occurredAt: new Date(info.mtimeMs).toISOString(),
        origin: { app: "memory_file", path: file.replace(HOME, "~").slice(0, 500) },
        hash,
      });
    });
  }
  return { entries, found: [...found] };
}

async function post(config, token, route, body) {
  const response = await fetch(`${config.gsamUrl.replace(/\/+$/, "")}/api/companies/${config.companyId}/memory${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GSAM answered ${response.status} on ${route}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function writeTextAtomic(file, text) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/**
 * Mirrors the handoff both ways. NOW.md changed since the last run: it is
 * sent back (redacted) with the revision this Mac last wrote, and GSAM merges
 * it per section. Otherwise GSAM's current handoff is read. Either way the
 * answer is written to NOW.md, unless the file changed while the call was out
 * (a tool is editing it; the next run sends that edit). GSAM unreachable:
 * NOW.md is left as it is, for both tools to use, and the edit waits.
 */
export async function syncHandoff({ config, token, state, send, dryRun = false, log = () => {} }) {
  const file = path.join(config.memoryDir, HANDOFF_FILE);
  state.handoff ??= { revision: 0, hash: null };
  let text = null;
  let mtimeMs = null;
  try {
    text = fs.readFileSync(file, "utf8");
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    text = null;
  }
  const localChanged = text !== null && text.trim() !== "" && sha256(text) !== state.handoff.hash;
  if (dryRun) return { localChanged, offline: false, written: false, conflicts: 0 };
  if (!token) return { localChanged, offline: true, written: false, conflicts: 0, error: "no token" };
  let remote;
  let redacted = [];
  try {
    if (localChanged) {
      const clean = redact(text);
      redacted = clean.found;
      remote = await send(config, token, "/handoff/file", {
        text: clean.text,
        fileChangedAt: new Date(mtimeMs).toISOString(),
        baseRevision: state.handoff.revision,
      });
    } else {
      remote = await send(config, token, "/handoff");
    }
  } catch (error) {
    state.handoff.pendingSince ??= localChanged ? new Date(mtimeMs).toISOString() : null;
    state.handoff.lastError = String(error.message ?? error).slice(0, 300);
    // A 4xx is GSAM refusing the file (say, a value that looks like a secret); anything else is GSAM or the PC down.
    const refused = /answered 4\d\d/.test(state.handoff.lastError);
    log(`handoff: ${refused ? "GSAM did not take NOW.md" : "GSAM not reachable"}, NOW.md stays as it is (${state.handoff.lastError})`);
    return { localChanged, offline: !refused, refused, written: false, conflicts: 0, error: state.handoff.lastError };
  }
  const conflicts = remote?.conflicts?.length ?? 0;
  if (conflicts > 0) log(`handoff: ${conflicts} section(s) changed on both sides; the newer edit was kept and the other is recorded in GSAM`);
  // Nothing in GSAM yet and nothing here: leave the folder alone.
  if (!remote || (remote.revision === 0 && text === null)) {
    state.handoff = { revision: remote?.revision ?? 0, hash: text === null ? null : sha256(text), syncedAt: new Date().toISOString() };
    return { localChanged, offline: false, written: false, conflicts, redacted };
  }
  let stillSame = true;
  try {
    stillSame = text === null ? !fs.existsSync(file) : fs.statSync(file).mtimeMs === mtimeMs;
  } catch {
    stillSame = text === null;
  }
  if (!stillSame) {
    log("handoff: NOW.md changed during the sync; it is sent on the next run");
    state.handoff.revision = remote.revision;
    return { localChanged, offline: false, written: false, conflicts, redacted };
  }
  const written = remote.markdown !== text;
  if (written) writeTextAtomic(file, remote.markdown);
  state.handoff = { revision: remote.revision, hash: sha256(remote.markdown), syncedAt: new Date().toISOString() };
  return { localChanged, offline: false, written, conflicts, redacted, revision: remote.revision };
}

export async function run({ dryRun = false, env = process.env, now = Date.now(), send = post, log = console.log } = {}) {
  const config = loadConfig(env);
  const dir = configDir(env);
  const problem = tailnetUrlProblem(config.gsamUrl);
  if (problem) throw new Error(problem);
  if (!config.companyId) throw new Error(`companyId is missing in ${path.join(dir, "config.json")}`);
  const statePath = path.join(dir, "state.json");
  const state = readJson(statePath, null) ?? { version: 1, files: {}, memory: {}, daily: {}, backfillFrom: now - config.backfillDays * 86_400_000 };
  state.files ??= {};
  state.memory ??= {};
  state.daily ??= {};
  const today = utcDay(new Date(now));
  state.daily = { [today]: state.daily[today] ?? 0 };
  const release = dryRun ? () => {} : takeLock(dir);
  if (!release) {
    log("another sync is running; skipped");
    return { skipped: true };
  }
  const summary = { sent: 0, added: 0, revised: 0, unchanged: 0, heldBack: 0, capped: 0, redacted: {}, dryRun };
  const countRedactions = (types) => types.forEach((type) => (summary.redacted[type] = (summary.redacted[type] ?? 0) + 1));
  const save = () => {
    if (!dryRun) writeJsonAtomic(statePath, state);
  };
  try {
    const tokens = { claude_code: readToken(config.tokens.claude_code, env), codex: readToken(config.tokens.codex, env) };
    let budget = Math.max(0, Math.min(config.maxEntriesPerRun, config.dailyCap - state.daily[today]));

    // The handoff first: it is the one thing the other tool needs next session.
    const handoff = await syncHandoff({ config, token: tokens.claude_code ?? tokens.codex, state, send, dryRun, log });
    summary.handoff = { offline: handoff.offline, sentBack: handoff.localChanged && !handoff.offline && !handoff.refused, written: handoff.written, conflicts: handoff.conflicts };
    countRedactions(handoff.redacted ?? []);
    save();

    // Newest first, so a backlog never delays today's work.
    const sources = [
      ...listFiles(config.claudeProjectsDir, (file) => file.endsWith(".jsonl"), 1).map((file) => ({ file, source: "claude_code" })),
      ...listFiles(config.codexSessionsDir, (file) => file.endsWith(".jsonl")).map((file) => ({ file, source: "codex" })),
    ].sort((a, b) => fs.statSync(b.file).mtimeMs - fs.statSync(a.file).mtimeMs);

    const deliver = async (source, entries) => {
      const token = tokens[source === "codex" ? "codex" : "claude_code"];
      if (!token) throw new Error(`no token for ${source}: add it to the Keychain (see the runbook)`);
      const outcomes = [];
      for (let at = 0; at < entries.length; at += MAX_ENTRIES_PER_CALL) {
        const chunk = entries.slice(at, at + MAX_ENTRIES_PER_CALL);
        const result = await send(config, token, "/sync", {
          entries: chunk.map(({ source: s, sourceId, title, content, occurredAt, origin }) => ({ source: s, sourceId, title, content, occurredAt, origin })),
        });
        for (const entry of result.entries) {
          outcomes.push(entry.outcome);
          if (entry.outcome === "added") summary.added += 1;
          else if (entry.outcome === "revised") summary.revised += 1;
          else if (entry.outcome === "held_back") summary.heldBack += 1;
          else if (entry.outcome === "capped") summary.capped += 1;
          else summary.unchanged += 1;
          if (entry.outcome === "added" || entry.outcome === "revised") state.daily[today] += 1;
        }
        if (result.capReached && !state.capNotified?.startsWith(today)) {
          state.capNotified = today;
          notify(`Daily cap reached (${result.usedToday}/${result.dailyCap}). The rest is sent tomorrow.`);
          log(`ALERT daily cap reached on GSAM: ${result.usedToday}/${result.dailyCap}`);
        }
      }
      summary.sent += entries.length;
      return outcomes;
    };

    for (const { file, source } of sources) {
      if (budget <= 0) break;
      const { entries, advance, found } = sessionEntries(file, source, state, { now, backfillFrom: state.backfillFrom });
      countRedactions(found ?? []);
      if (!advance) continue;
      const batch = entries.slice(0, budget);
      if (dryRun) {
        summary.sent += batch.length;
        budget -= batch.length;
        continue;
      }
      const outcomes = batch.length > 0 ? await deliver(source, batch) : [];
      // Advance past everything accepted; stop at the first capped entry so it is sent again tomorrow.
      const firstCapped = outcomes.indexOf("capped");
      if (firstCapped >= 0) {
        if (firstCapped > 0) state.files[file] = { ...advance, turns: batch[firstCapped - 1].turnsThrough, size: -1 };
        save();
        budget = 0;
        break;
      }
      state.files[file] = batch.length < entries.length ? { ...advance, turns: batch.at(-1).turnsThrough, size: -1 } : advance;
      budget -= batch.length;
      save();
    }

    if (budget > 0) {
      const { entries, found } = memoryFileEntries(config.memoryDir, state);
      countRedactions(found);
      const batch = entries.slice(0, budget);
      if (dryRun) summary.sent += batch.length;
      else if (batch.length > 0) {
        const outcomes = await deliver("memory_file", batch);
        batch.forEach((entry, index) => {
          if (outcomes[index] !== "capped") state.memory[entry.sourceId] = entry.hash;
        });
        save();
      }
    }
    state.lastRun = { at: new Date(now).toISOString(), ok: true, ...summary };
    save();
    log(`shared memory sync: ${JSON.stringify(summary)}`);
    return summary;
  } catch (error) {
    state.lastRun = { at: new Date(now).toISOString(), ok: false, error: String(error.message ?? error).slice(0, 300) };
    save();
    throw error;
  } finally {
    release();
  }
}

async function main(argv) {
  const [command = "run", ...rest] = argv;
  const config = loadConfig();
  if (command === "run") {
    await run({ dryRun: rest.includes("--dry-run") });
  } else if (command === "status") {
    const state = readJson(path.join(configDir(), "state.json"), {});
    console.log(JSON.stringify({ lastRun: state.lastRun ?? null, today: state.daily ?? {}, sessionFiles: Object.keys(state.files ?? {}).length, memoryFiles: Object.keys(state.memory ?? {}).length }, null, 2));
  } else if (command === "check") {
    const problem = tailnetUrlProblem(config.gsamUrl);
    console.log(`gsamUrl ${config.gsamUrl}: ${problem ? `FAIL ${problem}` : "PASS tailnet only"}`);
    console.log(`companyId: ${config.companyId ? "PASS" : "FAIL missing"}`);
    for (const [app, ref] of Object.entries(config.tokens)) {
      const token = readToken(ref);
      console.log(`token ${app} (${ref}): ${token ? "PASS present" : "FAIL not found"}`);
      if (token && !problem && config.companyId) {
        try {
          const scopes = await post(config, token, "/scopes");
          const mine = (scopes ?? []).find((scope) => scope.kind === "person");
          console.log(`  GSAM reachable as ${app}: PASS; person scope ${mine ? `"${mine.name}"` : "not made yet"}`);
        } catch (error) {
          console.log(`  GSAM reachable as ${app}: FAIL ${String(error.message).slice(0, 200)}`);
        }
      }
    }
    for (const dir of [config.memoryDir, config.claudeProjectsDir, config.codexSessionsDir]) {
      console.log(`${dir.replace(HOME, "~")}: ${fs.existsSync(dir) ? "PASS found" : "NOTE not found"}`);
    }
  } else if (command === "recall") {
    const query = rest.filter((arg) => !arg.startsWith("--"))[0];
    const as = rest.includes("--as") ? rest[rest.indexOf("--as") + 1] : "claude";
    const token = readToken(config.tokens[as === "codex" ? "codex" : "claude_code"]);
    if (!query || !token) throw new Error('usage: recall "<query>" [--as claude|codex] (and the token must be in the Keychain)');
    const result = await post(config, token, "/recall", { query, limit: 8 });
    for (const hit of result.results ?? []) {
      const record = hit.record;
      console.log(`- ${record.title ?? "(untitled)"}\n  source: ${record.sourceKind ?? "?"} ${record.sourceId ?? ""}; when: ${record.effectiveFrom ?? record.createdAt}; status: ${record.status}\n  ${String(hit.excerpt).replace(/\s+/g, " ").slice(0, 400)}`);
    }
    if (!result.available) console.log(result.message);
  } else if (command === "handoff") {
    const token = readToken(config.tokens.claude_code) ?? readToken(config.tokens.codex);
    try {
      if (!token) throw new Error("no token in the Keychain");
      const remote = await post(config, token, `/handoff?since=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}`);
      console.log(remote.markdown);
      for (const change of remote.changesSince?.changes ?? []) console.log(`- ${change.at.slice(0, 16)} ${change.summary} (by ${change.by.label})`);
    } catch (error) {
      console.log(`GSAM not reachable (${String(error.message).slice(0, 200)}); NOW.md, the fallback:\n`);
      console.log(fs.readFileSync(path.join(config.memoryDir, HANDOFF_FILE), "utf8"));
    }
  } else {
    throw new Error(`unknown command ${command}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`shared memory sync failed: ${error.message}`);
    process.exitCode = 1;
  });
}
