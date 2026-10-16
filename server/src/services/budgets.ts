import { and, desc, eq, gte, inArray, isNotNull, lt, lte, ne, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  agentWakeupRequests,
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  projects,
} from "@greatstone/db";
import { DEFAULT_BUDGET_WARN_PERCENT } from "@greatstone/shared";
import type {
  BudgetIncident,
  BudgetIncidentResolutionInput,
  BudgetMetric,
  BudgetOverview,
  PauseReason,
  BudgetPolicy,
  BudgetPolicySummary,
  BudgetPolicyUpsertInput,
  BudgetScopeType,
  BudgetThresholdType,
  BudgetWindowKind,
} from "@greatstone/shared";
import { notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

type ScopeRecord = {
  companyId: string;
  name: string;
  paused: boolean;
  pauseReason: PauseReason | null;
};

type PolicyRow = typeof budgetPolicies.$inferSelect;
type IncidentRow = typeof budgetIncidents.$inferSelect;

export type BudgetEnforcementScope = {
  companyId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
};

export type BudgetServiceHooks = {
  cancelWorkForScope?: (scope: BudgetEnforcementScope) => Promise<void>;
  /** Once per hard incident, after the scope is paused: tell the open work why it stopped. */
  noticeHardStop?: (scope: BudgetEnforcementScope) => Promise<void>;
  /** After the scope resumes: wake each task its hard stop held, once (GRE-1365). */
  releaseHeldWorkForScope?: (scope: BudgetEnforcementScope) => Promise<void>;
};

/**
 * Wake statuses of task work kept at a budget hard stop in hold mode
 * (GRE-1365). `budget_releasing` is a release in flight; it still counts.
 */
export const BUDGET_HELD_WAKE_STATUSES = ["budget_held", "budget_releasing"] as const;

/** Tasks held at a hard stop, by scope: one per agent and task, however many wakes. */
async function countHeldTasks(db: Db, companyId: string, scope?: { scopeType: BudgetScopeType; scopeId: string }) {
  const heldIssueId = sql`${agentWakeupRequests.payload} ->> 'issueId'`;
  const conditions = [
    eq(agentWakeupRequests.companyId, companyId),
    inArray(agentWakeupRequests.status, [...BUDGET_HELD_WAKE_STATUSES]),
  ];
  if (scope?.scopeType === "agent") conditions.push(eq(agentWakeupRequests.agentId, scope.scopeId));
  if (scope?.scopeType === "project") {
    conditions.push(sql`exists (
      select 1 from issues held_issue
      where held_issue.company_id = ${companyId}
        and held_issue.id::text = ${heldIssueId}
        and held_issue.project_id = ${scope.scopeId}
    )`);
  }
  const [row] = await db
    .select({
      count: sql<number>`count(distinct (${agentWakeupRequests.agentId}::text || ':' || coalesce(${heldIssueId}, '')))::int`,
    })
    .from(agentWakeupRequests)
    .where(and(...conditions));
  return Number(row?.count ?? 0);
}

function currentUtcMonthWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
  return { start, end };
}

