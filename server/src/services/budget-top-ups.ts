import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { approvals, budgetPolicies, budgetTopUps, financeEvents } from "@greatstone/db";
import {
  BUDGET_TOP_UP_APPROVAL_TYPE,
  TOP_UP_APPROVER_REQUIRED_ERROR_CODE,
  TOP_UP_REQUESTER_NOT_ALLOWED_ERROR_CODE,
  type BudgetAuthority,
  type BudgetTopUp,
  type BudgetTopUpApproval,
  type BudgetTopUpKind,
  type BudgetTopUpStatus,
  type BudgetTopUpWindow,
  type RecordBudgetPreAuthorisation,
  type RequestBudgetTopUp,
  type TopUpApprovalRule,
  type TopUpApprovalSide,
} from "@greatstone/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { publishActivity, logActivity, type ActivityPublication } from "./activity-log.js";
import { readAiAccessRoute } from "./ai-access-route.js";
import { budgetAuthorityService, isTopUpOperatorSide, type SpendingActor } from "./budget-authority.js";
import { appliedTopUpCents, budgetService, topUpWindowStartOn, type BudgetServiceHooks } from "./budgets.js";
import { instanceSettingsService } from "./instance-settings.js";

/**
 * Budget top-ups and pre-authorised extra ceilings (GRE-1371, B3 on GRE-1357).
 *
 * A top-up adds its amount to one month's AI allowance and company cap. Who
 * must accept it is a setting per AI route (`topUpApprovalByRoute` on the
 * spending authority). The requester counts for their own side. A missing
 * operator side is met by a pre-authorised ceiling with headroom left;
 * otherwise the request waits on an approval card for the missing side, and
 * nothing changes until that side accepts (AT-1.6).
 *
 * Every write is one transaction: the ledger row, its `finance_events` row
 * and its activity row land together or not at all (AT-1.5, AT-2.4). Writes
 * for one company take one advisory lock, so two requests cannot both spend
 * the same pre-authorised headroom.
 */
export type TopUpActor = SpendingActor & {
  /** A company owner or admin: the client side. */
  clientAdmin: boolean;
};

type TopUpRow = typeof budgetTopUps.$inferSelect;

/** With no rule set for the route, or no route, the operator side accepts. */
const RULE_WHEN_UNSET: TopUpApprovalRule = "operator";

const SIDES_FOR_RULE: Record<TopUpApprovalRule, TopUpApprovalSide[]> = {
  operator: ["operator"],
  client: ["client"],
  operator_and_client: ["operator", "client"],
};

export function topUpRuleFor(authority: BudgetAuthority, route: string | null): TopUpApprovalRule {
  return (route ? authority.topUpApprovalByRoute[route] : undefined) ?? RULE_WHEN_UNSET;
}

/** The sides an actor can accept for. The operator stands for both. */
export function topUpSidesOf(authority: BudgetAuthority, actor: TopUpActor): TopUpApprovalSide[] {
  const sides: TopUpApprovalSide[] = [];
  if (isTopUpOperatorSide(authority, actor)) sides.push("operator");
  if (actor.operator || actor.clientAdmin) sides.push("client");
  return sides;
}

export function canDecideTopUp(authority: BudgetAuthority, actor: TopUpActor, awaitingSide: TopUpApprovalSide | null) {
  return awaitingSide !== null && topUpSidesOf(authority, actor).includes(awaitingSide);
}

