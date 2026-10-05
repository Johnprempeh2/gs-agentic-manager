import { and, eq, inArray, ne, or } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { memoryConflicts, memoryRecords, memoryReviewEvents } from "@greatstone/db";
import type { MemoryConflictLink, MemoryRecordStatus, MemoryReviewEventAction } from "@greatstone/shared";

// Review events and conflict detection (GRE-886, plan 8.5). Shared by the
// contribute path and the review service so both write the same rows.

type DbOrTransaction = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type RecordRow = typeof memoryRecords.$inferSelect;
type ConflictRow = typeof memoryConflicts.$inferSelect;

/** The authenticated caller of a review step. Never taken from a request body or from memory text. */
export type MemoryReviewActor = {
  companyId: string;
  actorType: "agent" | "user" | "system";
  actorId: string;
  agentId: string | null;
  userId: string | null;
  runId: string | null;
};

export async function insertReviewEvent(
  database: DbOrTransaction,
  actor: MemoryReviewActor,
  record: Pick<RecordRow, "id" | "scopeId">,
  event: {
    action: MemoryReviewEventAction;
    fromStatus?: string | null;
    toStatus?: string | null;
    reason?: string | null;
    relatedRecordId?: string | null;
    now?: Date;
  },
) {
  await database.insert(memoryReviewEvents).values({
    companyId: actor.companyId,
    recordId: record.id,
    scopeId: record.scopeId,
    action: event.action,
    fromStatus: event.fromStatus ?? null,
    toStatus: event.toStatus ?? null,
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    userId: actor.userId,
    runId: actor.runId,
    reason: event.reason ?? null,
    relatedRecordId: event.relatedRecordId ?? null,
    ...(event.now ? { createdAt: event.now } : {}),
  });
}

function normalised(values: string[]) {
  return new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean));
}

function intersect(a: Set<string>, b: Set<string>) {
  return [...a].filter((value) => b.has(value));
}

/**
 * Names and topics two records share, when that suggests they speak about the
 * same thing. A shared topic counts only if the records do not name different
 * entities; with no topics, a shared entity counts. A matching title counts.
 * This is a cheap, fallible lead for a reviewer, not proof of a contradiction.
 */
export function possibleConflictTerms(
  candidate: Pick<RecordRow, "title" | "entities" | "topics">,
  approved: Pick<RecordRow, "title" | "entities" | "topics">,
): string[] {
  const entitiesA = normalised(candidate.entities);
  const entitiesB = normalised(approved.entities);
  const topicsA = normalised(candidate.topics);
  const topicsB = normalised(approved.topics);
  const sharedEntities = intersect(entitiesA, entitiesB);
  const sharedTopics = intersect(topicsA, topicsB);
  const terms = new Set<string>();
  const entitiesAgree = entitiesA.size === 0 || entitiesB.size === 0 || sharedEntities.length > 0;
  if (sharedTopics.length > 0 && entitiesAgree) {
    sharedTopics.forEach((term) => terms.add(term));
    sharedEntities.forEach((term) => terms.add(term));
  } else if ((topicsA.size === 0 || topicsB.size === 0) && sharedEntities.length > 0) {
    sharedEntities.forEach((term) => terms.add(term));
  }
  const titleA = candidate.title?.trim().toLowerCase();
  if (titleA && titleA === approved.title?.trim().toLowerCase()) terms.add(titleA);
  return [...terms];
}

/**
 * Opens a conflict between a new record and every approved record in the same
 * scope it may contradict. Records in other scopes (another client, another
 * project) are never compared. Returns the conflicts opened.
 */
export async function flagPossibleConflicts(
  database: DbOrTransaction,
  actor: MemoryReviewActor,
  record: RecordRow,
  now: Date,
): Promise<MemoryConflictLink[]> {
  const approved = await database
    .select()
    .from(memoryRecords)
    .where(
      and(
        eq(memoryRecords.companyId, record.companyId),
        eq(memoryRecords.scopeId, record.scopeId),
        eq(memoryRecords.status, "approved"),
        ne(memoryRecords.id, record.id),
      ),
    );
  const links: MemoryConflictLink[] = [];
  for (const other of approved) {
    const sharedTerms = possibleConflictTerms(record, other);
    if (sharedTerms.length === 0) continue;
    const [conflict] = await database
      .insert(memoryConflicts)
      .values({
        companyId: record.companyId,
        scopeId: record.scopeId,
        recordId: record.id,
        approvedRecordId: other.id,
        origin: "contribution_check",
        sharedTerms,
        detectedAt: now,
      })
      .onConflictDoNothing({ target: [memoryConflicts.recordId, memoryConflicts.approvedRecordId] })
      .returning();
    if (!conflict) continue;
    await insertReviewEvent(database, actor, record, {
      action: "conflict_flagged",
      reason: "Possible conflict found by the contribution check",
      relatedRecordId: other.id,
      now,
    });
    links.push({
      conflictId: conflict.id,
      otherRecordId: other.id,
      otherStatus: "approved",
      isApprovedSide: false,
      sharedTerms,
    });
  }
  return links;
}

/** Open conflicts touching any of these records, as links from each record's side. */
export async function openConflictLinks(
  database: DbOrTransaction,
  companyId: string,
  recordIds: string[],
): Promise<{ links: Map<string, MemoryConflictLink[]>; rows: ConflictRow[] }> {
  const links = new Map<string, MemoryConflictLink[]>();
  if (recordIds.length === 0) return { links, rows: [] };
  const rows = await database
    .select()
    .from(memoryConflicts)
    .where(
      and(
        eq(memoryConflicts.companyId, companyId),
        eq(memoryConflicts.state, "open"),
        or(inArray(memoryConflicts.recordId, recordIds), inArray(memoryConflicts.approvedRecordId, recordIds)),
      ),
    );
  if (rows.length === 0) return { links, rows };
  const otherIds = [...new Set(rows.flatMap((row) => [row.recordId, row.approvedRecordId]))];
  const statuses = new Map(
    (
      await database
        .select({ id: memoryRecords.id, status: memoryRecords.status })
        .from(memoryRecords)
        .where(and(eq(memoryRecords.companyId, companyId), inArray(memoryRecords.id, otherIds)))
    ).map((row) => [row.id, row.status as MemoryRecordStatus]),
  );
  const add = (recordId: string, link: MemoryConflictLink) => links.set(recordId, [...(links.get(recordId) ?? []), link]);
  for (const row of rows) {
    add(row.recordId, {
      conflictId: row.id,
      otherRecordId: row.approvedRecordId,
      otherStatus: statuses.get(row.approvedRecordId) ?? "approved",
      isApprovedSide: false,
      sharedTerms: row.sharedTerms,
    });
    add(row.approvedRecordId, {
      conflictId: row.id,
      otherRecordId: row.recordId,
      otherStatus: statuses.get(row.recordId) ?? "unreviewed",
      isApprovedSide: true,
      sharedTerms: row.sharedTerms,
    });
  }
  return { links, rows };
}
