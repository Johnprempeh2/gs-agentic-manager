import { and, eq, gt, isNotNull } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { budgetAuthorities, budgetIncidents, budgetPolicies } from "@greatstone/db";
import {
  BUDGET_ABOVE_OPERATOR_CEILING_ERROR_CODE,
  BUDGET_APPROVER_REQUIRED_ERROR_CODE,
  BUDGET_CAP_OPERATOR_MANAGED_ERROR_CODE,
  type BudgetAuthority,
  type BudgetScopeType,
  type BudgetWindowKind,
  type TopUpApprovalRule,
  type UpdateBudgetAuthority,
} from "@greatstone/shared";
import { forbidden } from "../errors.js";
import { logActivity } from "./activity-log.js";

/**
 * Spending authority (GRE-1363). The hosting operator (an instance admin, or
 * the implicit local board) sets a ceiling and named override approvers per
 * company. Everyone else, the client board included, works inside them.
 */
export type SpendingActor = {
  userId: string | null;
  /** The hosting operator: not bound by the ceiling, always an approver. */
  operator: boolean;
};

export type BudgetChange = {
  scopeType: BudgetScopeType;
  windowKind?: BudgetWindowKind;
  amount: number;
  isActive?: boolean;
  hardStopEnabled?: boolean;
};

const NO_AUTHORITY = (companyId: string): BudgetAuthority => ({
  companyId,
  ceilingCents: null,
  approverUserIds: [],
  topUpApprovalByRoute: {},
  updatedByUserId: null,
  updatedAt: null,
});

/**
 * Refuse (403) a budget a non-operator may not set: an amount above the
 * ceiling, or, while a ceiling is set, a monthly company cap that is removed
 * (0), switched off, or loses its hard stop. Without a ceiling nothing changes.
 */
export function assertBudgetWithinAuthority(
  authority: BudgetAuthority,
  change: BudgetChange,
  actor: SpendingActor,
) {
  if (actor.operator || authority.ceilingCents === null) return;
  const ceiling = authority.ceilingCents;
  if (change.amount > ceiling) {
    throw forbidden(`This budget is above the operator ceiling of ${ceiling} cents. Ask the operator to raise it.`, {
      code: BUDGET_ABOVE_OPERATOR_CEILING_ERROR_CODE,
      ceilingCents: ceiling,
    });
  }
  const monthlyCompanyCap = change.scopeType === "company" && (change.windowKind ?? "calendar_month_utc") === "calendar_month_utc";
  if (monthlyCompanyCap && (change.amount <= 0 || change.isActive === false || change.hardStopEnabled === false)) {
    throw forbidden("The company spending cap is managed by the operator. It cannot be removed or switched off.", {
      code: BUDGET_CAP_OPERATOR_MANAGED_ERROR_CODE,
      ceilingCents: ceiling,
    });
  }
}

export function canResolveBudgetOverride(authority: BudgetAuthority, actor: SpendingActor) {
  if (actor.operator) return true;
  if (authority.approverUserIds.length === 0) return true;
  return actor.userId !== null && authority.approverUserIds.includes(actor.userId);
}

export function assertCanResolveBudgetOverride(authority: BudgetAuthority, actor: SpendingActor) {
  if (canResolveBudgetOverride(authority, actor)) return;
  throw forbidden("Only a named budget approver can decide this budget override.", {
    code: BUDGET_APPROVER_REQUIRED_ERROR_CODE,
  });
}

/**
 * The operator side of a top-up (GRE-1371): the operator or a named approver.
 * Unlike a budget override, an empty approver list does not open it to every
 * board user, so the client can never accept its own top-up on this side.
 */
export function isTopUpOperatorSide(authority: BudgetAuthority, actor: SpendingActor) {
  if (actor.operator) return true;
  return actor.userId !== null && authority.approverUserIds.includes(actor.userId);
}

/**
 * The per-route rules as a list for the activity log: it redacts any key that
 * looks like a secret, and route names such as `claude_api_key` do.
 */
function auditableRules(rules: BudgetAuthority["topUpApprovalByRoute"]) {
  return Object.entries(rules).map(([route, rule]) => ({ route, rule }));
}

