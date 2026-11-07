import { randomUUID } from "node:crypto";
import type {
  LiveDesignReply,
  LiveDesignRequest,
  LiveDesignStatus,
  LiveDesignMessage,
  LiveDesignVariant,
  LiveDesignView,
} from "@greatstone/shared";

/**
 * Live design sessions: John uses Impeccable's own page tools on an agent's
 * HTML prototype; GSAM stands in for Impeccable's local helper. The agent
 * stays in one run, long-polling GSAM for the next request, and replies with
 * versions that GSAM wraps in Impeccable's variant markup for the page.
 * Agents use the two endpoints through paperclipApiRequest (or curl with
 * their API key), so live design needs no new MCP tool.
 *
 * ponytail: in memory on the one server process. A restart ends open sessions;
 * the editor says so and John opens it again. Move to a table if GSAM ever
 * runs more than one server process.
 */

type Request = LiveDesignRequest & { id: string; startedAt: string };

type AgentEvent =
  | { type: "generate"; requestId: string; request: LiveDesignRequest; attachmentId: string; count: number }
  | {
      type: "accept";
      requestId: string;
      variant: number;
      chosen: LiveDesignVariant;
      paramValues: Record<string, unknown> | null;
      request: LiveDesignRequest;
      attachmentId: string;
    }
  | { type: "steer"; requestId: string | null; message: string }
  | { type: "edits"; requestId: string; edits: StagedEdit[]; attachmentId: string }
  | { type: "discard"; requestId: string }
  | { type: "restored"; attachmentId: string; version: number | null }
  | { type: "end" };

/** One batch of John's direct text edits or element removals, staged by Impeccable's pencil until he applies them. */
export interface StagedEdit {
  id: string;
  element: Record<string, unknown> | null;
  ops: Array<Record<string, unknown>>;
}

/**
 * Where the page being designed lives: a task file (an HTML attachment) or a
 * website page (a page revision). The session's `attachmentId` is the current
 * version's id in either case.
 */
export interface LivePageSource {
  kind: "attachment" | "website-page";
  /** The editor frame's address for a version (Impeccable's tools inside). */
  frameSrc(versionId: string): string;
  /** The HTML of a version, for the agent. */
  read(versionId: string): Promise<string>;
  /** Save the agent's complete page; returns the new version's id. */
  save(html: string, agentId: string): Promise<string>;
  /** The page's name, for messages. */
  label: string;
  /** Extra rules for the agent about this kind of page (a website page's size, media and shared parts). */
  guidance?: string;
}

/** What the page's Impeccable scripts receive, in order, as their helper's event stream. */
type Frame = { seq: number; data: Record<string, unknown> };

interface Session {
  id: string;
  companyId: string;
  issueId: string;
  attachmentId: string;
  agentId: string;
  status: LiveDesignStatus;
  request: Request | null;
  variants: LiveDesignVariant[];
  appliedAttachmentId: string | null;
  error: string | null;
  messages: LiveDesignMessage[];
  queue: AgentEvent[];
  /** John's last chat note, until the agent answers it with versions (so a discard cannot lose it). */
  lastSteer?: { requestId: string | null; message: string } | null;
  waiter: ((event: AgentEvent | null) => void) | null;
  frames: Frame[];
  frameWaiters: Array<() => void>;
  staged: StagedEdit[];
  /** The project's DESIGN.md as the agent last sent it, for Impeccable's design panel. */
  designMd: string | null;
  /** Set while the agent writes John's applied edits into the page. */
  editsRequestId: string | null;
  /** Editors open on this session (laptop and phone share one); it ends when the last one leaves. */
  viewers: number;
  /** Markup screenshots GSAM saved for this session, by Impeccable event id. Only these go to the agent. */
  markups: Map<string, string>;
  /** The deliverable this page is (its latest version id), when opened from Deliverables. */
  deliverableId: string | null;
  source: LivePageSource | null;
  /** For a website page: the islands it may use, as agent instructions (GRE-3786). Null for other pages. */
  islands: string | null;
  agentSeenAt: number;
  touchedAt: number;
}

/** An agent counts as connected while it polls at least this often. */
const AGENT_PRESENCE_MS = 45_000;
/** A session nobody has used for this long ends, which lets the agent's run finish. */
const IDLE_END_MS = 20 * 60_000;
const MAX_POLL_MS = 25_000;

const sessions = new Map<string, Session>();

