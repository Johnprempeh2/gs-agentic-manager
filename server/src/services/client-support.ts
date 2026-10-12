import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { clientSupportAttachments, clientSupportReplies, clientSupportTickets, issues } from "@greatstone/db";
import {
  FLEET_SUPPORT_ATTACHMENTS_PER_TICKET,
  FLEET_SUPPORT_SYNC_MAX_TICKETS,
  fleetSupportPriority,
  type ClientSupportInbox,
  type ClientSupportOutbox,
  type FleetSupportContentType,
  type FleetSupportKind,
  type FleetSupportPriority,
} from "@greatstone/shared/fleet-support";
import { conflict, notFound, unprocessable } from "../errors.js";
import type { StorageService } from "../storage/types.js";
import { logActivity } from "./activity-log.js";

// Spoke side of the support bridge (GRE-1084). The client's board member
// opens a ticket with "Get help"; it waits here as `queued`. The host script
// (scripts/client-instance, signed in as the operator) reads the outbox,
// sends it to the hub, and writes the hub's answer back through the inbox.
// The app itself never talks to the hub and holds no fleet key.
//
// What may leave: kind, title, summary, priority, and files the client picked.
// The linked issue, run logs and records stay here.

type Actor = { actorType: "user" | "agent" | "system"; actorId: string; agentId?: string | null };
type TicketRow = typeof clientSupportTickets.$inferSelect;

