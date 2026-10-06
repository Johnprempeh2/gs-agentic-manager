import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { deliverableComments } from "@greatstone/db";
import type {
  CreateDeliverableComment,
  DeliverableComment,
  DeliverableCommentStatus,
} from "@greatstone/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

// Deliverable comments (GRE-982): a board user pins notes to passages of one
// deliverable version, edits them as drafts, then sends them all at once as a
// single task comment. Drafts are private to their author; sent notes are read
// only and visible to anyone who may read the deliverable.

type CommentRow = typeof deliverableComments.$inferSelect;

export function toDeliverableComment(row: CommentRow): DeliverableComment {
  return {
    id: row.id,
    companyId: row.companyId,
    deliverableId: row.workProductId,
    issueId: row.issueId,
    quote: row.quote,
    prefix: row.prefix ?? null,
    suffix: row.suffix ?? null,
    textStart: row.textStart ?? null,
    body: row.body,
    status: row.status === "sent" ? "sent" : "draft",
    authorUserId: row.authorUserId,
    sentCommentId: row.sentCommentId ?? null,
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function blockquote(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `> ${line}`)
    .join("\n");
}

/** The one task comment that carries every sent note, quote first. */
export function buildDeliverableCommentsBody(input: {
  deliverable: { title: string; version: number; key: string };
  comments: Array<Pick<DeliverableComment, "quote" | "body">>;
}) {
  const { deliverable, comments } = input;
  const sections = comments.map((comment, index) => [
    `**${index + 1}.**`,
    blockquote(comment.quote),
    "",
    comment.body.trim(),
  ].join("\n"));
  return [
    `**Comments on the deliverable "${deliverable.title}" (v${deliverable.version})**`,
    "",
    sections.join("\n\n"),
    "",
    `Please revise the deliverable and register the new version with key \`${deliverable.key}\`.`,
  ].join("\n");
}

export function deliverableCommentService(db: Db) {
  async function getOwnDraft(companyId: string, deliverableId: string, commentId: string, userId: string) {
    const row = await db
      .select()
      .from(deliverableComments)
      .where(and(
        eq(deliverableComments.id, commentId),
        eq(deliverableComments.companyId, companyId),
        eq(deliverableComments.workProductId, deliverableId),
      ))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Comment not found");
    if (row.status !== "draft") throw conflict("This comment was sent and can no longer change");
    // Another user's draft is private: it does not exist for this caller.
    if (row.authorUserId !== userId) throw notFound("Comment not found");
    return row;
  }

  return {
    /** Sent notes on this version, plus the caller's own drafts. */
    list: async (companyId: string, deliverableId: string, viewerUserId: string | null) => {
      const visible = viewerUserId
        ? or(
          eq(deliverableComments.status, "sent"),
          and(eq(deliverableComments.status, "draft"), eq(deliverableComments.authorUserId, viewerUserId)),
        )
        : eq(deliverableComments.status, "sent");
      const rows = await db
        .select()
        .from(deliverableComments)
        .where(and(
          eq(deliverableComments.companyId, companyId),
          eq(deliverableComments.workProductId, deliverableId),
          visible,
        ))
        .orderBy(asc(deliverableComments.createdAt), asc(deliverableComments.id));
      return rows.map(toDeliverableComment);
    },

    create: async (input: {
      companyId: string;
      deliverable: { id: string; issueId: string };
      userId: string;
      fields: CreateDeliverableComment;
    }) => {
      const { fields } = input;
      const [row] = await db
        .insert(deliverableComments)
        .values({
          companyId: input.companyId,
          workProductId: input.deliverable.id,
          issueId: input.deliverable.issueId,
          quote: fields.quote,
          prefix: fields.prefix ?? null,
          suffix: fields.suffix ?? null,
          textStart: fields.textStart ?? null,
          body: fields.body,
          status: "draft",
          authorUserId: input.userId,
        })
        .returning();
      return toDeliverableComment(row!);
    },

    update: async (companyId: string, deliverableId: string, commentId: string, userId: string, body: string) => {
      await getOwnDraft(companyId, deliverableId, commentId, userId);
      const [row] = await db
        .update(deliverableComments)
        .set({ body, updatedAt: new Date() })
        .where(and(eq(deliverableComments.id, commentId), eq(deliverableComments.status, "draft")))
        .returning();
      if (!row) throw conflict("This comment was sent and can no longer change");
      return toDeliverableComment(row);
    },

    remove: async (companyId: string, deliverableId: string, commentId: string, userId: string) => {
      await getOwnDraft(companyId, deliverableId, commentId, userId);
      const deleted = await db
        .delete(deliverableComments)
        .where(and(eq(deliverableComments.id, commentId), eq(deliverableComments.status, "draft")))
        .returning({ id: deliverableComments.id });
      if (deleted.length === 0) throw conflict("This comment was sent and can no longer change");
    },

    /**
     * Claim the caller's drafts on this version as sent. Claiming first means
     * a double click cannot post the same notes twice: the second call finds
     * no drafts left.
     */
    claimDrafts: async (companyId: string, deliverableId: string, userId: string) => {
      const sentAt = new Date();
      const rows = await db
        .update(deliverableComments)
        .set({ status: "sent" satisfies DeliverableCommentStatus, sentAt, updatedAt: sentAt })
        .where(and(
          eq(deliverableComments.companyId, companyId),
          eq(deliverableComments.workProductId, deliverableId),
          eq(deliverableComments.authorUserId, userId),
          eq(deliverableComments.status, "draft"),
        ))
        .returning();
      if (rows.length === 0) throw unprocessable("There are no draft comments to send");
      return rows
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
        .map(toDeliverableComment);
    },

    /** Put claimed notes back to draft when the task comment could not be posted. */
    releaseClaim: async (commentIds: string[]) => {
      if (commentIds.length === 0) return;
      await db
        .update(deliverableComments)
        .set({ status: "draft", sentAt: null, updatedAt: new Date() })
        .where(inArray(deliverableComments.id, commentIds));
    },

    recordSentComment: async (commentIds: string[], sentCommentId: string) => {
      const rows = await db
        .update(deliverableComments)
        .set({ sentCommentId })
        .where(inArray(deliverableComments.id, commentIds))
        .returning();
      return rows
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
        .map(toDeliverableComment);
    },
  };
}