function say(s: Session, from: LiveDesignMessage["from"], text: string) {
  s.messages.push({ from, text: text.slice(0, 2000), at: new Date().toISOString() });
  if (s.messages.length > 200) s.messages.splice(0, s.messages.length - 200);
}

function isConnected(s: Session, now = Date.now()) {
  return now - s.agentSeenAt < AGENT_PRESENCE_MS;
}

function push(s: Session, event: AgentEvent) {
  if (s.waiter) {
    const resolve = s.waiter;
    s.waiter = null;
    resolve(event);
  } else {
    s.queue.push(event);
  }
}

function frame(s: Session, data: Record<string, unknown>) {
  const seq = (s.frames[s.frames.length - 1]?.seq ?? 0) + 1;
  s.frames.push({ seq, data });
  if (s.frames.length > 100) s.frames.splice(0, s.frames.length - 100);
  const waiters = s.frameWaiters.splice(0);
  for (const wake of waiters) wake();
}

function end(s: Session) {
  if (s.status === "ended") return;
  s.status = "ended";
  s.queue = [];
  push(s, { type: "end" });
  frame(s, { type: "agent_polling", connected: false });
  // Keep it briefly so a late poll or page refresh sees "ended", not "not found".
  setTimeout(() => sessions.delete(s.id), 5 * 60_000).unref?.();
}

/** A first wake can take minutes; an agent that was polling and went quiet has stopped. */
// Generous: an agent rewriting a whole page can work for minutes without calling back.
const STALL_NEVER_JOINED_MS = 8 * 60_000;
const STALL_WENT_QUIET_MS = { generating: 8 * 60_000, applying: 12 * 60_000 } as const;

/** The agent stopped answering mid-request: say so and free the page instead of spinning forever. */
function checkStall(s: Session, now: number) {
  if (s.status !== "generating" && s.status !== "applying") return;
  const since = s.request ? Date.parse(s.request.startedAt) : s.touchedAt;
  const quiet = s.agentSeenAt === 0 ? now - since > STALL_NEVER_JOINED_MS : now - s.agentSeenAt > STALL_WENT_QUIET_MS[s.status];
  if (!quiet) return;
  const id = s.editsRequestId ?? s.request?.id ?? null;
  const editing = !!s.editsRequestId;
  s.editsRequestId = null;
  s.request = null;
  s.variants = [];
  s.status = "waiting_agent";
  s.queue = [];
  say(s, "gsam", editing
    ? "The agent stopped responding, so your edits were not applied. They are still staged: press Apply again."
    : "The agent stopped responding. Press Go again; GSAM will wake an agent.");
  if (id) frame(s, editing ? { type: "manual_edit_commit_failed", error: "agent_stopped" } : { type: "error", id, message: "The agent stopped responding. Press Go again." });
}

function sweep(now = Date.now()) {
  for (const s of sessions.values()) {
    if (s.status !== "ended" && now - s.touchedAt > IDLE_END_MS) end(s);
    else checkStall(s, now);
  }
}

export type LiveDesignSession = Session;

export function viewLiveDesign(s: Session): LiveDesignView {
  return {
    id: s.id,
    issueId: s.issueId,
    attachmentId: s.attachmentId,
    status: s.status === "waiting_agent" && isConnected(s) ? "idle" : s.status,
    agentConnected: isConnected(s),
    request: s.request,
    variants: s.variants,
    appliedAttachmentId: s.appliedAttachmentId,
    error: s.error,
    messages: s.messages,
    deliverableId: s.deliverableId,
    frameSrc: s.source ? s.source.frameSrc(s.attachmentId) : null,
    sourceKind: s.source?.kind ?? "attachment",
  };
}

export function getLiveDesign(id: string) {
  sweep();
  return sessions.get(id) ?? null;
}

/** An open editor keeps its session alive (the idle sweep ends only sessions nobody is looking at). */
export function touchLiveDesign(s: Session) {
  if (s.status !== "ended") s.touchedAt = Date.now();
}

export function isLiveDesignEnded(s: Session) {
  return s.status === "ended";
}

/** Impeccable's markup screenshot for one Go, saved once; refuses more than a handful per session. */
export function recordLiveDesignMarkup(s: Session, eventId: string, attachmentId: string) {
  s.markups.set(eventId, attachmentId);
}

export function liveDesignMarkupFor(s: Session, eventId: string) {
  return s.markups.get(eventId) ?? null;
}

export const MAX_MARKUPS_PER_SESSION = 20;

