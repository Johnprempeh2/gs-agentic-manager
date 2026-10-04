/**
 * Client support queue (GRE-665). Each client support inbox feeds one queue:
 * tickets land as issues in the queue's project, tagged with the client code,
 * owned by the triage agent (or the cover agent when triage is paused), and
 * carry a first-response clock in UK working hours (support-hours.ts).
 *
 * Every waiting state has a wake path: intake wakes the owner, the sweep
 * wakes the owner at the warning point, and a missed target or a P1 opens a
 * confirmation addressed to the named human (John), which reaches the
 * decisions feed and phone. Sweep steps are guarded updates, so a repeated
 * or overlapping sweep never warns twice.
 */
import { and, asc, eq, gte, inArray, isNull, notInArray } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  agents,
  chatConversations,
  emailMessages,
  issues,
  labels,
  supportQueues,
  supportTickets,
} from "@greatstone/db";
import type { IssuePriority } from "@greatstone/shared";
import { badRequest, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { evaluateAgentInvokability, type AgentOrgRow } from "./agent-invokability.js";
import type { heartbeatService } from "./heartbeat.js";
import { issueService } from "./issues.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import {
  SUPPORT_FIRST_RESPONSE_MINUTES,
  formatLondon,
  supportClock,
  type SupportPriority,
} from "./support-hours.js";

export type SupportCategory = "general" | "install" | "reliability";
export type SupportQueueRow = typeof supportQueues.$inferSelect;
export type SupportTicketRow = typeof supportTickets.$inferSelect;

type Wakeup = Pick<ReturnType<typeof heartbeatService>, "wakeup">["wakeup"];
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const SUPPORT_ISSUE_PRIORITY: Record<SupportPriority, IssuePriority> = {
  P1: "critical",
  P2: "high",
  P3: "medium",
};

const CLIENT_CODE = /^[A-Z0-9]{2,12}$/;
const SUPPORT_LABEL_COLOR = "#0f766e";

