import { randomUUID } from "node:crypto";
import {
  LIVE_DESIGN_VARIANT_COUNT,
  type LiveDesignReply,
  type LiveDesignRequest,
  type LiveDesignStatus,
  type LiveDesignMessage,
  type LiveDesignVariant,
  type LiveDesignView,
} from "@greatstone/shared";

/**
 * Live design sessions: John picks an element on an agent's HTML prototype and
 * asks for a change; the agent stays in one run, long-polling GSAM for the next
 * request, and replies with versions that the review page shows in place.
 *
 * ponytail: in memory on the one server process. A restart ends open sessions;
 * the page says so and John presses Live again. Move to a table if GSAM ever
 * runs more than one server process.
 */

type AgentEvent =
  | { type: "generate"; requestId: string; request: LiveDesignRequest; attachmentId: string; count: number }
  | { type: "accept"; requestId: string; variant: number; chosen: LiveDesignVariant; request: LiveDesignRequest; attachmentId: string }
  | { type: "discard"; requestId: string }
  | { type: "end" };

interface Session {
  id: string;
  companyId: string;
  issueId: string;
  attachmentId: string;
  agentId: string;
  status: LiveDesignStatus;
  request: (LiveDesignRequest & { id: string; startedAt: string }) | null;
  variants: LiveDesignVariant[];
  appliedAttachmentId: string | null;
  error: string | null;
  messages: LiveDesignMessage[];
  queue: AgentEvent[];
  waiter: ((event: AgentEvent | null) => void) | null;
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

function end(s: Session) {
  if (s.status === "ended") return;
  s.status = "ended";
  s.queue = [];
  push(s, { type: "end" });
  // Keep it briefly so a late poll or page refresh sees "ended", not "not found".
  setTimeout(() => sessions.delete(s.id), 5 * 60_000).unref?.();
}

function sweep(now = Date.now()) {
  for (const s of sessions.values()) {
    if (s.status !== "ended" && now - s.touchedAt > IDLE_END_MS) end(s);
  }
}

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
  };
}

export function getLiveDesign(id: string) {
  sweep();
  return sessions.get(id) ?? null;
}

/**
 * The open session for this task and agent, or a new one. `needsWake` is true
 * when no agent run is polling, so the caller wakes the agent.
 */
export function startLiveDesign(input: { companyId: string; issueId: string; attachmentId: string; agentId: string }) {
  sweep();
  let s = [...sessions.values()].find(
    (x) => x.status !== "ended" && x.issueId === input.issueId && x.agentId === input.agentId,
  );
  if (!s) {
    s = {
      id: randomUUID(),
      ...input,
      status: "waiting_agent",
      request: null,
      variants: [],
      appliedAttachmentId: null,
      error: null,
      messages: [],
      queue: [],
      waiter: null,
      agentSeenAt: 0,
      touchedAt: Date.now(),
    };
    sessions.set(s.id, s);
  }
  s.attachmentId = input.attachmentId;
  s.touchedAt = Date.now();
  return { session: s, needsWake: !isConnected(s) };
}

export class LiveDesignConflict extends Error {}

export function requestLiveDesign(s: Session, request: LiveDesignRequest) {
  if (s.status === "ended") throw new LiveDesignConflict("This live session has ended. Press Live to start again.");
  if (s.status === "applying") throw new LiveDesignConflict("The agent is still saving the last version.");
  // A new request replaces versions John has not kept.
  if (s.request && s.status === "ready") push(s, { type: "discard", requestId: s.request.id });
  s.request = { ...request, id: randomUUID().slice(0, 8), startedAt: new Date().toISOString() };
  s.variants = [];
  s.error = null;
  s.status = "generating";
  s.touchedAt = Date.now();
  say(s, "john", request.prompt);
  push(s, { type: "generate", requestId: s.request.id, request, attachmentId: s.attachmentId, count: LIVE_DESIGN_VARIANT_COUNT });
  return s;
}

export function acceptLiveDesign(s: Session, requestId: string, variant: number) {
  const chosen = s.variants[variant];
  if (!s.request || s.request.id !== requestId || s.status !== "ready" || !chosen) {
    throw new LiveDesignConflict("Those versions are no longer open.");
  }
  s.status = "applying";
  s.touchedAt = Date.now();
  say(s, "gsam", `You kept version ${variant + 1}${chosen.name ? ` (${chosen.name})` : ""}. The agent is saving it into the page.`);
  push(s, { type: "accept", requestId, variant, chosen, request: s.request, attachmentId: s.attachmentId });
  return s;
}

export function discardLiveDesign(s: Session) {
  if (s.request && (s.status === "ready" || s.status === "generating")) {
    push(s, { type: "discard", requestId: s.request.id });
    say(s, "gsam", "Discarded. The page is back as it was.");
  }
  if (s.status !== "ended") s.status = isConnected(s) ? "idle" : "waiting_agent";
  s.request = null;
  s.variants = [];
  s.touchedAt = Date.now();
  return s;
}

export function endLiveDesign(s: Session) {
  end(s);
  return s;
}

