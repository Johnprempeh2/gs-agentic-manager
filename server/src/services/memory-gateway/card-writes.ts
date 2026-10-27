import { and, eq, or } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { memoryConflicts, memoryRecords, memoryScopeStewards } from "@greatstone/db";
import type {
  MemoryRecord,
  MemoryReviseResult,
  MemoryStewardActionResult,
  RetireMemoryRecord,
  ReviseMemoryRecord,
} from "@greatstone/shared";
import { conflict, forbidden } from "../../errors.js";
import { enqueueMemoryIngest } from "./ingest-outbox-db.js";
import {
  flagPossibleConflicts,
  insertRelationship,
  insertReviewEvent,
  loadChainAuthorLinks,
  loadEditChain,
  possibleConflictTerms,
} from "./review-store.js";
import type { MemoryReviewService } from "./review.js";
import { detectSensitiveContent, MEMORY_SENSITIVE_CONTENT_CODE, MemorySensitiveContentError } from "./sensitive-content.js";
import type { MemoryStewardService } from "./steward-actions.js";
import {
  isExternalApp,
  isHardBoundary,
  memoryEngineDocument,
  toRecord,
  type MemoryCaller,
  type MemoryGatewayService,
  type RecordRow,
  type ScopeRow,
} from "./service.js";

// Shared memory M2 (GRE-1081, deck v7 slide 22): revise, confirm, dispute and
// retire. Each one sends the version the caller saw; a card that changed since
// refuses the call, so nothing is overwritten silently. Revise is a proposal:
// it never changes what is confirmed until a person confirms the new version.
// An app outside GSAM may revise; it never confirms, disputes or retires.

const CARD_REFUSALS = {
  no_contribute_right: "You do not have the right to add to this scope.",
  not_yours_to_revise: "Only the person who proposed this card, or a reviewer of it, can revise it while it waits for review.",
  no_retire_right: "Only a reviewer or the steward of this scope can retire this card.",
} as const;
type CardRefusal = keyof typeof CARD_REFUSALS;