// A first guess only: the triage agent confirms or changes it. Words that
// usually mean "the service is down for us" start the P1 path at once, so a
// real outage is never parked behind triage.
const P1_HINTS = [
  /\b(down|outage|offline)\b/i,
  /\bnot (working|loading|responding) (at all|for anyone|for everyone)\b/i,
  /\b(nobody|no one|everyone) can(not|'t)? (log ?in|sign ?in|access|use)\b/i,
  /\bdata (loss|lost|leak)\b/i,
  /\bsecurity (incident|breach)\b/i,
];
const P3_HINTS = [/\bhow (do|can) (i|we)\b/i, /\bfeature request\b/i, /\bquestion\b/i, /\bwhen you (get|have) a (chance|moment)\b/i];

export function suggestSupportPriority(subject: string, body: string): SupportPriority {
  const text = `${subject}\n${body}`;
  if (P1_HINTS.some((hint) => hint.test(text))) return "P1";
  if (P3_HINTS.some((hint) => hint.test(text))) return "P3";
  return "P2";
}

export function normalizeClientCode(raw: string): string {
  const code = raw.trim().toUpperCase();
  if (!CLIENT_CODE.test(code)) throw badRequest("Client code must be 2 to 12 letters or digits (no client names)");
  return code;
}

type AgentLite = AgentOrgRow;

export type SupportRoute = { agentId: string | null; reason: string };

/**
 * Who owns a ticket first. Install faults go to the install owner (Bedrock),
 * reliability faults to the reliability owner (Ridge), everything else to the
 * triage agent. If that agent cannot run (paused, over budget, terminated),
 * the cover agent takes it; if cover cannot run either, nobody is assigned
 * and the named human is alerted instead.
 */
export function routeSupportTicket(
  queue: Pick<SupportQueueRow, "triageAgentId" | "installAgentId" | "reliabilityAgentId" | "coverAgentId">,
  category: SupportCategory,
  companyAgents: AgentLite[],
): SupportRoute {
  const byId = new Map(companyAgents.map((agent) => [agent.id, agent]));
  const canRun = (id: string | null | undefined) =>
    Boolean(id) && evaluateAgentInvokability(byId.get(id!), companyAgents).invokable;
  const primary =
    category === "install" ? queue.installAgentId ?? queue.triageAgentId
      : category === "reliability" ? queue.reliabilityAgentId ?? queue.triageAgentId
        : queue.triageAgentId;
  if (canRun(primary)) return { agentId: primary, reason: `${category} owner` };
  if (primary !== queue.triageAgentId && canRun(queue.triageAgentId))
    return { agentId: queue.triageAgentId, reason: `${category} owner unavailable; triage agent covers` };
  if (canRun(queue.coverAgentId)) return { agentId: queue.coverAgentId, reason: "owner unavailable; cover agent covers" };
  return { agentId: null, reason: "no support agent can run; named human must act" };
}

export type SupportIntakeInput = {
  subject: string;
  body: string;
  from?: string | null;
  receivedAt?: Date;
  priority?: SupportPriority;
};

export function supportQueueService(db: Db, deps: { wakeup?: Wakeup; now?: () => Date } = {}) {
  const now = deps.now ?? (() => new Date());
  const issuesSvc = issueService(db);

  async function companyAgents(companyId: string): Promise<AgentLite[]> {
    return db
      .select({ id: agents.id, companyId: agents.companyId, name: agents.name, reportsTo: agents.reportsTo, status: agents.status })
      .from(agents)
      .where(eq(agents.companyId, companyId));
  }

  async function ensureClientLabel(companyId: string, clientCode: string) {
    const name = `client:${clientCode}`;
    await db.insert(labels).values({ companyId, name, color: SUPPORT_LABEL_COLOR }).onConflictDoNothing();
    const [label] = await db.select().from(labels).where(and(eq(labels.companyId, companyId), eq(labels.name, name)));
    return label!;
  }

  async function getQueue(companyId: string, clientCode: string) {
    const [queue] = await db
      .select()
      .from(supportQueues)
      .where(and(eq(supportQueues.companyId, companyId), eq(supportQueues.clientCode, normalizeClientCode(clientCode))));
    if (!queue) throw notFound("Support queue not found");
    return queue;
  }

  function clockLine(ticket: Pick<SupportTicketRow, "priority" | "warnAt" | "dueAt">) {
    const hours = SUPPORT_FIRST_RESPONSE_MINUTES[ticket.priority] / 60;
    return `First response due **${formatLondon(ticket.dueAt)}** UK (${ticket.priority}: ${hours} working hours). Warning at ${formatLondon(ticket.warnAt)}.`;
  }

  function description(queue: SupportQueueRow, input: SupportIntakeInput, priority: SupportPriority, route: SupportRoute) {
    return [
      `Client support ticket for client **${queue.clientCode}**.`,
      "",
      `- Suggested priority: **${priority}** (${route.reason})`,
      `- Received: ${formatLondon(input.receivedAt ?? now())} UK`,
      "",
      "**Triage:** confirm the priority (P1 service down or data at risk, P2 a feature broken, P3 a question) and the kind of fault",
      "(`general`, `install` for Bedrock, `reliability` for Ridge) with",
      "`POST /api/issues/{id}/support-ticket` and body `{\"priority\":\"P2\",\"category\":\"install\"}`.",
      "This moves the owner and restarts the clock. A reply email to the client stops the clock;",
      "a board user can also record a response by phone with `{\"respondedAt\":\"...\"}`.",
    ].join("\n");
  }

  async function alertNamedHuman(
    queue: SupportQueueRow,
    issue: { id: string; companyId: string },
    key: string,
    prompt: string,
  ) {
    if (!queue.p1UserId) {
      logger.warn({ issueId: issue.id, clientCode: queue.clientCode }, "support queue has no named human to alert");
      return false;
    }
    await issueThreadInteractionService(db).create(
      issue,
      {
        kind: "request_confirmation",
        idempotencyKey: `support:${issue.id}:${key}`,
        addresseeUserId: queue.p1UserId,
        continuationPolicy: "wake_assignee",
        title: prompt.slice(0, 240),
        payload: {
          version: 1,
          prompt,
          acceptLabel: "I have seen it",
          rejectLabel: "Not P1",
          allowDeclineReason: true,
          declineReasonPlaceholder: "Tell the owner why this is not P1.",
        },
      },
      { systemId: "system:support-queue" },
    );
    return true;
  }

  async function wakeOwner(issueId: string, agentId: string | null, reason: string, key: string) {
    if (!agentId || !deps.wakeup) return;
    await deps.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason,
      idempotencyKey: key,
      requestedByActorType: "system",
      requestedByActorId: "support-queue",
      payload: { issueId },
      contextSnapshot: { issueId },
      issueStateGuard: { statuses: ["todo", "in_progress", "blocked", "in_review"], assigneeAgentId: agentId },
    }).catch((err: unknown) => logger.warn({ err, issueId }, "support queue wake failed"));
  }

  /** Issue fields for a new support ticket. The email path and the manual path share it. */
  async function issueFields(queue: SupportQueueRow, input: SupportIntakeInput) {
    const priority = input.priority ?? suggestSupportPriority(input.subject, input.body);
    const route = routeSupportTicket(queue, "general", await companyAgents(queue.companyId));
    const label = await ensureClientLabel(queue.companyId, queue.clientCode);
    return {
      priority,
      route,
      fields: {
        projectId: queue.projectId,
        labelIds: [label.id],
        title: `[${queue.clientCode}] ${input.subject.trim() || "(no subject)"}`.slice(0, 200),
        description: description(queue, input, priority, route),
        status: "todo" as const,
        priority: SUPPORT_ISSUE_PRIORITY[priority],
        assigneeAgentId: route.agentId,
        responsibleUserId: queue.p1UserId,
      },
    };
  }

  /** Start the clock for a new ticket. Idempotent per issue. */
  async function openTicket(
    queue: SupportQueueRow,
    issueId: string,
    priority: SupportPriority,
    receivedAt: Date,
    tx: Tx | Db = db,
  ) {
    const clock = supportClock(priority, receivedAt, queue.holidays);
    const [row] = await tx
      .insert(supportTickets)
      .values({ companyId: queue.companyId, queueId: queue.id, issueId, priority, receivedAt, warnAt: clock.warnAt, dueAt: clock.dueAt })
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  }

  /** After the ticket commits: post the clock, wake the owner, alert John on P1. */
  async function announce(queue: SupportQueueRow, issue: { id: string; companyId: string }, ticket: SupportTicketRow, route: SupportRoute) {
    await issuesSvc.addComment(issue.id, `**Support clock started.** ${clockLine(ticket)}\nOwner: ${route.reason}.`, {}, { authorType: "system" });
    if (ticket.priority === "P1" || !route.agentId) await alertP1(queue, issue, ticket, route);
    await wakeOwner(issue.id, route.agentId, "support_ticket_received", `support:${ticket.id}:received`);
  }

  async function alertP1(queue: SupportQueueRow, issue: { id: string; companyId: string }, ticket: SupportTicketRow, route: SupportRoute) {
    const [claimed] = await db
      .update(supportTickets)
      .set({ p1AlertedAt: now(), updatedAt: now() })
      .where(and(eq(supportTickets.id, ticket.id), isNull(supportTickets.p1AlertedAt)))
      .returning({ id: supportTickets.id });
    if (!claimed) return;
    const why = route.agentId ? "P1 support ticket" : "Support ticket with no available agent";
    await alertNamedHuman(
      queue,
      issue,
      "p1",
      `${why} for client ${queue.clientCode}. First response is due ${formatLondon(ticket.dueAt)} UK. Confirm that you have seen it.`,
    );
  }

  /** Manual or test intake: a board user logs a client email that arrived elsewhere. */
  async function intake(companyId: string, clientCode: string, input: SupportIntakeInput) {
    const queue = await getQueue(companyId, clientCode);
    const receivedAt = input.receivedAt ?? now();
    const { priority, route, fields } = await issueFields(queue, { ...input, receivedAt });
    const created = await db.transaction(async (tx) => {
      const issue = await issuesSvc.create(companyId, { ...fields, originKind: "manual" }, tx);
      if (input.from || input.body)
        await issuesSvc.addComment(
          issue.id,
          `**Client message${input.from ? ` from ${input.from}` : ""}**\n\n${input.body || "(No text body)"}`,
          {},
          { authorType: "system" },
          tx,
        );
      const ticket = await openTicket(queue, issue.id, priority, receivedAt, tx);
      return { issue, ticket: ticket! };
    });
    await announce(queue, created.issue, created.ticket, route);
    return created;
  }

  /** The email path calls this after it commits a new support issue. */
  async function afterEmailIntake(endpointId: string, issueId: string, receivedAt: Date) {
    const [queue] = await db.select().from(supportQueues).where(eq(supportQueues.emailEndpointId, endpointId));
    if (!queue) return null;
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    if (!issue) return null;
    const priority = (Object.entries(SUPPORT_ISSUE_PRIORITY).find(([, value]) => value === issue.priority)?.[0] ?? "P2") as SupportPriority;
    const ticket = await openTicket(queue, issueId, priority, receivedAt);
    if (!ticket) return null;
    const route = routeSupportTicket(queue, "general", await companyAgents(queue.companyId));
    await announce(queue, issue, ticket, { ...route, agentId: issue.assigneeAgentId ?? null });
    return ticket;
  }

  /** Triage: confirm priority and kind of fault. Moves the owner and restarts the clock from receipt. */
  async function triage(
    issueId: string,
    input: { priority?: SupportPriority; category?: SupportCategory; respondedAt?: Date },
  ) {
    const [ticket] = await db.select().from(supportTickets).where(eq(supportTickets.issueId, issueId));
    if (!ticket) throw notFound("This issue is not a support ticket");
    const [queue] = await db.select().from(supportQueues).where(eq(supportQueues.id, ticket.queueId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    if (input.respondedAt) {
      const [marked] = await db
        .update(supportTickets)
        .set({ firstResponseAt: input.respondedAt, updatedAt: now() })
        .where(and(eq(supportTickets.id, ticket.id), isNull(supportTickets.firstResponseAt)))
        .returning();
      if (marked) await issuesSvc.addComment(issueId, `**First response recorded** at ${formatLondon(input.respondedAt)} UK. Clock stopped.`, {}, { authorType: "system" });
      return marked ?? ticket;
    }
    const priority = input.priority ?? ticket.priority;
    const category = input.category ?? ticket.category;
    const clock = supportClock(priority, ticket.receivedAt, queue!.holidays);
    const route = routeSupportTicket(queue!, category, await companyAgents(ticket.companyId));
    const [updated] = await db
      .update(supportTickets)
      .set({
        priority,
        category,
        warnAt: clock.warnAt,
        dueAt: clock.dueAt,
        // A new target gets its own warning; an old warning does not carry over.
        warnedAt: priority === ticket.priority ? ticket.warnedAt : null,
        updatedAt: now(),
      })
      .where(eq(supportTickets.id, ticket.id))
      .returning();
    await issuesSvc.update(issueId, {
      priority: SUPPORT_ISSUE_PRIORITY[priority],
      ...(route.agentId && route.agentId !== issue!.assigneeAgentId ? { assigneeAgentId: route.agentId, assigneeUserId: null } : {}),
    });
    await issuesSvc.addComment(
      issueId,
      `**Triaged:** ${priority}, ${category}. Owner: ${route.reason}.\n${clockLine(updated!)}`,
      {},
      { authorType: "system" },
    );
    if (priority === "P1" || !route.agentId) await alertP1(queue!, issue!, updated!, route);
    if (route.agentId && route.agentId !== issue!.assigneeAgentId)
      await wakeOwner(issueId, route.agentId, "support_ticket_routed", `support:${ticket.id}:routed:${route.agentId}`);
    return updated!;
  }

  /** The earliest reply email on the ticket's thread after it arrived. */
  async function firstOutboundEmail(ticket: SupportTicketRow) {
    const [row] = await db
      .select({ at: emailMessages.timestamp })
      .from(emailMessages)
      .innerJoin(chatConversations, eq(chatConversations.id, emailMessages.conversationId))
      .where(and(
        eq(chatConversations.issueId, ticket.issueId),
        eq(emailMessages.direction, "outbound"),
        eq(emailMessages.automatic, false),
        gte(emailMessages.timestamp, ticket.receivedAt),
      ))
      .orderBy(asc(emailMessages.timestamp))
      .limit(1);
    return row?.at ?? null;
  }

  /**
   * One pass of the clock. Stops clocks that got a reply, warns owners at the
   * warning point and escalates a missed target to the named human. Each step
   * claims its row with a guarded update first, so it runs once.
   */
  async function sweep() {
    const at = now();
    // Every running clock is checked each pass: a reply email can arrive at
    // any time, and support volume is a handful of open tickets.
    const rows = await db
      .select({ ticket: supportTickets, issue: issues })
      .from(supportTickets)
      .innerJoin(issues, eq(issues.id, supportTickets.issueId))
      .where(and(isNull(supportTickets.firstResponseAt), notInArray(issues.status, ["done", "cancelled"])));
    const result = { responded: 0, warned: 0, breached: 0 };
    if (rows.length === 0) return result;
    const open = rows.map((row) => row.ticket);
    const issueById = new Map(rows.map((row) => [row.issue.id, row.issue]));
    const queueRows = await db.select().from(supportQueues).where(inArray(supportQueues.id, [...new Set(open.map((t) => t.queueId))]));
    const queueById = new Map(queueRows.map((row) => [row.id, row]));
    for (const ticket of open) {
      const issue = issueById.get(ticket.issueId);
      const queue = queueById.get(ticket.queueId);
      if (!issue || !queue) continue;
      try {
        const replied = await firstOutboundEmail(ticket);
        if (replied) {
          const [marked] = await db
            .update(supportTickets)
            .set({ firstResponseAt: replied, updatedAt: at })
            .where(and(eq(supportTickets.id, ticket.id), isNull(supportTickets.firstResponseAt)))
            .returning();
          if (marked) {
            result.responded += 1;
            const late = replied > ticket.dueAt ? " (after the target)" : "";
            await issuesSvc.addComment(issue.id, `**First response sent** at ${formatLondon(replied)} UK${late}. Clock stopped.`, {}, { authorType: "system" });
          }
          continue;
        }
        if (!ticket.breachedAt && ticket.dueAt <= at) {
          const [claimed] = await db
            .update(supportTickets)
            .set({ breachedAt: at, warnedAt: ticket.warnedAt ?? at, updatedAt: at })
            .where(and(eq(supportTickets.id, ticket.id), isNull(supportTickets.breachedAt), isNull(supportTickets.firstResponseAt)))
            .returning();
          if (!claimed) continue;
          result.breached += 1;
          await issuesSvc.addComment(issue.id, `**First-response target missed** (${ticket.priority}, due ${formatLondon(ticket.dueAt)} UK). Escalated to the named human.`, {}, { authorType: "system" });
          await alertNamedHuman(queue, issue, `breach:${ticket.priority}:${ticket.dueAt.toISOString()}`,
            `Client ${queue.clientCode} ${ticket.priority} ticket missed its first-response target (due ${formatLondon(ticket.dueAt)} UK). Reply to the client or reassign the ticket.`);
          await wakeOwner(issue.id, issue.assigneeAgentId, "support_first_response_missed", `support:${ticket.id}:breach:${ticket.dueAt.toISOString()}`);
          continue;
        }
        if (!ticket.warnedAt && ticket.warnAt <= at) {
          const [claimed] = await db
            .update(supportTickets)
            .set({ warnedAt: at, updatedAt: at })
            .where(and(eq(supportTickets.id, ticket.id), isNull(supportTickets.warnedAt), isNull(supportTickets.firstResponseAt)))
            .returning();
          if (!claimed) continue;
          result.warned += 1;
          await issuesSvc.addComment(issue.id, `**Support clock warning:** first response is due ${formatLondon(ticket.dueAt)} UK (${ticket.priority}). Reply to the client now.`, {}, { authorType: "system" });
          await wakeOwner(issue.id, issue.assigneeAgentId, "support_first_response_due", `support:${ticket.id}:warn:${ticket.dueAt.toISOString()}`);
        }
      } catch (err) {
        logger.warn({ err, ticketId: ticket.id }, "support clock step failed");
      }
    }
    return result;
  }

  async function configureQueue(
    companyId: string,
    input: {
      clientCode: string;
      projectId: string;
      triageAgentId: string;
      emailEndpointId?: string | null;
      installAgentId?: string | null;
      reliabilityAgentId?: string | null;
      coverAgentId?: string | null;
      p1UserId?: string | null;
      holidays?: string[];
    },
  ) {
    const clientCode = normalizeClientCode(input.clientCode);
    const values = {
      companyId,
      clientCode,
      projectId: input.projectId,
      triageAgentId: input.triageAgentId,
      emailEndpointId: input.emailEndpointId ?? null,
      installAgentId: input.installAgentId ?? null,
      reliabilityAgentId: input.reliabilityAgentId ?? null,
      coverAgentId: input.coverAgentId ?? null,
      p1UserId: input.p1UserId ?? null,
      holidays: input.holidays ?? [],
    };
    const [row] = await db
      .insert(supportQueues)
      .values(values)
      .onConflictDoUpdate({ target: [supportQueues.companyId, supportQueues.clientCode], set: { ...values, updatedAt: now() } })
      .returning();
    return row!;
  }

  async function listTickets(companyId: string) {
    return db
      .select({ ticket: supportTickets, identifier: issues.identifier, title: issues.title, status: issues.status, assigneeAgentId: issues.assigneeAgentId, clientCode: supportQueues.clientCode })
      .from(supportTickets)
      .innerJoin(issues, eq(issues.id, supportTickets.issueId))
      .innerJoin(supportQueues, eq(supportQueues.id, supportTickets.queueId))
      .where(eq(supportTickets.companyId, companyId))
      .orderBy(asc(supportTickets.dueAt));
  }

  return {
    configureQueue,
    listQueues: (companyId: string) => db.select().from(supportQueues).where(eq(supportQueues.companyId, companyId)),
    queueForEmailEndpoint: async (endpointId: string) =>
      (await db.select().from(supportQueues).where(eq(supportQueues.emailEndpointId, endpointId)))[0] ?? null,
    issueFields,
    afterEmailIntake,
    intake,
    triage,
    sweep,
    listTickets,
  };
}

export type SupportQueueService = ReturnType<typeof supportQueueService>;
