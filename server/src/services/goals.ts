import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne, notInArray, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  agents,
  approvals,
  authUsers,
  companyMemberships,
  goalCheckIns,
  goalKpiReadings,
  goals,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueRelations,
  issues,
  issueThreadInteractions,
} from "@greatstone/db";
import {
  DEFAULT_KPI_AMBER_THRESHOLD_PCT,
  DEFAULT_KPI_RED_THRESHOLD_PCT,
  GOAL_KIND_DEFAULT_LEVEL,
  STRATEGIC_PLAN_TEMPLATE,
  computeKpiStatus,
  goalKindParentError,
  rollUpKpiStatus,
  type GoalKind,
} from "@greatstone/shared";
import type {
  CreateGoalCheckIn,
  CreateGoalKpiReading,
  GoalCheckIn,
  GoalKpiReading,
  GoalRagRollup,
  KpiDirection,
  KpiRagStatus,
  KpiReadingSource,
  KpiStatus,
  GoalDetail,
  GoalMilestone,
  GoalWithProgress,
  IssueStatus,
} from "@greatstone/shared";
import {
  addIssueToCounts,
  collectGoalBlockers,
  computeGoalProgress,
  goalSubtreeIds,
  sortMilestones,
  explainBlockedIssue,
  sortSubGoals,
  type ActorNames,
  type GoalBlockedIssue,
  type GoalBlockingIssue,
  type GoalDependent,
  type GoalIssueCounts,
} from "./goal-progress.js";
import { badRequest, unprocessable } from "../errors.js";

type GoalReader = Pick<Db, "select">;

/** The blocker note is cleaned and cut again in the UI; this only bounds the payload. */
const MAX_BLOCKER_NOTE_CHARS = 600;

