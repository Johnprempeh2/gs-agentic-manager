import { and, asc, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  memoryConflicts,
  memoryExtractedFacts,
  memoryIngestOutbox,
  memoryLinkLeads,
  memoryRecords,
  memoryRelationships,
  memoryReviewEvents,
  memoryScopes,
  projects,
} from "@greatstone/db";
import {
  MEMORY_CONFLICT_NOTE,
  MEMORY_OWNER_ONLY_CLASSES,
  MEMORY_RETENTION_DAYS,
  type CreateMemoryRelationship,
  type DeleteMemoryRecord,
  type MemoryConflict,
  type MemoryConflictGroup,
  type MemoryConflictQueue,
  type MemoryDecisionClass,
  type MemoryExtractedFact,
  type MemoryRecord,
  type MemoryRecordHistory,
  type MemoryRelationship,
  type MemoryRelationshipType,
  type MemoryRetentionItem,
  type MemoryRetentionResult,
  type MemoryReviewEvent,
  type MemoryReviewEventAction,
  type MemoryRecordStatus,
  type ResolveMemoryConflict,
  type ReviewMemoryRecord,
  type RunMemoryRetention,
  type SupersedeMemoryRecord,
} from "@greatstone/shared";
import { badRequest, conflict, forbidden, notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { classifyEngineError, nextAttemptAt } from "./ingest-outbox.js";
import { enqueueMemoryIngest, settleDirectMemoryIngest } from "./ingest-outbox-db.js";
import { authorRefusal, insertRelationship, insertReviewEvent, loadEditChain } from "./review-store.js";
import {
  DIRECT_RETAIN_GRACE_MS,
  grantedScopeIds,
  grantCovers,
  isHardBoundary,
  toRecord,
  toScope,
  type MemoryCaller,
  type MemoryGatewayService,
  type RecordRow,
  type ScopeRow,
} from "./service.js";

// Memory review workflow (GRE-886, G1 decisions 6 and 7, plan 8.5).
//
// Who may approve comes only from the authenticated caller: John (a person
// who owns or administers the company), the project lead agent, or an agent
// with a `memory:approve` grant. Nothing in a request body, a reason or a
// memory record can grant it. Nobody approves their own entry.

type DbOrTransaction = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type Access = Awaited<ReturnType<MemoryGatewayService["internals"]["accessFor"]>>;

const DAY_MS = 24 * 60 * 60 * 1000;

const REFUSALS = {
  own_entry: "Nobody can approve or settle their own entry",
  incomplete_history: "This record's edit history cannot be fully checked, so it cannot be approved",
  owner_only: "Only the company owner can review this kind of record",
  working_notes: "Agent working notes are never reviewed",
  no_review_right: "You do not have the right to review this record",
  no_delete_right: "You do not have the right to delete this record",
  no_contribute_right: "You do not have the right to add relationships in this scope",
  no_retention_right: "Only the company owner or a memory admin can run retention",
} as const;
type Refusal = keyof typeof REFUSALS;

function toEvent(row: typeof memoryReviewEvents.$inferSelect): MemoryReviewEvent {
  return {
    id: row.id,
    recordId: row.recordId,
    scopeId: row.scopeId,
    action: row.action as MemoryReviewEventAction,
    fromStatus: row.fromStatus as MemoryRecordStatus | null,
    toStatus: row.toStatus as MemoryRecordStatus | null,
    actorType: row.actorType,
    actorId: row.actorId,
    agentId: row.agentId,
    userId: row.userId,
    runId: row.runId,
    reason: row.reason,
    relatedRecordId: row.relatedRecordId,
    createdAt: row.createdAt,
  };
}

function toRelationship(row: typeof memoryRelationships.$inferSelect): MemoryRelationship {
  return {
    id: row.id,
    scopeId: row.scopeId,
    fromRecordId: row.fromRecordId,
    toRecordId: row.toRecordId,
    type: row.type as MemoryRelationshipType,
    origin: "explicit",
    authorAgentId: row.authorAgentId,
    authorUserId: row.authorUserId,
    runId: row.runId,
    sourceKind: row.sourceKind,
    sourceId: row.sourceId,
    note: row.note,
    createdAt: row.createdAt,
  };
}

function toFact(row: typeof memoryExtractedFacts.$inferSelect): MemoryExtractedFact {
  return {
    id: row.id,
    recordId: row.recordId,
    engineUnitId: row.engineUnitId,
    factType: row.factType,
    contributorAgentId: row.contributorAgentId,
    contributorUserId: row.contributorUserId,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
  };
}

export function memoryReviewService(db: Db, gateway: MemoryGatewayService) {
  const { accessFor, logOperation, loadScope, callEngine, engine, engineTimeoutMs } = gateway.internals;

  async function refuse(
    caller: MemoryCaller,
    operation: string,
    refusal: Refusal,
    extra: { scopeIds?: string[]; recordId?: string | null } = {},
  ): Promise<never> {
    await logOperation(caller, operation, "denied", { ...extra, detail: { reason: refusal } });
    throw forbidden(REFUSALS[refusal]);
  }

  /**
   * Nobody approves or settles a record when they wrote any version of it:
   * the first proposal or any edit since (GRE-1089). The whole edit history
   * is checked; if it cannot be read in full, the step is refused.
   */
  async function refuseIfAuthor(
    caller: MemoryCaller,
    operation: string,
    rows: RecordRow[],
    audit: { scopeIds?: string[]; recordId?: string | null },
  ) {
    for (const row of rows) {
      const chain = await loadEditChain(db, caller.companyId, row);
      if (!chain) await refuse(caller, operation, "incomplete_history", audit);
      if (authorRefusal(caller, chain!)) await refuse(caller, operation, "own_entry", audit);
    }
  }

  /** A record the caller may read, or 404 with an audit row. Same answer for "missing" and "not yours". */
  async function loadReadable(caller: MemoryCaller, recordId: string, operation: string) {
    await gateway.assertEnabled(caller.companyId);
    const row = await db
      .select()
      .from(memoryRecords)
      .where(and(eq(memoryRecords.id, recordId), eq(memoryRecords.companyId, caller.companyId)))
      .then((rows) => rows[0] ?? null);
    const scope = row ? await loadScope(caller.companyId, row.scopeId) : null;
    const access = await accessFor(caller);
    if (!row || !scope || !access.canRead(scope)) {
      await logOperation(caller, operation, "denied", { recordId: row ? row.id : null, detail: { requestedId: recordId } });
      throw notFound("Memory record not found");
    }
    return { row, scope, access };
  }

  /**
   * G1 decision 6. Returns why the caller may not review this record, or null.
   * The contributor check is separate: disputing your own entry is allowed,
   * approving it is not.
   */
  async function reviewRefusal(
    caller: MemoryCaller,
    access: Access,
    scope: ScopeRow,
    decisionClass: string,
  ): Promise<Refusal | null> {
    if (scope.kind === "agent") return "working_notes";
    if (access.isOwner) return null;
    if (isHardBoundary(scope.kind)) return "owner_only";
    if ((MEMORY_OWNER_ONLY_CLASSES as readonly string[]).includes(decisionClass)) return "owner_only";
    const approveScope = access.grants.get("memory:approve");
    const namedIds = access.grants.has("memory:approve") ? grantedScopeIds(approveScope) : null;
    const grantClasses = Array.isArray(approveScope?.decisionClasses)
      ? (approveScope.decisionClasses as unknown[]).filter((value): value is string => typeof value === "string")
      : ["operational"];
    if (scope.kind === "project") {
      if (caller.agentId && scope.projectId) {
        const project = await db
          .select({ leadAgentId: projects.leadAgentId })
          .from(projects)
          .where(and(eq(projects.id, scope.projectId), eq(projects.companyId, caller.companyId)))
          .then((rows) => rows[0] ?? null);
        if (project?.leadAgentId === caller.agentId) return null;
      }
      // Otherwise only a grant that names this project scope.
      return namedIds?.includes(scope.id) && grantClasses.includes(decisionClass) ? null : "no_review_right";
    }
    // Organization: a `memory:approve` grant covering it, for the classes it names (default operational).
    const coversOrg = access.grants.has("memory:approve") && (namedIds ? namedIds.includes(scope.id) : true);
    return coversOrg && grantClasses.includes(decisionClass) ? null : "no_review_right";
  }

  async function review(caller: MemoryCaller, recordId: string, input: ReviewMemoryRecord): Promise<MemoryRecord> {
    const operation = `review_${input.action}`;
    const { row, scope, access } = await loadReadable(caller, recordId, operation);
    const audit = { scopeIds: [scope.id], recordId: row.id };
    if (row.status === "deleted" || row.status === "superseded") {
      throw conflict(`A ${row.status} record cannot be reviewed`);
    }
    const target: MemoryRecordStatus = input.action === "approve" ? "approved" : "disputed";
    if (row.status === target) throw conflict(`The record is already ${target}`);
    const refusal = await reviewRefusal(caller, access, scope, row.decisionClass);
    if (refusal) await refuse(caller, operation, refusal, audit);
    if (input.action === "approve") await refuseIfAuthor(caller, operation, [row], audit);

    if (input.action === "approve") {
      // An entry that may contradict an approved record never replaces it by approval.
      const open = await db
        .select({ id: memoryConflicts.id, approvedRecordId: memoryConflicts.approvedRecordId })
        .from(memoryConflicts)
        .where(and(eq(memoryConflicts.recordId, row.id), eq(memoryConflicts.state, "open")));
      if (open.length > 0) {
        await logOperation(caller, operation, "denied", { ...audit, detail: { reason: "open_conflict", conflictIds: open.map((c) => c.id) } });
        throw conflict(
          "This record has an open conflict with an approved record. Supersede the approved record or resolve the conflict first.",
        );
      }
    }

    const now = new Date();
    const updated = await db.transaction(async (tx) => {
      const [next] = await tx
        .update(memoryRecords)
        .set({ status: target, reviewedAt: now, updatedAt: now })
        .where(and(eq(memoryRecords.id, row.id), eq(memoryRecords.status, row.status)))
        .returning();
      if (!next) return null;
      await insertReviewEvent(tx, caller, row, {
        action: input.action,
        fromStatus: row.status,
        toStatus: target,
        reason: input.reason,
        now,
      });
      return next;
    });
    if (!updated) throw conflict("The record changed while it was reviewed; read it again");
    await logOperation(caller, operation, "ok", { ...audit, detail: { from: row.status, to: target } });
    return toRecord(updated, scope);
  }

  /**
   * The supersession writes, in the caller's transaction: `old` becomes
   * superseded and `replacement` approved, conflicts between them are settled
   * and other open challenges to `old` move to `replacement`. Null when `old`
   * changed since it was read. Also used by steward confirm (GRE-1089).
   */
  async function applySupersede(
    tx: DbOrTransaction,
    caller: MemoryCaller,
    old: RecordRow,
    replacement: RecordRow,
    reason: string,
    now: Date,
  ) {
    const [oldNext] = await tx
      .update(memoryRecords)
      .set({
        status: "superseded",
        supersededById: replacement.id,
        supersededAt: now,
        effectiveTo: old.effectiveTo ?? replacement.effectiveFrom ?? now,
        updatedAt: now,
      })
      .where(and(eq(memoryRecords.id, old.id), eq(memoryRecords.status, old.status)))
      .returning();
    if (!oldNext) return null;
    const [replacementNext] = await tx
      .update(memoryRecords)
      .set({ status: "approved", supersedesId: old.id, version: old.version + 1, reviewedAt: now, updatedAt: now })
      .where(and(eq(memoryRecords.id, replacement.id), eq(memoryRecords.status, replacement.status)))
      .returning();
    if (!replacementNext) throw conflict("The replacement changed while it was reviewed; read it again");
    // Conflicts between the two are settled by this supersession.
    await tx
      .update(memoryConflicts)
      .set({
        state: "resolved",
        resolution: "superseded",
        resolutionNote: reason,
        resolvedByActorType: caller.actorType,
        resolvedByActorId: caller.actorId,
        resolvedAt: now,
      })
      .where(
        and(
          eq(memoryConflicts.state, "open"),
          or(
            and(eq(memoryConflicts.recordId, replacement.id), eq(memoryConflicts.approvedRecordId, old.id)),
            and(eq(memoryConflicts.recordId, old.id), eq(memoryConflicts.approvedRecordId, replacement.id)),
          ),
        ),
      );
    // Other open challenges to the old position now challenge the new one.
    await tx
      .update(memoryConflicts)
      .set({ approvedRecordId: replacement.id })
      .where(
        and(
          eq(memoryConflicts.state, "open"),
          eq(memoryConflicts.approvedRecordId, old.id),
          ne(memoryConflicts.recordId, replacement.id),
        ),
      );
    await insertReviewEvent(tx, caller, old, {
      action: "superseded_by",
      fromStatus: old.status,
      toStatus: "superseded",
      reason,
      relatedRecordId: replacement.id,
      now,
    });
    await insertReviewEvent(tx, caller, replacement, {
      action: "supersede",
      fromStatus: replacement.status,
      toStatus: "approved",
      reason,
      relatedRecordId: old.id,
      now,
    });
    return { oldNext, replacementNext };
  }

  /**
   * Replaces a record with a newer one in the same scope (correction or a
   * dated change). The old record stays, linked and readable, as history.
   * The replacement becomes approved, so its contributor cannot do this.
   */
  async function supersede(
    caller: MemoryCaller,
    recordId: string,
    input: SupersedeMemoryRecord,
  ): Promise<{ superseded: MemoryRecord; replacement: MemoryRecord }> {
    const operation = "supersede";
    const { row: old, scope, access } = await loadReadable(caller, recordId, operation);
    const audit = { scopeIds: [scope.id], recordId: old.id };
    if (input.replacementRecordId === old.id) throw badRequest("A record cannot supersede itself");
    const replacement = await db
      .select()
      .from(memoryRecords)
      .where(and(eq(memoryRecords.id, input.replacementRecordId), eq(memoryRecords.companyId, caller.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!replacement || replacement.scopeId !== old.scopeId) {
      await logOperation(caller, operation, "denied", { ...audit, detail: { reason: "replacement_not_in_scope" } });
      throw badRequest("The replacement must be a record in the same scope");
    }
    if (!["approved", "disputed", "unreviewed"].includes(old.status) || old.supersededById) {
      throw conflict(`A ${old.status} record cannot be superseded`);
    }
    if (!["unreviewed", "disputed"].includes(replacement.status)) {
      throw conflict(`A ${replacement.status} record cannot become the replacement`);
    }
    for (const decisionClass of new Set([old.decisionClass, replacement.decisionClass])) {
      const refusal = await reviewRefusal(caller, access, scope, decisionClass);
      if (refusal) await refuse(caller, operation, refusal, audit);
    }
    await refuseIfAuthor(caller, operation, [replacement], audit);

    const now = new Date();
    const result = await db.transaction((tx) => applySupersede(tx, caller, old, replacement, input.reason, now));
    if (!result) throw conflict("The record changed while it was reviewed; read it again");
    await logOperation(caller, operation, "ok", { ...audit, detail: { replacementRecordId: replacement.id } });
    return { superseded: toRecord(result.oldNext, scope), replacement: toRecord(result.replacementNext, scope) };
  }

  /**
   * Removes a record's content everywhere GSAM holds it and queues the engine
   * delete. Leaves only the tombstone: ids, scope, contributor, dates and links.
   * Returns the delete outbox entry and when it may run, or null if the record
   * was already deleted.
   */
  async function tombstone(
    tx: DbOrTransaction,
    caller: MemoryCaller,
    row: RecordRow,
    scope: ScopeRow,
    reason: string,
    now: Date,
    options: { direct: boolean },
  ) {
    const [deleted] = await tx
      .update(memoryRecords)
      .set({
        status: "deleted",
        title: null,
        content: null,
        entities: [],
        topics: [],
        evidence: null,
        syncState: "pending",
        syncError: null,
        deletedAt: now,
        updatedAt: now,
      })
      .where(and(eq(memoryRecords.id, row.id), ne(memoryRecords.status, "deleted")))
      .returning();
    if (!deleted) return null;

    // Outbox copies of the content: scrub every retain payload; one not yet sent never will be.
    const retains = await tx
      .select({ state: memoryIngestOutbox.state, attempts: memoryIngestOutbox.attempts, leaseUntil: memoryIngestOutbox.leaseUntil, nextAttemptAt: memoryIngestOutbox.nextAttemptAt })
      .from(memoryIngestOutbox)
      .where(and(eq(memoryIngestOutbox.recordId, row.id), eq(memoryIngestOutbox.op, "retain")));
    await tx
      .update(memoryIngestOutbox)
      .set({
        payload: { bankId: scope.bankId, documentId: row.id, scrubbed: true },
        state: sql`case when ${memoryIngestOutbox.state} = 'pending' then 'cancelled' else ${memoryIngestOutbox.state} end`,
        updatedAt: now,
      })
      .where(and(eq(memoryIngestOutbox.recordId, row.id), eq(memoryIngestOutbox.op, "retain")));
    // A retain that may still be in flight must land before the delete runs.
    let runAfter = now;
    for (const retain of retains) {
      const busyUntil =
        retain.state === "in_flight"
          ? retain.leaseUntil
          : retain.state === "pending" && retain.attempts === 0
            ? retain.nextAttemptAt
            : null;
      if (busyUntil && busyUntil > runAfter) runAfter = busyUntil;
    }
    const direct = options.direct && runAfter <= now;
    const entry = await enqueueMemoryIngest(tx, {
      companyId: row.companyId,
      recordId: row.id,
      op: "delete",
      payload: { bankId: scope.bankId, documentId: row.id },
      now,
      notBefore: direct ? new Date(now.getTime() + engineTimeoutMs + DIRECT_RETAIN_GRACE_MS) : runAfter,
    });

    await tx
      .update(memoryRelationships)
      .set({ note: null })
      .where(or(eq(memoryRelationships.fromRecordId, row.id), eq(memoryRelationships.toRecordId, row.id)));
    const touches = or(eq(memoryConflicts.recordId, row.id), eq(memoryConflicts.approvedRecordId, row.id));
    await tx
      .update(memoryConflicts)
      .set({ state: "resolved", resolution: "record_deleted", resolvedByActorType: caller.actorType, resolvedByActorId: caller.actorId, resolvedAt: now })
      .where(and(touches, eq(memoryConflicts.state, "open")));
    await tx.update(memoryConflicts).set({ sharedTerms: [] }).where(touches);
    // Link check leads: an open one closes, and every one drops the terms it matched on.
    const leadTouches = or(eq(memoryLinkLeads.fromRecordId, row.id), eq(memoryLinkLeads.toRecordId, row.id));
    await tx
      .update(memoryLinkLeads)
      .set({ state: "dismissed", resolution: "record_deleted", resolvedByActorType: caller.actorType, resolvedByActorId: caller.actorId, resolvedAt: now })
      .where(and(leadTouches, eq(memoryLinkLeads.state, "open")));
    await tx
      .update(memoryLinkLeads)
      .set({ basis: { entities: [], topics: [], values: [], sameSource: false }, resolutionNote: null })
      .where(leadTouches);
    await tx.delete(memoryExtractedFacts).where(eq(memoryExtractedFacts.recordId, row.id));
    await insertReviewEvent(tx, caller, row, { action: "delete", fromStatus: row.status, toStatus: "deleted", reason, now });
    return { deleted, entry, direct };
  }

  async function deleteRecord(caller: MemoryCaller, recordId: string, input: DeleteMemoryRecord): Promise<MemoryRecord> {
    const operation = "delete";
    const { row, scope, access } = await loadReadable(caller, recordId, operation);
    const audit = { scopeIds: [scope.id], recordId: row.id };
    if (row.status === "deleted") return toRecord(row, scope);
    const allowed = access.isOwner || access.ownsAgentScope(scope) || grantCovers(access.grants, "memory:delete", scope);
    if (!allowed) await refuse(caller, operation, "no_delete_right", audit);

    const now = new Date();
    const outcome = await db.transaction((tx) => tombstone(tx, caller, row, scope, input.reason, now, { direct: true }));
    if (!outcome) {
      const current = await db.select().from(memoryRecords).where(eq(memoryRecords.id, row.id)).then((rows) => rows[0]!);
      return toRecord(current, scope);
    }
    let result = outcome.deleted;
    let engineAvailable = true;
    if (outcome.direct) {
      try {
        await callEngine(() => engine.deleteDocument(scope.bankId, row.id));
        const done = new Date();
        await settleDirectMemoryIngest(db, outcome.entry.id, { now: done, outcome: "synced", usage: null });
        [result] = await db
          .update(memoryRecords)
          .set({ syncState: "synced", syncedAt: done, updatedAt: done })
          .where(eq(memoryRecords.id, row.id))
          .returning();
      } catch (error) {
        engineAvailable = false;
        const failed = new Date();
        const classified = classifyEngineError(error, failed);
        logger.warn({ err: error, recordId: row.id, kind: classified.kind }, "memory engine delete failed; queued for retry");
        await settleDirectMemoryIngest(db, outcome.entry.id, {
          now: failed,
          outcome: "deferred",
          nextAttemptAt: classified.kind === "rejected" ? failed : nextAttemptAt({ now: failed, attempts: 1, classified }),
          kind: classified.kind,
          error: classified.message,
        });
      }
    }
    await logOperation(caller, operation, engineAvailable ? "ok" : "unavailable", audit);
    return toRecord(result, scope);
  }

  async function history(caller: MemoryCaller, recordId: string): Promise<MemoryRecordHistory> {
    const { row, scope, access } = await loadReadable(caller, recordId, "history");
    const scopes = new Map<string, ScopeRow | null>([[scope.id, scope]]);
    const readable = async (candidate: RecordRow) => {
      if (!scopes.has(candidate.scopeId)) scopes.set(candidate.scopeId, await loadScope(caller.companyId, candidate.scopeId));
      const candidateScope = scopes.get(candidate.scopeId);
      return candidateScope && access.canRead(candidateScope) ? candidateScope : null;
    };
    const loadRow = (id: string) =>
      db
        .select()
        .from(memoryRecords)
        .where(and(eq(memoryRecords.id, id), eq(memoryRecords.companyId, caller.companyId)))
        .then((rows) => rows[0] ?? null);

    const chain: Array<{ row: RecordRow; scope: ScopeRow }> = [{ row, scope }];
    const seen = new Set([row.id]);
    for (let cursor = row.supersedesId; cursor && !seen.has(cursor) && chain.length < 100; ) {
      const previous = await loadRow(cursor);
      const previousScope = previous ? await readable(previous) : null;
      if (!previous || !previousScope) break;
      chain.unshift({ row: previous, scope: previousScope });
      seen.add(previous.id);
      cursor = previous.supersedesId;
    }
    for (let cursor = row.supersededById; cursor && !seen.has(cursor) && chain.length < 200; ) {
      const next = await loadRow(cursor);
      const nextScope = next ? await readable(next) : null;
      if (!next || !nextScope) break;
      chain.push({ row: next, scope: nextScope });
      seen.add(next.id);
      cursor = next.supersededById;
    }
    const chainIds = chain.map((link) => link.row.id);
    const events = await db
      .select()
      .from(memoryReviewEvents)
      .where(and(eq(memoryReviewEvents.companyId, caller.companyId), inArray(memoryReviewEvents.recordId, chainIds)))
      .orderBy(asc(memoryReviewEvents.createdAt));
    const facts = await db
      .select()
      .from(memoryExtractedFacts)
      .where(and(eq(memoryExtractedFacts.companyId, caller.companyId), eq(memoryExtractedFacts.recordId, row.id)))
      .orderBy(desc(memoryExtractedFacts.lastSeenAt))
      .limit(500);
    await logOperation(caller, "history", "ok", { scopeIds: [scope.id], recordId: row.id });
    return {
      record: toRecord(row, scope),
      chain: chain.map((link) => toRecord(link.row, link.scope)),
      events: events.map(toEvent),
      extractedFacts: facts.map(toFact),
    };
  }

  /**
   * Whether the caller may link a record in `fromScope` to one in `toScope`
   * (memory linking, 6 Oct 2026). The same rule as contributing: the right to
   * contribute to both scopes. A client or restricted-project record links
   * only to records in its own scope, so a link never joins a hard boundary
   * to anything outside it.
   */
  function linkRefusal(access: Access, fromScope: ScopeRow, toScope: ScopeRow): "cross_boundary" | "no_contribute_right" | null {
    if (fromScope.id !== toScope.id && (isHardBoundary(fromScope.kind) || isHardBoundary(toScope.kind))) return "cross_boundary";
    if (!access.canContribute(fromScope) || !access.canContribute(toScope)) return "no_contribute_right";
    return null;
  }

  async function refuseLink(
    caller: MemoryCaller,
    operation: string,
    reason: "cross_boundary" | "no_contribute_right",
    audit: { scopeIds: string[]; recordId: string | null },
  ): Promise<never> {
    if (reason === "no_contribute_right") return refuse(caller, operation, reason, audit);
    await logOperation(caller, operation, "denied", { ...audit, detail: { reason } });
    throw badRequest("A client or restricted entry can only be linked to entries in its own scope");
  }

  /**
   * Checks, before anything is written, that a new record in `scopeId` may be
   * linked to each of `targetIds` (`relatedTo` on contribute). Throws the same
   * 404 for a hidden record as for a missing one.
   */
  async function assertCanLink(caller: MemoryCaller, scopeId: string, targetIds: string[], operation: string) {
    await gateway.assertEnabled(caller.companyId);
    const scope = await loadScope(caller.companyId, scopeId);
    // An unknown or closed scope is refused by contribute itself, with its own audit row.
    if (!scope) return;
    for (const targetId of new Set(targetIds)) {
      const target = await loadReadable(caller, targetId, operation);
      if (target.row.status === "deleted") throw conflict("A deleted record cannot be related");
      const reason = linkRefusal(target.access, scope, target.scope);
      if (reason) await refuseLink(caller, operation, reason, { scopeIds: [...new Set([scope.id, target.scope.id])], recordId: target.row.id });
    }
  }

  async function createRelationship(
    caller: MemoryCaller,
    input: CreateMemoryRelationship,
    options: { operation?: string; via?: string } = {},
  ): Promise<MemoryRelationship> {
    const operation = options.operation ?? "relationship_create";
    if (input.fromRecordId === input.toRecordId) throw badRequest("A record cannot relate to itself");
    const from = await loadReadable(caller, input.fromRecordId, operation);
    const to = await loadReadable(caller, input.toRecordId, operation);
    const audit = { scopeIds: [...new Set([from.scope.id, to.scope.id])], recordId: from.row.id };
    const reason = linkRefusal(from.access, from.scope, to.scope);
    if (reason) await refuseLink(caller, operation, reason, audit);
    if (from.row.status === "deleted" || to.row.status === "deleted") throw conflict("A deleted record cannot be related");

    const now = new Date();
    const created = await db.transaction((tx) =>
      insertRelationship(tx, caller, from.row, to.row, {
        type: input.type,
        note: input.note ?? null,
        sourceKind: input.sourceKind ?? null,
        sourceId: input.sourceId ?? null,
        now,
      }),
    );
    if (!created) throw conflict("This relationship already exists");
    // Ids and the type only; the note stays on the relationship row.
    await logOperation(caller, operation, "ok", {
      ...audit,
      detail: { type: input.type, toRecordId: to.row.id, relationshipId: created.id, ...(options.via ? { via: options.via } : {}) },
    });
    return toRelationship(created);
  }

  async function listRelationships(caller: MemoryCaller, recordId: string): Promise<MemoryRelationship[]> {
    const { row, scope, access } = await loadReadable(caller, recordId, "relationships_list");
    const rows = await db
      .select()
      .from(memoryRelationships)
      .where(
        and(
          eq(memoryRelationships.companyId, caller.companyId),
          or(eq(memoryRelationships.fromRecordId, row.id), eq(memoryRelationships.toRecordId, row.id)),
        ),
      )
      .orderBy(asc(memoryRelationships.createdAt));
    // A link may cross into another scope; keep only those whose other end the caller may read.
    const otherIds = [...new Set(rows.map((rel) => (rel.fromRecordId === row.id ? rel.toRecordId : rel.fromRecordId)))];
    const readable = new Set<string>();
    if (otherIds.length > 0) {
      const scopes = new Map(
        (await db.select().from(memoryScopes).where(eq(memoryScopes.companyId, caller.companyId))).map((s) => [s.id, s]),
      );
      const others = await db
        .select({ id: memoryRecords.id, scopeId: memoryRecords.scopeId })
        .from(memoryRecords)
        .where(and(eq(memoryRecords.companyId, caller.companyId), inArray(memoryRecords.id, otherIds)));
      for (const other of others) {
        const otherScope = scopes.get(other.scopeId);
        if (otherScope && access.canRead(otherScope)) readable.add(other.id);
      }
    }
    const visible = rows.filter((rel) => readable.has(rel.fromRecordId === row.id ? rel.toRecordId : rel.fromRecordId));
    await logOperation(caller, "relationships_list", "ok", { scopeIds: [scope.id], recordId: row.id });
    return visible.map(toRelationship);
  }

  /** Conflict queue data for reviewers and the steward (GRE-887), grouped by the approved position. */
  async function listConflicts(caller: MemoryCaller, state: "open" | "resolved" | "all"): Promise<MemoryConflictQueue> {
    await gateway.assertEnabled(caller.companyId);
    const access = await accessFor(caller);
    const scopes = (await db.select().from(memoryScopes).where(eq(memoryScopes.companyId, caller.companyId))).filter(
      (scope) => access.canRead(scope),
    );
    const scopesById = new Map(scopes.map((scope) => [scope.id, scope]));
    const rows = scopes.length === 0
      ? []
      : await db
          .select()
          .from(memoryConflicts)
          .where(
            and(
              eq(memoryConflicts.companyId, caller.companyId),
              inArray(memoryConflicts.scopeId, [...scopesById.keys()]),
              ...(state === "all" ? [] : [eq(memoryConflicts.state, state)]),
            ),
          )
          .orderBy(asc(memoryConflicts.detectedAt))
          .limit(500);
    const recordIds = [...new Set(rows.flatMap((row) => [row.recordId, row.approvedRecordId]))];
    const records = new Map(
      (recordIds.length === 0
        ? []
        : await db
            .select()
            .from(memoryRecords)
            .where(and(eq(memoryRecords.companyId, caller.companyId), inArray(memoryRecords.id, recordIds)))
      ).map((row) => [row.id, row]),
    );
    const groups = new Map<string, MemoryConflictGroup>();
    for (const row of rows) {
      const scope = scopesById.get(row.scopeId);
      const challenger = records.get(row.recordId);
      const approved = records.get(row.approvedRecordId);
      if (!scope || !challenger || !approved) continue;
      if (challenger.scopeId !== scope.id || approved.scopeId !== scope.id) continue;
      const group = groups.get(approved.id) ?? {
        scope: toScope(scope),
        approvedPosition: toRecord(approved, scope),
        conflicts: [],
      };
      const item: MemoryConflict = {
        id: row.id,
        scopeId: row.scopeId,
        record: toRecord(challenger, scope),
        origin: row.origin as MemoryConflict["origin"],
        sharedTerms: row.sharedTerms,
        state: row.state as MemoryConflict["state"],
        resolution: row.resolution,
        resolutionNote: row.resolutionNote,
        detectedAt: row.detectedAt,
        resolvedAt: row.resolvedAt,
      };
      group.conflicts.push(item);
      groups.set(approved.id, group);
    }
    await logOperation(caller, "conflicts_list", "ok", {
      scopeIds: [...new Set(rows.map((row) => row.scopeId))],
      detail: { state, returned: rows.length },
    });
    return { note: MEMORY_CONFLICT_NOTE, groups: [...groups.values()] };
  }

  async function resolveConflict(caller: MemoryCaller, conflictId: string, input: ResolveMemoryConflict): Promise<MemoryConflict> {
    const operation = "conflict_resolve";
    await gateway.assertEnabled(caller.companyId);
    const row = await db
      .select()
      .from(memoryConflicts)
      .where(and(eq(memoryConflicts.id, conflictId), eq(memoryConflicts.companyId, caller.companyId)))
      .then((rows) => rows[0] ?? null);
    const scope = row ? await loadScope(caller.companyId, row.scopeId) : null;
    const access = await accessFor(caller);
    if (!row || !scope || !access.canRead(scope)) {
      await logOperation(caller, operation, "denied", { detail: { requestedId: conflictId } });
      throw notFound("Memory conflict not found");
    }
    const audit = { scopeIds: [scope.id], recordId: row.recordId };
    if (row.state !== "open") throw conflict("The conflict is already resolved");
    const [challenger, approved] = await Promise.all(
      [row.recordId, row.approvedRecordId].map((id) =>
        db.select().from(memoryRecords).where(eq(memoryRecords.id, id)).then((rows) => rows[0]!),
      ),
    );
    const decisionClass = approved.decisionClass as MemoryDecisionClass;
    const refusal = await reviewRefusal(caller, access, scope, decisionClass);
    if (refusal) await refuse(caller, operation, refusal, audit);
    await refuseIfAuthor(caller, operation, [challenger, approved], audit);

    const now = new Date();
    const resolved = await db.transaction(async (tx) => {
      const [next] = await tx
        .update(memoryConflicts)
        .set({
          state: "resolved",
          resolution: input.resolution,
          resolutionNote: input.reason,
          resolvedByActorType: caller.actorType,
          resolvedByActorId: caller.actorId,
          resolvedAt: now,
        })
        .where(and(eq(memoryConflicts.id, row.id), eq(memoryConflicts.state, "open")))
        .returning();
      if (!next) return null;
      await insertReviewEvent(tx, caller, challenger, {
        action: "conflict_resolved",
        reason: `${input.resolution}: ${input.reason}`,
        relatedRecordId: approved.id,
        now,
      });
      return next;
    });
    if (!resolved) throw conflict("The conflict is already resolved");
    await logOperation(caller, operation, "ok", { ...audit, detail: { resolution: input.resolution } });
    return {
      id: resolved.id,
      scopeId: resolved.scopeId,
      record: toRecord(challenger, scope),
      origin: resolved.origin as MemoryConflict["origin"],
      sharedTerms: resolved.sharedTerms,
      state: "resolved",
      resolution: resolved.resolution,
      resolutionNote: resolved.resolutionNote,
      detectedAt: resolved.detectedAt,
      resolvedAt: resolved.resolvedAt,
    };
  }

  /** Records due for deletion under G1 decision 7 as of `asOf`. */
  async function retentionCandidates(companyId: string, asOf: Date): Promise<MemoryRetentionItem[]> {
    const agentScopeIds = new Set(
      (await db.select({ id: memoryScopes.id }).from(memoryScopes).where(and(eq(memoryScopes.companyId, companyId), eq(memoryScopes.kind, "agent")))).map(
        (scope) => scope.id,
      ),
    );
    const rows = await db
      .select()
      .from(memoryRecords)
      .where(
        and(
          eq(memoryRecords.companyId, companyId),
          ne(memoryRecords.status, "deleted"),
          or(
            inArray(memoryRecords.status, ["unreviewed", "superseded"]),
            ...(agentScopeIds.size > 0 ? [inArray(memoryRecords.scopeId, [...agentScopeIds])] : []),
          ),
        ),
      );
    const unreviewedIds = rows.filter((row) => row.status === "unreviewed" && !agentScopeIds.has(row.scopeId)).map((row) => row.id);
    const kept = new Set<string>();
    if (unreviewedIds.length > 0) {
      // Cited by an approved record, or in an open conflict: kept until reviewed.
      const cited = await db
        .select({ id: memoryRelationships.toRecordId })
        .from(memoryRelationships)
        .innerJoin(memoryRecords, eq(memoryRecords.id, memoryRelationships.fromRecordId))
        .where(and(inArray(memoryRelationships.toRecordId, unreviewedIds), eq(memoryRecords.status, "approved")));
      cited.forEach((row) => kept.add(row.id));
      const open = await db
        .select({ id: memoryConflicts.recordId })
        .from(memoryConflicts)
        .where(and(inArray(memoryConflicts.recordId, unreviewedIds), eq(memoryConflicts.state, "open")));
      open.forEach((row) => kept.add(row.id));
    }
    const items: MemoryRetentionItem[] = [];
    const due = (from: Date, days: number) => new Date(from.getTime() + days * DAY_MS);
    for (const row of rows) {
      let item: MemoryRetentionItem | null = null;
      if (agentScopeIds.has(row.scopeId)) {
        item = { recordId: row.id, scopeId: row.scopeId, rule: "agent_working_notes", dueAt: due(row.lastUsedAt ?? row.updatedAt, MEMORY_RETENTION_DAYS.agentWorkingNotes) };
      } else if (row.status === "unreviewed" && !kept.has(row.id)) {
        item = { recordId: row.id, scopeId: row.scopeId, rule: "unreviewed", dueAt: due(row.createdAt, MEMORY_RETENTION_DAYS.unreviewed) };
      } else if (row.status === "superseded") {
        item = { recordId: row.id, scopeId: row.scopeId, rule: "superseded", dueAt: due(row.supersededAt ?? row.updatedAt, MEMORY_RETENTION_DAYS.superseded) };
      }
      if (item && (item.dueAt as Date) <= asOf) items.push(item);
    }
    return items;
  }

  /**
   * Retention (G1 decision 7). A dry run lists what is due, or due within
   * `withinDays` (the steward's warning list). Applying deletes each due
   * record like a manual delete; the engine deletes go through the outbox.
   */
  async function runRetention(caller: MemoryCaller, input: RunMemoryRetention): Promise<MemoryRetentionResult> {
    const operation = "retention";
    await gateway.assertEnabled(caller.companyId);
    const access = await accessFor(caller);
    if (!access.isOwner && !access.grants.has("memory:admin")) await refuse(caller, operation, "no_retention_right");
    if (!input.dryRun && input.withinDays > 0) throw badRequest("withinDays is for dry runs only");
    const now = new Date();
    const asOf = new Date(now.getTime() + input.withinDays * DAY_MS);
    const items = await retentionCandidates(caller.companyId, asOf);
    if (!input.dryRun) {
      const scopes = new Map<string, ScopeRow>();
      for (const item of items) {
        if (!scopes.has(item.scopeId)) scopes.set(item.scopeId, (await loadScope(caller.companyId, item.scopeId))!);
        const scope = scopes.get(item.scopeId)!;
        await db.transaction(async (tx) => {
          const row = await tx.select().from(memoryRecords).where(eq(memoryRecords.id, item.recordId)).then((rows) => rows[0]);
          if (row) await tombstone(tx, caller, row, scope, `Retention: ${item.rule}`, now, { direct: false });
        });
      }
    }
    await logOperation(caller, operation, "ok", {
      scopeIds: [...new Set(items.map((item) => item.scopeId))],
      detail: { dryRun: input.dryRun, withinDays: input.withinDays, count: items.length },
    });
    return { dryRun: input.dryRun, asOf, items };
  }

  return {
    /** For the steward actions (steward-actions.ts) only. */
    internals: { reviewRefusal, applySupersede, loadReadable, refuse },
    review,
    supersede,
    deleteRecord,
    history,
    assertCanLink,
    createRelationship,
    listRelationships,
    listConflicts,
    resolveConflict,
    runRetention,
  };
}

export type MemoryReviewService = ReturnType<typeof memoryReviewService>;