export function memoryCardService(db: Db, gateway: MemoryGatewayService, reviews: MemoryReviewService, stewards: MemoryStewardService) {
  const { logOperation } = gateway.internals;
  const { loadReadable, refuseStale, refuse: refuseReview, reviewRefusal } = reviews.internals;

  async function refuse(caller: MemoryCaller, operation: string, refusal: CardRefusal, audit: { scopeIds: string[]; recordId: string }): Promise<never> {
    await logOperation(caller, operation, "denied", { ...audit, detail: { reason: refusal } });
    throw forbidden(CARD_REFUSALS[refusal]);
  }

  /** Whether the caller, or the person their app acts for, wrote any version of this proposal. */
  async function wroteAnyVersion(caller: MemoryCaller, person: string | null, row: RecordRow) {
    const chain = (await loadEditChain(db, caller.companyId, row)) ?? [row];
    const links = await loadChainAuthorLinks(db, caller.companyId, chain);
    return chain.some(
      (version) =>
        (version.contributorAgentId !== null && version.contributorAgentId === caller.agentId) ||
        (person !== null &&
          (version.contributorUserId === person ||
            (version.contributorAgentId !== null && links.people.get(version.contributorAgentId) === person))),
    );
  }

  async function isStewardOf(caller: MemoryCaller, scope: ScopeRow) {
    if (caller.actorType !== "user" || !caller.userId || isHardBoundary(scope.kind)) return false;
    const steward = await db
      .select()
      .from(memoryScopeStewards)
      .where(and(eq(memoryScopeStewards.companyId, caller.companyId), eq(memoryScopeStewards.scopeId, scope.id)))
      .then((rows) => rows[0] ?? null);
    return steward !== null && (steward.primaryUserId === caller.userId || steward.backupUserId === caller.userId);
  }

  /**
   * A new version of a card, waiting for review. A proposal still waiting is
   * replaced by the new version, as an edit; a confirmed card stays in force
   * and the new version challenges it, so confirming it replaces the card.
   */
  async function revise(
    caller: MemoryCaller,
    recordId: string,
    input: ReviseMemoryRecord,
    /** The sync route (GRE-2668) only: the new version's own source details and date. */
    replace: { evidence?: Record<string, unknown> | null; effectiveFrom?: Date | null } = {},
  ): Promise<MemoryReviseResult> {
    const operation = "revise";
    const { row, scope, access } = await loadReadable(caller, recordId, operation);
    const audit = { scopeIds: [scope.id], recordId: row.id };
    if (!access.canContribute(scope)) await refuse(caller, operation, "no_contribute_right", audit);
    if (input.expectedVersion !== row.version) await refuseStale(caller, operation, audit, input.expectedVersion, row);
    if (row.status !== "unreviewed" && row.status !== "approved") throw conflict(`A ${row.status} card cannot be revised`);
    if (row.status === "unreviewed" && !(await wroteAnyVersion(caller, access.person, row))) {
      if ((await reviewRefusal(caller, access, scope, row.decisionClass)) !== null) {
        await refuse(caller, operation, "not_yours_to_revise", audit);
      }
    }
    const title = input.title === undefined ? row.title : input.title || null;
    // Same check as contribute: a refused value reaches no table and no engine (GRE-868).
    const matchedTypes = detectSensitiveContent([title, input.content].filter(Boolean).join("\n"));
    if (matchedTypes.length > 0) {
      await logOperation(caller, operation, "denied", { ...audit, detail: { reason: MEMORY_SENSITIVE_CONTENT_CODE, matchedTypes } });
      throw new MemorySensitiveContentError(matchedTypes);
    }
    const settings = await gateway.getSettings(caller.companyId);
    const now = new Date();
    const replacesProposal = row.status === "unreviewed";

    const result = await db.transaction(async (tx) => {
      // Takes the card at the version the caller saw. A confirmed card is not changed, only held.
      const [held] = await tx
        .update(memoryRecords)
        .set(replacesProposal ? { updatedAt: now } : { version: row.version })
        .where(and(eq(memoryRecords.id, row.id), eq(memoryRecords.version, input.expectedVersion), eq(memoryRecords.status, row.status)))
        .returning();
      if (!held) return null;
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
          evidence: replace.evidence === undefined ? row.evidence : replace.evidence,
          effectiveFrom: replace.effectiveFrom === undefined ? row.effectiveFrom : replace.effectiveFrom,
          effectiveTo: row.effectiveTo,
          supersedesId: replacesProposal ? row.id : null,
          version: row.version + 1,
          retainMode: settings.retainMode,
          syncState: "pending",
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      let card = held;
      if (replacesProposal) {
        [card] = await tx
          .update(memoryRecords)
          .set({ status: "superseded", supersededById: inserted!.id, supersededAt: now, updatedAt: now })
          .where(eq(memoryRecords.id, row.id))
          .returning();
        // Open challenges travel with the proposal.
        await tx
          .update(memoryConflicts)
          .set({ recordId: inserted!.id })
          .where(and(eq(memoryConflicts.recordId, row.id), eq(memoryConflicts.state, "open")));
        await insertReviewEvent(tx, caller, row, { action: "edit", fromStatus: "unreviewed", toStatus: "superseded", reason: input.reason, relatedRecordId: inserted!.id, now });
        await insertReviewEvent(tx, caller, inserted!, { action: "contribute", toStatus: "unreviewed", reason: input.reason, relatedRecordId: row.id, now });
      } else {
        await insertReviewEvent(tx, caller, inserted!, { action: "contribute", toStatus: "unreviewed", reason: input.reason, relatedRecordId: row.id, now });
        await insertRelationship(tx, caller, inserted!, row, { type: "refines", note: input.reason, sourceKind: null, sourceId: null, now });
        // The confirmed card it would replace, side by side in the review queue (GRE-1080).
        const [opened] = await tx
          .insert(memoryConflicts)
          .values({
            companyId: row.companyId,
            scopeId: row.scopeId,
            recordId: inserted!.id,
            approvedRecordId: row.id,
            origin: "revision",
            sharedTerms: possibleConflictTerms(inserted!, row),
            detectedAt: now,
          })
          .onConflictDoNothing({ target: [memoryConflicts.recordId, memoryConflicts.approvedRecordId] })
          .returning();
        if (opened) {
          await insertReviewEvent(tx, caller, inserted!, { action: "conflict_flagged", reason: "A new version of a confirmed card", relatedRecordId: row.id, now });
        }
      }
      await enqueueMemoryIngest(tx, {
        companyId: row.companyId,
        recordId: inserted!.id,
        op: "retain",
        payload: memoryEngineDocument(inserted!, scope, settings.retainMode) as unknown as Record<string, unknown>,
        now,
      });
      await flagPossibleConflicts(tx, caller, inserted!, now);
      return { card: card!, inserted: inserted! };
    });
    if (!result) await refuseStale(caller, operation, audit, input.expectedVersion, row);
    await logOperation(caller, operation, "ok", { ...audit, detail: { newRecordId: result!.inserted.id, from: row.status } });
    return { record: toRecord(result!.card, scope), newRecord: toRecord(result!.inserted, scope) };
  }

  /** No longer true. The card stays readable as history and ranks last. */
  async function retire(caller: MemoryCaller, recordId: string, input: RetireMemoryRecord): Promise<MemoryRecord> {
    const operation = "retire";
    const { row, scope, access } = await loadReadable(caller, recordId, operation);
    const audit = { scopeIds: [scope.id], recordId: row.id };
    const refusal = await reviewRefusal(caller, access, scope, row.decisionClass);
    if (refusal === "external_app" || refusal === "working_notes" || refusal === "owner_only") await refuseReview(caller, operation, refusal, audit);
    if (refusal !== null && !(await isStewardOf(caller, scope))) await refuse(caller, operation, "no_retire_right", audit);
    if (input.expectedVersion !== row.version) await refuseStale(caller, operation, audit, input.expectedVersion, row);
    if (row.status !== "approved" && row.status !== "disputed") {
      throw conflict(
        row.status === "unreviewed" ? "A card waiting for review is rejected, not retired." : `A ${row.status} card cannot be retired`,
      );
    }
    const now = new Date();
    const retired = await db.transaction(async (tx) => {
      const [next] = await tx
        .update(memoryRecords)
        .set({ status: "retired", version: row.version + 1, effectiveTo: row.effectiveTo ?? now, reviewedAt: now, updatedAt: now })
        .where(and(eq(memoryRecords.id, row.id), eq(memoryRecords.version, input.expectedVersion), eq(memoryRecords.status, row.status)))
        .returning();
      if (!next) return null;
      // A retired card is no longer a position to challenge or to hold.
      await tx
        .update(memoryConflicts)
        .set({
          state: "resolved",
          resolution: "record_retired",
          resolutionNote: input.reason,
          resolvedByActorType: caller.actorType,
          resolvedByActorId: caller.actorId,
          resolvedAt: now,
        })
        .where(and(eq(memoryConflicts.state, "open"), or(eq(memoryConflicts.recordId, row.id), eq(memoryConflicts.approvedRecordId, row.id))));
      await insertReviewEvent(tx, caller, row, { action: "retire", fromStatus: row.status, toStatus: "retired", reason: input.reason, now });
      return next;
    });
    if (!retired) await refuseStale(caller, operation, audit, input.expectedVersion, row);
    await logOperation(caller, operation, "ok", { ...audit, detail: { from: row.status } });
    return toRecord(retired!, scope);
  }

  /** Confirm a proposal at the version the caller saw: the steward confirm, with all its checks. */
  async function confirm(caller: MemoryCaller, recordId: string, input: { expectedVersion: number; reason: string }): Promise<MemoryStewardActionResult> {
    return stewards.act(caller, recordId, { action: "confirm", expectedVersion: input.expectedVersion, reason: input.reason });
  }

  /**
   * Reject a proposal, or dispute a confirmed card, at the version the caller
   * saw. A proposal goes through the steward reject; a confirmed card through
   * the review dispute.
   */
  async function dispute(caller: MemoryCaller, recordId: string, input: { expectedVersion: number; reason: string }): Promise<MemoryRecord> {
    const { row } = await loadReadable(caller, recordId, "dispute");
    if (row.status === "unreviewed") {
      return (await stewards.act(caller, recordId, { action: "reject", expectedVersion: input.expectedVersion, reason: input.reason })).record;
    }
    return reviews.review(caller, recordId, { action: "dispute", expectedVersion: input.expectedVersion, reason: input.reason });
  }

  return { revise, retire, confirm, dispute };
}

export type MemoryCardService = ReturnType<typeof memoryCardService>;