export function canStoreLiveDesignMarkup(s: Session, eventId: string) {
  return s.status !== "ended" && !s.markups.has(eventId) && s.markups.size < MAX_MARKUPS_PER_SESSION;
}

/** The open session on this task, whichever agent runs it: a second device joins it. */
export function openLiveDesignFor(issueId: string) {
  sweep();
  return [...sessions.values()].find((s) => s.status !== "ended" && s.issueId === issueId) ?? null;
}

/** Agents already serving an open live session: a busy designer is skipped for the next one. */
export function liveDesignBusyAgents() {
  sweep();
  return new Set([...sessions.values()].filter((s) => s.status !== "ended").map((s) => s.agentId));
}

export function isLiveDesignAgentConnected(s: Session) {
  return isConnected(s);
}

/**
 * The open session for this task and agent, or a new one. `needsWake` is true
 * when no agent run is polling, so the caller wakes the agent.
 */

// ponytail: in memory, so a GSAM restart clears the chats; store them with the page if that matters.
const chats = new Map<string, LiveDesignMessage[]>();
function pageChat(key: string) {
  let messages = chats.get(key);
  if (!messages) chats.set(key, (messages = []));
  return messages;
}

export function startLiveDesign(input: {
  companyId: string;
  issueId: string;
  attachmentId: string;
  agentId: string;
  source?: LivePageSource;
  islands?: string | null;
}) {
  const { islands = null, ...ids } = input;
  sweep();
  let s = [...sessions.values()].find(
    (x) => x.status !== "ended" && x.issueId === input.issueId && x.agentId === input.agentId,
  );
  if (!s) {
    s = {
      id: randomUUID(),
      ...ids,
      status: "waiting_agent",
      request: null,
      variants: [],
      appliedAttachmentId: null,
      error: null,
      // The page's chat carries over to the next time it is opened (any computer).
      messages: pageChat(`${input.issueId}:${input.attachmentId}`),
      queue: [],
      waiter: null,
      frames: [],
      frameWaiters: [],
      staged: [],
      designMd: null,
      editsRequestId: null,
      viewers: 0,
      markups: new Map(),
      deliverableId: null,
      source: null,
      islands,
      agentSeenAt: 0,
      touchedAt: Date.now(),
    };
    delete (s as { source?: unknown }).source;
    s.source = input.source ?? null;
    sessions.set(s.id, s);
  }
  s.attachmentId = input.attachmentId;
  if (input.source) s.source = input.source;
  s.islands = islands;
  s.touchedAt = Date.now();
  s.viewers += 1;
  return { session: s, needsWake: !isConnected(s) };
}

export class LiveDesignConflict extends Error {}

/** `id` is Impeccable's session id for this request, so the page and the agent use the same one. */
export function requestLiveDesign(s: Session, request: LiveDesignRequest, id = randomUUID().slice(0, 8)) {
  if (s.status === "ended") throw new LiveDesignConflict("This live session has ended. Open the editor again to carry on.");
  if (s.status === "applying") throw new LiveDesignConflict("The agent is still saving the last version.");
  // A new request replaces versions John has not kept.
  if (s.request && s.status === "ready") push(s, { type: "discard", requestId: s.request.id });
  s.request = { ...request, id, startedAt: new Date().toISOString() };
  s.variants = [];
  s.error = null;
  s.status = "generating";
  s.touchedAt = Date.now();
  say(s, "john", request.action === "impeccable" ? request.prompt : `${request.action}: ${request.prompt}`);
  push(s, { type: "generate", requestId: id, request, attachmentId: s.attachmentId, count: request.count });
  return s;
}

export function acceptLiveDesign(s: Session, requestId: string, variant: number, paramValues: Record<string, unknown> | null = null) {
  const chosen = s.variants[variant];
  if (!s.request || s.request.id !== requestId || s.status !== "ready" || !chosen) {
    throw new LiveDesignConflict("Those versions are no longer open.");
  }
  s.status = "applying";
  s.touchedAt = Date.now();
  say(s, "gsam", `You kept version ${variant + 1}${chosen.name ? ` (${chosen.name})` : ""}. The agent is saving it into the page.`);
  push(s, { type: "accept", requestId, variant, chosen, paramValues, request: s.request, attachmentId: s.attachmentId });
  return s;
}

