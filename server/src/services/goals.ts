import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne, notInArray, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  agents,
  approvals,
  authUsers,
  goalCheckIns,
  goals,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueRelations,
  issues,
  issueThreadInteractions,
} from "@greatstone/db";
import type {
  CreateGoalCheckIn,
  GoalCheckIn,
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
type GoalCheckInRow = typeof goalCheckIns.$inferSelect;

function toCheckIn(row: GoalCheckInRow): GoalCheckIn {
  return { ...row, blockers: Array.isArray(row.blockers) ? row.blockers : [] };
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

  function withProgress(
    goal: GoalRow,
    companyGoals: GoalRow[],
    loaded: Awaited<ReturnType<typeof loadIssueCounts>>,
    latestCheckIns: Map<string, GoalCheckIn>,
  ): GoalWithProgress {
    const subtree = goalSubtreeIds(goal.id, companyGoals);
    const latestCheckIn = latestCheckIns.get(goal.id) ?? null;
    return {
      ...(goal as GoalWithProgress),
      progress: computeGoalProgress(goal, subtree, loaded.countsByGoal),
      blockers: collectGoalBlockers(subtree, loaded.blockedByGoal, latestCheckIn, loaded.dependents),
      latestCheckIn,
    };
  }

  async function listWithProgress(companyId: string): Promise<GoalWithProgress[]> {
    const companyGoals = await db.select().from(goals).where(eq(goals.companyId, companyId));
    if (companyGoals.length === 0) return [];
    const [loaded, latestCheckIns] = await Promise.all([
      loadIssueCounts(companyId),
      loadLatestCheckIns(companyGoals.map((g) => g.id)),
    ]);
    return companyGoals.map((goal) => withProgress(goal, companyGoals, loaded, latestCheckIns));
  }

  async function getDetail(id: string): Promise<GoalDetail | null> {
    const goal = await db.select().from(goals).where(eq(goals.id, id)).then((rows) => rows[0] ?? null);
    if (!goal) return null;
    const companyGoals = await db.select().from(goals).where(eq(goals.companyId, goal.companyId));
    const subtree = goalSubtreeIds(goal.id, companyGoals);
    const directChildren = companyGoals.filter((g) => g.parentId === goal.id && g.id !== goal.id);
    const [loaded, latestCheckIns, issueRows] = await Promise.all([
      loadIssueCounts(goal.companyId, subtree),
      loadLatestCheckIns([goal.id, ...directChildren.map((g) => g.id)]),
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
      ...withProgress(goal, companyGoals, loaded, latestCheckIns),
      subGoals: sortSubGoals(directChildren).map((child) =>
        withProgress(child, companyGoals, loaded, latestCheckIns)),
      milestones,
    };
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

    getById: (id: string) =>
      db
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null),

    getDefaultCompanyGoal: (companyId: string) => getDefaultCompanyGoal(db, companyId),

    create: async (companyId: string, data: Omit<typeof goals.$inferInsert, "companyId">) => {
      const ownerAgentId = data.ownerAgentId ?? (await getCompanyLeadAgentId(db, companyId));
      return db
        .insert(goals)
        .values({ ...data, ownerAgentId, companyId })
        .returning()
        .then((rows) => rows[0]);
    },

    update: (id: string, data: Partial<typeof goals.$inferInsert>) =>
      db
        .update(goals)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    remove: (id: string) =>
      db
        .delete(goals)
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}