export function budgetAuthorityService(db: Db) {
  async function get(companyId: string): Promise<BudgetAuthority> {
    const row = await db
      .select()
      .from(budgetAuthorities)
      .where(eq(budgetAuthorities.companyId, companyId))
      .then((rows) => rows[0] ?? null);
    if (!row?.companyId) return NO_AUTHORITY(companyId);
    return {
      companyId: row.companyId,
      ceilingCents: row.ceilingCents ?? null,
      approverUserIds: row.approverUserIds ?? [],
      topUpApprovalByRoute: (row.topUpApprovalByRoute ?? {}) as Partial<Record<string, TopUpApprovalRule>>,
      updatedByUserId: row.updatedByUserId ?? null,
      updatedAt: row.updatedAt,
    };
  }

  return {
    get,

    /**
     * A budget scope with an open hard-stop incident is waiting on an override.
     * With named approvers set, only they (or the operator) may lift it, by
     * this route or by a policy change.
     */
    hasOpenHardStop: async (companyId: string, scopeType: BudgetScopeType, scopeId: string) => {
      const row = await db
        .select({ id: budgetIncidents.id })
        .from(budgetIncidents)
        .where(
          and(
            eq(budgetIncidents.companyId, companyId),
            eq(budgetIncidents.scopeType, scopeType),
            eq(budgetIncidents.scopeId, scopeId),
            eq(budgetIncidents.thresholdType, "hard"),
            eq(budgetIncidents.status, "open"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      return Boolean(row);
    },

    /**
     * Operator only (the route checks). Writes one `budget.authority_updated`
     * row with old and new values. Lowering the ceiling cancels each dated
     * change above it, one `budget.policy_change_cancelled` row each, so no
     * change made under the old ceiling can take effect above the new one.
     */
    update: async (companyId: string, input: UpdateBudgetAuthority, actorUserId: string): Promise<BudgetAuthority> => {
      const previous = await get(companyId);
      const now = new Date();
      const approverUserIds = [...new Set(input.approverUserIds)];
      const topUpApprovalByRoute = (input.topUpApprovalByRoute ?? previous.topUpApprovalByRoute) as Record<string, string>;
      await db
        .insert(budgetAuthorities)
        .values({
          companyId,
          ceilingCents: input.ceilingCents,
          approverUserIds,
          topUpApprovalByRoute,
          updatedByUserId: actorUserId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: budgetAuthorities.companyId,
          set: {
            ceilingCents: input.ceilingCents,
            approverUserIds,
            topUpApprovalByRoute,
            updatedByUserId: actorUserId,
            updatedAt: now,
          },
        });

      if (input.ceilingCents !== null) {
        const cancelled = await db
          .update(budgetPolicies)
          .set({
            pendingAmount: null,
            pendingEffectiveFrom: null,
            pendingReason: null,
            pendingRequestedByUserId: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(budgetPolicies.companyId, companyId),
              isNotNull(budgetPolicies.pendingAmount),
              gt(budgetPolicies.pendingAmount, input.ceilingCents),
            ),
          )
          .returning({ id: budgetPolicies.id, scopeType: budgetPolicies.scopeType, scopeId: budgetPolicies.scopeId });
        for (const policy of cancelled) {
          await logActivity(db, {
            companyId,
            actorType: "user",
            actorId: actorUserId,
            action: "budget.policy_change_cancelled",
            entityType: "budget_policy",
            entityId: policy.id,
            details: {
              scopeType: policy.scopeType,
              scopeId: policy.scopeId,
              effectiveFrom: now.toISOString(),
              reason: "Above the new operator ceiling",
            },
          });
        }
      }

      const next = await get(companyId);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId,
        action: "budget.authority_updated",
        entityType: "company",
        entityId: companyId,
        details: {
          oldValue: {
            ceilingCents: previous.ceilingCents,
            approverUserIds: previous.approverUserIds,
            topUpApprovalRules: auditableRules(previous.topUpApprovalByRoute),
          },
          newValue: {
            ceilingCents: next.ceilingCents,
            approverUserIds: next.approverUserIds,
            topUpApprovalRules: auditableRules(next.topUpApprovalByRoute),
          },
          effectiveFrom: now.toISOString(),
          reason: input.reason,
        },
      });
      return next;
    },
  };
}