export function discardLiveDesign(s: Session) {
  if (s.request && (s.status === "ready" || s.status === "generating")) {
    push(s, { type: "discard", requestId: s.request.id });
    say(s, "gsam", "Discarded. The page is back as it was.");
    // A note John sent about those versions is not dropped with them: it goes on as a request for the page.
    const notes = s.queue.filter((e) => e.type === "steer" && e.requestId === s.request!.id) as Array<{ message: string }>;
    for (const note of notes) push(s, { type: "steer", requestId: null, message: note.message });
    if (!notes.length && s.lastSteer?.requestId === s.request.id) push(s, { type: "steer", requestId: null, message: s.lastSteer.message });
  }
  // While the agent applies edits the session stays "applying"; only the versions go.
  if (s.status !== "ended" && !s.editsRequestId) s.status = isConnected(s) ? "idle" : "waiting_agent";
  s.request = null;
  s.variants = [];
  s.touchedAt = Date.now();
  return s;
}

/** A note from John to the agent mid-request ("make the second one calmer"). */
export function steerLiveDesign(s: Session, message: string, steerId: string | null = null) {
  if (s.status === "ended") throw new LiveDesignConflict("This live session has ended. Open the editor again to carry on.");
  const text = message.trim().slice(0, 2000);
  if (!text) return s;
  say(s, "john", text);
  s.touchedAt = Date.now();
  push(s, { type: "steer", requestId: s.request?.id ?? null, message: text });
  s.lastSteer = { requestId: s.request?.id ?? null, message: text };
  // Impeccable keeps its steer box locked until the helper says the note was taken.
  if (steerId) frame(s, { type: "steer_done", id: steerId, message: "Sent to the agent." });
  return s;
}

/** The deliverable's newest version after a save or a restore. */
export function setLiveDesignDeliverable(s: Session, deliverableId: string | null) {
  s.deliverableId = deliverableId;
}

/**
 * John brings back an earlier version. The caller has already saved it as the
 * newest version; the page and the agent move to it.
 */
export function restoreLiveDesign(s: Session, attachmentId: string, version: number | null) {
  if (s.status === "ended") throw new LiveDesignConflict("This live session has ended. Open the editor again to carry on.");
  if (s.status !== "idle" && s.status !== "waiting_agent") {
    throw new LiveDesignConflict("Keep or discard the open versions first, then restore.");
  }
  if (s.staged.length) throw new LiveDesignConflict("Apply or discard your text edits first, then restore.");
  s.attachmentId = attachmentId;
  s.appliedAttachmentId = attachmentId;
  s.touchedAt = Date.now();
  say(s, "gsam", version ? `Restored version ${version}. It is now the newest version.` : "Restored an earlier version.");
  push(s, { type: "restored", attachmentId, version });
  return s;
}

/** One editor leaves. The session (and the agent's run) ends when no editor is left. */
export function endLiveDesign(s: Session) {
  s.viewers = Math.max(0, s.viewers - 1);
  if (s.viewers === 0) end(s);
  return s;
}

/** The agent's long-poll: the next event, or `{ type: "timeout" }` after the wait. */
export async function pollLiveDesign(s: Session, waitMs: number, gone: () => boolean = () => false) {
  if (!isConnected(s) && s.status !== "ended") {
    say(s, "gsam", "The agent joined.");
    frame(s, { type: "agent_polling", connected: true });
  }
  s.agentSeenAt = Date.now();
  if (s.status === "waiting_agent") s.status = "idle";
  const queued = s.queue.shift();
  if (queued) return withInstructions(s, queued);
  if (s.status === "ended") return withInstructions(s, { type: "end" });
  // One poll at a time; an older poll from the same run just times out.
  s.waiter?.(null);
  const event = await new Promise<AgentEvent | null>((resolve) => {
    s.waiter = resolve;
    setTimeout(() => {
      if (s.waiter === resolve) {
        s.waiter = null;
        resolve(null);
      }
    }, Math.min(Math.max(waitMs, 1000), MAX_POLL_MS)).unref?.();
  });
  s.agentSeenAt = Date.now();
  // The agent's run went away mid-poll (cancelled, crashed): keep the event for its next poll.
  if (event && gone()) {
    s.queue.unshift(event);
    return { type: "timeout", sessionId: s.id, _instructions: "" };
  }
  return event
    ? withInstructions(s, event)
    : { type: "timeout", sessionId: s.id, _instructions: `Nothing yet. ${pollCall(s.id)} again now.` };
}

/** Whether a page the agent is about to send would be used: checked before anything is saved, so nothing is orphaned. */
export function liveDesignAcceptsPage(s: Session, requestId: string) {
  if (s.status === "ended") return false;
  if (requestId === LIVE_DESIGN_PAGE_REQUEST) return s.status === "idle" || s.status === "waiting_agent";
  if (s.editsRequestId === requestId) return true;
  return s.request?.id === requestId && s.status === "applying";
}

