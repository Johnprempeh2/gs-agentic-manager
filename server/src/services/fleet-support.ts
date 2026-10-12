import { createHash } from "node:crypto";
import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  agents,
  fleetInstances,
  fleetSupportAttachments,
  fleetSupportReplies,
  fleetSupportTickets,
  issues,
  supportQueues,
  supportTickets,
} from "@greatstone/db";
import {
  FLEET_SUPPORT_ATTACHMENTS_PER_TICKET,
  FLEET_SUPPORT_CURSOR_OVERLAP_MS,
  clientSupportStatusForIssue,
  fleetSupportPriority,
  fleetSupportSubject,
  fleetSupportTicketStateSchema,
  type FleetSupportSyncAnswer,
  type FleetSupportTicketState,
} from "@greatstone/shared/fleet-support";
import { notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { StorageService } from "../storage/types.js";
import { logActivity } from "./activity-log.js";
import { FleetMessageError, advanceSeq, signedSender } from "./fleet.js";
import type { heartbeatService } from "./heartbeat.js";
import { issueService } from "./issues.js";
import { supportQueueService } from "./support-queue.js";

// Hub side of the support bridge (GRE-1084). A client instance sends its
// "Get help" tickets in a signed `support-sync` message; each new ticket
// becomes a support ticket in the queue the hub admin linked to that
// instance. The answer carries only that instance's tickets: status, SLA
// times, our owner and the replies we chose to send. Internal comments,
// other clients' tickets and anything from the client's records never go.

type Wakeup = Pick<ReturnType<typeof heartbeatService>, "wakeup">["wakeup"];
type Actor = { actorType: "agent" | "user"; actorId: string; agentId: string | null; runId?: string | null };

const SYSTEM_ACTOR = { actorType: "system" as const, actorId: "fleet-support" };

const reject = (code: "fleet_support_unknown_ticket" | "fleet_support_bad_file" | "fleet_replay", status: 400 | 409): never => {
  throw new FleetMessageError(code, status);
};

export function fleetSupportService(db: Db, deps: { storage?: StorageService; wakeup?: Wakeup } = {}) {
  const queues = supportQueueService(db, { wakeup: deps.wakeup });
  const issuesSvc = issueService(db);

  /** The client-visible state of this instance's tickets changed since `since` (minus the overlap), or all when null. */
  async function ticketStates(fleetInstanceId: string, since: Date | null, alwaysRefs: Set<string>): Promise<FleetSupportTicketState[]> {
    const rows = await db
      .select({ link: fleetSupportTickets, ticket: supportTickets, issue: issues, ownerName: agents.name })
      .from(fleetSupportTickets)
      .innerJoin(supportTickets, eq(supportTickets.id, fleetSupportTickets.supportTicketId))
      .innerJoin(issues, eq(issues.id, fleetSupportTickets.issueId))
      .leftJoin(agents, eq(agents.id, issues.assigneeAgentId))
      .where(eq(fleetSupportTickets.fleetInstanceId, fleetInstanceId))
      .orderBy(asc(fleetSupportTickets.createdAt));
    if (rows.length === 0) return [];
    const replies = await db
      .select()
      .from(fleetSupportReplies)
      .where(inArray(fleetSupportReplies.fleetSupportTicketId, rows.map((row) => row.link.id)))
      .orderBy(asc(fleetSupportReplies.createdAt));
    const from = since ? since.getTime() - FLEET_SUPPORT_CURSOR_OVERLAP_MS : Number.NEGATIVE_INFINITY;
    const states: FleetSupportTicketState[] = [];
    for (const { link, ticket, issue, ownerName } of rows) {
      const own = replies.filter((reply) => reply.fleetSupportTicketId === link.id);
      const newReplies = own.filter((reply) => reply.createdAt.getTime() > from);
      const changedAt = Math.max(link.updatedAt.getTime(), ticket.updatedAt.getTime(), issue.updatedAt.getTime());
      if (!alwaysRefs.has(link.spokeRef) && changedAt <= from && newReplies.length === 0) continue;
      states.push(
        fleetSupportTicketStateSchema.parse({
          ref: link.spokeRef,
          hubTicketId: issue.identifier,
          revision: link.revision,
          status: clientSupportStatusForIssue(issue.status),
          priority: ticket.priority,
          category: ticket.category,
          receivedAt: ticket.receivedAt.toISOString(),
          firstResponseDueAt: ticket.dueAt.toISOString(),
          firstResponseAt: ticket.firstResponseAt?.toISOString() ?? null,
          owner: ownerName ?? (issue.assigneeUserId ? "Greatstone support" : null),
          replies: newReplies.slice(-200).map((reply) => ({ id: reply.id, body: reply.body, at: reply.createdAt.toISOString() })),
        }),
      );
    }
    return states.slice(-500);
  }

  return {
    /**
     * Spoke: send new or edited tickets, get back the state of its own
     * tickets. The replay fence and every ticket write share one
     * transaction, so two syncs from one instance never file a ticket twice.
     */
    async sync(compactJws: string, now = new Date()): Promise<FleetSupportSyncAnswer> {
      const { signer, claims } = await signedSender(db, compactJws, "support-sync", now);
      const support = claims.support!;
      const refused: FleetSupportSyncAnswer["refused"] = [];
      const announcements: Array<() => Promise<void>> = [];
      await db.transaction(async (tx) => {
        if (!(await advanceSeq(tx, signer, claims.seq, now))) reject("fleet_replay", 409);
        const [instance] = await tx.select().from(fleetInstances).where(eq(fleetInstances.id, signer.id));
        const queue = instance?.supportQueueId
          ? (await tx.select().from(supportQueues).where(eq(supportQueues.id, instance.supportQueueId)))[0] ?? null
          : null;
        for (const item of support.tickets) {
          if (!queue) {
            refused.push({ ref: item.ref, reason: "support_not_set_up" });
            continue;
          }
          const [existing] = await tx
            .select({ link: fleetSupportTickets, issueStatus: issues.status })
            .from(fleetSupportTickets)
            .innerJoin(issues, eq(issues.id, fleetSupportTickets.issueId))
            .where(and(eq(fleetSupportTickets.fleetInstanceId, signer.id), eq(fleetSupportTickets.spokeRef, item.ref)));
          if (existing) {
            if (item.revision <= existing.link.revision) continue;
            if (existing.issueStatus === "done" || existing.issueStatus === "cancelled") {
              refused.push({ ref: item.ref, reason: "ticket_closed" });
              continue;
            }
            // The client may change the words. Priority and category stay with our triage.
            await issuesSvc.update(existing.link.issueId, { title: `[${queue.clientCode}] ${fleetSupportSubject(existing.link.kind, item.title)}`.slice(0, 200) }, tx);
            await issuesSvc.addComment(
              existing.link.issueId,
              `**Client edited the ticket** (revision ${item.revision}).\n\n**${item.title}**\n\n${item.summary || "(No summary)"}`,
              {},
              { authorType: "system" },
              tx,
            );
            await tx
              .update(fleetSupportTickets)
              .set({ revision: item.revision, updatedAt: now })
              .where(eq(fleetSupportTickets.id, existing.link.id));
            await logActivity(tx as unknown as Db, {
              companyId: queue.companyId,
              ...SYSTEM_ACTOR,
              action: "fleet_support.ticket_edited",
              entityType: "issue",
              entityId: existing.link.issueId,
              issueId: existing.link.issueId,
              details: { fleetInstanceId: signer.id, revision: item.revision },
            });
            continue;
          }
          const priority = fleetSupportPriority(item.kind, item.priority);
          const created = await queues.intakeFromInstance(
            queue,
            { kind: item.kind, title: item.title, summary: item.summary, priority, receivedAt: now },
            async (inner, { issue, ticket }) => {
              await inner.insert(fleetSupportTickets).values({
                fleetInstanceId: signer.id,
                spokeRef: item.ref,
                kind: item.kind,
                revision: item.revision,
                supportTicketId: ticket.id,
                issueId: issue.id,
              });
            },
            tx,
          );
          await logActivity(tx as unknown as Db, {
            companyId: queue.companyId,
            ...SYSTEM_ACTOR,
            action: "fleet_support.ticket_received",
            entityType: "issue",
            entityId: created.issue.id,
            issueId: created.issue.id,
            details: { fleetInstanceId: signer.id, kind: item.kind, priority },
          });
          announcements.push(() => queues.announce(queue, created.issue, created.ticket, created.route));
        }
      });
      for (const announce of announcements) {
        await announce().catch((err: unknown) => logger.warn({ err }, "fleet support announce failed"));
      }
      const since = support.since ? new Date(support.since) : null;
      const tickets = await ticketStates(signer.id, since, new Set(support.tickets.map((t) => t.ref)));
      return { at: now.toISOString(), refused, tickets };
    },

    /** Spoke: one file the client picked. Kept once per spoke file id. */
    async attachment(compactJws: string, contentBase64: string, now = new Date()) {
      const { signer, claims } = await signedSender(db, compactJws, "support-attachment", now);
      const meta = claims.attachment!;
      const body = Buffer.from(contentBase64, "base64");
      if (body.length !== meta.byteSize || createHash("sha256").update(body).digest("hex") !== meta.sha256)
        reject("fleet_support_bad_file", 400);
      const [link] = await db
        .select({ link: fleetSupportTickets, companyId: issues.companyId })
        .from(fleetSupportTickets)
        .innerJoin(issues, eq(issues.id, fleetSupportTickets.issueId))
        .where(and(eq(fleetSupportTickets.fleetInstanceId, signer.id), eq(fleetSupportTickets.spokeRef, meta.ticketRef)));
      if (!link) return reject("fleet_support_unknown_ticket", 409);
      const [kept] = await db
        .select({ id: fleetSupportAttachments.id })
        .from(fleetSupportAttachments)
        .where(and(eq(fleetSupportAttachments.fleetSupportTicketId, link.link.id), eq(fleetSupportAttachments.spokeRef, meta.ref)));
      if (kept) {
        await db.transaction(async (tx) => {
          if (!(await advanceSeq(tx, signer, claims.seq, now))) reject("fleet_replay", 409);
        });
        return { receivedAt: now.toISOString(), duplicate: true };
      }
      const [{ value: held }] = await db
        .select({ value: count() })
        .from(fleetSupportAttachments)
        .where(eq(fleetSupportAttachments.fleetSupportTicketId, link.link.id));
      if ((held ?? 0) >= FLEET_SUPPORT_ATTACHMENTS_PER_TICKET) reject("fleet_support_bad_file", 400);
      if (!deps.storage) throw new Error("fleet support attachments need the storage service");
      const stored = await deps.storage.putFile({
        companyId: link.companyId,
        namespace: `issues/${link.link.issueId}`,
        originalFilename: meta.name,
        contentType: meta.contentType,
        body,
      });
      try {
        await db.transaction(async (tx) => {
          if (!(await advanceSeq(tx, signer, claims.seq, now))) reject("fleet_replay", 409);
        });
        const attachment = await issuesSvc.createAttachment({
          issueId: link.link.issueId,
          provider: stored.provider,
          objectKey: stored.objectKey,
          contentType: stored.contentType,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          originalFilename: stored.originalFilename,
        });
        await db.insert(fleetSupportAttachments).values({ fleetSupportTicketId: link.link.id, spokeRef: meta.ref, assetId: attachment.assetId });
      } catch (err) {
        await deps.storage.deleteObject(link.companyId, stored.objectKey).catch(() => undefined);
        throw err;
      }
      await issuesSvc.addComment(link.link.issueId, `**Client attached a file:** ${meta.name} (${meta.contentType}, ${meta.byteSize} bytes).`, {}, { authorType: "system" });
      await logActivity(db, {
        companyId: link.companyId,
        ...SYSTEM_ACTOR,
        action: "fleet_support.attachment_received",
        entityType: "issue",
        entityId: link.link.issueId,
        issueId: link.link.issueId,
        details: { fleetInstanceId: signer.id, contentType: meta.contentType, byteSize: meta.byteSize },
      });
      return { receivedAt: now.toISOString(), duplicate: false };
    },

    /** The fleet ticket behind a hub issue, or null when the issue did not come from a client instance. */
    async linkForIssue(issueId: string) {
      const [row] = await db.select().from(fleetSupportTickets).where(eq(fleetSupportTickets.issueId, issueId));
      return row ?? null;
    },

    /**
     * Hub: a reply for the client. It goes back on the next sync. The first
     * reply stops the first-response clock. Never sent: internal comments.
     */
    async reply(issueId: string, body: string, actor: Actor, now = new Date()) {
      const [row] = await db
        .select({ link: fleetSupportTickets, issue: issues })
        .from(fleetSupportTickets)
        .innerJoin(issues, eq(issues.id, fleetSupportTickets.issueId))
        .where(eq(fleetSupportTickets.issueId, issueId));
      if (!row) throw notFound("This issue is not a ticket from a client instance");
      const [reply] = await db
        .insert(fleetSupportReplies)
        .values({
          fleetSupportTicketId: row.link.id,
          body,
          authorAgentId: actor.agentId,
          authorUserId: actor.actorType === "user" ? actor.actorId : null,
          createdAt: now,
        })
        .returning();
      await db.update(fleetSupportTickets).set({ updatedAt: now }).where(eq(fleetSupportTickets.id, row.link.id));
      const [stopped] = await db
        .update(supportTickets)
        .set({ firstResponseAt: now, updatedAt: now })
        .where(and(eq(supportTickets.id, row.link.supportTicketId), isNull(supportTickets.firstResponseAt)))
        .returning({ id: supportTickets.id });
      await issuesSvc.addComment(
        issueId,
        `**Reply sent to the client** (goes on the next sync)${stopped ? ". First response recorded; clock stopped" : ""}.\n\n${body}`,
        actor.actorType === "agent" ? { agentId: actor.actorId, runId: actor.runId ?? null } : { userId: actor.actorId },
      );
      await logActivity(db, {
        companyId: row.issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId ?? null,
        action: "fleet_support.reply_sent",
        entityType: "issue",
        entityId: issueId,
        issueId,
        details: { fleetSupportTicketId: row.link.id, replyId: reply!.id },
      });
      return { id: reply!.id, createdAt: reply!.createdAt };
    },

    /** Hub admin: the queue an instance's tickets land in. Null stops intake (tickets wait on the spoke). */
    async setSupportQueue(fleetInstanceId: string, supportQueueId: string | null, actor: Actor) {
      const queue = supportQueueId
        ? (await db.select().from(supportQueues).where(eq(supportQueues.id, supportQueueId)))[0] ?? null
        : null;
      if (supportQueueId && !queue) throw unprocessable("Support queue not found");
      const [row] = await db
        .update(fleetInstances)
        .set({ supportQueueId, updatedAt: new Date() })
        .where(eq(fleetInstances.id, fleetInstanceId))
        .returning({ id: fleetInstances.id, code: fleetInstances.code, supportQueueId: fleetInstances.supportQueueId });
      if (!row) throw notFound("Fleet instance not found");
      if (queue)
        await logActivity(db, {
          companyId: queue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          action: "fleet_support.queue_linked",
          entityType: "support_queue",
          entityId: queue.id,
          details: { fleetInstanceId: row.id, instanceCode: row.code },
        });
      return row;
    },
  };
}
