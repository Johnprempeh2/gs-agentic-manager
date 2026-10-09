import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  agents,
  authUsers,
  companyMemberships,
  memoryConflicts,
  memoryRecords,
  memoryScopes,
  memoryScopeStewards,
} from "@greatstone/db";
import {
  MEMORY_STEWARD_ACTIONS,
  memoryReviewAgeFlag,
  type MemoryActorLabel,
  type MemoryReviewQueue,
  type MemoryReviewQueueItem,
  type MemoryReviewQueueQuery,
  type MemoryScopeKind,
  type MemoryScopeSteward,
  type MemoryStewardAction,
  type MemoryStewardActionInput,
  type MemoryStewardActionResult,
  type SetMemoryScopeSteward,
} from "@greatstone/shared";
import { badRequest, conflict, forbidden, notFound } from "../../errors.js";
import { enqueueMemoryIngest } from "./ingest-outbox-db.js";
import { authorRefusal, flagPossibleConflicts, insertRelationship, insertReviewEvent, loadEditChain } from "./review-store.js";
import type { MemoryReviewService } from "./review.js";
import { detectSensitiveContent, MEMORY_SENSITIVE_CONTENT_CODE, MemorySensitiveContentError } from "./sensitive-content.js";
import {
  isHardBoundary,
  memoryEngineDocument,
  toRecord,
  type MemoryCaller,
  type MemoryGatewayService,
  type RecordRow,
  type ScopeRow,
} from "./service.js";

// Shared memory M1 (GRE-1080, GRE-1089): stewards per scope, the review queue
// and the card actions a steward takes on a proposal.
//
// A steward is a person the owner or an admin names for an organization or
// project scope. Client and restricted scopes, and the owner-only decision
// classes, always route to the owner and cannot be handed to a steward. The
// existing reviewers (the owner, a project lead, a `memory:approve` grant)
// keep their rights; a steward adds to them. Nobody confirms a card when they
// wrote or edited any version of it.

type DbOrTransaction = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type Access = Awaited<ReturnType<MemoryGatewayService["internals"]["accessFor"]>>;
type StewardRow = typeof memoryScopeStewards.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;
const QUEUE_LIMIT = 1_000;

/** Plain reasons for every refusal; the UI shows them as they are. */
const STEWARD_REFUSALS = {
  own_proposal: "You proposed this card. Someone else must confirm it.",
  own_edit: "You edited this card. Someone else must confirm it.",
  not_steward: "You are not the steward for this scope.",
  owner_only: "Only the company owner can review this card.",
  working_notes: "Agent working notes are never reviewed.",
  not_owner_or_admin: "Only the company owner or an admin can set stewards.",
  owner_only_scope: "Client and restricted scopes always route to the company owner.",
  incomplete_history: "This card's edit history cannot be fully checked, so it cannot be confirmed.",
} as const;
type StewardRefusal = keyof typeof STEWARD_REFUSALS;

const STALE_VERSION_MESSAGE = "This card changed since you opened it. Reload it and try again.";
const MULTIPLE_CONFLICTS_MESSAGE = "This card conflicts with more than one confirmed card. Settle the other conflicts first.";

function isStewardOf(caller: MemoryCaller, steward: StewardRow | undefined) {
  if (!steward || caller.actorType !== "user" || !caller.userId) return false;
  return steward.primaryUserId === caller.userId || steward.backupUserId === caller.userId;
}

function actorKey(row: Pick<RecordRow, "contributorAgentId" | "contributorUserId">) {
  if (row.contributorAgentId) return { type: "agent" as const, id: row.contributorAgentId };
  if (row.contributorUserId) return { type: "user" as const, id: row.contributorUserId };
  return null;
}

/** Why the caller may not confirm: they wrote some version, or the full history cannot be read. */
function confirmRefusal(caller: MemoryCaller, chain: RecordRow[] | null): StewardRefusal | null {
  return chain ? authorRefusal(caller, chain) : "incomplete_history";
}

