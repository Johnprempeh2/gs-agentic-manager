import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import type {
  LiveDesignReply,
  LiveDesignRequest,
  LiveDesignStatus,
  LiveDesignMessage, LiveDesignCodeTask,
  LiveDesignVariant,
  LiveDesignView,
} from "@greatstone/shared";
import { LIVE_DESIGN_VIEW_FRAME } from "@greatstone/shared";
import { applyEditsToPage, applyVariantToPage, parseQuickChange, previewEdits, quickTextOp } from "./live-design-direct.js";

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
  | { type: "steer"; requestId: string | null; message: string; about?: { label: string; selector: string; html: string } }
  | { type: "edits"; requestId: string; edits: StagedEdit[]; attachmentId: string }
  | { type: "discard"; requestId: string }
  | { type: "restored"; attachmentId: string; version: number | null }
  | { type: "end" };

/** One batch of John's direct text edits or element removals, staged by Impeccable's pencil until he applies them. */
export interface StagedEdit {
  id: string;
  element: Record<string, unknown> | null;
  ops: Array<Record<string, unknown>>;
  /** Who made it: edits not saved yet are kept per page and per person, so they survive a restart. */
  userId?: string | null;
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
  /** Save a complete page; returns the new version's id. `userId`: the person who made the change, when it was not the agent. */
  save(html: string, agentId: string, userId?: string | null): Promise<string>;
  /** Set an island's words (the home landing's data-copy) on the newest version; returns the new version's id. */
  setIslandCopy?(versionId: string, changes: Record<string, string | boolean>, agentId: string): Promise<string>;
  /** The version number John sees for a version id, when the source numbers them. */
  version?(versionId: string): Promise<number | null>;
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
  /** Edits taken back with Undo, newest last, for Redo. Cleared by any new edit, save or restore. */
  redo: StagedEdit[];
  /** Edits put back from the store when the editor opened (after a restart, a crash or a closed tab), until the next change. */
  restoredCount: number;
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
  codeTasks: LiveDesignCodeTask[];
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
  saveStore();
  // The editor reads the session again when the stream says so, instead of asking every few seconds.
  if (s.frames) frame(s, { type: LIVE_DESIGN_VIEW_FRAME });
}

/** A line from GSAM in the editor's chat. */
export function liveDesignNote(s: Session, text: string) {
  say(s, "gsam", text);
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
    codeTasks: s.codeTasks,
    stagedCount: opCount(s),
    redoCount: s.redo.length,
    restoredCount: s.restoredCount,
    queued: s.queue.flatMap((e) =>
      e.type === "generate" ? [`${e.request.label || e.request.tag}: ${e.request.prompt}`] : e.type === "steer" && !e.requestId ? [e.about ? `${e.about.label}: ${e.message}` : e.message] : [],
    ),
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

// Chats, code tasks and edits not saved yet are kept in one small file so a GSAM restart, a crash
// or a closed tab does not lose them.
// ponytail: one JSON file rewritten on change; move to the database if it grows past a few MB.
const chats = new Map<string, LiveDesignMessage[]>();
/** Edits not saved yet, by `page|person`: the version they were made on, and Undo's redo line. */
interface PendingEdits { versionId: string; staged: StagedEdit[]; redo: StagedEdit[]; at: string }
const pendingEdits = new Map<string, PendingEdits>();
let storeFileOverride: string | null = null;
const storeFile = () => storeFileOverride ?? path.resolve(resolvePaperclipInstanceRoot(), "live-design-chats.json");
const storeOff = () => !!process.env.VITEST && !storeFileOverride;
let storeLoaded = storeOff();
let saveTimer: NodeJS.Timeout | null = null;
function loadStore() {
  if (storeLoaded) return;
  storeLoaded = true;
  try {
    const saved = JSON.parse(fs.readFileSync(storeFile(), "utf8")) as {
      chats?: Record<string, LiveDesignMessage[]>;
      codeTasks?: Record<string, LiveDesignCodeTask[]>;
      pendingEdits?: Record<string, PendingEdits>;
    };
    for (const [k, v] of Object.entries(saved.chats ?? {})) chats.set(k, v);
    for (const [k, v] of Object.entries(saved.codeTasks ?? {})) pageCodeTasks.set(k, v);
    for (const [k, v] of Object.entries(saved.pendingEdits ?? {})) pendingEdits.set(k, v);
  } catch {
    // No file yet, or unreadable: start empty.
  }
}
function writeStoreNow() {
  const body = JSON.stringify({ chats: Object.fromEntries(chats), codeTasks: Object.fromEntries(pageCodeTasks), pendingEdits: Object.fromEntries(pendingEdits) });
  try {
    fs.writeFileSync(storeFile() + ".tmp", body);
    fs.renameSync(storeFile() + ".tmp", storeFile());
  } catch {
    // A full disk or a missing folder: the session still works, only the restart copy is behind.
  }
}
/** `now`: written before returning (edits not saved yet must survive a crash a moment later). */
function saveStore(now = false) {
  if (storeOff()) return;
  if (now) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    writeStoreNow();
    return;
  }
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeStoreNow();
  }, 2000);
  saveTimer.unref?.();
}

