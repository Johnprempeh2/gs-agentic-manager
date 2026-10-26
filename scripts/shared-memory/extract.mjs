// What the shared memory keeps from a session (GRE-2668): John's messages and
// the final answer of each turn. Tool calls, tool output, thinking, subagent
// side chains and injected context are dropped. Pure functions, no I/O.

const USER_MAX_CHARS = 2_000;
const ANSWER_MAX_CHARS = 3_000;
export const BATCH_MAX_CHARS = 6_000;
export const BATCH_MAX_TURNS = 8;

function trim(text, max) {
  const clean = text.trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)} …[trimmed]`;
}

function parseLines(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A half-written last line: the next run reads it whole.
    }
  }
  return rows;
}

/** Text the tools inject into the user's turn, never John's own words. */
function stripInjected(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<(environment_context|user_instructions|permissions instructions|INSTRUCTIONS)>[\s\S]*?<\/\1>/g, "")
    .trim();
}

function isInjectedUserText(text) {
  return (
    text === "" ||
    /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr)>/.test(text) ||
    /^Caveat: The messages below were generated/.test(text) ||
    /^\[Request interrupted/.test(text) ||
    /^# AGENTS\.md instructions/.test(text) ||
    /^This session is being continued from a previous conversation/.test(text)
  );
}

const TRIVIAL_USER = /^(y|yes|yep|ok|okay|k|no|nope|continue|go|go on|go ahead|proceed|carry on|next|sure|thanks|thank you|thx|do it|done|great|good|nice|cool)[.!]*$/i;

/** A turn with nothing worth remembering: "yes" with a short reply, or almost no text at all. */
export function isTrivialTurn(turn) {
  const user = turn.user.trim();
  const answer = turn.answer.trim();
  if (user.length + answer.length < 40) return true;
  return (TRIVIAL_USER.test(user) || user.length < 4) && answer.length < 200;
}

function textBlocks(content, kinds) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && kinds.includes(block.type) && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Claude Code transcript (`~/.claude/projects/<project>/<session>.jsonl`).
 * Returns the turns in order. `complete` is false for the last turn while the
 * session may still be writing it (no later user message and the file is fresh).
 */
export function claudeTurns(fileText, { idle = false } = {}) {
  const turns = [];
  let current = null;
  let meta = { sessionId: null, cwd: null, gitBranch: null };
  for (const row of parseLines(fileText)) {
    if (row.isSidechain) continue;
    if (row.sessionId) meta = { sessionId: row.sessionId, cwd: row.cwd ?? meta.cwd, gitBranch: row.gitBranch ?? meta.gitBranch };
    const message = row.message;
    if (row.type === "user" && message?.role === "user" && !row.isMeta) {
      const raw = textBlocks(message.content, ["text"]);
      const text = stripInjected(raw);
      if (isInjectedUserText(text)) continue; // tool results carry no text blocks and land here too
      current = { id: row.uuid ?? `line${turns.length}`, at: row.timestamp ?? null, user: text, answerParts: new Map(), lastAnswerId: null, ...meta };
      turns.push(current);
    } else if (row.type === "assistant" && current && message?.role === "assistant") {
      const text = textBlocks(message.content, ["text"]).trim();
      if (!text) continue;
      const id = message.id ?? row.uuid;
      if (id !== current.lastAnswerId) current.answerParts = new Map();
      current.answerParts.set(row.uuid ?? String(current.answerParts.size), text);
      current.lastAnswerId = id;
      current.answerAt = row.timestamp ?? current.answerAt;
    }
  }
  return finish(turns, idle);
}

function finish(turns, idle) {
  return turns.map((turn, index) => ({
    id: turn.id,
    at: turn.at,
    answerAt: turn.answerAt ?? null,
    sessionId: turn.sessionId,
    cwd: turn.cwd,
    gitBranch: turn.gitBranch ?? null,
    user: trim(turn.user, USER_MAX_CHARS),
    answer: trim([...(turn.answerParts?.values() ?? [])].join("\n\n") || turn.answer || "", ANSWER_MAX_CHARS),
    complete: index < turns.length - 1 || idle,
  }));
}

/**
 * Codex session (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`), current
 * format (`{timestamp, type, payload}`) and the older one (bare items).
 * John's words come from `user_message` events when there are any, else from
 * user `message` items; the final answer is `task_complete.last_agent_message`,
 * else the last assistant message of the turn.
 */