/** The agent's long-poll: the next event, or `{ type: "timeout" }` after the wait. */
export async function pollLiveDesign(s: Session, waitMs: number) {
  if (!isConnected(s) && s.status !== "ended") say(s, "gsam", "The agent joined.");
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
  return event
    ? withInstructions(s, event)
    : { type: "timeout", sessionId: s.id, _instructions: `Nothing yet. ${pollCall(s.id)} again now.` };
}

export function replyLiveDesign(s: Session, reply: LiveDesignReply) {
  s.agentSeenAt = Date.now();
  if (!s.request || s.request.id !== reply.requestId) return { ok: false, reason: "stale_request" as const };
  if (reply.message) say(s, "agent", reply.message);
  if (reply.error) {
    say(s, "gsam", `The agent could not do that: ${reply.error}`);
    s.error = reply.error;
    s.status = "idle";
    return { ok: true };
  }
  if (s.status === "generating" && reply.variants?.length) {
    s.variants = reply.variants;
    s.status = "ready";
    say(s, "gsam", `${reply.variants.length} version${reply.variants.length === 1 ? "" : "s"} ready. Flick through them on the page, then keep one or discard.`);
    return { ok: true };
  }
  if (s.status === "applying" && reply.appliedAttachmentId) {
    s.appliedAttachmentId = reply.appliedAttachmentId;
    s.attachmentId = reply.appliedAttachmentId;
    s.request = null;
    s.variants = [];
    s.status = "idle";
    say(s, "gsam", "Saved into the page as a new version of the file.");
    return { ok: true };
  }
  if (reply.message) return { ok: true };
  return { ok: false, reason: "unexpected_reply" as const };
}

function withInstructions(s: Session, event: AgentEvent) {
  const base = { sessionId: s.id, ...event };
  switch (event.type) {
    case "generate":
      return {
        ...base,
        _instructions: [
          `John picked ${event.request.label || event.request.tag} on the page and asked: "${event.request.prompt}".`,
          `Make ${event.count} versions of that element. Each version is ONE element (normally the same tag) that replaces it, plus the CSS it needs.`,
          "Give each version a different direction, not three shades of one idea. Keep the page's brand, colours and words unless John asked to change them.",
          "CSS applies to the whole page while that version shows, so target classes you add to your element (for example .lv-glow) rather than shared ones.",
          "Respect prefers-reduced-motion for anything that moves. Keep text contrast readable.",
          `John reads a chat beside the page. Send one short note first so he knows what you are trying: ${replyCall(s.id)} and jsonBody { "requestId": "${event.requestId}", "message": "<one plain sentence>" }. You can add a "message" to your versions reply too.`,
          `The element's current HTML is in request.html; for the rest of the page, GET /api/attachments/${event.attachmentId}/content with your API key.`,
          `Then ${replyCall(s.id)} and jsonBody { "requestId": "${event.requestId}", "variants": [{ "name": "...", "html": "...", "css": "..." }] }. Speed matters: John is watching. Then poll again.`,
        ].join("\n"),
      };
    case "accept":
      return {
        ...base,
        _instructions: [
          `John kept version ${event.variant + 1} ("${event.chosen.name}").`,
          "Write it into the real page: replace the element at request.selector with chosen.html, and move chosen.css into the page's own stylesheet with tidy class names.",
          `Edit your workspace copy of this page if you have one; otherwise start from GET /api/attachments/${event.attachmentId}/content.`,
          "Upload the updated page as a new attachment on this task with the same file name.",
          `Then ${replyCall(s.id)} and jsonBody { "requestId": "${event.requestId}", "appliedAttachmentId": "<new attachment id>" }, and poll again.`,
          `If you cannot save it, ${replyCall(s.id)} and jsonBody { "requestId": "${event.requestId}", "error": "<short reason>" } so John knows.`,
        ].join("\n"),
      };
    case "discard":
      return { ...base, _instructions: "John discarded those versions. Change nothing. Poll again." };
    case "end":
      return {
        ...base,
        _instructions: "John closed live design. Stop polling, post nothing, and end your run (no comment needed unless you saved changes).",
      };
  }
}

// Agents reach live design through the existing paperclipApiRequest tool, so it needs no new MCP tool.
const pollCall = (id: string) =>
  `Call paperclipApiRequest with method GET and path /live-design/${id}/poll?waitSeconds=25 (or curl GET /api/live-design/${id}/poll?waitSeconds=25 with your API key)`;
const replyCall = (id: string) => `call paperclipApiRequest with method POST, path /live-design/${id}/reply`;

/** What the agent reads when GSAM wakes it for live design. */
export function liveDesignWakeMessage(sessionId: string, fileName: string) {
  return [
    `John opened live design on ${fileName} and is watching it now, possibly on his phone.`,
    `Stay in this run as the live designer. ${pollCall(sessionId)} in a loop; each call waits up to 25 seconds.`,
    "Each event carries _instructions: follow them, send the reply they describe, then poll again straight away.",
    "A timeout event just means nothing happened yet; poll again. Stop only when you get an end event.",
    "Do not post comments or change the task status during live design; John sees your versions on the page.",
  ].join("\n");
}

/** Test seam. */
export function resetLiveDesignSessions() {
  sessions.clear();
}