const pendingKey = (pageKey: string, userId: string | null | undefined) => `${pageKey}|${userId ?? ""}`;

/** Copy the session's edits not saved yet to the store, one entry per person; none left clears the page's entries. */
function keepPendingEdits(s: Session) {
  loadStore();
  for (const k of [...pendingEdits.keys()]) if (k.startsWith(`${s.issueId}|`)) pendingEdits.delete(k);
  const people = new Set([...s.staged, ...s.redo].map((e) => e.userId ?? ""));
  for (const person of people) {
    const mine = (e: StagedEdit) => (e.userId ?? "") === person;
    const staged = s.staged.filter(mine);
    // Only a Redo line with nothing waiting is not worth keeping: there is nothing to save.
    if (!staged.length) continue;
    pendingEdits.set(pendingKey(s.issueId, person), { versionId: s.attachmentId, staged, redo: s.redo.filter(mine), at: new Date().toISOString() });
  }
  saveStore(true);
}

/** Any change to the edits not saved yet: the restored note goes, and the store follows. */
function editsChanged(s: Session) {
  s.restoredCount = 0;
  keepPendingEdits(s);
}

/** The person's edits not saved yet on this page, put back when they open it again on the same version. */
function restorePendingEdits(s: Session, userId: string | null) {
  const key = pendingKey(s.issueId, userId);
  const kept = pendingEdits.get(key);
  if (!kept || s.editsRequestId) return;
  // Already in the open session (a second device): nothing to put back.
  if ([...s.staged, ...s.redo].some((e) => (e.userId ?? "") === (userId ?? ""))) return;
  const count = kept.staged.reduce((n, e) => n + e.ops.length, 0);
  if (kept.versionId !== s.attachmentId) {
    // The page has a newer version (an agent or someone else saved): the edits may not fit it, so they are not put back.
    pendingEdits.delete(key);
    say(s, "gsam", `${count} edit${count === 1 ? "" : "s"} not saved last time ${count === 1 ? "was" : "were"} made on an earlier version of this page, so ${count === 1 ? "it was" : "they were"} not put back: ${kept.staged.map(editSummary).join("; ")}.`);
    saveStore(true);
    return;
  }
  s.staged.push(...kept.staged);
  s.redo.push(...kept.redo);
  s.restoredCount = count;
  say(s, "gsam", `Restored ${count} unsaved edit${count === 1 ? "" : "s"} from last time. Save to draft keeps ${count === 1 ? "it" : "them"}; Discard all drops ${count === 1 ? "it" : "them"}.`);
}
const pageCodeTasks = new Map<string, LiveDesignCodeTask[]>();
function codeTasksFor(issueId: string) {
  let tasks = pageCodeTasks.get(issueId);
  if (!tasks) pageCodeTasks.set(issueId, (tasks = []));
  return tasks;
}

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
  /** The person opening the editor: their edits not saved yet come back. */
  userId?: string | null;
}) {
  const { islands = null, userId = null, ...ids } = input;
  sweep();
  loadStore();
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
      redo: [],
      restoredCount: 0,
      designMd: null,
      editsRequestId: null,
      viewers: 0,
      markups: new Map(),
      deliverableId: null,
      source: null,
      islands,
      codeTasks: codeTasksFor(input.issueId),
      agentSeenAt: 0,
      touchedAt: Date.now(),
    };
    delete (s as { source?: unknown }).source;
    s.source = input.source ?? null;
    sessions.set(s.id, s);
    // The last session went away with John's message unanswered (a GSAM restart drops open sessions,
    // and waiting requests; edits not saved yet come back from the store): say so, never leave it looking taken.
    if (s.messages.at(-1)?.from === "john") {
      say(s, "gsam", "Your last message got no answer before the editor reconnected, so nothing from it was saved or deployed. Send it again if you still want it.");
    }
  }
  s.attachmentId = input.attachmentId;
  if (input.source) s.source = input.source;
  s.islands = islands;
  restorePendingEdits(s, userId);
  s.touchedAt = Date.now();
  s.viewers += 1;
  return { session: s, needsWake: !isConnected(s) };
}