export function codexTurns(fileText, { idle = false } = {}) {
  const rows = parseLines(fileText);
  let meta = { sessionId: null, cwd: null };
  const items = rows.map((row) => {
    if (row.payload && row.type) return { at: row.timestamp ?? null, kind: row.type, payload: row.payload };
    if (row.type === "message" || row.type === "function_call" || row.type === "reasoning") {
      return { at: row.timestamp ?? null, kind: "response_item", payload: row };
    }
    if (row.id && row.instructions !== undefined) return { at: row.timestamp ?? null, kind: "session_meta", payload: row };
    return { at: row.timestamp ?? null, kind: "other", payload: row };
  });
  const useEvents = items.some((item) => item.kind === "event_msg" && item.payload.type === "user_message");
  const turns = [];
  let current = null;
  let ordinal = 0;
  for (const { at, kind, payload } of items) {
    if (kind === "session_meta") {
      meta = { sessionId: payload.id ?? meta.sessionId, cwd: payload.cwd ?? meta.cwd };
      continue;
    }
    let userText = null;
    let answerText = null;
    let final = false;
    if (useEvents && kind === "event_msg") {
      if (payload.type === "user_message" && typeof payload.message === "string") userText = payload.message;
      else if (payload.type === "agent_message" && typeof payload.message === "string") answerText = payload.message;
      else if (payload.type === "task_complete" && typeof payload.last_agent_message === "string") {
        answerText = payload.last_agent_message;
        final = true;
      }
    } else if (!useEvents && kind === "response_item" && payload.type === "message") {
      if (payload.role === "user") userText = textBlocks(payload.content, ["input_text", "text"]);
      else if (payload.role === "assistant") answerText = textBlocks(payload.content, ["output_text", "text"]);
    }
    if (userText !== null) {
      const text = stripInjected(userText);
      if (isInjectedUserText(text)) continue;
      ordinal += 1;
      current = { id: `u${ordinal}`, at, user: text, answer: "", final: false, ...meta };
      turns.push(current);
    } else if (answerText !== null && current && answerText.trim()) {
      if (current.final && !final) continue;
      current.answer = answerText;
      current.answerAt = at;
      current.final = current.final || final;
    }
  }
  return finish(turns, idle);
}

/**
 * Groups turns into entries of at most BATCH_MAX_TURNS turns and about
 * BATCH_MAX_CHARS characters. Each batch is one retain (one model call).
 */
export function batchTurns(turns, render) {
  const batches = [];
  let batch = [];
  let size = 0;
  for (const turn of turns) {
    const length = render(turn).length;
    if (batch.length > 0 && (batch.length >= BATCH_MAX_TURNS || size + length > BATCH_MAX_CHARS)) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(turn);
    size += length;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function hhmm(at) {
  return at ? `${String(at).slice(11, 16)} UTC` : "time unknown";
}

export function dayLabel(at) {
  if (!at) return "date unknown";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "date unknown";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** One turn as text: who said what, when. `assistant` is "Claude" or "Codex (ChatGPT)". */
export function renderTurn(turn, assistant) {
  const lines = [`[${hhmm(turn.at)}] John: ${turn.user}`];
  if (turn.answer) lines.push(`[${hhmm(turn.answerAt ?? turn.at)}] ${assistant}, final answer: ${turn.answer}`);
  return lines.join("\n");
}