/** The request id an agent uses for a change to the whole page that John asked for in the chat. */
export const LIVE_DESIGN_PAGE_REQUEST = "page";

export function replyLiveDesign(s: Session, reply: LiveDesignReply) {
  if (s.status === "ended") return { ok: false, reason: "ended" as const };
  s.agentSeenAt = Date.now();
  if (reply.requestId === LIVE_DESIGN_PAGE_REQUEST) return replyPage(s, reply);
  if (reply.designMd) s.designMd = reply.designMd;
  if (s.editsRequestId && reply.requestId === s.editsRequestId) return replyEdits(s, reply);
  if (!s.request || s.request.id !== reply.requestId) return { ok: false, reason: "stale_request" as const };
  if (reply.message) say(s, "agent", reply.message);
  if (reply.error) {
    say(s, "gsam", `The agent could not do that: ${reply.error}`);
    s.error = reply.error;
    s.status = "idle";
    frame(s, { type: "error", id: reply.requestId, message: reply.error });
    return { ok: true };
  }
  // Versions answer John's last note; discarding them must not send it again.
  if (reply.variants?.length) s.lastSteer = null;
  // "ready" too: after a comment on a version, the agent sends the revised set for the same request.
  if ((s.status === "generating" || s.status === "ready") && reply.variants?.length) {
    const revised = s.status === "ready";
    s.variants = reply.variants;
    s.status = "ready";
    say(s, "gsam", revised ? "Versions updated on the page." : `${reply.variants.length} version${reply.variants.length === 1 ? "" : "s"} ready. Flick through them on the page, then accept one.`);
    // The editor inserts the wrapper into the page, then hands Impeccable the "done".
    frame(s, { type: "done", id: reply.requestId, gsVariantsHtml: impeccableVariantsHtml(reply.requestId, reply.variants, !!s.request.insert), message: reply.message ?? null });
    return { ok: true };
  }
  if (s.status === "applying" && reply.appliedAttachmentId) {
    s.appliedAttachmentId = reply.appliedAttachmentId;
    s.attachmentId = reply.appliedAttachmentId;
    s.request = null;
    s.variants = [];
    s.status = "idle";
    say(s, "gsam", "Saved into the page as a new version of the file.");
    frame(s, { type: "agent_done", id: reply.requestId, data: { carbonize: false } });
    return { ok: true };
  }
  if (reply.message) return { ok: true };
  return { ok: false, reason: "unexpected_reply" as const };
}

/** A whole-page change from the chat: saved straight away as the next version, no versions to pick. */
function replyPage(s: Session, reply: LiveDesignReply) {
  if (reply.message) say(s, "agent", reply.message);
  if (!reply.appliedAttachmentId) return { ok: true };
  // Never under open versions or edits: a later Accept would target a page that changed under it.
  if (s.status !== "idle" && s.status !== "waiting_agent") return { ok: false, reason: "busy" as const };
  s.attachmentId = reply.appliedAttachmentId;
  s.appliedAttachmentId = reply.appliedAttachmentId;
  s.touchedAt = Date.now();
  say(s, "gsam", "Page updated and saved as a new version. Use Versions to undo.");
  return { ok: true };
}

const opCount = (s: Session) => s.staged.reduce((n, e) => n + e.ops.length, 0);

/** Impeccable's pencil saved an edit (or a removal); it waits here until John applies. */
export function stageLiveDesignEdit(s: Session, edit: StagedEdit) {
  if (s.status === "ended") throw new LiveDesignConflict("This live session has ended. Open the editor again to carry on.");
  if (s.editsRequestId) throw new LiveDesignConflict("The agent is still applying your last edits.");
  s.staged.push({ ...edit, ops: edit.ops.slice(0, 50) });
  s.touchedAt = Date.now();
  for (const op of edit.ops) {
    if (op.removeElement === true) say(s, "john", `Removed ${String(op.tag ?? "an element")}.`);
    else if (typeof op.newText === "string") say(s, "john", `Changed “${String(op.originalText ?? "").slice(0, 80)}” to “${op.newText.slice(0, 80)}”.`);
  }
  frame(s, { type: "manual_edit_stashed", pendingCount: opCount(s) });
  return { ok: true, pendingCount: opCount(s) };
}

export function liveDesignEditCount(s: Session) {
  return opCount(s);
}