export class LiveDesignConflict extends Error {}

/** `id` is Impeccable's session id for this request, so the page and the agent use the same one. */
export function requestLiveDesign(s: Session, request: LiveDesignRequest, id = randomUUID().slice(0, 8)) {
  if (s.status === "ended") throw new LiveDesignConflict("This live session has ended. Open the editor again to carry on.");
  // A pick while the agent is busy waits its turn and is then made straight on the page (Versions undoes it).
  if (s.status === "generating" || s.status === "applying") {
    const label = request.label || request.tag;
    say(s, "john", `${label}: ${request.prompt}`);
    push(s, { type: "steer", requestId: null, message: request.prompt, about: { label, selector: request.selector, html: request.html.slice(0, 20_000) } });
    const waiting = s.queue.filter((e) => e.type === "steer" && !e.requestId).length;
    say(s, "gsam", `Queued (${waiting} waiting). The agent makes it straight on the page after the current one; Versions undoes it.`);
    frame(s, { type: "error", id, message: `Queued, number ${waiting}. Pick the next thing whenever you like.` });
    s.touchedAt = Date.now();
    return s;
  }
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

/**
 * Accept without the agent (GRE-5369): GSAM puts the kept version into the page and saves the next
 * version itself, so the save takes moments and never waits for an agent that has stopped. Null means
 * it could not place it for certain (or the version has tune knobs to bake in): the caller hands the
 * accept to the agent, as before. A failed save leaves the versions open and says why.
 */
export async function acceptLiveDesignDirect(s: Session, requestId: string, variant: number, paramValues: Record<string, unknown> | null, userId: string | null) {
  const chosen = s.variants[variant];
  if (!s.request || s.request.id !== requestId || s.status !== "ready" || !chosen) {
    throw new LiveDesignConflict("Those versions are no longer open.");
  }
  if (!s.source || chosen.params?.length || (paramValues && Object.keys(paramValues).length)) return null;
  const request = s.request;
  const startedAt = Date.now();
  // Held while the page is read and saved, so a second accept or a new pick waits.
  s.status = "applying";
  try {
    const result = applyVariantToPage(await s.source.read(s.attachmentId), request, chosen);
    if ("failed" in result) {
      s.status = "ready";
      return null;
    }
    const id = await s.source.save(result.html, s.agentId, userId);
    const version = (await s.source.version?.(id).catch(() => null)) ?? null;
    s.attachmentId = id;
    s.appliedAttachmentId = id;
    s.request = null;
    s.variants = [];
    s.error = null;
    s.status = isConnected(s) ? "idle" : "waiting_agent";
    s.touchedAt = Date.now();
    const name = chosen.name ? ` (${chosen.name})` : "";
    say(s, "gsam", version ? `Kept version ${variant + 1}${name}. Saved as version ${version}.` : `Kept version ${variant + 1}${name}. Saved as a new version of the file.`);
    frame(s, { type: "agent_done", id: requestId, data: { carbonize: false } });
    // Work still waiting for this request is done; the agent's copy of the page is now behind.
    s.queue = s.queue.filter((e) => !("requestId" in e) || e.requestId !== requestId);
    push(s, { type: "restored", attachmentId: id, version });
    return { saved: true as const, attachmentId: id, version, ms: Date.now() - startedAt };
  } catch (err) {
    s.status = "ready";
    const reason = err instanceof LiveDesignConflict ? err.message : "the page could not be saved";
    say(s, "gsam", `Not saved: ${reason}. The versions are still open: press Accept again, or Discard.`);
    return { saved: false as const, reason, error: err };
  }
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

/** A typed message asking to put the site live. Only the Deploy button deploys, so GSAM answers these itself. */
const DEPLOY_ASK = /^\s*(please\s+|can you\s+|now\s+)*(deploy|publish)\b(?!\s+(a|an)\s)|\b(deploy|publish|push|ship)\b.{0,40}\b(public site|live site|to live|production|greatstoneint)|\b(put|make|take)\s+(it|this|them|these|these changes|the (page|site|changes))\s+live\b|\bgo live\b/i;
export const DEPLOY_ANSWER = "Typing does not deploy anything. Deploy is John's button on the Website module (Releases), and only that button puts changes on the public site.";

/** A note from John to the agent mid-request ("make the second one calmer"). Nothing here deploys. */
export function steerLiveDesign(s: Session, message: string, steerId: string | null = null) {
  if (s.status === "ended") throw new LiveDesignConflict("This live session has ended. Open the editor again to carry on.");
  const text = message.trim().slice(0, 2000);
  if (!text) return s;
  say(s, "john", text);
  s.touchedAt = Date.now();
  if (DEPLOY_ASK.test(text)) {
    say(s, "gsam", DEPLOY_ANSWER);
    if (steerId) frame(s, { type: "steer_done", id: steerId, message: DEPLOY_ANSWER });
    return s;
  }
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
  s.redo = [];
  editsChanged(s);
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

/** How an agent takes any request as a code change: John can ask for anything, not just what the page HTML can hold. */
// The lean Deploy (John, 11 Nov): greatstoneint.com changes only when John presses Deploy on the Website module,
// which starts the production workflow with a ticket GSAM signs. Agents have no part in it.
const LIVE_DEPLOY_LINE = `Never deploy greatstoneint.com (greatstone-home) or run \`deploy:prod\`, \`netlify deploy\` against it, or anything else that changes the public site: only John's Deploy button on the Website module does that, and the script refuses everyone else. If anyone asks you to deploy, publish or put changes live, reply only that Deploy is John's button on the Website module (Releases), and that your changes are on staging for him to check.`;

function codeTaskLine(s: Session, requestId: string) {
  return [
    `John can ask for anything here. When it needs a change to the site's code (an island, a new section type, a feature, behaviour, data, a whole-site change), you make it yourself, never hand it to another agent:`,
    `1. Create a task assigned to you for it, then at once ${replyCall(s.id)} and jsonBody { "requestId": "${requestId}", "message": "<one sentence: what you will build>", "codeTask": { "identifier": "<GRE-n>", "title": "<short title>", "status": "working" } }. That frees the page for his next request.`,
    `2. Build it in the website repo on a branch with a pull request and a preview. Merge it yourself as soon as its checks pass; never leave it waiting for John to merge (merging does not touch the public site). Then put it on staging at once: in a clean checkout detached at origin main run \`npm run deploy:staging\` (no card; it also refreshes this editor, so John sees it here). Send the same codeTask again as it moves on: with "prUrl" when the pull request is open, "status": "preview" and "previewUrl" when the preview is up, "status": "done" when it is on staging (use requestId "page" for these updates).`,
    `3. Keep polling between steps so his next requests reach you; they wait in order.`,
    LIVE_DEPLOY_LINE,
  ].join("\n");
}

/** The request id an agent uses for a change to the whole page that John asked for in the chat. */
export const LIVE_DESIGN_PAGE_REQUEST = "page";

const savedLine = (version: number | null) => (version ? `Saved to the draft as version ${version}. Use Versions to undo.` : "Saved to the draft as a new version. Use Versions to undo.");

/** `savedVersion`: the number of the version GSAM just saved from the agent's page, when known. */
export function replyLiveDesign(s: Session, reply: LiveDesignReply, savedVersion: number | null = null) {
  if (s.status === "ended") return { ok: false, reason: "ended" as const };
  s.agentSeenAt = Date.now();
  if (reply.codeTask) return replyCodeTask(s, reply, reply.codeTask);
  if (reply.requestId === LIVE_DESIGN_PAGE_REQUEST) return replyPage(s, reply, savedVersion);
  if (reply.designMd) s.designMd = reply.designMd;
  if (s.editsRequestId && reply.requestId === s.editsRequestId) return replyEdits(s, reply, savedVersion);
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
    say(s, "gsam", s.source?.kind === "website-page" ? savedLine(savedVersion) : "Saved into the page as a new version of the file.");
    frame(s, { type: "agent_done", id: reply.requestId, data: { carbonize: false } });
    return { ok: true };
  }
  if (reply.message) return { ok: true };
  return { ok: false, reason: "unexpected_reply" as const };
}

/** The agent took a pick or a note as a code change, or reports progress on one. */
function replyCodeTask(s: Session, reply: LiveDesignReply, task: LiveDesignCodeTask) {
  const known = s.codeTasks.findIndex((t) => t.identifier === task.identifier);
  if (known >= 0) s.codeTasks.splice(known, 1);
  s.codeTasks.unshift(task);
  if (s.codeTasks.length > 20) s.codeTasks.length = 20;
  saveStore();
  if (reply.message) say(s, "agent", reply.message);
  if (known < 0) say(s, "gsam", `Taken as a code change: ${task.identifier} ${task.title}. Pick the next thing whenever you like.`);
  else if (task.status === "preview" && task.previewUrl) say(s, "gsam", `${task.identifier} has a preview ready.`);
  // A pick the agent will not answer with versions: free the page now.
  if (s.request?.id === reply.requestId && s.status === "generating") {
    s.request = null;
    s.variants = [];
    s.status = "idle";
    frame(s, { type: "error", id: reply.requestId, message: `Taken as a code change (${task.identifier}).` });
  }
  return { ok: true };
}

/** A whole-page change from the chat: saved straight away as the next version, no versions to pick. */
function replyPage(s: Session, reply: LiveDesignReply, savedVersion: number | null) {
  if (reply.message) say(s, "agent", reply.message);
  if (!reply.appliedAttachmentId) return { ok: true };
  // Never under open versions or edits: a later Accept would target a page that changed under it.
  if (s.status !== "idle" && s.status !== "waiting_agent") return { ok: false, reason: "busy" as const };
  s.attachmentId = reply.appliedAttachmentId;
  s.appliedAttachmentId = reply.appliedAttachmentId;
  s.touchedAt = Date.now();
  say(s, "gsam", s.source?.kind === "website-page" ? savedLine(savedVersion) : "Page updated and saved as a new version. Use Versions to undo.");
  return { ok: true };
}

const ELEMENT_NOUNS: Record<string, string> = {
  a: "link", button: "button", img: "image", picture: "image", svg: "graphic", video: "video",
  h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
  p: "paragraph", li: "list item", ul: "list", ol: "list", section: "section", nav: "menu",
  form: "form", input: "field", figure: "figure", table: "table", blockquote: "quote",
};

/** "Removed the “Begin the Conversation” link.", from what Impeccable found the element by. */
export function describeRemoval(op: Record<string, unknown>) {
  const tag = String(op.tag ?? "").toLowerCase();
  const noun = ELEMENT_NOUNS[tag] ?? "element";
  const text = String(op.originalText ?? "").replace(/\s+/g, " ").trim();
  // Impeccable falls back to an id or class name when there is no text; that is no use to John.
  const named = text && text !== op.elementId && !(Array.isArray(op.classes) && op.classes.includes(text));
  return named ? `Removed the “${text.length > 60 ? `${text.slice(0, 57)}…` : text}” ${noun}.` : `Removed ${/^[aeiou]/.test(noun) ? "an" : "a"} ${noun}.`;
}

const opCount = (s: Session) => s.staged.reduce((n, e) => n + e.ops.length, 0);

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9]{0,39}$/;

/** Pick changed or hid the landing's words: GSAM writes them into the island and saves the next draft version. */
async function saveIslandCopy(s: Session, ops: Array<Record<string, unknown>>) {
  const changes: Record<string, string | boolean> = {};
  for (const op of ops) {
    const toggle = String(op.islandToggle ?? "");
    const field = String(op.islandField ?? "");
    if (op.removeElement === true && FIELD_NAME.test(toggle)) {
      changes[toggle] = false;
      say(s, "john", describeRemoval(op).replace(/^Removed/, "Hid"));
    } else if (op.removeElement === true && FIELD_NAME.test(field)) {
      changes[field] = "";
      say(s, "john", describeRemoval(op).replace(/^Removed/, "Hid"));
    } else if (FIELD_NAME.test(field) && typeof op.newText === "string") {
      changes[field] = op.newText.slice(0, 600);
      say(s, "john", `Changed “${String(op.originalText ?? "").slice(0, 80)}” to “${op.newText.slice(0, 80)}”.`);
    }
  }
  if (!Object.keys(changes).length || !s.source?.setIslandCopy) return;
  try {
    const id = await s.source.setIslandCopy(s.attachmentId, changes, s.agentId);
    const version = (await s.source.version?.(id).catch(() => null)) ?? null;
    s.attachmentId = id;
    s.appliedAttachmentId = id;
    s.touchedAt = Date.now();
    say(s, "gsam", savedLine(version));
    frame(s, { type: "manual_edit_commit_done", appliedCount: ops.length, remainingCount: opCount(s) });
  } catch (err) {
    say(s, "gsam", `Not saved: ${err instanceof Error ? err.message : "the page could not be saved"}`);
    frame(s, { type: "manual_edit_commit_failed", error: "not_saved" });
  }
}

/** Impeccable's pencil saved an edit (or a removal); it waits here until John applies. */
export function stageLiveDesignEdit(s: Session, edit: StagedEdit) {
  if (s.status === "ended") throw new LiveDesignConflict("This live session has ended. Open the editor again to carry on.");
  if (s.editsRequestId) throw new LiveDesignConflict("The agent is still applying your last edits.");
  // Edits on an island's words (Pick marks them islandField / islandToggle) save at once, without the agent.
  const islandOps = edit.ops.filter((op) => typeof op.islandField === "string" || typeof op.islandToggle === "string");
  if (islandOps.length && s.source?.setIslandCopy) {
    void saveIslandCopy(s, islandOps);
    edit = { ...edit, ops: edit.ops.filter((op) => !islandOps.includes(op)) };
    if (!edit.ops.length) return { ok: true, pendingCount: opCount(s) };
  }
  const before = opCount(s);
  s.staged.push({ ...edit, ops: edit.ops.slice(0, 50) });
  // A new edit starts a new line of history, as in any editor.
  s.redo = [];
  editsChanged(s);
  s.touchedAt = Date.now();
  for (const op of edit.ops) {
    if (op.removeElement === true) say(s, "john", describeRemoval(op));
    else if (typeof op.newText === "string") say(s, "john", `Changed “${String(op.originalText ?? "").slice(0, 80)}” to “${op.newText.slice(0, 80)}”.`);
  }
  if (!before) say(s, "gsam", "Not saved yet. Press Save to draft below the chat to save it, or Undo.");
  frame(s, { type: "manual_edit_stashed", pendingCount: opCount(s) });
  return { ok: true, pendingCount: opCount(s) };
}

export function liveDesignEditCount(s: Session) {
  return opCount(s);
}

/** What one edit did, in a few words, for the chat. */
function editSummary(e: StagedEdit) {
  const op = e.ops[0] ?? {};
  if (op.removeElement === true) return describeRemoval(op).replace(/\.$/, "").replace(/^Removed/, "removing");
  return typeof op.newText === "string" ? `changing “${String(op.originalText ?? "").slice(0, 60)}” to “${op.newText.slice(0, 60)}”` : "an edit";
}

/** Undo (Cmd or Ctrl Z in the editor): takes back the newest edit not saved yet, one at a time. */
export function undoLiveDesignEdit(s: Session) {
  if (s.status === "ended") throw new LiveDesignConflict("This live session has ended. Open the editor again to carry on.");
  if (s.editsRequestId) throw new LiveDesignConflict("Your edits are being saved now. Undo when the save has finished.");
  const last = s.staged.pop();
  if (!last) return s;
  s.redo.push(last);
  editsChanged(s);
  s.touchedAt = Date.now();
  say(s, "gsam", `Undone: ${editSummary(last)}.`);
  frame(s, { type: "manual_edit_discarded", pendingCount: opCount(s) });
  return s;
}

/** Redo (Shift Cmd or Ctrl Z): puts back the edit Undo took, until a new edit is made. */
export function redoLiveDesignEdit(s: Session) {
  if (s.status === "ended") throw new LiveDesignConflict("This live session has ended. Open the editor again to carry on.");
  if (s.editsRequestId) throw new LiveDesignConflict("Your edits are being saved now. Redo when the save has finished.");
  const next = s.redo.pop();
  if (!next) return s;
  s.staged.push(next);
  editsChanged(s);
  s.touchedAt = Date.now();
  say(s, "gsam", `Redone: ${editSummary(next)}.`);
  frame(s, { type: "manual_edit_stashed", pendingCount: opCount(s) });
  return s;
}

/**
 * The chat's fast path: a request that is only a change of words is made at once, as an edit not
 * saved yet (the person sees it on the page, then saves or undoes it), with no agent round trip.
 * `done: false` means it is not that simple, or not certain: the caller sends it to the agent as before.
 */
export async function quickLiveDesignEdit(s: Session, message: string, userId: string | null = null): Promise<{ done: true } | { done: false; reason: string }> {
  if (s.status === "ended") throw new LiveDesignConflict("This live session has ended. Open the editor again to carry on.");
  const change = parseQuickChange(message);
  if (!change) return { done: false, reason: "not a simple change of words" };
  if (!s.source || s.editsRequestId || (s.status !== "idle" && s.status !== "waiting_agent")) return { done: false, reason: "the page is busy" };
  const saved = await s.source.read(s.attachmentId);
  const staged = s.staged.flatMap((e) => e.ops);
  const op = quickTextOp(previewEdits(saved, staged), change);
  if ("failed" in op) return { done: false, reason: String(op.failed) };
  // It must save the way a hand edit saves, on top of the edits already waiting.
  const check = applyEditsToPage(saved, [...staged, op]);
  if ("failed" in check) return { done: false, reason: check.failed };
  stageLiveDesignEdit(s, { id: `quick-${randomUUID().slice(0, 8)}`, element: null, ops: [op], userId });
  say(s, "gsam", "Done at once, without the agent. It shows on the page now.");
  return { done: true };
}

/**
 * The edits not saved yet, for drawing the page as it will be saved (the frame reloads after an
 * Undo or Redo). Only for the version the session is on: any other version shows as it was saved.
 */
export function liveDesignPreviewOps(sessionId: unknown, versionId: string, companyId?: string) {
  const s = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
  if (!s || s.status === "ended" || s.attachmentId !== versionId || (companyId !== undefined && s.companyId !== companyId)) return [];
  return s.staged.flatMap((e) => e.ops);
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
  s.redo = [];
  editsChanged(s);
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

/**
 * "Save to draft" without the agent: GSAM writes the staged words and removals into the page itself
 * and saves the next version, so the save takes moments instead of an agent's turn. Null means it
 * could not (an edit it cannot place for certain, a busy session); the caller then asks the agent,
 * as before. A page the source refuses (the home page's guard, a size limit) stays staged.
 */
export async function saveLiveDesignEditsDirect(s: Session, userId: string | null) {
  if (!s.source || s.editsRequestId || (s.status !== "idle" && s.status !== "waiting_agent")) return null;
  const ops = s.staged.flatMap((e) => e.ops);
  if (!ops.length) return null;
  const startedAt = Date.now();
  const was = s.status;
  // Held while the page is read and saved, so nothing else is staged or applied in between.
  s.editsRequestId = `direct-${randomUUID().slice(0, 8)}`;
  s.status = "applying";
  const settle = () => {
    s.editsRequestId = null;
    if (s.status === "applying") s.status = was;
  };
  try {
    const result = applyEditsToPage(await s.source.read(s.attachmentId), ops);
    if ("failed" in result) {
      settle();
      return null;
    }
    const id = await s.source.save(result.html, s.agentId, userId);
    const version = (await s.source.version?.(id).catch(() => null)) ?? null;
    settle();
    s.staged = [];
    s.redo = [];
    editsChanged(s);
    s.attachmentId = id;
    s.appliedAttachmentId = id;
    s.touchedAt = Date.now();
    say(s, "gsam", s.source.kind === "website-page" ? savedLine(version) : "Edits saved into the page as a new version of the file.");
    frame(s, { type: "manual_edit_commit_done", appliedCount: ops.length, remainingCount: 0 });
    // The agent's copy of the page is now behind: it reads the page again before its next change.
    push(s, { type: "restored", attachmentId: id, version });
    return { saved: true as const, attachmentId: id, version, applied: ops.length, ms: Date.now() - startedAt };
  } catch (err) {
    settle();
    if (!(err instanceof LiveDesignConflict)) return null;
    say(s, "gsam", `Not saved: ${err.message}`);
    say(s, "gsam", "Your edits are still waiting. Undo them, or ask in the chat.");
    frame(s, { type: "manual_edit_commit_failed", error: err.message });
    return { saved: false as const, reason: err.message };
  }
}

function replyEdits(s: Session, reply: LiveDesignReply, savedVersion: number | null) {
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
    s.redo = [];
    editsChanged(s);
    s.appliedAttachmentId = reply.appliedAttachmentId;
    s.attachmentId = reply.appliedAttachmentId;
    say(s, "gsam", s.source?.kind === "website-page" ? savedLine(savedVersion) : "Edits saved into the page as a new version of the file.");
    frame(s, { type: "manual_edit_commit_done", appliedCount: count, remainingCount: 0 });
    return { ok: true };
  }
  return reply.message ? { ok: true } : { ok: false, reason: "unexpected_reply" as const };
}

/**
 * The page's source refused the agent's page (the home page's Two Doors guard, a size limit):
 * John sees why in the chat, and edits being applied stay staged instead of vanishing.
 */
export function refuseLiveDesignSave(s: Session, requestId: string, reason: string) {
  say(s, "gsam", `Not saved: ${reason}`);
  if (s.editsRequestId === requestId) {
    s.editsRequestId = null;
    if (s.status === "applying") s.status = "idle";
    say(s, "gsam", "Your edits are still waiting. Undo them, or ask in the chat.");
    frame(s, { type: "manual_edit_commit_failed", error: reason });
  }
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
          event.count === 1
            ? "Make ONE version of that element: your best answer to the request, following the impeccable skill's live-mode rules. It is ONE element (normally the same tag) that replaces the original. John asks for alternatives when he wants them."
            : `Make ${event.count} versions of that element, following the impeccable skill's live-mode rules: each version commits to a DIFFERENT primary direction, and each is ONE element (normally the same tag) that replaces the original.`,
          "Give each version its own class names (for example .lv-halo) and put its CSS in that version's css; do not restyle shared classes. Respect prefers-reduced-motion. Keep text contrast readable.",
          ...(s.source?.guidance ? [s.source.guidance] : []),
          "Tune knobs only when John asks for them (a version with knobs waits for you to bake them in when he keeps it): params [{ id, kind: \"range\" | \"steps\" | \"toggle\", ... }] as in the impeccable skill's live.md section 7, driving --p-<id> custom properties or data-p-<id> attributes.",
          `The element's current HTML is in request.html; for the whole page, ${pageCall(s.id)}.`,
          ...(s.islands ? [s.islands] : []),
          ...(event.request.notes.length ? [`John pinned these comments on the page: ${event.request.notes.map((n) => `"${n}"`).join("; ")}.`] : []),
          ...(event.request.screenshotAttachmentId
            ? [`He also marked the page up; open the screenshot at GET /api/attachments/${event.request.screenshotAttachmentId}/content to see where.`]
            : []),
          `John reads a chat beside the page. Send one short note first so he knows what you are trying: ${replyCall(s.id)} and jsonBody { "requestId": "${event.requestId}", "message": "<one plain sentence>"${s.designMd ? "" : ', "designMd": "<the full text of DESIGN.md>"'} }.${s.designMd ? "" : " Include designMd this once so his design panel shows the project's design system."}`,
          `Then ${replyCall(s.id)} and jsonBody { "requestId": "${event.requestId}", "variants": [{ "name": "...", "html": "...", "css": "...", "params": [] }] }. Speed matters: John is watching. Then poll again.`,
          codeTaskLine(s, event.requestId),
          `If you cannot do it at all, ${replyCall(s.id)} and jsonBody { "requestId": "${event.requestId}", "error": "<one plain sentence>" } straight away: until you answer, the page stays locked and John cannot pick anything else.`,
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
              event.about
                ? `John picked ${event.about.label} (selector ${event.about.selector}) while you were busy and asked: "${event.message}". Its HTML: ${event.about.html}\nMake it straight on the page, no versions to pick.`
                : `John wrote in the chat: "${event.message}".`,
              `If it needs more than a quick answer, first ${replyCall(s.id)} and jsonBody { "requestId": "page", "message": "<one plain sentence: what you are about to do>" } so he knows you are on it, then do the work.`,
              ...(s.source?.guidance ? [s.source.guidance] : []),
              `If he asks for a change to the page, make it to the whole page (start from ${pageCall(s.id)}) and ${replyCall(s.id)} and jsonBody { "requestId": "page", "pageHtml": "<the complete updated page>", "message": "<what you changed>" }. GSAM saves it as the next version.`,
              codeTaskLine(s, "page"),
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
        _instructions: `The page changed without you: John restored an earlier version, or saved his own edits. ${pageCall(s.id)} and make your workspace copy match it before the next change. Reply nothing. Poll again.`,
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
  pageCodeTasks.clear();
  pendingEdits.clear();
  storeLoaded = storeOff();
}

/** Test seam: keep the store in this file (null: back to off under tests). */
export function setLiveDesignStoreFile(file: string | null) {
  storeFileOverride = file;
  storeLoaded = storeOff();
}
