import { and, eq, inArray, ne, or } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { memoryConflicts, memoryRecords, memoryRelationships, memoryReviewEvents } from "@greatstone/db";
import type { MemoryCallerApp, MemoryConflictLink, MemoryRecordStatus, MemoryReviewEventAction } from "@greatstone/shared";
import { textConflictTerms } from "./text-conflict.js";

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
  /** The app and its session (GRE-1079). Taken from the authenticated request, like the rest. */
  app?: MemoryCallerApp | null;
  sessionId?: string | null;
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
    app: actor.app ?? null,
    sessionId: actor.sessionId ?? null,
    reason: event.reason ?? null,
    relatedRecordId: event.relatedRecordId ?? null,
    ...(event.now ? { createdAt: event.now } : {}),
  });
}

/**
 * The record and every earlier version an edit replaced, oldest first. Steward
 * edit and confirm (GRE-1089) writes each edit as a new version and an `edit`
 * event on the version it replaced; only those links are followed, not the
 * supersession of an approved card. There is no length limit: null means the
 * history cannot be fully read (a missing version or a loop), and callers then
 * refuse to approve rather than check part of it.
 */
export async function loadEditChain(database: DbOrTransaction, companyId: string, row: RecordRow): Promise<RecordRow[] | null> {
  const chain = [row];
  const seen = new Set([row.id]);
  for (let current = row; current.supersedesId; ) {
    const previousId = current.supersedesId;
    const edit = await database
      .select({ id: memoryReviewEvents.id })
      .from(memoryReviewEvents)
      .where(
        and(
          eq(memoryReviewEvents.companyId, companyId),
          eq(memoryReviewEvents.recordId, previousId),
          eq(memoryReviewEvents.action, "edit"),
          eq(memoryReviewEvents.relatedRecordId, current.id),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!edit) break;
    if (seen.has(previousId)) return null;
    const previous = await database
      .select()
      .from(memoryRecords)
      .where(and(eq(memoryRecords.id, previousId), eq(memoryRecords.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!previous) return null;
    chain.unshift(previous);
    seen.add(previous.id);
    current = previous;
  }
  return chain;
}

/** Why this actor may not approve: they wrote the first version of the chain, or a later edit. */
export function authorRefusal(
  actor: Pick<MemoryReviewActor, "agentId" | "userId">,
  chain: Array<Pick<RecordRow, "contributorAgentId" | "contributorUserId">>,
): "own_proposal" | "own_edit" | null {
  const wrote = (version: Pick<RecordRow, "contributorAgentId" | "contributorUserId">) =>
    (version.contributorAgentId !== null && version.contributorAgentId === actor.agentId) ||
    (version.contributorUserId !== null && version.contributorUserId === actor.userId);
  const [first, ...edits] = chain;
  if (first && wrote(first)) return "own_proposal";
  if (edits.some(wrote)) return "own_edit";
  return null;
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
 * scope it may contradict: by shared tags first, then by a text check for a
 * different price, date or amount on the same subject (GRE-934), so a wrong or
 * missing tag does not hide it. Records in other scopes (another client,
 * another project) are never compared. Returns the conflicts opened.
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
    const tagTerms = possibleConflictTerms(record, other);
    const sharedTerms = tagTerms.length > 0 ? tagTerms : textConflictTerms(record, other);
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
      reason:
        tagTerms.length > 0
          ? "Possible conflict found by the contribution check"
          : "Possible conflict found by the contribution check: the text states a different value",
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

/**
 * Writes one stated relationship, with the caller as author. Returns null when
 * the same link already exists. A stated contradiction of an approved record
 * in the same scope opens a conflict for review; conflicts never span scopes.
 * The caller has already checked that the author may link both records.
 */
export async function insertRelationship(
  database: DbOrTransaction,
  actor: MemoryReviewActor,
  from: RecordRow,
  to: RecordRow,
  input: { type: string; note: string | null; sourceKind: string | null; sourceId: string | null; now: Date },
) {
  const [relationship] = await database
    .insert(memoryRelationships)
    .values({
      companyId: actor.companyId,
      scopeId: from.scopeId,
      fromRecordId: from.id,
      toRecordId: to.id,
      type: input.type,
      authorAgentId: actor.agentId,
      authorUserId: actor.userId,
      runId: actor.runId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      note: input.note,
      createdAt: input.now,
    })
    .onConflictDoNothing({
      target: [memoryRelationships.fromRecordId, memoryRelationships.toRecordId, memoryRelationships.type],
    })
    .returning();
  if (!relationship) return null;
  if (input.type === "contradicts" && from.scopeId === to.scopeId) {
    const pair =
      from.status === "approved" && ["unreviewed", "disputed"].includes(to.status)
        ? { challenger: to, approved: from }
        : to.status === "approved" && ["unreviewed", "disputed"].includes(from.status)
          ? { challenger: from, approved: to }
          : null;
    if (pair) {
      const [opened] = await database
        .insert(memoryConflicts)
        .values({
          companyId: actor.companyId,
          scopeId: from.scopeId,
          recordId: pair.challenger.id,
          approvedRecordId: pair.approved.id,
          origin: "relationship",
          sharedTerms: possibleConflictTerms(pair.challenger, pair.approved),
          detectedAt: input.now,
        })
        .onConflictDoNothing({ target: [memoryConflicts.recordId, memoryConflicts.approvedRecordId] })
        .returning();
      if (opened) {
        await insertReviewEvent(database, actor, pair.challenger, {
          action: "conflict_flagged",
          reason: "Stated as contradicting an approved record",
          relatedRecordId: pair.approved.id,
          now: input.now,
        });
      }
    }
  }
  return relationship;
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