const SYSTEM_ACTOR = { actorType: "system" as const, actorId: "fleet-support-sync" };
const CLOSED = ["resolved", "closed"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function clientSupportService(db: Db, deps: { storage?: StorageService } = {}) {
  async function getTicket(companyId: string, ticketId: string) {
    if (!UUID_PATTERN.test(ticketId)) throw notFound("Support ticket not found");
    const [row] = await db
      .select()
      .from(clientSupportTickets)
      .where(and(eq(clientSupportTickets.id, ticketId), eq(clientSupportTickets.companyId, companyId)));
    if (!row) throw notFound("Support ticket not found");
    return row;
  }

  const log = (ticket: Pick<TicketRow, "id" | "companyId">, actor: Actor, action: string, details: Record<string, unknown> = {}) =>
    logActivity(db, {
      companyId: ticket.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      action: `client_support.${action}`,
      entityType: "client_support_ticket",
      entityId: ticket.id,
      details,
    });

  return {
    async list(companyId: string) {
      const tickets = await db
        .select()
        .from(clientSupportTickets)
        .where(eq(clientSupportTickets.companyId, companyId))
        .orderBy(desc(clientSupportTickets.createdAt));
      if (tickets.length === 0) return [];
      const ids = tickets.map((t) => t.id);
      const replies = await db.select().from(clientSupportReplies).where(inArray(clientSupportReplies.ticketId, ids)).orderBy(asc(clientSupportReplies.sentAt));
      const files = await db
        .select({
          id: clientSupportAttachments.id,
          ticketId: clientSupportAttachments.ticketId,
          name: clientSupportAttachments.name,
          contentType: clientSupportAttachments.contentType,
          byteSize: clientSupportAttachments.byteSize,
          sentAt: clientSupportAttachments.sentAt,
          createdAt: clientSupportAttachments.createdAt,
        })
        .from(clientSupportAttachments)
        .where(inArray(clientSupportAttachments.ticketId, ids));
      return tickets.map((ticket) => ({
        ...ticket,
        replies: replies.filter((r) => r.ticketId === ticket.id).map(({ id, body, sentAt }) => ({ id, body, sentAt })),
        attachments: files.filter((f) => f.ticketId === ticket.id),
      }));
    },

    async create(
      companyId: string,
      input: { kind: FleetSupportKind; title: string; summary: string; priority: FleetSupportPriority; linkedIssueId?: string | null },
      actor: Actor & { actorType: "user" },
    ) {
      if (input.linkedIssueId) {
        const [issue] = await db
          .select({ id: issues.id })
          .from(issues)
          .where(and(eq(issues.id, input.linkedIssueId), eq(issues.companyId, companyId)));
        if (!issue) throw unprocessable("Linked issue is not in this company");
      }
      const [ticket] = await db
        .insert(clientSupportTickets)
        .values({
          companyId,
          kind: input.kind,
          title: input.title,
          summary: input.summary,
          priority: fleetSupportPriority(input.kind, input.priority),
          linkedIssueId: input.linkedIssueId ?? null,
          createdByUserId: actor.actorId,
        })
        .returning();
      await log(ticket!, actor, "ticket_created", { kind: ticket!.kind, priority: ticket!.priority });
      return ticket!;
    },

    /** The client changes the words. Each edit is a new revision, sent on the next sync. */
    async edit(companyId: string, ticketId: string, input: { title?: string; summary?: string }, actor: Actor) {
      const ticket = await getTicket(companyId, ticketId);
      if (CLOSED.includes(ticket.status)) throw conflict("This ticket is closed. Open a new ticket.");
      const [updated] = await db
        .update(clientSupportTickets)
        .set({
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
          revision: sql`${clientSupportTickets.revision} + 1`,
          refusedReason: null,
          updatedAt: new Date(),
        })
        .where(eq(clientSupportTickets.id, ticket.id))
        .returning();
      await log(updated!, actor, "ticket_edited", { revision: updated!.revision });
      return updated!;
    },

    /** A file the client picked. Only these files ever go to the hub. */
    async attach(
      companyId: string,
      ticketId: string,
      file: { name: string; contentType: FleetSupportContentType; body: Buffer },
      actor: Actor & { actorType: "user" },
    ) {
      const ticket = await getTicket(companyId, ticketId);
      if (CLOSED.includes(ticket.status)) throw conflict("This ticket is closed. Open a new ticket.");
      const held = await db.select({ id: clientSupportAttachments.id }).from(clientSupportAttachments).where(eq(clientSupportAttachments.ticketId, ticket.id));
      if (held.length >= FLEET_SUPPORT_ATTACHMENTS_PER_TICKET) throw unprocessable(`A ticket takes at most ${FLEET_SUPPORT_ATTACHMENTS_PER_TICKET} files`);
      if (!deps.storage) throw new Error("client support attachments need the storage service");
      const stored = await deps.storage.putFile({
        companyId,
        namespace: `client-support/${ticket.id}`,
        originalFilename: file.name,
        contentType: file.contentType,
        body: file.body,
      });
      const [row] = await db
        .insert(clientSupportAttachments)
        .values({
          ticketId: ticket.id,
          companyId,
          provider: stored.provider,
          objectKey: stored.objectKey,
          name: file.name,
          contentType: file.contentType,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          createdByUserId: actor.actorId,
        })
        .returning();
      await log(ticket, actor, "attachment_added", { attachmentId: row!.id, contentType: file.contentType, byteSize: stored.byteSize });
      const { provider: _p, objectKey: _k, ...view } = row!;
      return view;
    },

    /**
     * Operator: what to send. Tickets with an unsent revision, oldest first;
     * files the client picked, once the hub holds their ticket.
     */
    async outbox(): Promise<ClientSupportOutbox> {
      const tickets = await db
        .select()
        .from(clientSupportTickets)
        .where(or(isNull(clientSupportTickets.sentRevision), lt(clientSupportTickets.sentRevision, clientSupportTickets.revision)))
        .orderBy(asc(clientSupportTickets.createdAt))
        .limit(FLEET_SUPPORT_SYNC_MAX_TICKETS);
      const files = await db
        .select({ file: clientSupportAttachments })
        .from(clientSupportAttachments)
        .innerJoin(clientSupportTickets, eq(clientSupportTickets.id, clientSupportAttachments.ticketId))
        .where(and(isNull(clientSupportAttachments.sentAt), isNotNull(clientSupportTickets.hubTicketId)))
        .orderBy(asc(clientSupportAttachments.createdAt))
        .limit(20);
      return {
        tickets: tickets.map((t) => ({ ref: t.id, revision: t.revision, kind: t.kind, title: t.title, summary: t.summary, priority: t.priority })),
        attachments: files.map(({ file }) => ({
          ticketRef: file.ticketId,
          ref: file.id,
          name: file.name,
          contentType: file.contentType as FleetSupportContentType,
          byteSize: file.byteSize,
          sha256: file.sha256,
        })),
      };
    },

    /** Operator: the bytes of one picked file, for the host script to sign and send. */
    async attachmentContent(attachmentId: string) {
      if (!UUID_PATTERN.test(attachmentId)) throw notFound("Attachment not found");
      const [file] = await db.select().from(clientSupportAttachments).where(eq(clientSupportAttachments.id, attachmentId));
      if (!file) throw notFound("Attachment not found");
      if (!deps.storage) throw new Error("client support attachments need the storage service");
      const object = await deps.storage.getObject(file.companyId, file.objectKey);
      const chunks: Buffer[] = [];
      for await (const chunk of object.stream) chunks.push(Buffer.from(chunk as Uint8Array));
      return { content: Buffer.concat(chunks).toString("base64") };
    },

    /** Operator: write back what was sent and what the hub answered. Safe to apply twice. */
    async applyInbox(inbox: ClientSupportInbox, now = new Date()) {
      const notSetUp = new Set(inbox.refused.filter((r) => r.reason === "support_not_set_up").map((r) => r.ref));
      const result = { sent: 0, refused: 0, updated: 0, replies: 0, attachments: 0 };
      for (const sent of inbox.sentTickets) {
        if (notSetUp.has(sent.ref)) continue;
        const [row] = await db
          .update(clientSupportTickets)
          .set({ sentRevision: sent.revision, refusedReason: null, updatedAt: now })
          .where(and(eq(clientSupportTickets.id, sent.ref), or(isNull(clientSupportTickets.sentRevision), lt(clientSupportTickets.sentRevision, sent.revision))))
          .returning();
        if (row) {
          result.sent += 1;
          await log(row, SYSTEM_ACTOR, "ticket_sent", { revision: sent.revision });
        }
      }
      for (const refused of inbox.refused) {
        const [row] = await db
          .update(clientSupportTickets)
          .set({ refusedReason: refused.reason, updatedAt: now })
          .where(eq(clientSupportTickets.id, refused.ref))
          .returning();
        if (row) {
          result.refused += 1;
          await log(row, SYSTEM_ACTOR, "ticket_refused", { reason: refused.reason });
        }
      }
      for (const state of inbox.tickets) {
        const [before] = await db.select().from(clientSupportTickets).where(eq(clientSupportTickets.id, state.ref));
        if (!before) continue;
        const [after] = await db
          .update(clientSupportTickets)
          .set({
            status: state.status,
            hubTicketId: state.hubTicketId,
            hubPriority: state.priority,
            hubCategory: state.category,
            hubOwner: state.owner,
            hubReceivedAt: new Date(state.receivedAt),
            firstResponseDueAt: new Date(state.firstResponseDueAt),
            firstResponseAt: state.firstResponseAt ? new Date(state.firstResponseAt) : null,
            syncedAt: now,
            updatedAt: now,
          })
          .where(eq(clientSupportTickets.id, before.id))
          .returning();
        if (before.status !== after!.status || before.hubOwner !== after!.hubOwner || before.hubPriority !== after!.hubPriority) {
          result.updated += 1;
          await log(after!, SYSTEM_ACTOR, "ticket_updated", {
            hubTicketId: state.hubTicketId,
            status: state.status,
            priority: state.priority,
            owner: state.owner,
          });
        }
        for (const reply of state.replies) {
          const [kept] = await db
            .insert(clientSupportReplies)
            .values({ ticketId: before.id, hubReplyId: reply.id, body: reply.body, sentAt: new Date(reply.at) })
            .onConflictDoNothing()
            .returning({ id: clientSupportReplies.id });
          if (kept) {
            result.replies += 1;
            await log(after!, SYSTEM_ACTOR, "reply_received", { hubReplyId: reply.id });
          }
        }
      }
      if (inbox.sentAttachments.length > 0) {
        const rows = await db
          .update(clientSupportAttachments)
          .set({ sentAt: now })
          .where(and(inArray(clientSupportAttachments.id, inbox.sentAttachments), isNull(clientSupportAttachments.sentAt)))
          .returning();
        for (const row of rows) {
          result.attachments += 1;
          await log({ id: row.ticketId, companyId: row.companyId }, SYSTEM_ACTOR, "attachment_sent", { attachmentId: row.id });
        }
      }
      return result;
    },
  };
}