export async function getDefaultCompanyGoal(db: GoalReader, companyId: string) {
  const activeRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        eq(goals.status, "active"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (activeRootGoal) return activeRootGoal;

  const anyRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (anyRootGoal) return anyRootGoal;

  return db
    .select()
    .from(goals)
    .where(and(eq(goals.companyId, companyId), eq(goals.level, "company")))
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
}

/**
 * The company's lead agent: the oldest live agent that reports to no one.
 * New goals without an owner go to it, and it may check in on any goal.
 */
export async function getCompanyLeadAgentId(db: GoalReader, companyId: string): Promise<string | null> {
  const row = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), isNull(agents.reportsTo), ne(agents.status, "terminated")))
    .orderBy(asc(agents.createdAt), asc(agents.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row?.id ?? null;
}

type GoalRow = typeof goals.$inferSelect;
type GoalInsert = typeof goals.$inferInsert;
type GoalCheckInRow = typeof goalCheckIns.$inferSelect;
type GoalKpiReadingRow = typeof goalKpiReadings.$inferSelect;

function toCheckIn(row: GoalCheckInRow): GoalCheckIn {
  return { ...row, blockers: Array.isArray(row.blockers) ? row.blockers : [] };
}

function toReading(row: GoalKpiReadingRow): GoalKpiReading {
  return { ...row, source: row.source as KpiReadingSource };
}

/** Today as "YYYY-MM-DD" (UTC), the date KPI deadlines are checked against. */
function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Newest first: by reading date, then by when it was recorded. */
const READING_ORDER = [desc(goalKpiReadings.readingDate), desc(goalKpiReadings.createdAt), desc(goalKpiReadings.id)];

interface KpiState {
  latest: Map<string, GoalKpiReading>;
  statusById: Map<string, KpiStatus>;
  rollup: Map<string, GoalRagRollup>;
}

const NO_ROLLUP: GoalRagRollup = { status: null, red: 0, amber: 0, green: 0, noStatus: 0 };

/** Red may not sit below amber. Null thresholds fall back to the defaults. */
function assertValidThresholds(amber: number | null | undefined, red: number | null | undefined) {
  const amberPct = amber ?? DEFAULT_KPI_AMBER_THRESHOLD_PCT;
  const redPct = red ?? DEFAULT_KPI_RED_THRESHOLD_PCT;
  if (redPct < amberPct) {
    throw unprocessable(`The red line (${redPct}%) must not be below the amber line (${amberPct}%)`);
  }
}

export function goalService(db: Db) {
  async function loadIssueCounts(companyId: string, goalIds?: string[]) {
    const scope = [eq(issues.companyId, companyId), isNull(issues.hiddenAt), isNotNull(issues.goalId)];
    if (goalIds) scope.push(inArray(issues.goalId, goalIds));
    const grouped = await db
      .select({ goalId: issues.goalId, status: issues.status, n: count() })
      .from(issues)
      .where(and(...scope))
      .groupBy(issues.goalId, issues.status);
    const countsByGoal = new Map<string, GoalIssueCounts>();
    for (const row of grouped) {
      const goalId = row.goalId as string;
      const current = countsByGoal.get(goalId) ?? { done: 0, open: 0, blocked: 0 };
      countsByGoal.set(goalId, addIssueToCounts(current, row.status, Number(row.n)));
    }

    const blocked = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        goalId: issues.goalId,
        createdAt: issues.createdAt,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        createdByUserId: issues.createdByUserId,
      })
      .from(issues)
      .where(and(...scope, eq(issues.status, "blocked")))
      .orderBy(asc(issues.createdAt));
    const [facts, dependents] = await Promise.all([
      loadBlockedIssueFacts(companyId, blocked.map((row) => row.id)),
      loadGoalDependents(companyId),
    ]);

    const agentIds = new Set<string>();
    const userIds = new Set<string>();
    for (const row of blocked) {
      if (row.assigneeAgentId) agentIds.add(row.assigneeAgentId);
      if (row.assigneeUserId) userIds.add(row.assigneeUserId);
      if (row.createdByUserId) userIds.add(row.createdByUserId);
    }
    for (const blocker of facts.openBlockers.values()) {
      for (const b of blocker) {
        if (b.assigneeAgentId) agentIds.add(b.assigneeAgentId);
        if (b.assigneeUserId) userIds.add(b.assigneeUserId);
      }
    }
    const names = await loadActorNames([...agentIds], [...userIds]);

    const blockedByGoal = new Map<string, GoalBlockedIssue[]>();
    for (const row of blocked) {
      const goalId = row.goalId as string;
      const explained = explainBlockedIssue(
        {
          assigneeAgentId: row.assigneeAgentId,
          assigneeUserId: row.assigneeUserId,
          createdByUserId: row.createdByUserId,
          openBlockers: facts.openBlockers.get(row.id) ?? [],
          waitingOnPerson: facts.waitingOnPerson.has(row.id),
          lastRunStatus: facts.lastRunStatus.get(row.id) ?? null,
        },
        names,
      );
      const list = blockedByGoal.get(goalId) ?? [];
      list.push({
        id: row.id,
        identifier: row.identifier,
        title: row.title,
        goalId,
        createdAt: row.createdAt,
        ...explained,
        note: facts.lastComment.get(row.id) ?? null,
      });
      blockedByGoal.set(goalId, list);
    }
    return { countsByGoal, blockedByGoal, dependents };
  }

  /** Everything that explains why each blocked task is stuck, in one batch per source. */
  async function loadBlockedIssueFacts(companyId: string, blockedIds: string[]) {
    const openBlockers = new Map<string, GoalBlockingIssue[]>();
    const waitingOnPerson = new Set<string>();
    const lastRunStatus = new Map<string, string>();
    const lastComment = new Map<string, string>();
    if (blockedIds.length === 0) return { openBlockers, waitingOnPerson, lastRunStatus, lastComment };

    const runIssueId = sql<string>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
    const [relationRows, interactionRows, approvalRows, runRows, commentRows] = await Promise.all([
      db
        .select({
          blockedId: issueRelations.relatedIssueId,
          issueId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issues.id, issueRelations.issueId))
        .where(
          and(
            eq(issueRelations.companyId, companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.relatedIssueId, blockedIds),
            ne(issues.status, "done"),
          ),
        )
        .orderBy(asc(issueRelations.createdAt)),
      db
        .selectDistinct({ issueId: issueThreadInteractions.issueId })
        .from(issueThreadInteractions)
        .where(
          and(
            eq(issueThreadInteractions.companyId, companyId),
            inArray(issueThreadInteractions.issueId, blockedIds),
            eq(issueThreadInteractions.status, "pending"),
          ),
        ),
      db
        .selectDistinct({ issueId: issueApprovals.issueId })
        .from(issueApprovals)
        .innerJoin(approvals, eq(approvals.id, issueApprovals.approvalId))
        .where(and(inArray(issueApprovals.issueId, blockedIds), eq(approvals.status, "pending"))),
      db
        .selectDistinctOn([runIssueId], { issueId: runIssueId, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), inArray(runIssueId, blockedIds)))
        .orderBy(runIssueId, desc(heartbeatRuns.createdAt)),
      db
        .selectDistinctOn([issueComments.issueId], { issueId: issueComments.issueId, body: issueComments.body })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, companyId),
            inArray(issueComments.issueId, blockedIds),
            isNull(issueComments.deletedAt),
          ),
        )
        .orderBy(issueComments.issueId, desc(issueComments.createdAt), desc(issueComments.id)),
    ]);

    for (const row of relationRows) {
      const list = openBlockers.get(row.blockedId) ?? [];
      list.push({ ...row, status: row.status as IssueStatus });
      openBlockers.set(row.blockedId, list);
    }
    for (const row of [...interactionRows, ...approvalRows]) waitingOnPerson.add(row.issueId);
    for (const row of runRows) lastRunStatus.set(row.issueId, row.status);
    for (const row of commentRows) lastComment.set(row.issueId, row.body.slice(0, MAX_BLOCKER_NOTE_CHARS));
    return { openBlockers, waitingOnPerson, lastRunStatus, lastComment };
  }

  /** Open goal-linked tasks keyed by the task they wait on, for the "holds up" count. */
  async function loadGoalDependents(companyId: string) {
    const rows = await db
      .select({ blockerId: issueRelations.issueId, id: issues.id, goalId: issues.goalId })
      .from(issueRelations)
      .innerJoin(issues, eq(issues.id, issueRelations.relatedIssueId))
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "blocks"),
          isNull(issues.hiddenAt),
          isNotNull(issues.goalId),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );
    const dependents = new Map<string, GoalDependent[]>();
    for (const row of rows) {
      const list = dependents.get(row.blockerId) ?? [];
      list.push({ id: row.id, goalId: row.goalId as string });
      dependents.set(row.blockerId, list);
    }
    return dependents;
  }

  async function loadActorNames(agentIds: string[], userIds: string[]): Promise<ActorNames> {
    const [agentRows, userRows] = await Promise.all([
      agentIds.length === 0
        ? []
        : db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds)),
      userIds.length === 0
        ? []
        : db.select({ id: authUsers.id, name: authUsers.name }).from(authUsers).where(inArray(authUsers.id, userIds)),
    ]);
    return {
      agents: new Map(agentRows.map((row) => [row.id, row.name])),
      users: new Map(userRows.map((row) => [row.id, row.name])),
    };
  }

  async function loadLatestCheckIns(goalIds: string[]) {
    const latest = new Map<string, GoalCheckIn>();
    if (goalIds.length === 0) return latest;
    const rows = await db
      .selectDistinctOn([goalCheckIns.goalId])
      .from(goalCheckIns)
      .where(inArray(goalCheckIns.goalId, goalIds))
      .orderBy(goalCheckIns.goalId, desc(goalCheckIns.createdAt), desc(goalCheckIns.id));
    for (const row of rows) latest.set(row.goalId, toCheckIn(row));
    return latest;
  }

  /**
   * Status of every KPI in the company and its roll-up up the tree. Reads the
   * newest and the oldest reading per KPI (the oldest is the baseline when
   * none is set) in two batched queries.
   */
  async function loadKpiState(companyGoals: GoalRow[]): Promise<KpiState> {
    const kpis = companyGoals.filter((goal) => goal.kind === "kpi");
    const latest = new Map<string, GoalKpiReading>();
    const first = new Map<string, GoalKpiReading>();
    if (kpis.length > 0) {
      const ids = kpis.map((goal) => goal.id);
      const [latestRows, firstRows] = await Promise.all([
        db
          .selectDistinctOn([goalKpiReadings.goalId])
          .from(goalKpiReadings)
          .where(inArray(goalKpiReadings.goalId, ids))
          .orderBy(goalKpiReadings.goalId, ...READING_ORDER),
        db
          .selectDistinctOn([goalKpiReadings.goalId])
          .from(goalKpiReadings)
          .where(inArray(goalKpiReadings.goalId, ids))
          .orderBy(goalKpiReadings.goalId, asc(goalKpiReadings.readingDate), asc(goalKpiReadings.createdAt)),
      ]);
      for (const row of latestRows) latest.set(row.goalId, toReading(row));
      for (const row of firstRows) first.set(row.goalId, toReading(row));
    }
    const today = todayIso();
    const statusById = new Map<string, KpiStatus>();
    const ragById = new Map<string, KpiRagStatus | null>();
    for (const kpi of kpis) {
      const status = computeKpiStatus(
        { ...kpi, kpiDirection: kpi.kpiDirection as KpiDirection | null },
        latest.get(kpi.id) ?? null,
        first.get(kpi.id) ?? null,
        today,
      );
      statusById.set(kpi.id, status);
      ragById.set(kpi.id, status.status);
    }
    return { latest, statusById, rollup: rollUpKpiStatus(companyGoals, ragById) };
  }

  function withProgress(
    goal: GoalRow,
    companyGoals: GoalRow[],
    loaded: Awaited<ReturnType<typeof loadIssueCounts>>,
    latestCheckIns: Map<string, GoalCheckIn>,
    kpiState: KpiState,
  ): GoalWithProgress {
    const subtree = goalSubtreeIds(goal.id, companyGoals);
    const latestCheckIn = latestCheckIns.get(goal.id) ?? null;
    return {
      ...(goal as GoalWithProgress),
      progress: computeGoalProgress(goal, subtree, loaded.countsByGoal),
      blockers: collectGoalBlockers(subtree, loaded.blockedByGoal, latestCheckIn, loaded.dependents),
      latestCheckIn,
      kpiStatus: kpiState.statusById.get(goal.id) ?? null,
      ragRollup: kpiState.rollup.get(goal.id) ?? NO_ROLLUP,
      latestReading: kpiState.latest.get(goal.id) ?? null,
    };
  }

  async function listWithProgress(companyId: string): Promise<GoalWithProgress[]> {
    const companyGoals = await db.select().from(goals).where(eq(goals.companyId, companyId));
    if (companyGoals.length === 0) return [];
    const [loaded, latestCheckIns, kpiState] = await Promise.all([
      loadIssueCounts(companyId),
      loadLatestCheckIns(companyGoals.map((g) => g.id)),
      loadKpiState(companyGoals),
    ]);
    return companyGoals.map((goal) => withProgress(goal, companyGoals, loaded, latestCheckIns, kpiState));
  }

  async function getDetail(id: string): Promise<GoalDetail | null> {
    const goal = await db.select().from(goals).where(eq(goals.id, id)).then((rows) => rows[0] ?? null);
    if (!goal) return null;
    const companyGoals = await db.select().from(goals).where(eq(goals.companyId, goal.companyId));
    const subtree = goalSubtreeIds(goal.id, companyGoals);
    const directChildren = companyGoals.filter((g) => g.parentId === goal.id && g.id !== goal.id);
    const [loaded, latestCheckIns, kpiState, issueRows] = await Promise.all([
      loadIssueCounts(goal.companyId, subtree),
      loadLatestCheckIns([goal.id, ...directChildren.map((g) => g.id)]),
      loadKpiState(companyGoals),
      db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          goalId: issues.goalId,
          assigneeAgentId: issues.assigneeAgentId,
          createdAt: issues.createdAt,
          completedAt: issues.completedAt,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, goal.companyId),
            isNull(issues.hiddenAt),
            inArray(issues.goalId, subtree),
            ne(issues.status, "cancelled"),
          ),
        ),
    ]);
    const milestones = sortMilestones(
      issueRows.map((row) => ({ ...row, goalId: row.goalId as string, status: row.status as IssueStatus })),
    ) satisfies GoalMilestone[];
    return {
      ...withProgress(goal, companyGoals, loaded, latestCheckIns, kpiState),
      subGoals: sortSubGoals(directChildren).map((child) =>
        withProgress(child, companyGoals, loaded, latestCheckIns, kpiState)),
      milestones,
    };
  }

  /**
   * Checks a create or update before it is written: the parent is in the same
   * company, the kind fits under the parent kind (and, on update, the direct
   * children still fit under the new kind), and the owner is one person or one
   * agent of this company. Throws 400/422 with a reason the user can act on.
   */
  async function assertValidGoalChange(
    companyId: string,
    next: { kind: GoalKind | null; parentId: string | null; ownerAgentId: string | null; ownerUserId: string | null },
    existing: GoalRow | null,
  ) {
    if (next.ownerAgentId && next.ownerUserId) {
      throw badRequest("A goal has one owner: a person or an agent, not both");
    }
    if (next.ownerUserId && next.ownerUserId !== existing?.ownerUserId) {
      const member = await db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, next.ownerUserId),
            eq(companyMemberships.status, "active"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!member) throw unprocessable("Owner must be an active member of this company");
    }
    if (next.ownerAgentId && next.ownerAgentId !== existing?.ownerAgentId) {
      const agent = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, next.ownerAgentId), eq(agents.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!agent) throw unprocessable("Owner agent must belong to this company");
    }

    const kindChanged = existing ? next.kind !== (existing.kind ?? null) : true;
    const parentChanged = existing ? next.parentId !== existing.parentId : true;
    if (!kindChanged && !parentChanged) return;

    let parentKind: GoalKind | null = null;
    if (next.parentId) {
      if (existing && next.parentId === existing.id) throw unprocessable("A goal cannot be its own parent");
      const parent = await db
        .select({ kind: goals.kind })
        .from(goals)
        .where(and(eq(goals.id, next.parentId), eq(goals.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!parent) throw unprocessable("Parent goal not found in this company");
      parentKind = (parent.kind as GoalKind | null) ?? null;
    }
    const parentError = goalKindParentError(next.kind, next.parentId != null, parentKind);
    if (parentError) throw unprocessable(parentError);

    if (existing && kindChanged) {
      const children = await db
        .select({ title: goals.title, kind: goals.kind })
        .from(goals)
        .where(and(eq(goals.parentId, existing.id), eq(goals.companyId, companyId)));
      for (const child of children) {
        const childError = goalKindParentError(child.kind as GoalKind | null, true, next.kind);
        if (childError) throw unprocessable(`Cannot change kind: sub-goal "${child.title}" no longer fits. ${childError}`);
      }
    }
  }

  return {
    list: (companyId: string) => db.select().from(goals).where(eq(goals.companyId, companyId)),

    listWithProgress,

    getDetail,

    getCompanyLeadAgentId: (companyId: string) => getCompanyLeadAgentId(db, companyId),

    listCheckIns: (goalId: string) =>
      db
        .select()
        .from(goalCheckIns)
        .where(eq(goalCheckIns.goalId, goalId))
        .orderBy(desc(goalCheckIns.createdAt), desc(goalCheckIns.id))
        .then((rows) => rows.map(toCheckIn)),

    createCheckIn: async (
      goal: Pick<GoalRow, "id" | "companyId">,
      input: CreateGoalCheckIn,
      author: { agentId: string | null; userId: string | null },
    ): Promise<GoalCheckIn> => {
      let progressPercent = input.progressPercent ?? null;
      if (progressPercent == null) {
        progressPercent = (await getDetail(goal.id))?.progress.percent ?? null;
      }
      const row = await db
        .insert(goalCheckIns)
        .values({
          companyId: goal.companyId,
          goalId: goal.id,
          authorAgentId: author.agentId,
          authorUserId: author.userId,
          body: input.body,
          progressPercent,
          blockers: input.blockers ?? [],
        })
        .returning()
        .then((rows) => rows[0]);
      return toCheckIn(row);
    },

    listReadings: (goalId: string) =>
      db
        .select()
        .from(goalKpiReadings)
        .where(eq(goalKpiReadings.goalId, goalId))
        .orderBy(...READING_ORDER)
        .then((rows) => rows.map(toReading)),

    /**
     * Records one KPI reading. When it is the newest by reading date, the
     * goal's currentValue follows it so the progress bar shows the same number.
     */
    createReading: (
      goal: Pick<GoalRow, "id" | "companyId">,
      input: CreateGoalKpiReading,
      recordedBy: { agentId: string | null; userId: string | null },
    ): Promise<GoalKpiReading> =>
      db.transaction(async (tx) => {
        const row = await tx
          .insert(goalKpiReadings)
          .values({
            companyId: goal.companyId,
            goalId: goal.id,
            value: input.value,
            readingDate: input.readingDate,
            note: input.note ?? null,
            source: input.source,
            recordedByAgentId: recordedBy.agentId,
            recordedByUserId: recordedBy.userId,
          })
          .returning()
          .then((rows) => rows[0]);
        const newest = await tx
          .select({ id: goalKpiReadings.id })
          .from(goalKpiReadings)
          .where(eq(goalKpiReadings.goalId, goal.id))
          .orderBy(...READING_ORDER)
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (newest?.id === row.id) {
          await tx
            .update(goals)
            .set({ currentValue: row.value, updatedAt: new Date() })
            .where(eq(goals.id, goal.id));
        }
        return toReading(row);
      }),

    getById: (id: string) =>
      db
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null),

    getDefaultCompanyGoal: (companyId: string) => getDefaultCompanyGoal(db, companyId),

    create: async (companyId: string, data: Omit<GoalInsert, "companyId">) => {
      const kind = (data.kind as GoalKind | null | undefined) ?? null;
      const ownerUserId = data.ownerUserId ?? null;
      await assertValidGoalChange(
        companyId,
        { kind, parentId: data.parentId ?? null, ownerAgentId: data.ownerAgentId ?? null, ownerUserId },
        null,
      );
      assertValidThresholds(data.amberThresholdPct, data.redThresholdPct);
      // No owner sent: the lead agent owns it, as before.
      const ownerAgentId = ownerUserId
        ? null
        : data.ownerAgentId ?? (await getCompanyLeadAgentId(db, companyId));
      const level = data.level ?? (kind ? GOAL_KIND_DEFAULT_LEVEL[kind] : "task");
      return db
        .insert(goals)
        .values({ ...data, kind, level, ownerAgentId, ownerUserId, companyId })
        .returning()
        .then((rows) => rows[0]);
    },

    update: async (id: string, data: Partial<GoalInsert>) => {
      const existing = await db.select().from(goals).where(eq(goals.id, id)).then((rows) => rows[0] ?? null);
      if (!existing) return null;
      const patch = { ...data };
      // Setting one kind of owner clears the other.
      if (patch.ownerUserId && patch.ownerAgentId === undefined) patch.ownerAgentId = null;
      if (patch.ownerAgentId && patch.ownerUserId === undefined) patch.ownerUserId = null;
      await assertValidGoalChange(
        existing.companyId,
        {
          kind: (patch.kind !== undefined ? patch.kind : existing.kind) as GoalKind | null,
          parentId: patch.parentId !== undefined ? patch.parentId : existing.parentId,
          ownerAgentId: patch.ownerAgentId !== undefined ? patch.ownerAgentId : existing.ownerAgentId,
          ownerUserId: patch.ownerUserId !== undefined ? patch.ownerUserId : existing.ownerUserId,
        },
        existing,
      );
      if (patch.amberThresholdPct !== undefined || patch.redThresholdPct !== undefined) {
        assertValidThresholds(
          patch.amberThresholdPct !== undefined ? patch.amberThresholdPct : existing.amberThresholdPct,
          patch.redThresholdPct !== undefined ? patch.redThresholdPct : existing.redThresholdPct,
        );
      }
      return db
        .update(goals)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(goals.id, existing.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    /** Creates the empty strategic plan (STRATEGIC_PLAN_TEMPLATE) in one transaction. */
    createStrategicPlan: (companyId: string): Promise<GoalRow[]> =>
      db.transaction(async (tx) => {
        const idsByKey = new Map<string, string>();
        const created: GoalRow[] = [];
        for (const node of STRATEGIC_PLAN_TEMPLATE) {
          const parentId = node.parentKey ? idsByKey.get(node.parentKey) ?? null : null;
          const row = await tx
            .insert(goals)
            .values({
              companyId,
              title: node.title,
              description: node.description,
              kind: node.kind,
              level: GOAL_KIND_DEFAULT_LEVEL[node.kind],
              status: "planned",
              parentId,
            })
            .returning()
            .then((rows) => rows[0]);
          idsByKey.set(node.key, row.id);
          created.push(row);
        }
        return created;
      }),

    remove: (id: string) =>
      db
        .delete(goals)
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}