function toTopUp(row: TopUpRow): BudgetTopUp {
  return {
    id: row.id,
    companyId: row.companyId,
    kind: row.kind as BudgetTopUpKind,
    status: row.status as BudgetTopUpStatus,
    amountCents: row.amountCents,
    windowStart: row.windowStart,
    effectiveFrom: row.effectiveFrom?.toISOString() ?? null,
    reason: row.reason,
    requestedByUserId: row.requestedByUserId ?? null,
    approvedByUserId: row.approvedByUserId ?? null,
    approvals: (row.approvals ?? []) as BudgetTopUpApproval[],
    approvalRule: (row.approvalRule ?? null) as TopUpApprovalRule | null,
    awaitingSide: (row.awaitingSide ?? null) as TopUpApprovalSide | null,
    preAuthorisationId: row.preAuthorisationId ?? null,
    approvalId: row.approvalId ?? null,
    invoiceReference: row.invoiceReference ?? null,
    financeEventId: row.financeEventId ?? null,
    decisionNote: row.decisionNote ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function lockCompany(tx: Db, companyId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`budget-top-up:${companyId}`}, 0))`);
}

/** The company's monthly cap in force before top-ups; null when it has none. */
async function companyCapCents(db: Db, companyId: string, now: Date): Promise<number | null> {
  const policy = await db
    .select()
    .from(budgetPolicies)
    .where(
      and(
        eq(budgetPolicies.companyId, companyId),
        eq(budgetPolicies.scopeType, "company"),
        eq(budgetPolicies.scopeId, companyId),
        eq(budgetPolicies.metric, "billed_cents"),
        eq(budgetPolicies.windowKind, "calendar_month_utc"),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!policy) return null;
  const due = policy.pendingAmount != null && policy.pendingEffectiveFrom && policy.pendingEffectiveFrom <= now;
  const amount = due ? policy.pendingAmount! : policy.amount;
  const active = due ? amount > 0 : policy.isActive;
  return active && amount > 0 ? amount : null;
}

/** Headroom before and after a top-up, as the audit row records it. */
async function headroom(db: Db, companyId: string, now: Date) {
  const [topUpTotalCents, cap] = await Promise.all([appliedTopUpCents(db, companyId, now), companyCapCents(db, companyId, now)]);
  return { topUpTotalCents, capCents: cap === null ? null : cap + topUpTotalCents };
}

/** Pre-authorised ceilings of one month with the headroom each has left, oldest first. */
async function preAuthorisationsOf(db: Db, companyId: string, windowStart: string) {
  const rows = await db
    .select()
    .from(budgetTopUps)
    .where(
      and(
        eq(budgetTopUps.companyId, companyId),
        eq(budgetTopUps.windowStart, windowStart),
        eq(budgetTopUps.kind, "pre_authorisation"),
        eq(budgetTopUps.status, "applied"),
      ),
    )
    .orderBy(asc(budgetTopUps.createdAt), asc(budgetTopUps.id));
  if (rows.length === 0) return [];
  const used = await db
    .select({
      preAuthorisationId: budgetTopUps.preAuthorisationId,
      total: sql<number>`coalesce(sum(${budgetTopUps.amountCents}), 0)::double precision`,
    })
    .from(budgetTopUps)
    .where(
      and(
        eq(budgetTopUps.companyId, companyId),
        eq(budgetTopUps.kind, "top_up"),
        eq(budgetTopUps.status, "applied"),
        inArray(budgetTopUps.preAuthorisationId, rows.map((row) => row.id)),
      ),
    )
    .groupBy(budgetTopUps.preAuthorisationId);
  const usedBy = new Map(used.map((row) => [row.preAuthorisationId, Number(row.total)]));
  return rows.map((row) => ({ row, remainingCents: Math.max(0, row.amountCents - (usedBy.get(row.id) ?? 0)) }));
}

export function budgetTopUpService(db: Db, hooks: BudgetServiceHooks = {}) {
  const authority = budgetAuthorityService(db);
  const budgets = budgetService(db, hooks);
  const settings = instanceSettingsService(db);

  async function currentRule(companyAuthority: BudgetAuthority) {
    return topUpRuleFor(companyAuthority, readAiAccessRoute(await settings.getGeneral()));
  }

  /**
   * Write an applied top-up's effect, in the caller's transaction: the
   * `finance_events` row and the `budget.top_up_recorded` activity row.
   */
  async function recordApplied(
    tx: Db,
    row: TopUpRow,
    input: { actorUserId: string; before: { topUpTotalCents: number; capCents: number | null }; now: Date },
    publications: ActivityPublication[],
  ) {
    const preAuthorised = row.preAuthorisationId !== null;
    const [event] = await tx
      .insert(financeEvents)
      .values({
        companyId: row.companyId,
        eventKind: "allowance_top_up",
        direction: "debit",
        biller: "hosting_operator",
        amountCents: row.amountCents,
        currency: "USD",
        externalInvoiceId: row.invoiceReference,
        description: row.reason,
        metadataJson: {
          topUpId: row.id,
          windowStart: row.windowStart,
          approvedByUserId: row.approvedByUserId,
          requestedByUserId: row.requestedByUserId,
          approvalRule: row.approvalRule,
          approvalBasis: preAuthorised ? "pre-authorised" : "approved",
          // Not "preAuthorisationId": the activity log redacts keys that contain "auth".
          extraCeilingId: row.preAuthorisationId,
        },
        occurredAt: input.now,
      })
      .returning({ id: financeEvents.id });
    await tx.update(budgetTopUps).set({ financeEventId: event!.id }).where(eq(budgetTopUps.id, row.id));
    const after = await headroom(tx, row.companyId, input.now);
    await logActivity(tx, {
      companyId: row.companyId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "budget.top_up_recorded",
      entityType: "budget_top_up",
      entityId: row.id,
      details: {
        oldValue: input.before,
        newValue: after,
        effectiveFrom: input.now.toISOString(),
        reason: row.reason,
        amountCents: row.amountCents,
        windowStart: row.windowStart,
        approvedByUserId: row.approvedByUserId,
        requestedByUserId: row.requestedByUserId,
        approvalRule: row.approvalRule,
        approvalBasis: preAuthorised ? "pre-authorised" : "approved",
        extraCeilingId: row.preAuthorisationId,
        approvalId: row.approvalId,
        invoiceReference: row.invoiceReference,
        financeEventId: event!.id,
      },
    }, publications);
    return { ...row, financeEventId: event!.id };
  }

  /** After a top-up is in force: resume a company stopped at its cap and wake its held tasks. */
  async function afterApplied(companyId: string, actorUserId: string) {
    await budgets.reconcileCompanyCap(companyId, actorUserId);
  }

  async function inTransaction<T>(companyId: string, work: (tx: Db, publications: ActivityPublication[]) => Promise<T>) {
    const publications: ActivityPublication[] = [];
    const result = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await lockCompany(tx, companyId);
      return work(tx, publications);
    });
    for (const publication of publications) publishActivity(publication);
    return result;
  }

  /**
   * Apply a pending top-up once its approval is decided. Guarded on
   * `pending`, so a repeat, the sweep and the approval route racing each
   * other apply it one time.
   */
  async function settleDecided(
    topUpId: string,
    decision: { approved: boolean; decidedByUserId: string; decisionNote: string | null; decidedAt: Date },
  ): Promise<{ topUp: BudgetTopUp; changed: boolean } | null> {
    const existing = await db.select().from(budgetTopUps).where(eq(budgetTopUps.id, topUpId)).then((rows) => rows[0] ?? null);
    if (!existing) return null;
    const now = decision.decidedAt;
    const settled = await inTransaction(existing.companyId, async (tx, publications) => {
      const before = await headroom(tx, existing.companyId, now);
      const approvalsSoFar = (existing.approvals ?? []) as BudgetTopUpApproval[];
      const [row] = await tx
        .update(budgetTopUps)
        .set(
          decision.approved
            ? {
              status: "applied",
              approvedByUserId: decision.decidedByUserId,
              approvals: [
                ...approvalsSoFar,
                { side: existing.awaitingSide ?? "operator", userId: decision.decidedByUserId, at: now.toISOString() },
              ],
              awaitingSide: null,
              // A top-up counts in the month it is accepted in.
              windowStart: topUpWindowStartOn(now),
              effectiveFrom: now,
              decisionNote: decision.decisionNote,
              decidedAt: now,
              updatedAt: now,
            }
            : {
              status: "rejected",
              awaitingSide: null,
              decisionNote: decision.decisionNote,
              decidedAt: now,
              updatedAt: now,
            },
        )
        .where(and(eq(budgetTopUps.id, topUpId), eq(budgetTopUps.status, "pending")))
        .returning();
      if (!row) return null;
      if (!decision.approved) {
        await logActivity(tx, {
          companyId: row.companyId,
          actorType: "user",
          actorId: decision.decidedByUserId,
          action: "budget.top_up_rejected",
          entityType: "budget_top_up",
          entityId: row.id,
          details: {
            oldValue: before,
            newValue: before,
            effectiveFrom: null,
            reason: row.reason,
            decisionNote: decision.decisionNote,
            amountCents: row.amountCents,
            approvalId: row.approvalId,
          },
        }, publications);
        return row;
      }
      return recordApplied(tx, row, { actorUserId: decision.decidedByUserId, before, now }, publications);
    });
    if (!settled) {
      const current = await db.select().from(budgetTopUps).where(eq(budgetTopUps.id, topUpId)).then((rows) => rows[0]!);
      return { topUp: toTopUp(current), changed: false };
    }
    if (decision.approved) await afterApplied(settled.companyId, decision.decidedByUserId);
    return { topUp: toTopUp(settled), changed: true };
  }

  return {
    async window(companyId: string, now: Date, windowStart = topUpWindowStartOn(now)): Promise<BudgetTopUpWindow> {
      const [entries, preAuthorisations, companyAuthority] = await Promise.all([
        db
          .select()
          .from(budgetTopUps)
          .where(and(eq(budgetTopUps.companyId, companyId), eq(budgetTopUps.windowStart, windowStart)))
          .orderBy(desc(budgetTopUps.createdAt), desc(budgetTopUps.id)),
        preAuthorisationsOf(db, companyId, windowStart),
        authority.get(companyId),
      ]);
      return {
        companyId,
        windowStart,
        topUpTotalCents: entries
          .filter((row) => row.kind === "top_up" && row.status === "applied")
          .reduce((sum, row) => sum + row.amountCents, 0),
        preAuthorisedCents: preAuthorisations.reduce((sum, entry) => sum + entry.row.amountCents, 0),
        preAuthorisedRemainingCents: preAuthorisations.reduce((sum, entry) => sum + entry.remainingCents, 0),
        approvalRule: await currentRule(companyAuthority),
        entries: entries.map(toTopUp),
      };
    },

    /**
     * Ask for a top-up of this month. Applies at once when the requester (and
     * a pre-authorised ceiling, for the operator side) meet every side the
     * rule needs; otherwise opens one approval card for the missing side.
     */
    async request(companyId: string, input: RequestBudgetTopUp, actor: TopUpActor, now: Date) {
      const companyAuthority = await authority.get(companyId);
      const sides = topUpSidesOf(companyAuthority, actor);
      if (sides.length === 0) {
        throw forbidden("Only a company owner or admin, a named budget approver or the operator can ask for a top-up.", {
          code: TOP_UP_REQUESTER_NOT_ALLOWED_ERROR_CODE,
        });
      }
      const rule = await currentRule(companyAuthority);
      const required = SIDES_FOR_RULE[rule];
      const requesterId = actor.userId ?? "board";
      const windowStart = topUpWindowStartOn(now);

      const outcome = await inTransaction(companyId, async (tx, publications) => {
        const given: BudgetTopUpApproval[] = required
          .filter((side) => sides.includes(side))
          .map((side) => ({ side, userId: requesterId, at: now.toISOString() }));
        let missing = required.filter((side) => !sides.includes(side));
        let preAuthorisation: TopUpRow | null = null;
        if (missing.includes("operator")) {
          // The oldest ceiling with room for the whole amount. A top-up is never split across two.
          const found = (await preAuthorisationsOf(tx, companyId, windowStart)).find((entry) => entry.remainingCents >= input.amountCents);
          if (found) {
            preAuthorisation = found.row;
            given.push({ side: "operator", userId: found.row.approvedByUserId ?? "board", at: now.toISOString() });
            missing = missing.filter((side) => side !== "operator");
          }
        }
        const before = await headroom(tx, companyId, now);
        const base = {
          companyId,
          kind: "top_up",
          amountCents: input.amountCents,
          windowStart,
          reason: input.reason,
          requestedByUserId: requesterId,
          approvals: given,
          approvalRule: rule,
          preAuthorisationId: preAuthorisation?.id ?? null,
          invoiceReference: input.invoiceReference ?? null,
        };

        if (missing.length === 0) {
          const approver = preAuthorisation?.approvedByUserId ?? requesterId;
          const [row] = await tx
            .insert(budgetTopUps)
            .values({ ...base, status: "applied", approvedByUserId: approver, effectiveFrom: now, decidedAt: now })
            .returning();
          return { status: "applied" as const, row: await recordApplied(tx, row!, { actorUserId: requesterId, before, now }, publications) };
        }

        const awaitingSide = missing[0]!;
        const [pending] = await tx
          .insert(budgetTopUps)
          .values({ ...base, status: "pending", awaitingSide })
          .returning();
        const [approval] = await tx
          .insert(approvals)
          .values({
            companyId,
            type: BUDGET_TOP_UP_APPROVAL_TYPE,
            requestedByUserId: requesterId,
            requestedByAgentId: null,
            status: "pending",
            payload: {
              title: `Top-up of ${input.amountCents} cents for ${windowStart.slice(0, 7)}`,
              topUpId: pending!.id,
              amountCents: input.amountCents,
              windowStart,
              reason: input.reason,
              approvalRule: rule,
              awaitingSide,
            },
          })
          .returning();
        const [row] = await tx
          .update(budgetTopUps)
          .set({ approvalId: approval!.id })
          .where(eq(budgetTopUps.id, pending!.id))
          .returning();
        await logActivity(tx, {
          companyId,
          actorType: "user",
          actorId: requesterId,
          action: "budget.top_up_requested",
          entityType: "budget_top_up",
          entityId: row!.id,
          details: {
            oldValue: before,
            newValue: before,
            effectiveFrom: null,
            reason: input.reason,
            amountCents: input.amountCents,
            windowStart,
            approvalRule: rule,
            awaitingSide,
            approvalId: approval!.id,
          },
        }, publications);
        return { status: "pending" as const, row: row!, approval: approval! };
      });

      if (outcome.status === "applied") await afterApplied(companyId, requesterId);
      return outcome.status === "applied"
        ? { status: "applied" as const, topUp: toTopUp(outcome.row) }
        : { status: "pending" as const, topUp: toTopUp(outcome.row), approval: outcome.approval };
    },

    /** Operator side only: room for top-ups in one month that need no further approval. */
    async preAuthorise(companyId: string, input: RecordBudgetPreAuthorisation, actor: TopUpActor, now: Date) {
      const companyAuthority = await authority.get(companyId);
      if (!isTopUpOperatorSide(companyAuthority, actor)) {
        throw forbidden("Only the operator or a named budget approver can pre-authorise top-ups.", {
          code: TOP_UP_APPROVER_REQUIRED_ERROR_CODE,
        });
      }
      const currentWindow = topUpWindowStartOn(now);
      const windowStart = input.windowStart ?? currentWindow;
      if (windowStart < currentWindow) throw unprocessable("A pre-authorised ceiling cannot cover a past month");
      const approverId = actor.userId ?? "board";
      const row = await inTransaction(companyId, async (tx, publications) => {
        const before = await preAuthorisationsOf(tx, companyId, windowStart);
        const remainingBefore = before.reduce((sum, entry) => sum + entry.remainingCents, 0);
        const [inserted] = await tx
          .insert(budgetTopUps)
          .values({
            companyId,
            kind: "pre_authorisation",
            status: "applied",
            amountCents: input.amountCents,
            windowStart,
            effectiveFrom: now,
            reason: input.reason,
            requestedByUserId: approverId,
            approvedByUserId: approverId,
            approvals: [{ side: "operator", userId: approverId, at: now.toISOString() }],
            invoiceReference: input.invoiceReference ?? null,
            decidedAt: now,
          })
          .returning();
        await logActivity(tx, {
          companyId,
          actorType: "user",
          actorId: approverId,
          action: "budget.pre_authorisation_recorded",
          entityType: "budget_top_up",
          entityId: inserted!.id,
          details: {
            oldValue: { preAuthorisedRemainingCents: remainingBefore },
            newValue: { preAuthorisedRemainingCents: remainingBefore + input.amountCents },
            effectiveFrom: now.toISOString(),
            reason: input.reason,
            amountCents: input.amountCents,
            windowStart,
            approvedByUserId: approverId,
            invoiceReference: inserted!.invoiceReference,
          },
        }, publications);
        return inserted!;
      });
      return toTopUp(row);
    },

    /**
     * Operator only: name the invoice line that bills a top-up or ceiling.
     * Sending the same reference again changes nothing; a different one is a
     * conflict, so a billed line is never silently moved.
     */
    async attachInvoice(companyId: string, topUpId: string, invoiceReference: string, actorUserId: string, now: Date) {
      return inTransaction(companyId, async (tx, publications) => {
        const row = await tx
          .select()
          .from(budgetTopUps)
          .where(and(eq(budgetTopUps.id, topUpId), eq(budgetTopUps.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        if (!row) throw notFound("Top-up not found");
        if (row.invoiceReference === invoiceReference) return toTopUp(row);
        if (row.invoiceReference !== null) {
          throw conflict("This top-up is already on another invoice line", { invoiceReference: row.invoiceReference });
        }
        const [updated] = await tx
          .update(budgetTopUps)
          .set({ invoiceReference, updatedAt: now })
          .where(and(eq(budgetTopUps.id, topUpId), isNull(budgetTopUps.invoiceReference)))
          .returning();
        if (updated!.financeEventId) {
          await tx
            .update(financeEvents)
            .set({ externalInvoiceId: invoiceReference })
            .where(eq(financeEvents.id, updated!.financeEventId));
        }
        await logActivity(tx, {
          companyId,
          actorType: "user",
          actorId: actorUserId,
          action: "budget.top_up_invoiced",
          entityType: "budget_top_up",
          entityId: topUpId,
          details: {
            oldValue: { invoiceReference: null },
            newValue: { invoiceReference },
            effectiveFrom: now.toISOString(),
            reason: null,
          },
        }, publications);
        return toTopUp(updated!);
      });
    },

    /** Who may decide the approval card of a pending top-up. */
    async assertCanDecide(approval: { companyId: string; payload: unknown }, actor: TopUpActor) {
      const topUpId = (approval.payload as Record<string, unknown> | null)?.topUpId;
      const row = typeof topUpId === "string"
        ? await db.select().from(budgetTopUps).where(eq(budgetTopUps.id, topUpId)).then((rows) => rows[0] ?? null)
        : null;
      if (!row || row.companyId !== approval.companyId) throw unprocessable("This approval names no top-up");
      const companyAuthority = await authority.get(approval.companyId);
      if (!canDecideTopUp(companyAuthority, actor, row.awaitingSide as TopUpApprovalSide | null)) {
        throw forbidden(`Only the ${row.awaitingSide ?? "awaited"} side can decide this top-up.`, {
          code: TOP_UP_APPROVER_REQUIRED_ERROR_CODE,
          awaitingSide: row.awaitingSide,
        });
      }
    },

    /** The approval route calls this after a `budget_top_up` approval is approved or rejected. */
    async settleApproval(approval: { id: string; status: string; decidedByUserId?: string | null; decisionNote?: string | null }) {
      if (approval.status !== "approved" && approval.status !== "rejected") return null;
      const row = await db.select().from(budgetTopUps).where(eq(budgetTopUps.approvalId, approval.id)).then((rows) => rows[0] ?? null);
      if (!row) return null;
      return settleDecided(row.id, {
        approved: approval.status === "approved",
        decidedByUserId: approval.decidedByUserId ?? "board",
        decisionNote: approval.decisionNote ?? null,
        decidedAt: new Date(),
      });
    },

    /**
     * The sweep: settle each pending top-up whose approval was decided but
     * not applied (the server stopped between the two writes). Without it
     * such a top-up would wait forever on a card nobody can act on again.
     */
    async settleDecidedApprovals() {
      const stranded = await db
        .select({ topUpId: budgetTopUps.id, approval: approvals })
        .from(budgetTopUps)
        .innerJoin(approvals, eq(approvals.id, budgetTopUps.approvalId))
        .where(
          and(
            eq(budgetTopUps.status, "pending"),
            isNotNull(budgetTopUps.approvalId),
            inArray(approvals.status, ["approved", "rejected"]),
          ),
        )
        .limit(100);
      let settled = 0;
      for (const { topUpId, approval } of stranded) {
        const result = await settleDecided(topUpId, {
          approved: approval.status === "approved",
          decidedByUserId: approval.decidedByUserId ?? "board",
          decisionNote: approval.decisionNote ?? null,
          decidedAt: new Date(),
        });
        if (result?.changed) settled += 1;
      }
      return { settled };
    },
  };
}