/** Undo one staged op by its ref, or every staged edit. Returns what was dropped, for Impeccable to restore. */
export function discardLiveDesignEdits(s: Session, ref: string | null) {
  if (s.editsRequestId) throw new LiveDesignConflict("The agent is applying these edits now.");
  const dropped: StagedEdit[] = [];
  if (ref) {
    for (const e of s.staged) {
      const ops = e.ops.filter((op) => op.ref === ref);
      if (ops.length) dropped.push({ ...e, ops });
      e.ops = e.ops.filter((op) => op.ref !== ref);
    }
    s.staged = s.staged.filter((e) => e.ops.length);
  } else {
    dropped.push(...s.staged);
    s.staged = [];
  }
  if (dropped.length) say(s, "gsam", "Edits undone.");
  frame(s, { type: "manual_edit_discarded", pendingCount: opCount(s) });
  return { entries: dropped, remainingCount: opCount(s) };
}

/** "Apply edits": the agent writes the staged edits into its copy of the page and saves it. */
export function applyLiveDesignEdits(s: Session) {
  if (s.status === "ended") throw new LiveDesignConflict("This live session has ended. Open the editor again to carry on.");
  if (s.editsRequestId) throw new LiveDesignConflict("The agent is already applying your edits.");
  if (s.status !== "idle" && s.status !== "waiting_agent") {
    throw new LiveDesignConflict("Keep or discard the open versions first, then apply your edits.");
  }
  const count = opCount(s);
  if (!count) return { status: "nothing", remainingCount: 0 };
  const id = `edits-${randomUUID().slice(0, 8)}`;
  s.editsRequestId = id;
  s.status = "applying";
  s.touchedAt = Date.now();
  say(s, "gsam", `Applying ${count} edit${count === 1 ? "" : "s"}. The agent is writing ${count === 1 ? "it" : "them"} into the page.`);
  frame(s, { type: "manual_edit_commit_started", pendingCount: count });
  push(s, { type: "edits", requestId: id, edits: s.staged, attachmentId: s.attachmentId });
  return { status: "started", pendingCount: count };
}

function replyEdits(s: Session, reply: LiveDesignReply) {
  if (reply.message) say(s, "agent", reply.message);
  const count = opCount(s);
  const settle = () => {
    s.editsRequestId = null;
    if (s.status === "applying") s.status = "idle";
  };
  if (reply.error) {
    settle();
    say(s, "gsam", `The agent could not apply your edits: ${reply.error}. They are still staged.`);
    frame(s, { type: "manual_edit_commit_failed", error: reply.error });
    return { ok: true };
  }
  if (reply.appliedAttachmentId) {
    settle();
    s.staged = [];
    s.appliedAttachmentId = reply.appliedAttachmentId;
    s.attachmentId = reply.appliedAttachmentId;
    say(s, "gsam", "Edits saved into the page as a new version of the file.");
    frame(s, { type: "manual_edit_commit_done", appliedCount: count, remainingCount: 0 });
    return { ok: true };
  }
  return reply.message ? { ok: true } : { ok: false, reason: "unexpected_reply" as const };
}

/** The page's helper event stream from `after`, waiting up to `waitMs` for something new. */
export async function pollLiveDesignFrames(s: Session, after: number, waitMs: number) {
  const pending = () => s.frames.filter((f) => f.seq > after);
  if (!pending().length && s.status !== "ended") {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(Math.max(waitMs, 0), MAX_POLL_MS));
      timer.unref?.();
      s.frameWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  return pending();
}

const escapeAttr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;");

/**
 * Impeccable's variant markup (skill/reference/live.md, "DOM contract"). The
 * original slot is empty: the page moves the live element into it, so its
 * listeners and state survive.
 */
export function impeccableVariantsHtml(id: string, variants: LiveDesignVariant[], insert = false) {
  const css = variants.map((v) => v.css).filter(Boolean).join("\n").replace(/<\/style/gi, "<\\/style");
  const slots = variants.map((v, i) => {
    const params = v.params?.length ? ` data-impeccable-params='${escapeAttr(JSON.stringify(v.params))}'` : "";
    const hidden = i === 0 ? "" : ' style="display: none"';
    return `<div data-impeccable-variant="${i + 1}"${params}${hidden}>${v.html}</div>`;
  });
  return [
    `<div data-impeccable-variants="${escapeAttr(id)}" data-impeccable-variant-count="${variants.length}"${insert ? ' data-impeccable-mode="insert"' : ""} style="display: contents">`,
    insert ? "" : `<div data-impeccable-variant="original"></div>`,
    css ? `<style data-impeccable-css="${escapeAttr(id)}">${css}</style>` : "",
    ...slots,
    "</div>",
  ].join("");
}