function resolveWindow(windowKind: BudgetWindowKind, now = new Date()) {
  if (windowKind === "lifetime") {
    return {
      start: new Date(Date.UTC(1970, 0, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(9999, 0, 1, 0, 0, 0, 0)),
    };
  }
  return currentUtcMonthWindow(now);
}

function budgetStatusFromObserved(
  observedAmount: number,
  amount: number,
  warnPercent: number,
): BudgetPolicySummary["status"] {
  if (amount <= 0) return "ok";
  if (observedAmount >= amount) return "hard_stop";
  if (observedAmount >= Math.ceil((amount * warnPercent) / 100)) return "warning";
  return "ok";
}

/**
 * The policy as it stands at `now` (GRE-1363). A dated change that is due
 * counts at once, before the budget sweep writes it into `amount`, so a raise
 * dated tomorrow applies tomorrow with no restart and no wait for the sweep.
 */
function inForce(policy: PolicyRow, now = new Date()): PolicyRow {
  if (policy.pendingAmount == null || !policy.pendingEffectiveFrom || policy.pendingEffectiveFrom > now) return policy;
  return { ...policy, amount: policy.pendingAmount, isActive: policy.pendingAmount > 0 };
}

const CLEARED_PENDING_CHANGE = {
  pendingAmount: null,
  pendingEffectiveFrom: null,
  pendingReason: null,
  pendingRequestedByUserId: null,
} as const;

function pendingChangeOf(policy: PolicyRow | null) {
  if (!policy || policy.pendingAmount == null || !policy.pendingEffectiveFrom) return null;
  return { amount: policy.pendingAmount, effectiveFrom: policy.pendingEffectiveFrom.toISOString() };
}

function normalizeScopeName(scopeType: BudgetScopeType, name: string) {
  if (scopeType === "company") return name;
  return name.trim().length > 0 ? name : scopeType;
}

async function resolveScopeRecord(db: Db, scopeType: BudgetScopeType, scopeId: string): Promise<ScopeRecord> {
  if (scopeType === "company") {
    const row = await db
      .select({
        companyId: companies.id,
        name: companies.name,
        status: companies.status,
        pauseReason: companies.pauseReason,
        pausedAt: companies.pausedAt,
      })
      .from(companies)
      .where(eq(companies.id, scopeId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Company not found");
    return {
      companyId: row.companyId,
      name: row.name,
      paused: row.status === "paused" || Boolean(row.pausedAt),
      pauseReason: (row.pauseReason as ScopeRecord["pauseReason"]) ?? null,
    };
  }

  if (scopeType === "agent") {
    const row = await db
      .select({
        companyId: agents.companyId,
        name: agents.name,
        status: agents.status,
        pauseReason: agents.pauseReason,
      })
      .from(agents)
      .where(eq(agents.id, scopeId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Agent not found");
    return {
      companyId: row.companyId,
      name: row.name,
      paused: row.status === "paused",
      pauseReason: (row.pauseReason as ScopeRecord["pauseReason"]) ?? null,
    };
  }

  const row = await db
    .select({
      companyId: projects.companyId,
      name: projects.name,
      pauseReason: projects.pauseReason,
      pausedAt: projects.pausedAt,
    })
    .from(projects)
    .where(eq(projects.id, scopeId))
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Project not found");
  return {
    companyId: row.companyId,
    name: row.name,
    paused: Boolean(row.pausedAt),
    pauseReason: (row.pauseReason as ScopeRecord["pauseReason"]) ?? null,
  };
}

async function computeObservedAmount(
  db: Db,
  policy: Pick<PolicyRow, "companyId" | "scopeType" | "scopeId" | "windowKind" | "metric">,
) {
  if (policy.metric !== "billed_cents") return 0;

  const conditions = [eq(costEvents.companyId, policy.companyId)];
  if (policy.scopeType === "agent") conditions.push(eq(costEvents.agentId, policy.scopeId));
  if (policy.scopeType === "project") conditions.push(eq(costEvents.projectId, policy.scopeId));
  const { start, end } = resolveWindow(policy.windowKind as BudgetWindowKind);
  if (policy.windowKind === "calendar_month_utc") {
    conditions.push(gte(costEvents.occurredAt, start));
    conditions.push(lt(costEvents.occurredAt, end));
  }

  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
    })
    .from(costEvents)
    .where(and(...conditions));

  return Number(row?.total ?? 0);
}

function buildApprovalPayload(input: {
  policy: PolicyRow;
  scopeName: string;
  thresholdType: BudgetThresholdType;
  amountObserved: number;
  windowStart: Date;
  windowEnd: Date;
}) {
  return {
    scopeType: input.policy.scopeType,
    scopeId: input.policy.scopeId,
    scopeName: input.scopeName,
    metric: input.policy.metric,
    windowKind: input.policy.windowKind,
    thresholdType: input.thresholdType,
    budgetAmount: input.policy.amount,
    observedAmount: input.amountObserved,
    warnPercent: input.policy.warnPercent,
    windowStart: input.windowStart.toISOString(),
    windowEnd: input.windowEnd.toISOString(),
    policyId: input.policy.id,
    guidance: "Raise the budget and resume the scope, or keep the scope paused.",
  };
}

async function markApprovalStatus(
  db: Db,
  approvalId: string | null,
  status: "approved" | "rejected",
  decisionNote: string | null | undefined,
  decidedByUserId: string,
) {
  if (!approvalId) return;
  await db
    .update(approvals)
    .set({
      status,
      decisionNote: decisionNote ?? null,
      decidedByUserId,
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(approvals.id, approvalId));
}

export function budgetService(db: Db, hooks: BudgetServiceHooks = {}) {
  async function pauseScopeForBudget(policy: PolicyRow) {
    const now = new Date();
    if (policy.scopeType === "agent") {
      await db
        .update(agents)
        .set({
          status: "paused",
          pauseReason: "budget",
          pausedAt: now,
          updatedAt: now,
        })
        .where(and(eq(agents.id, policy.scopeId), inArray(agents.status, ["active", "idle", "running", "error"])));
      return;
    }

    if (policy.scopeType === "project") {
      await db
        .update(projects)
        .set({
          pauseReason: "budget",
          pausedAt: now,
          updatedAt: now,
        })
        .where(eq(projects.id, policy.scopeId));
      return;
    }

    // An operator pause (GRE-1364) is not overwritten, so a budget resume cannot lift it.
    await db
      .update(companies)
      .set({
        status: "paused",
        pauseReason: "budget",
        pausedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(companies.id, policy.scopeId),
        sql`${companies.pauseReason} is distinct from 'manual'`,
      ));
  }

  async function pauseAndCancelScopeForBudget(policy: PolicyRow) {
    await pauseScopeForBudget(policy);
    await hooks.cancelWorkForScope?.({
      companyId: policy.companyId,
      scopeType: policy.scopeType as BudgetScopeType,
      scopeId: policy.scopeId,
    });
  }

  async function resumeScopeFromBudget(policy: PolicyRow) {
    await resumeScopeRowsFromBudget(policy);
    // Hold mode (GRE-1365): the release checks each held task's gate again, so
    // a task another budget still stops stays held. It never fails the raise;
    // the heartbeat sweep releases anything this call missed.
    try {
      await hooks.releaseHeldWorkForScope?.({
        companyId: policy.companyId,
        scopeType: policy.scopeType as BudgetScopeType,
        scopeId: policy.scopeId,
      });
    } catch (err) {
      logger.warn({ err, policyId: policy.id }, "held budget work not released yet; the sweep retries");
    }
  }

  async function resumeScopeRowsFromBudget(policy: PolicyRow) {
    const now = new Date();
    if (policy.scopeType === "agent") {
      await db
        .update(agents)
        .set({
          status: "idle",
          pauseReason: null,
          pausedAt: null,
          updatedAt: now,
        })
        .where(and(eq(agents.id, policy.scopeId), eq(agents.pauseReason, "budget")));
      return;
    }

    if (policy.scopeType === "project") {
      await db
        .update(projects)
        .set({
          pauseReason: null,
          pausedAt: null,
          updatedAt: now,
        })
        .where(and(eq(projects.id, policy.scopeId), eq(projects.pauseReason, "budget")));
      return;
    }

    await db
      .update(companies)
      .set({
        status: "active",
        pauseReason: null,
        pausedAt: null,
        updatedAt: now,
      })
      .where(and(eq(companies.id, policy.scopeId), eq(companies.pauseReason, "budget")));
  }

  async function getPolicyRow(policyId: string) {
    const policy = await db
      .select()
      .from(budgetPolicies)
      .where(eq(budgetPolicies.id, policyId))
      .then((rows) => rows[0] ?? null);
    if (!policy) throw notFound("Budget policy not found");
    return policy;
  }

  async function listPolicyRows(companyId: string) {
    return db
      .select()
      .from(budgetPolicies)
      .where(eq(budgetPolicies.companyId, companyId))
      .orderBy(desc(budgetPolicies.updatedAt));
  }

  async function buildPolicySummary(storedPolicy: PolicyRow): Promise<BudgetPolicySummary> {
    const policy = inForce(storedPolicy);
    const pending = policy === storedPolicy ? pendingChangeOf(storedPolicy) : null;
    const scope = await resolveScopeRecord(db, policy.scopeType as BudgetScopeType, policy.scopeId);
    const observedAmount = await computeObservedAmount(db, policy);
    const { start, end } = resolveWindow(policy.windowKind as BudgetWindowKind);
    const amount = policy.isActive ? policy.amount : 0;
    const utilizationPercent =
      amount > 0 ? Number(((observedAmount / amount) * 100).toFixed(2)) : 0;
    return {
      policyId: policy.id,
      companyId: policy.companyId,
      scopeType: policy.scopeType as BudgetScopeType,
      scopeId: policy.scopeId,
      scopeName: normalizeScopeName(policy.scopeType as BudgetScopeType, scope.name),
      metric: policy.metric as BudgetMetric,
      windowKind: policy.windowKind as BudgetWindowKind,
      amount,
      observedAmount,
      remainingAmount: amount > 0 ? Math.max(0, amount - observedAmount) : 0,
      utilizationPercent,
      warnPercent: policy.warnPercent,
      hardStopEnabled: policy.hardStopEnabled,
      notifyEnabled: policy.notifyEnabled,
      isActive: policy.isActive,
      status: policy.isActive
        ? budgetStatusFromObserved(observedAmount, amount, policy.warnPercent)
        : "ok",
      paused: scope.paused,
      pauseReason: scope.pauseReason,
      windowStart: start,
      windowEnd: end,
      pendingAmount: pending?.amount ?? null,
      pendingEffectiveFrom: pending ? storedPolicy.pendingEffectiveFrom : null,
      heldTaskCount: await countHeldTasks(db, policy.companyId, {
        scopeType: policy.scopeType as BudgetScopeType,
        scopeId: policy.scopeId,
      }),
    };
  }

  async function createIncidentIfNeeded(
    policy: PolicyRow,
    thresholdType: BudgetThresholdType,
    amountObserved: number,
  ) {
    const { start, end } = resolveWindow(policy.windowKind as BudgetWindowKind);
    const existing = await db
      .select()
      .from(budgetIncidents)
      .where(
        and(
          eq(budgetIncidents.policyId, policy.id),
          eq(budgetIncidents.windowStart, start),
          eq(budgetIncidents.thresholdType, thresholdType),
          ne(budgetIncidents.status, "dismissed"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (existing) return { incident: existing, created: false };

    const scope = await resolveScopeRecord(db, policy.scopeType as BudgetScopeType, policy.scopeId);
    const payload = buildApprovalPayload({
      policy,
      scopeName: normalizeScopeName(policy.scopeType as BudgetScopeType, scope.name),
      thresholdType,
      amountObserved,
      windowStart: start,
      windowEnd: end,
    });

    const approval = thresholdType === "hard"
      ? await db
        .insert(approvals)
        .values({
          companyId: policy.companyId,
          type: "budget_override_required",
          requestedByUserId: null,
          requestedByAgentId: null,
          status: "pending",
          payload,
        })
        .returning()
        .then((rows) => rows[0] ?? null)
      : null;

    const incident = await db
      .insert(budgetIncidents)
      .values({
        companyId: policy.companyId,
        policyId: policy.id,
        scopeType: policy.scopeType,
        scopeId: policy.scopeId,
        metric: policy.metric,
        windowKind: policy.windowKind,
        windowStart: start,
        windowEnd: end,
        thresholdType,
        amountLimit: policy.amount,
        amountObserved,
        status: "open",
        approvalId: approval?.id ?? null,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
    return incident ? { incident, created: true } : null;
  }

  async function resolveOpenSoftIncidents(policyId: string) {
    await db
      .update(budgetIncidents)
      .set({
        status: "resolved",
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(budgetIncidents.policyId, policyId),
          eq(budgetIncidents.thresholdType, "soft"),
          eq(budgetIncidents.status, "open"),
        ),
      );
  }

  async function resolveOpenIncidentsForPolicy(
    policyId: string,
    approvalStatus: "approved" | "rejected" | null,
    decidedByUserId: string | null,
  ) {
    const openRows = await db
      .select()
      .from(budgetIncidents)
      .where(and(eq(budgetIncidents.policyId, policyId), eq(budgetIncidents.status, "open")));

    await db
      .update(budgetIncidents)
      .set({
        status: "resolved",
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(budgetIncidents.policyId, policyId), eq(budgetIncidents.status, "open")));

    if (!approvalStatus || !decidedByUserId) return;
    for (const row of openRows) {
      await markApprovalStatus(db, row.approvalId ?? null, approvalStatus, "Resolved via budget update", decidedByUserId);
    }
  }

  async function hydrateIncidentRows(rows: IncidentRow[]): Promise<BudgetIncident[]> {
    const approvalIds = rows.map((row) => row.approvalId).filter((value): value is string => Boolean(value));
    const approvalRows = approvalIds.length > 0
      ? await db
        .select({ id: approvals.id, status: approvals.status })
        .from(approvals)
        .where(inArray(approvals.id, approvalIds))
      : [];
    const approvalStatusById = new Map(approvalRows.map((row) => [row.id, row.status]));

    return Promise.all(
      rows.map(async (row) => {
        const scope = await resolveScopeRecord(db, row.scopeType as BudgetScopeType, row.scopeId);
        return {
          id: row.id,
          companyId: row.companyId,
          policyId: row.policyId,
          scopeType: row.scopeType as BudgetScopeType,
          scopeId: row.scopeId,
          scopeName: normalizeScopeName(row.scopeType as BudgetScopeType, scope.name),
          metric: row.metric as BudgetMetric,
          windowKind: row.windowKind as BudgetWindowKind,
          windowStart: row.windowStart,
          windowEnd: row.windowEnd,
          thresholdType: row.thresholdType as BudgetThresholdType,
          amountLimit: row.amountLimit,
          amountObserved: row.amountObserved,
          status: row.status as BudgetIncident["status"],
          approvalId: row.approvalId ?? null,
          approvalStatus: row.approvalId ? approvalStatusById.get(row.approvalId) ?? null : null,
          resolvedAt: row.resolvedAt ?? null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
      }),
    );
  }

  async function syncScopeMonthlyBudget(policy: PolicyRow, now: Date) {
    if (policy.windowKind !== "calendar_month_utc") return;
    if (policy.scopeType === "company") {
      await db
        .update(companies)
        .set({ budgetMonthlyCents: policy.amount, updatedAt: now })
        .where(eq(companies.id, policy.scopeId));
    }
    if (policy.scopeType === "agent") {
      await db
        .update(agents)
        .set({ budgetMonthlyCents: policy.amount, updatedAt: now })
        .where(eq(agents.id, policy.scopeId));
    }
  }

  /** After the amount in force changes: resume the scope under it, or warn and stop it over it. */
  async function reconcileScopeAfterAmountChange(row: PolicyRow, actorUserId: string | null) {
    if (row.amount > 0) {
      const observedAmount = await computeObservedAmount(db, row);
      if (observedAmount < row.amount) {
        await resumeScopeFromBudget(row);
        await resolveOpenIncidentsForPolicy(row.id, actorUserId ? "approved" : null, actorUserId);
      } else {
        const softThreshold = Math.ceil((row.amount * row.warnPercent) / 100);
        if (row.notifyEnabled && observedAmount >= softThreshold) {
          await createIncidentIfNeeded(row, "soft", observedAmount);
        }
        if (row.hardStopEnabled && observedAmount >= row.amount) {
          await resolveOpenSoftIncidents(row.id);
          await createIncidentIfNeeded(row, "hard", observedAmount);
          await pauseAndCancelScopeForBudget(row);
        }
      }
    } else {
      await resumeScopeFromBudget(row);
      await resolveOpenIncidentsForPolicy(row.id, actorUserId ? "approved" : null, actorUserId);
    }
  }

  /**
   * Write a due dated change into `amount`, once. The guarded update matches
   * the exact pending change, so two sweeps (or a sweep and a request) racing
   * on one policy apply it one time; the loser re-reads the row.
   */
  async function applyPendingIfDue(policy: PolicyRow, now = new Date()): Promise<{ row: PolicyRow; applied: boolean }> {
    if (policy.pendingAmount == null || !policy.pendingEffectiveFrom || policy.pendingEffectiveFrom > now) {
      return { row: policy, applied: false };
    }
    const applied = await db
      .update(budgetPolicies)
      .set({
        amount: policy.pendingAmount,
        isActive: policy.pendingAmount > 0,
        ...CLEARED_PENDING_CHANGE,
        updatedByUserId: policy.pendingRequestedByUserId,
        updatedAt: now,
      })
      .where(
        and(
          eq(budgetPolicies.id, policy.id),
          eq(budgetPolicies.pendingAmount, policy.pendingAmount),
          eq(budgetPolicies.pendingEffectiveFrom, policy.pendingEffectiveFrom),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!applied) return { row: await getPolicyRow(policy.id), applied: false };

    await syncScopeMonthlyBudget(applied, now);
    await logActivity(db, {
      companyId: applied.companyId,
      actorType: "system",
      actorId: "budget_service",
      action: "budget.policy_change_applied",
      entityType: "budget_policy",
      entityId: applied.id,
      details: {
        scopeType: applied.scopeType,
        scopeId: applied.scopeId,
        windowKind: applied.windowKind,
        amount: applied.amount,
        oldValue: policy.amount,
        newValue: applied.amount,
        effectiveFrom: policy.pendingEffectiveFrom.toISOString(),
        reason: policy.pendingReason,
        requestedByUserId: policy.pendingRequestedByUserId,
      },
    });
    await reconcileScopeAfterAmountChange(applied, policy.pendingRequestedByUserId);
    return { row: applied, applied: true };
  }

  return {
    listPolicies: async (companyId: string): Promise<BudgetPolicy[]> => {
      const rows = await listPolicyRows(companyId);
      return rows.map((row) => ({
        ...row,
        scopeType: row.scopeType as BudgetScopeType,
        metric: row.metric as BudgetMetric,
        windowKind: row.windowKind as BudgetWindowKind,
      }));
    },

    upsertPolicy: async (
      companyId: string,
      input: BudgetPolicyUpsertInput,
      actorUserId: string | null,
    ): Promise<BudgetPolicySummary> => {
      const scope = await resolveScopeRecord(db, input.scopeType, input.scopeId);
      if (scope.companyId !== companyId) {
        throw unprocessable("Budget scope does not belong to company");
      }

      const metric = input.metric ?? "billed_cents";
      const windowKind = input.windowKind ?? (input.scopeType === "project" ? "lifetime" : "calendar_month_utc");
      const amount = Math.max(0, Math.floor(input.amount));
      const nextIsActive = amount > 0 && (input.isActive ?? true);
      const now = new Date();
      const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : null;
      const reason = input.reason?.trim() || null;
      const stored = await db
        .select()
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, companyId),
            eq(budgetPolicies.scopeType, input.scopeType),
            eq(budgetPolicies.scopeId, input.scopeId),
            eq(budgetPolicies.metric, metric),
            eq(budgetPolicies.windowKind, windowKind),
          ),
        )
        .then((rows) => rows[0] ?? null);
      // A due dated change lands first, so this change replaces it, not the reverse.
      const existing = stored ? (await applyPendingIfDue(stored, now)).row : null;
      const oldValue = existing ? existing.amount : null;
      const replacedPending = pendingChangeOf(existing);

      if (effectiveFrom && effectiveFrom > now) {
        // Dated change: only the amount changes, from `effectiveFrom`. The old
        // cap stays in force until then.
        const pendingChange = {
          pendingAmount: amount,
          pendingEffectiveFrom: effectiveFrom,
          pendingReason: reason,
          pendingRequestedByUserId: actorUserId,
        };
        const row = existing
          ? await db
            .update(budgetPolicies)
            .set({ ...pendingChange, updatedByUserId: actorUserId, updatedAt: now })
            .where(eq(budgetPolicies.id, existing.id))
            .returning()
            .then((rows) => rows[0])
          : await db
            .insert(budgetPolicies)
            .values({
              companyId,
              scopeType: input.scopeType,
              scopeId: input.scopeId,
              metric,
              windowKind,
              amount: 0,
              warnPercent: input.warnPercent ?? 80,
              hardStopEnabled: input.hardStopEnabled ?? true,
              notifyEnabled: input.notifyEnabled ?? true,
              isActive: false,
              ...pendingChange,
              createdByUserId: actorUserId,
              updatedByUserId: actorUserId,
            })
            .returning()
            .then((rows) => rows[0]);

        await logActivity(db, {
          companyId,
          actorType: "user",
          actorId: actorUserId ?? "board",
          action: "budget.policy_change_scheduled",
          entityType: "budget_policy",
          entityId: row.id,
          details: {
            scopeType: row.scopeType,
            scopeId: row.scopeId,
            windowKind: row.windowKind,
            amount: row.amount,
            oldValue,
            newValue: amount,
            effectiveFrom: effectiveFrom.toISOString(),
            reason,
            replacedPending,
          },
        });

        return buildPolicySummary(row);
      }

      const row = existing
        ? await db
          .update(budgetPolicies)
          .set({
            amount,
            warnPercent: input.warnPercent ?? existing.warnPercent,
            hardStopEnabled: input.hardStopEnabled ?? existing.hardStopEnabled,
            notifyEnabled: input.notifyEnabled ?? existing.notifyEnabled,
            isActive: nextIsActive,
            // A change that acts now replaces any dated change still waiting.
            ...CLEARED_PENDING_CHANGE,
            updatedByUserId: actorUserId,
            updatedAt: now,
          })
          .where(eq(budgetPolicies.id, existing.id))
          .returning()
          .then((rows) => rows[0])
        : await db
          .insert(budgetPolicies)
          .values({
            companyId,
            scopeType: input.scopeType,
            scopeId: input.scopeId,
            metric,
            windowKind,
            amount,
            warnPercent: input.warnPercent ?? DEFAULT_BUDGET_WARN_PERCENT,
            hardStopEnabled: input.hardStopEnabled ?? true,
            notifyEnabled: input.notifyEnabled ?? true,
            isActive: nextIsActive,
            createdByUserId: actorUserId,
            updatedByUserId: actorUserId,
          })
          .returning()
          .then((rows) => rows[0]);

      await syncScopeMonthlyBudget(row, now);
      await reconcileScopeAfterAmountChange(row, actorUserId);

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId ?? "board",
        action: "budget.policy_upserted",
        entityType: "budget_policy",
        entityId: row.id,
        details: {
          scopeType: row.scopeType,
          scopeId: row.scopeId,
          amount: row.amount,
          windowKind: row.windowKind,
          oldValue,
          newValue: row.amount,
          effectiveFrom: now.toISOString(),
          reason,
          replacedPending,
        },
      });

      return buildPolicySummary(row);
    },

    /**
     * The budget sweep: write each due dated change into its policy, resume
     * or stop the scope, and log it. Safe to run again or in parallel.
     */
    applyDueChanges: async (now = new Date()) => {
      const due = await db
        .select()
        .from(budgetPolicies)
        .where(and(isNotNull(budgetPolicies.pendingAmount), lte(budgetPolicies.pendingEffectiveFrom, now)))
        .limit(100);
      let applied = 0;
      for (const policy of due) {
        // One bad policy must not hold back the rest on every sweep. Its
        // pending change is cleared once applied, so it is not retried forever.
        try {
          if ((await applyPendingIfDue(policy, now)).applied) applied += 1;
        } catch (err) {
          logger.error({ err, policyId: policy.id }, "dated budget change could not be applied");
        }
      }
      return { applied };
    },

    overview: async (companyId: string): Promise<BudgetOverview> => {
      const rows = await listPolicyRows(companyId);
      const policies = await Promise.all(rows.map((row) => buildPolicySummary(row)));
      const activeIncidentRows = await db
        .select()
        .from(budgetIncidents)
        .where(and(eq(budgetIncidents.companyId, companyId), eq(budgetIncidents.status, "open")))
        .orderBy(desc(budgetIncidents.createdAt));
      const activeIncidents = await hydrateIncidentRows(activeIncidentRows);
      return {
        companyId,
        policies,
        activeIncidents,
        pausedAgentCount: policies.filter((policy) => policy.scopeType === "agent" && policy.paused).length,
        pausedProjectCount: policies.filter((policy) => policy.scopeType === "project" && policy.paused).length,
        pendingApprovalCount: activeIncidents.filter((incident) => incident.approvalStatus === "pending").length,
        heldTaskCount: await countHeldTasks(db, companyId),
      };
    },

    evaluateCostEvent: async (event: typeof costEvents.$inferSelect) => {
      const candidatePolicies = await db
        .select()
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, event.companyId),
            eq(budgetPolicies.isActive, true),
            inArray(budgetPolicies.scopeType, ["company", "agent", "project"]),
          ),
        );

      const now = new Date();
      const relevantPolicies = candidatePolicies.map((policy) => inForce(policy, now)).filter((policy) => {
        if (policy.scopeType === "company") return policy.scopeId === event.companyId;
        if (policy.scopeType === "agent") return policy.scopeId === event.agentId;
        if (policy.scopeType === "project") return Boolean(event.projectId) && policy.scopeId === event.projectId;
        return false;
      });

      for (const policy of relevantPolicies) {
        if (policy.metric !== "billed_cents" || policy.amount <= 0) continue;
        const observedAmount = await computeObservedAmount(db, policy);
        const softThreshold = Math.ceil((policy.amount * policy.warnPercent) / 100);

        if (policy.notifyEnabled && observedAmount >= softThreshold) {
          const softIncident = await createIncidentIfNeeded(policy, "soft", observedAmount);
          if (softIncident?.created) {
            await logActivity(db, {
              companyId: policy.companyId,
              actorType: "system",
              actorId: "budget_service",
              action: "budget.soft_threshold_crossed",
              entityType: "budget_incident",
              entityId: softIncident.incident.id,
              details: {
                scopeType: policy.scopeType,
                scopeId: policy.scopeId,
                amountObserved: observedAmount,
                amountLimit: policy.amount,
              },
            });
          }
        }

        if (policy.hardStopEnabled && observedAmount >= policy.amount) {
          await resolveOpenSoftIncidents(policy.id);
          const hardIncident = await createIncidentIfNeeded(policy, "hard", observedAmount);
          await pauseAndCancelScopeForBudget(policy);
          if (hardIncident?.created) {
            await hooks.noticeHardStop?.({
              companyId: policy.companyId,
              scopeType: policy.scopeType as BudgetScopeType,
              scopeId: policy.scopeId,
            });
            await logActivity(db, {
              companyId: policy.companyId,
              actorType: "system",
              actorId: "budget_service",
              action: "budget.hard_threshold_crossed",
              entityType: "budget_incident",
              entityId: hardIncident.incident.id,
              details: {
                scopeType: policy.scopeType,
                scopeId: policy.scopeId,
                amountObserved: observedAmount,
                amountLimit: policy.amount,
                approvalId: hardIncident.incident.approvalId ?? null,
              },
            });
          }
        }
      }
    },

    getInvocationBlock: async (
      companyId: string,
      agentId: string,
      context?: { issueId?: string | null; projectId?: string | null },
    ) => {
      const agent = await db
        .select({
          status: agents.status,
          pauseReason: agents.pauseReason,
          companyId: agents.companyId,
          name: agents.name,
        })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null);
      if (!agent || agent.companyId !== companyId) throw notFound("Agent not found");

      const company = await db
        .select({
          status: companies.status,
          pauseReason: companies.pauseReason,
          name: companies.name,
        })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) throw notFound("Company not found");
      if (company.status === "paused") {
        return {
          scopeType: "company" as const,
          scopeId: companyId,
          scopeName: company.name,
          reason:
            company.pauseReason === "budget"
              ? "Company is paused because its budget hard-stop was reached."
              : "Company is paused and cannot start new work.",
        };
      }

      const companyPolicyRow = await db
        .select()
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, companyId),
            eq(budgetPolicies.scopeType, "company"),
            eq(budgetPolicies.scopeId, companyId),
            eq(budgetPolicies.isActive, true),
            eq(budgetPolicies.metric, "billed_cents"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      const companyPolicy = companyPolicyRow ? inForce(companyPolicyRow) : null;
      if (companyPolicy && companyPolicy.hardStopEnabled && companyPolicy.amount > 0) {
        const observed = await computeObservedAmount(db, companyPolicy);
        if (observed >= companyPolicy.amount) {
          return {
            scopeType: "company" as const,
            scopeId: companyId,
            scopeName: company.name,
            reason: "Company cannot start new work because its budget hard-stop is exceeded.",
          };
        }
      }

      if (agent.status === "paused" && agent.pauseReason === "budget") {
        return {
          scopeType: "agent" as const,
          scopeId: agentId,
          scopeName: agent.name,
          reason: "Agent is paused because its budget hard-stop was reached.",
        };
      }

      const agentPolicyRow = await db
        .select()
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, companyId),
            eq(budgetPolicies.scopeType, "agent"),
            eq(budgetPolicies.scopeId, agentId),
            eq(budgetPolicies.isActive, true),
            eq(budgetPolicies.metric, "billed_cents"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      const agentPolicy = agentPolicyRow ? inForce(agentPolicyRow) : null;
      if (agentPolicy && agentPolicy.hardStopEnabled && agentPolicy.amount > 0) {
        const observed = await computeObservedAmount(db, agentPolicy);
        if (observed >= agentPolicy.amount) {
          return {
            scopeType: "agent" as const,
            scopeId: agentId,
            scopeName: agent.name,
            reason: "Agent cannot start because its budget hard-stop is still exceeded.",
          };
        }
      }

      const candidateProjectId = context?.projectId ?? null;
      if (!candidateProjectId) return null;

      const project = await db
        .select({
          id: projects.id,
          name: projects.name,
          companyId: projects.companyId,
          pauseReason: projects.pauseReason,
          pausedAt: projects.pausedAt,
        })
        .from(projects)
        .where(eq(projects.id, candidateProjectId))
        .then((rows) => rows[0] ?? null);

      if (!project || project.companyId !== companyId) return null;
      const projectPolicyRow = await db
        .select()
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, companyId),
            eq(budgetPolicies.scopeType, "project"),
            eq(budgetPolicies.scopeId, project.id),
            eq(budgetPolicies.isActive, true),
            eq(budgetPolicies.metric, "billed_cents"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      const projectPolicy = projectPolicyRow ? inForce(projectPolicyRow) : null;
      if (projectPolicy && projectPolicy.hardStopEnabled && projectPolicy.amount > 0) {
        const observed = await computeObservedAmount(db, projectPolicy);
        if (observed >= projectPolicy.amount) {
          return {
            scopeType: "project" as const,
            scopeId: project.id,
            scopeName: project.name,
            reason: "Project cannot start work because its budget hard-stop is still exceeded.",
          };
        }
      }

      if (!project.pausedAt || project.pauseReason !== "budget") return null;
      return {
        scopeType: "project" as const,
        scopeId: project.id,
        scopeName: project.name,
        reason: "Project is paused because its budget hard-stop was reached.",
      };
    },

    resolveIncident: async (
      companyId: string,
      incidentId: string,
      input: BudgetIncidentResolutionInput,
      actorUserId: string,
      /** Throws to refuse a raise, before anything is written (GRE-1363 ceiling). */
      authorizeRaise?: (policy: PolicyRow, amount: number) => void,
    ): Promise<BudgetIncident> => {
      const incident = await db
        .select()
        .from(budgetIncidents)
        .where(eq(budgetIncidents.id, incidentId))
        .then((rows) => rows[0] ?? null);
      if (!incident) throw notFound("Budget incident not found");
      if (incident.companyId !== companyId) throw notFound("Budget incident not found");

      const policy = (await applyPendingIfDue(await getPolicyRow(incident.policyId))).row;
      const oldValue = policy.amount;
      const replacedPending = pendingChangeOf(policy);
      if (input.action === "raise_budget_and_resume") {
        const nextAmount = Math.max(0, Math.floor(input.amount ?? 0));
        authorizeRaise?.(policy, nextAmount);
        const currentObserved = await computeObservedAmount(db, policy);
        if (nextAmount <= currentObserved) {
          throw unprocessable("New budget must exceed current observed spend");
        }

        const now = new Date();
        await db
          .update(budgetPolicies)
          .set({
            amount: nextAmount,
            isActive: true,
            ...CLEARED_PENDING_CHANGE,
            updatedByUserId: actorUserId,
            updatedAt: now,
          })
          .where(eq(budgetPolicies.id, policy.id));

        if (policy.scopeType === "company" && policy.windowKind === "calendar_month_utc") {
          await db
            .update(companies)
            .set({ budgetMonthlyCents: nextAmount, updatedAt: now })
            .where(eq(companies.id, policy.scopeId));
        }

        if (policy.scopeType === "agent" && policy.windowKind === "calendar_month_utc") {
          await db
            .update(agents)
            .set({ budgetMonthlyCents: nextAmount, updatedAt: now })
            .where(eq(agents.id, policy.scopeId));
        }

        await resumeScopeFromBudget(policy);
        await db
          .update(budgetIncidents)
          .set({
            status: "resolved",
            resolvedAt: now,
            updatedAt: now,
          })
          .where(and(eq(budgetIncidents.policyId, policy.id), eq(budgetIncidents.status, "open")));

        await markApprovalStatus(db, incident.approvalId ?? null, "approved", input.decisionNote, actorUserId);
      } else {
        await db
          .update(budgetIncidents)
          .set({
            status: "dismissed",
            resolvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(budgetIncidents.id, incident.id));
        await markApprovalStatus(db, incident.approvalId ?? null, "rejected", input.decisionNote, actorUserId);
      }

      await logActivity(db, {
        companyId: incident.companyId,
        actorType: "user",
        actorId: actorUserId,
        action: "budget.incident_resolved",
        entityType: "budget_incident",
        entityId: incident.id,
        details: {
          action: input.action,
          amount: input.amount ?? null,
          scopeType: incident.scopeType,
          scopeId: incident.scopeId,
          policyId: policy.id,
          oldValue,
          newValue: input.action === "raise_budget_and_resume" ? Math.max(0, Math.floor(input.amount ?? 0)) : oldValue,
          effectiveFrom: new Date().toISOString(),
          reason: input.decisionNote?.trim() || null,
          replacedPending: input.action === "raise_budget_and_resume" ? replacedPending : null,
        },
      });

      const [updated] = await hydrateIncidentRows([{
        ...incident,
        status: input.action === "raise_budget_and_resume" ? "resolved" : "dismissed",
        resolvedAt: new Date(),
        updatedAt: new Date(),
      }]);
      return updated!;
    },
  };
}