export function memoryStewardService(db: Db, gateway: MemoryGatewayService, reviews: MemoryReviewService) {
  const { accessFor, logOperation, loadScope } = gateway.internals;
  const { reviewRefusal, applySupersede } = reviews.internals;

  async function refuse(
    caller: MemoryCaller,
    operation: string,
    refusal: StewardRefusal,
    extra: { scopeIds?: string[]; recordId?: string | null } = {},
  ): Promise<never> {
    await logOperation(caller, operation, "denied", { ...extra, detail: { reason: refusal } });
    throw forbidden(STEWARD_REFUSALS[refusal]);
  }

  async function loadStewards(companyId: string) {
    const rows = await db.select().from(memoryScopeStewards).where(eq(memoryScopeStewards.companyId, companyId));
    return new Map(rows.map((row) => [row.scopeId, row]));
  }

  /** The person who owns the company; owner-only scopes and classes route to them. */
  async function ownerUserId(companyId: string) {
    return db
      .select({ id: companyMemberships.principalId })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.membershipRole, "owner"),
          eq(companyMemberships.status, "active"),
        ),
      )
      .orderBy(asc(companyMemberships.createdAt))
      .then((rows) => rows[0]?.id ?? null);
  }

  /** A steward may read the scope they look after; nobody else gains anything here. */
  function canSee(access: Access, caller: MemoryCaller, scope: ScopeRow, stewards: Map<string, StewardRow>) {
    if (scope.kind === "agent") return false;
    return access.canRead(scope) || (!isHardBoundary(scope.kind) && isStewardOf(caller, stewards.get(scope.id)));
  }

  /** Who may act on a proposal: the existing reviewers, plus the scope's stewards. */
  async function stewardRefusal(
    caller: MemoryCaller,
    access: Access,
    scope: ScopeRow,
    decisionClass: string,
    stewards: Map<string, StewardRow>,
  ): Promise<StewardRefusal | null> {
    const refusal = await reviewRefusal(caller, access, scope, decisionClass);
    if (refusal === null) return null;
    if (refusal === "working_notes" || refusal === "owner_only") return refusal;
    return isStewardOf(caller, stewards.get(scope.id)) ? null : "not_steward";
  }

  async function labels(keys: Array<{ type: "user" | "agent"; id: string }>) {
    const userIds = [...new Set(keys.filter((key) => key.type === "user").map((key) => key.id))];
    const agentIds = [...new Set(keys.filter((key) => key.type === "agent").map((key) => key.id))];
    const users = new Map(
      userIds.length === 0
        ? []
        : (await db.select({ id: authUsers.id, name: authUsers.name }).from(authUsers).where(inArray(authUsers.id, userIds))).map(
            (user) => [user.id, user.name],
          ),
    );
    const agentNames = new Map(
      agentIds.length === 0
        ? []
        : (await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))).map(
            (agent) => [agent.id, agent.name],
          ),
    );
    // The app comes from M0 (GRE-1079); until it lands every label says null.
    return (key: { type: "user" | "agent"; id: string }): MemoryActorLabel => ({
      type: key.type,
      id: key.id,
      name: (key.type === "user" ? users.get(key.id) : agentNames.get(key.id)) ?? (key.type === "user" ? "Unknown person" : "Unknown agent"),
      app: null,
    });
  }

  async function reviewQueue(caller: MemoryCaller, query: MemoryReviewQueueQuery): Promise<MemoryReviewQueue> {
    await gateway.assertEnabled(caller.companyId);
    const access = await accessFor(caller);
    const stewards = await loadStewards(caller.companyId);
    const scopes = (await db.select().from(memoryScopes).where(eq(memoryScopes.companyId, caller.companyId))).filter((scope) =>
      canSee(access, caller, scope, stewards),
    );
    const scopesById = new Map(scopes.map((scope) => [scope.id, scope]));
    const rows =
      scopes.length === 0
        ? []
        : await db
            .select()
            .from(memoryRecords)
            .where(
              and(
                eq(memoryRecords.companyId, caller.companyId),
                eq(memoryRecords.status, "unreviewed"),
                inArray(memoryRecords.scopeId, [...scopesById.keys()]),
              ),
            )
            .orderBy(asc(memoryRecords.createdAt))
            .limit(QUEUE_LIMIT);

    // Only proposals the caller may act on; the right is the same for one scope and class.
    const rights = new Map<string, StewardRefusal | null>();
    const reviewable: RecordRow[] = [];
    for (const row of rows) {
      const key = `${row.scopeId}:${row.decisionClass}`;
      if (!rights.has(key)) rights.set(key, await stewardRefusal(caller, access, scopesById.get(row.scopeId)!, row.decisionClass, stewards));
      if (rights.get(key) === null) reviewable.push(row);
    }

    const chains = new Map<string, RecordRow[] | null>();
    for (const row of reviewable) chains.set(row.id, await loadEditChain(db, caller.companyId, row));

    const ids = reviewable.map((row) => row.id);
    const conflictRows =
      ids.length === 0
        ? []
        : await db
            .select()
            .from(memoryConflicts)
            .where(and(eq(memoryConflicts.companyId, caller.companyId), eq(memoryConflicts.state, "open"), inArray(memoryConflicts.recordId, ids)))
            .orderBy(asc(memoryConflicts.detectedAt));
    const conflictsByRecord = new Map<string, typeof conflictRows>();
    for (const row of conflictRows) conflictsByRecord.set(row.recordId, [...(conflictsByRecord.get(row.recordId) ?? []), row]);
    const approvedIds = [...new Set(conflictRows.map((row) => row.approvedRecordId))];
    const approvedRows = new Map(
      (approvedIds.length === 0
        ? []
        : await db
            .select()
            .from(memoryRecords)
            .where(and(eq(memoryRecords.companyId, caller.companyId), inArray(memoryRecords.id, approvedIds), eq(memoryRecords.status, "approved")))
      ).map((row) => [row.id, row]),
    );

    const label = await labels(
      reviewable.flatMap((row) => (chains.get(row.id) ?? [row]).map(actorKey)).filter((key): key is NonNullable<typeof key> => key !== null),
    );
    const now = Date.now();
    const all: MemoryReviewQueueItem[] = reviewable.map((row) => {
      const scope = scopesById.get(row.scopeId)!;
      const chain = chains.get(row.id) ?? null;
      const first = chain?.[0] ?? row;
      const proposerKey = actorKey(first);
      const editorKey = chain && chain.length > 1 ? actorKey(row) : null;
      const conflicts = conflictsByRecord.get(row.id) ?? [];
      // The confirmed card it changes: the approved side of its open conflict.
      const currentRow = conflicts.map((c) => approvedRows.get(c.approvedRecordId)).find(Boolean) ?? null;
      const ageDays = Math.max(0, Math.floor((now - first.createdAt.getTime()) / DAY_MS));
      const ownRefusal = confirmRefusal(caller, chain);
      const blockedReason = ownRefusal
        ? STEWARD_REFUSALS[ownRefusal]
        : conflicts.length > 1
          ? MULTIPLE_CONFLICTS_MESSAGE
          : null;
      const allowed = Object.fromEntries(MEMORY_STEWARD_ACTIONS.map((action) => [action, true])) as Record<MemoryStewardAction, boolean>;
      allowed.confirm = blockedReason === null;
      return {
        proposal: toRecord(row, scope),
        proposer: proposerKey ? label(proposerKey) : { type: "user", id: "", name: "Unknown person", app: null },
        editedBy: editorKey ? label(editorKey) : null,
        current: currentRow ? toRecord(currentRow, scopesById.get(currentRow.scopeId) ?? scope) : null,
        scope: { id: scope.id, name: scope.name, kind: scope.kind as MemoryScopeKind },
        ageDays,
        ageFlag: memoryReviewAgeFlag(ageDays),
        conflictIds: conflicts.map((c) => c.id),
        allowed,
        blockedReason,
      };
    });

    const facets: MemoryReviewQueue["facets"] = { scopes: [], people: [], apps: [] };
    const count = <T extends { count: number }>(list: T[], match: (entry: T) => boolean, create: () => T) => {
      const found = list.find(match);
      if (found) found.count += 1;
      else list.push(create());
    };
    for (const item of all) {
      count(facets.scopes, (entry) => entry.id === item.scope.id, () => ({ id: item.scope.id, name: item.scope.name, count: 1 }));
      const person = item.proposer;
      count(facets.people, (entry) => entry.type === person.type && entry.id === person.id, () => ({ type: person.type, id: person.id, name: person.name, count: 1 }));
      if (person.app) count(facets.apps, (entry) => entry.app === person.app, () => ({ app: person.app!, count: 1 }));
    }

    const items = all
      .filter((item) => !query.scopeId || item.scope.id === query.scopeId)
      .filter((item) => !query.person || `${item.proposer.type}:${item.proposer.id}` === query.person)
      .filter((item) => !query.app || item.proposer.app === query.app || item.editedBy?.app === query.app)
      .filter((item) => !query.age || item.ageFlag === query.age)
      .filter((item) => query.conflict === undefined || item.conflictIds.length > 0 === query.conflict)
      // Expired last, then oldest first.
      .sort((a, b) => Number(a.ageFlag === "expired") - Number(b.ageFlag === "expired") || b.ageDays - a.ageDays);

    await logOperation(caller, "review_queue", "ok", {
      scopeIds: [...new Set(items.map((item) => item.scope.id))],
      detail: { returned: items.length, reviewable: all.length },
    });
    return { items, facets };
  }

  /** The proposal, or the same 404 for "missing" and "not yours", with an audit row. */
  async function loadForAction(caller: MemoryCaller, recordId: string, operation: string) {
    await gateway.assertEnabled(caller.companyId);
    const row = await db
      .select()
      .from(memoryRecords)
      .where(and(eq(memoryRecords.id, recordId), eq(memoryRecords.companyId, caller.companyId)))
      .then((rows) => rows[0] ?? null);
    const scope = row ? await loadScope(caller.companyId, row.scopeId) : null;
    const access = await accessFor(caller);
    const stewards = await loadStewards(caller.companyId);
    if (!row || !scope || !canSee(access, caller, scope, stewards)) {
      await logOperation(caller, operation, "denied", { recordId: row ? row.id : null, detail: { requestedId: recordId } });
      throw notFound("Memory record not found");
    }
    return { row, scope, access, stewards };
  }

  /**
   * Takes the proposal for this action: still unreviewed and at the version
   * the caller saw. Null when another reviewer got there first.
   */
  async function claim(tx: DbOrTransaction, row: RecordRow, expectedVersion: number, now: Date) {
    const [claimed] = await tx
      .update(memoryRecords)
      .set({ updatedAt: now })
      .where(and(eq(memoryRecords.id, row.id), eq(memoryRecords.version, expectedVersion), eq(memoryRecords.status, "unreviewed")))
      .returning();
    return claimed ?? null;
  }

  async function resolveOpenConflicts(tx: DbOrTransaction, caller: MemoryCaller, recordId: string, resolution: string, note: string, now: Date) {
    await tx
      .update(memoryConflicts)
      .set({ state: "resolved", resolution, resolutionNote: note, resolvedByActorType: caller.actorType, resolvedByActorId: caller.actorId, resolvedAt: now })
      .where(and(eq(memoryConflicts.recordId, recordId), eq(memoryConflicts.state, "open")));
  }

  async function act(caller: MemoryCaller, recordId: string, input: MemoryStewardActionInput): Promise<MemoryStewardActionResult> {
    const operation = `steward_${input.action}`;
    const { row, scope, access, stewards } = await loadForAction(caller, recordId, operation);
    const audit = { scopeIds: [scope.id], recordId: row.id };
    const refusal = await stewardRefusal(caller, access, scope, row.decisionClass, stewards);
    if (refusal) await refuse(caller, operation, refusal, audit);
    const stale = async (reason: string): Promise<never> => {
      await logOperation(caller, operation, "denied", { ...audit, detail: { reason, expectedVersion: input.expectedVersion, version: row.version, status: row.status } });
      throw conflict(reason === "stale_version" ? STALE_VERSION_MESSAGE : "This card is no longer waiting for review.");
    };
    if (row.version !== input.expectedVersion) await stale("stale_version");
    if (row.status !== "unreviewed") await stale("not_unreviewed");
    const now = new Date();

    switch (input.action) {
      case "confirm": {
        const own = confirmRefusal(caller, await loadEditChain(db, caller.companyId, row));
        if (own) await refuse(caller, operation, own, audit);
        const open = await db
          .select()
          .from(memoryConflicts)
          .where(and(eq(memoryConflicts.recordId, row.id), eq(memoryConflicts.state, "open")));
        if (open.length > 1) {
          await logOperation(caller, operation, "denied", { ...audit, detail: { reason: "multiple_conflicts", conflictIds: open.map((c) => c.id) } });
          throw conflict(MULTIPLE_CONFLICTS_MESSAGE);
        }
        // A proposal that challenges a confirmed card replaces it when confirmed;
        // its `supersedesId` then names that card, and earlier versions still
        // point forward to it through `supersededById`.
        const current = open[0]
          ? await db.select().from(memoryRecords).where(eq(memoryRecords.id, open[0].approvedRecordId)).then((rows) => rows[0] ?? null)
          : null;
        if (current) {
          const currentRefusal = await stewardRefusal(caller, access, scope, current.decisionClass, stewards);
          if (currentRefusal) await refuse(caller, operation, currentRefusal, audit);
        }
        const confirmed = await db.transaction(async (tx) => {
          const claimed = await claim(tx, row, input.expectedVersion, now);
          if (!claimed) return null;
          if (current && current.status === "approved") {
            const result = await applySupersede(tx, caller, current, claimed, input.reason, now);
            if (!result) throw conflict(STALE_VERSION_MESSAGE);
            return result.replacementNext;
          }
          const [next] = await tx
            .update(memoryRecords)
            .set({ status: "approved", reviewedAt: now, updatedAt: now })
            .where(eq(memoryRecords.id, row.id))
            .returning();
          await insertReviewEvent(tx, caller, row, { action: "approve", fromStatus: "unreviewed", toStatus: "approved", reason: input.reason, now });
          return next!;
        });
        if (!confirmed) await stale("stale_version");
        await logOperation(caller, operation, "ok", { ...audit, detail: { supersededRecordId: current?.id ?? null } });
        return { record: toRecord(confirmed!, scope) };
      }

      case "edit_and_confirm": {
        const title = input.title === undefined ? row.title : input.title || null;
        // Same check as contribute: a refused value reaches no table and no engine (GRE-868).
        const matchedTypes = detectSensitiveContent([title, input.content].filter(Boolean).join("\n"));
        if (matchedTypes.length > 0) {
          await logOperation(caller, operation, "denied", { ...audit, detail: { reason: MEMORY_SENSITIVE_CONTENT_CODE, matchedTypes } });
          throw new MemorySensitiveContentError(matchedTypes);
        }
        const settings = await gateway.getSettings(caller.companyId);
        const result = await db.transaction(async (tx) => {
          const claimed = await claim(tx, row, input.expectedVersion, now);
          if (!claimed) return null;
          // The new version is the editor's own proposal, back in the queue.
          const [inserted] = await tx
            .insert(memoryRecords)
            .values({
              companyId: row.companyId,
              scopeId: row.scopeId,
              kind: row.kind,
              status: "unreviewed",
              entryType: row.entryType,
              decisionClass: row.decisionClass,
              sensitivity: row.sensitivity,
              title,
              content: input.content,
              entities: row.entities,
              topics: row.topics,
              contributorAgentId: caller.agentId,
              contributorUserId: caller.userId,
              runId: caller.runId,
              sourceKind: row.sourceKind,
              sourceId: row.sourceId,
              evidence: row.evidence,
              effectiveFrom: row.effectiveFrom,
              effectiveTo: row.effectiveTo,
              supersedesId: row.id,
              version: row.version + 1,
              retainMode: settings.retainMode,
              syncState: "pending",
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          const [old] = await tx
            .update(memoryRecords)
            .set({ status: "superseded", supersededById: inserted!.id, supersededAt: now, reviewedAt: now, updatedAt: now })
            .where(eq(memoryRecords.id, row.id))
            .returning();
          // Open challenges travel with the proposal.
          await tx
            .update(memoryConflicts)
            .set({ recordId: inserted!.id })
            .where(and(eq(memoryConflicts.recordId, row.id), eq(memoryConflicts.state, "open")));
          await enqueueMemoryIngest(tx, {
            companyId: row.companyId,
            recordId: inserted!.id,
            op: "retain",
            payload: memoryEngineDocument(inserted!, scope, settings.retainMode) as unknown as Record<string, unknown>,
            now,
          });
          await insertReviewEvent(tx, caller, row, { action: "edit", fromStatus: "unreviewed", toStatus: "superseded", reason: input.reason, relatedRecordId: inserted!.id, now });
          await insertReviewEvent(tx, caller, inserted!, { action: "contribute", toStatus: "unreviewed", reason: input.reason, relatedRecordId: row.id, now });
          await flagPossibleConflicts(tx, caller, inserted!, now);
          return { old: old!, inserted: inserted! };
        });
        if (!result) await stale("stale_version");
        await logOperation(caller, operation, "ok", { ...audit, detail: { newRecordId: result!.inserted.id } });
        return { record: toRecord(result!.old, scope), newRecord: toRecord(result!.inserted, scope) };
      }

      case "reject": {
        const rejected = await db.transaction(async (tx) => {
          const claimed = await claim(tx, row, input.expectedVersion, now);
          if (!claimed) return null;
          const [next] = await tx
            .update(memoryRecords)
            .set({ status: "disputed", reviewedAt: now, updatedAt: now })
            .where(eq(memoryRecords.id, row.id))
            .returning();
          await resolveOpenConflicts(tx, caller, row.id, "keep_approved", input.reason, now);
          await insertReviewEvent(tx, caller, row, { action: "reject", fromStatus: "unreviewed", toStatus: "disputed", reason: input.reason, now });
          return next!;
        });
        if (!rejected) await stale("stale_version");
        await logOperation(caller, operation, "ok", audit);
        return { record: toRecord(rejected!, scope) };
      }

      case "merge": {
        if (input.intoRecordId === row.id) throw badRequest("A card cannot be merged into itself.");
        const target = await db
          .select()
          .from(memoryRecords)
          .where(and(eq(memoryRecords.id, input.intoRecordId), eq(memoryRecords.companyId, caller.companyId)))
          .then((rows) => rows[0] ?? null);
        if (!target || target.scopeId !== row.scopeId) {
          await logOperation(caller, operation, "denied", { ...audit, detail: { reason: "target_not_in_scope" } });
          throw badRequest("Merge into a card in the same scope.");
        }
        if (!["approved", "unreviewed"].includes(target.status)) throw conflict(`A ${target.status} card cannot take a merge.`);
        const merged = await db.transaction(async (tx) => {
          const claimed = await claim(tx, row, input.expectedVersion, now);
          if (!claimed) return null;
          const [next] = await tx
            .update(memoryRecords)
            .set({ status: "superseded", supersededById: target.id, supersededAt: now, reviewedAt: now, updatedAt: now })
            .where(eq(memoryRecords.id, row.id))
            .returning();
          await resolveOpenConflicts(tx, caller, row.id, "proposal_merged", input.reason, now);
          await insertRelationship(tx, caller, row, target, { type: "same_subject", note: input.reason, sourceKind: null, sourceId: null, now });
          await insertReviewEvent(tx, caller, row, { action: "merge", fromStatus: "unreviewed", toStatus: "superseded", reason: input.reason, relatedRecordId: target.id, now });
          return next!;
        });
        if (!merged) await stale("stale_version");
        await logOperation(caller, operation, "ok", { ...audit, detail: { intoRecordId: target.id } });
        return { record: toRecord(merged!, scope) };
      }
    }
  }

  function toSteward(scope: ScopeRow, row: StewardRow | undefined, ownerId: string | null): MemoryScopeSteward {
    const ownerOnly = isHardBoundary(scope.kind);
    return {
      scopeId: scope.id,
      scopeName: scope.name,
      scopeKind: scope.kind as MemoryScopeKind,
      ownerOnly,
      primaryUserId: ownerOnly ? ownerId : (row?.primaryUserId ?? null),
      backupUserId: ownerOnly ? null : (row?.backupUserId ?? null),
    };
  }

  async function listStewards(caller: MemoryCaller): Promise<{ scopes: MemoryScopeSteward[] }> {
    await gateway.assertEnabled(caller.companyId);
    const access = await accessFor(caller);
    const stewards = await loadStewards(caller.companyId);
    const ownerId = await ownerUserId(caller.companyId);
    const scopes = (await db.select().from(memoryScopes).where(eq(memoryScopes.companyId, caller.companyId)).orderBy(asc(memoryScopes.createdAt))).filter(
      (scope) => canSee(access, caller, scope, stewards),
    );
    await logOperation(caller, "stewards_list", "ok", { scopeIds: scopes.map((scope) => scope.id) });
    return { scopes: scopes.map((scope) => toSteward(scope, stewards.get(scope.id), ownerId)) };
  }

  async function setSteward(caller: MemoryCaller, scopeId: string, input: SetMemoryScopeSteward): Promise<MemoryScopeSteward> {
    const operation = "steward_set";
    await gateway.assertEnabled(caller.companyId);
    if (caller.actorType !== "user" || !caller.isBoardAdmin || !caller.userId) await refuse(caller, operation, "not_owner_or_admin", { scopeIds: [scopeId] });
    const scope = await loadScope(caller.companyId, scopeId);
    if (!scope) throw notFound("Memory scope not found");
    const audit = { scopeIds: [scope.id] };
    if (scope.kind === "agent") throw badRequest("Agent working notes have no steward.");
    if (isHardBoundary(scope.kind)) await refuse(caller, operation, "owner_only_scope", audit);
    if (input.primaryUserId && input.primaryUserId === input.backupUserId) throw badRequest("The backup must be a different person from the primary steward.");
    const named = [input.primaryUserId, input.backupUserId].filter((id): id is string => Boolean(id));
    if (named.length > 0) {
      const members = new Set(
        (
          await db
            .select({ id: companyMemberships.principalId })
            .from(companyMemberships)
            .where(
              and(
                eq(companyMemberships.companyId, caller.companyId),
                eq(companyMemberships.principalType, "user"),
                eq(companyMemberships.status, "active"),
                inArray(companyMemberships.principalId, named),
              ),
            )
        ).map((member) => member.id),
      );
      const outsiders = named.filter((id) => !members.has(id));
      if (outsiders.length > 0) {
        await logOperation(caller, operation, "denied", { ...audit, detail: { reason: "not_a_member" } });
        throw badRequest("A steward must be a person in this company.");
      }
    }
    const now = new Date();
    const values = { primaryUserId: input.primaryUserId, backupUserId: input.backupUserId, setByUserId: caller.userId!, setAt: now };
    const [row] = await db
      .insert(memoryScopeStewards)
      .values({ companyId: caller.companyId, scopeId: scope.id, ...values })
      .onConflictDoUpdate({ target: memoryScopeStewards.scopeId, set: values })
      .returning();
    await logOperation(caller, operation, "ok", { ...audit, detail: { primaryUserId: input.primaryUserId, backupUserId: input.backupUserId } });
    return toSteward(scope, row, null);
  }

  return { reviewQueue, act, listStewards, setSteward };
}

export type MemoryStewardService = ReturnType<typeof memoryStewardService>;