// Agents reach live design through the existing paperclipApiRequest tool, so it needs no new MCP tool.
const pollCall = (id: string) =>
  `Call paperclipApiRequest with method GET and path /live-design/${id}/poll?waitSeconds=25 (or curl GET /api/live-design/${id}/poll?waitSeconds=25 with your API key)`;
const pageCall = (id: string) =>
  `read it with paperclipApiRequest method GET path /live-design/${id}/page (or curl GET /api/live-design/${id}/page with your API key)`;
const replyCall = (id: string) => `call paperclipApiRequest with method POST, path /live-design/${id}/reply`;

function withInstructions(s: Session, event: AgentEvent) {
  const base = { sessionId: s.id, ...event };
  switch (event.type) {
    case "generate": {
      const action = event.request.action === "impeccable"
        ? "a freeform request"
        : `Impeccable's "${event.request.action}" command (follow that command's guidance in the impeccable skill's reference folder)`;
      return {
        ...base,
        _instructions: [
          event.request.insert
            ? `John wants ${event.request.label} (the element at request.selector, whose HTML is request.html) and asked: "${event.request.prompt}". Each version is a NEW element to place ${event.request.insert.position} it; nothing is replaced.`
            : `John picked ${event.request.label || event.request.tag} on the page and asked, as ${action}: "${event.request.prompt}".`,
          "First read PRODUCT.md and DESIGN.md at your workspace root and design inside them. If they are missing, write them before your versions (Greatstone brand by default; the client's brand for client work), and tell John in your note.",
          `The company's reference studio lists approved brand elements and examples with notes on how to use them: GET /api/companies/${s.companyId}/references (optional ?tag=). When John names a reference or gives an /api/assets/.../content path, fetch that image and follow its note.`,
          `Make ${event.count} versions of that element, following the impeccable skill's live-mode rules: each version commits to a DIFFERENT primary direction, and each is ONE element (normally the same tag) that replaces the original.`,
          "Give each version its own class names (for example .lv-halo) and put its CSS in that version's css; do not restyle shared classes. Respect prefers-reduced-motion. Keep text contrast readable.",
          ...(s.source?.guidance ? [s.source.guidance] : []),
          "Optional tune knobs per version: params [{ id, kind: \"range\" | \"steps\" | \"toggle\", ... }] as in the impeccable skill's live.md section 7, driving --p-<id> custom properties or data-p-<id> attributes.",
          `The element's current HTML is in request.html; for the whole page, ${pageCall(s.id)}.`,
          ...(s.islands ? [s.islands] : []),
          ...(event.request.notes.length ? [`John pinned these comments on the page: ${event.request.notes.map((n) => `"${n}"`).join("; ")}.`] : []),
          ...(event.request.screenshotAttachmentId
            ? [`He also marked the page up; open the screenshot at GET /api/attachments/${event.request.screenshotAttachmentId}/content to see where.`]
            : []),
          `John reads a chat beside the page. Send one short note first so he knows what you are trying: ${replyCall(s.id)} and jsonBody { "requestId": "${event.requestId}", "message": "<one plain sentence>"${s.designMd ? "" : ', "designMd": "<the full text of DESIGN.md>"'} }.${s.designMd ? "" : " Include designMd this once so his design panel shows the project's design system."}`,
          `Then ${replyCall(s.id)} and jsonBody { "requestId": "${event.requestId}", "variants": [{ "name": "...", "html": "...", "css": "...", "params": [] }] }. Speed matters: John is watching. Then poll again.`,
          `If you will not make versions for this pick (for example it is site code you are changing in the repo instead), ${replyCall(s.id)} and jsonBody { "requestId": "${event.requestId}", "error": "<one plain sentence on what you are doing instead>" } straight away: until you do, the page stays locked and John cannot pick anything else.`,
        ].join("\n"),
      };
    }
    case "accept":
      return {
        ...base,
        _instructions: [
          `John accepted version ${event.variant + 1} ("${event.chosen.name}")${event.paramValues ? ` with tune values ${JSON.stringify(event.paramValues)}` : ""}.`,
          event.request.insert
            ? `Write it into the real page: put chosen.html ${event.request.insert.position} the element at request.selector, bake any tune values in, and move chosen.css into the page's own stylesheet with tidy class names.`
            : "Write it into the real page: replace the element at request.selector with chosen.html, bake any tune values in, and move chosen.css into the page's own stylesheet with tidy class names (Impeccable's carbonize step).",
          `Start from the current page: ${pageCall(s.id)} (or your workspace copy if it matches it).`,
          ...(s.source?.guidance ? [s.source.guidance] : []),
          ...(s.islands ? [s.islands] : []),
          `Then ${replyCall(s.id)} and jsonBody { "requestId": "${event.requestId}", "pageHtml": "<the complete updated page>", "message": "<what you saved>" }; GSAM saves it on the task as the next version. Poll again.`,
          `If you cannot save it, ${replyCall(s.id)} and jsonBody { "requestId": "${event.requestId}", "error": "<short reason>" } so John knows.`,
        ].join("\n"),
      };
    case "steer":
      return {
        ...base,
        _instructions: event.requestId
          ? `John added a note to the current request: "${event.message}". Take it into account; if you already sent versions, send revised ones with the same requestId. If the note starts "About version N", it is about that version: revise it and send all versions again in the same order, the others unchanged. Answer him with a short "message" reply.`
          : [
              `John wrote in the chat: "${event.message}".`,
              `If it needs more than a quick answer, first ${replyCall(s.id)} and jsonBody { "requestId": "page", "message": "<one plain sentence: what you are about to do>" } so he knows you are on it, then do the work.`,
              ...(s.source?.guidance ? [s.source.guidance] : []),
              `If he asks for a change to the page, make it to the whole page (start from ${pageCall(s.id)}) and ${replyCall(s.id)} and jsonBody { "requestId": "page", "pageHtml": "<the complete updated page>", "message": "<what you changed>" }. GSAM saves it as the next version.`,
              `Otherwise answer with jsonBody { "requestId": "page", "message": "<your answer>" }. Then poll again.`,
            ].join("\n"),
      };
    case "edits":
      return {
        ...base,
        _instructions: [
          `John edited the page directly with Impeccable's pencil and pressed Apply. edits[].ops holds each change: originalText to newText for text (plain text only), or removeElement: true to delete an element. Each op carries a locator (tag, elementId, classes, leaf context, nearbyEditableTexts) to find it.`,
          "Apply exactly these changes and nothing else: no restyling, no rewording beyond newText. Follow the impeccable skill's live.md guidance on applying manual edits.",
          ...(s.islands ? [s.islands] : []),
          `Start from the current page: ${pageCall(s.id)} (or your workspace copy if it matches).`,
          ...(s.source?.guidance ? [s.source.guidance] : []),
          `Then ${replyCall(s.id)} and jsonBody { "requestId": "${event.requestId}", "pageHtml": "<the complete updated page>", "message": "<what you changed>" }; GSAM saves it on the task as the next version. Poll again.`,
          `If an edit cannot be applied safely, ${replyCall(s.id)} and jsonBody { "requestId": "${event.requestId}", "error": "<which one and why>" }; the edits stay staged for John.`,
        ].join("\n"),
      };
    case "discard":
      return { ...base, _instructions: "John discarded those versions. Change nothing. Poll again." };
    case "restored":
      return {
        ...base,
        _instructions: `John restored an earlier version of the page. ${pageCall(s.id)} and make your workspace copy match it before the next change. Reply nothing. Poll again.`,
      };
    case "end":
      return {
        ...base,
        _instructions: "John closed live design. Stop polling, post nothing, and end your run (no comment needed unless you saved changes).",
      };
  }
}

/** What the agent reads when GSAM wakes it for live design. */
/** The current page's HTML, for the agent. */
export async function readLiveDesignPage(s: Session) {
  if (!s.source) throw new LiveDesignConflict("This live session has no page.");
  return s.source.read(s.attachmentId);
}

export function liveDesignWakeMessage(sessionId: string, fileName: string) {
  return [
    `John opened live design on ${fileName} and is watching it now, possibly on his phone. He uses Impeccable's live tools on the page.`,
    `Stay in this run as the live designer. ${pollCall(sessionId)} in a loop; each call waits up to 25 seconds.`,
    "Each event carries _instructions: follow them, send the reply they describe, then poll again straight away.",
    "A timeout event just means nothing happened yet; poll again. Stop only when you get an end event.",
    "Do not post comments or change the task status during live design; John sees your versions and notes in the editor.",
  ].join("\n");
}

/** Test seam. */
export function resetLiveDesignSessions() {
  sessions.clear();
  chats.clear();
}
