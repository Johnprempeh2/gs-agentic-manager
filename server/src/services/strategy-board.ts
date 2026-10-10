import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, notInArray, or } from "drizzle-orm";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  goalKpiAlerts,
  goalKpiReadings,
  goals,
  goalWhyRequests,
  issues,
  principalPermissionGrants,
  strategyBoardPacks,
  type Db,
} from "@greatstone/db";
import {
  buildStrategyBoardAreas,
  buildStrategyBoardKpis,
  buildStrategyBoardOverdueActions,
  countStrategyBoardKpis,
  kpiAlertAction,
  rankStrategyBoardAttention,
  renderStrategyBoardPackMarkdown,
  type CreateStrategyBoardPack,
  type GoalKpiAlert,
  type GoalWhyRequest,
  type GoalWhyRequestStatus,
  type GoalWithProgress,
  type KpiReadingSource,
  type KpiStatus,
  type SetStrategyBoardMembers,
  type StrategyBoardActionTask,
  type StrategyBoardMember,
  type StrategyBoardPack,
  type StrategyBoardPackListItem,
  type StrategyBoardPackSnapshot,
  type StrategyBoardPackStatus,
  type StrategyBoardSummary,
  type StrategyBoardViewerRights,
} from "@greatstone/shared";
import { logger } from "../middleware/logger.js";
import { unprocessable } from "../errors.js";
import { isEntitled } from "./entitlements.js";
import { goalService } from "./goals.js";
import { issueService } from "./issues.js";

/**
 * Board control panel (GRE-1135): the board summary, slippage alerts to the
 * chair, "Why?" requests and board packs. Every function takes the company
 * id and reads only that company's rows. Callers check the
 * `enableStrategyBoard` switch and who may act.
 */

export const BOARD_MEMBER_PERMISSION = "strategy:board_member";
export const BOARD_CHAIR_PERMISSION = "strategy:board_chair";
const BOARD_PERMISSIONS = [BOARD_MEMBER_PERMISSION, BOARD_CHAIR_PERMISSION];

export const KPI_ALERT_ORIGIN_KIND = "strategy_board_kpi_alert";
export const WHY_REQUEST_ORIGIN_KIND = "strategy_board_why_request";

/** A person's place on the board, from their membership role and board rights. */
export interface BoardStanding {
  role: string | null;
  /** A viewer with the board member right. */
  isBoardMember: boolean;
  /** Holds the chair right and is a board member or a company owner. */
  isChair: boolean;
}

type WhyRequestRow = typeof goalWhyRequests.$inferSelect;
type AlertRow = typeof goalKpiAlerts.$inferSelect;
type PackRow = typeof strategyBoardPacks.$inferSelect;

function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function toWhyRequest(row: WhyRequestRow): GoalWhyRequest {
  return { ...row, status: row.status as GoalWhyRequestStatus };
}

function toAlert(row: AlertRow): GoalKpiAlert {
  const { readingId: _readingId, ...rest } = row;
  return rest;
}

function toPack(row: PackRow): StrategyBoardPack {
  return { ...row, status: row.status as StrategyBoardPackStatus, snapshot: row.snapshot as unknown as StrategyBoardPackSnapshot };
}

/** Who makes a pack: a board member (accepted at once) or the board secretary agent (a draft). */
export type BoardPackMaker = { kind: "user"; userId: string | null } | { kind: "secretary"; agentId: string };

/** The agents a board member may ask, kept on their board member grant as `scope.agentIds` (GRE-1186). */
export function boardAgentIdsFromScope(scope: Record<string, unknown> | null | undefined): string[] {
  const ids = scope?.agentIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

function standingFrom(role: string | null, keys: ReadonlySet<string>): BoardStanding {
  const isBoardMember = role === "viewer" && keys.has(BOARD_MEMBER_PERMISSION);
  const isChair = keys.has(BOARD_CHAIR_PERMISSION) && (isBoardMember || role === "owner");
  return { role, isBoardMember, isChair };
}

/** Board rights of a signed-in person. Owners and admins (the C-suite) act like board members. */
export function boardViewerRights(
  standing: BoardStanding,
  opts: { isOwnerOrAdmin: boolean; isCompanyOwner: boolean },
): StrategyBoardViewerRights {
  const mayAct = standing.isBoardMember || standing.isChair || opts.isOwnerOrAdmin;
  return {
    isBoardMember: standing.isBoardMember,
    isChair: standing.isChair,
    mayAskWhy: mayAct,
    mayMakeBoardPack: mayAct,
    mayManageMembers: opts.isCompanyOwner,
  };
}

export function strategyBoardService(db: Db) {
  const goalsSvc = goalService(db);
  const issuesSvc = issueService(db);

  async function getStanding(companyId: string, userId: string): Promise<BoardStanding> {
    const [membership, grants] = await Promise.all([
      db
        .select({ role: companyMemberships.membershipRole })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ),
        )
        .then((rows) => rows[0] ?? null),
      db
        .select({ key: principalPermissionGrants.permissionKey })
        .from(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, "user"),
            eq(principalPermissionGrants.principalId, userId),
            inArray(principalPermissionGrants.permissionKey, BOARD_PERMISSIONS),
          ),
        ),
    ]);
    if (!membership) return { role: null, isBoardMember: false, isChair: false };
    return standingFrom(membership.role, new Set(grants.map((grant) => grant.key)));
  }

  /** The board chair's user id, or null when the board has no chair. */
  async function findChairUserId(companyId: string): Promise<string | null> {
    const holders = await db
      .select({ userId: principalPermissionGrants.principalId })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, "user"),
          eq(principalPermissionGrants.permissionKey, BOARD_CHAIR_PERMISSION),
        ),
      )
      .orderBy(asc(principalPermissionGrants.createdAt));
    for (const holder of holders) {
      if ((await getStanding(companyId, holder.userId)).isChair) return holder.userId;
    }
    return null;
  }

  async function loadOwnerNames(companyGoals: readonly GoalWithProgress[], tasks: readonly StrategyBoardActionTask[] = []) {
    const userIds = [
      ...new Set([...companyGoals.map((goal) => goal.ownerUserId), ...tasks.map((task) => task.assigneeUserId)].filter((id): id is string => !!id)),
    ];
    const agentIds = [
      ...new Set([...companyGoals.map((goal) => goal.ownerAgentId), ...tasks.map((task) => task.assigneeAgentId)].filter((id): id is string => !!id)),
    ];
    const [userRows, agentRows] = await Promise.all([
      userIds.length ? db.select({ id: authUsers.id, name: authUsers.name }).from(authUsers).where(inArray(authUsers.id, userIds)) : [],
      agentIds.length ? db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds)) : [],
    ]);
    return {
      users: new Map<string, string | null>(userRows.map((row) => [row.id, row.name])),
      agents: new Map<string, string | null>(agentRows.map((row) => [row.id, row.name])),
    };
  }

  /** The meeting's pack: the newest accepted one. Drafts never count. */
  async function latestPackRow(companyId: string): Promise<PackRow | null> {
    return db
      .select()
      .from(strategyBoardPacks)
      .where(and(eq(strategyBoardPacks.companyId, companyId), eq(strategyBoardPacks.status, "accepted")))
      .orderBy(desc(strategyBoardPacks.createdAt), desc(strategyBoardPacks.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function openWhyCounts(companyId: string): Promise<Map<string, number>> {
    const rows = await db
      .select({ goalId: goalWhyRequests.goalId })
      .from(goalWhyRequests)
      .where(and(eq(goalWhyRequests.companyId, companyId), eq(goalWhyRequests.status, "open")));
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.goalId, (counts.get(row.goalId) ?? 0) + 1);
    return counts;
  }

  /** Open, visible tasks with a due date before `today` (GRE-1188); the builder keeps those on the plan. */
  async function pastDueTasks(companyId: string, today: string): Promise<StrategyBoardActionTask[]> {
    return db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        goalId: issues.goalId,
        dueDate: issues.dueDate,
        assigneeUserId: issues.assigneeUserId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          isNotNull(issues.dueDate),
          lt(issues.dueDate, today),
          notInArray(issues.status, ["done", "cancelled"]),
          isNull(issues.hiddenAt),
        ),
      );
  }

  /** The board's picture of the plan today, compared with the last board pack. */
  async function buildBoard(companyId: string, today = todayIso()) {
    const [companyGoals, dueTasks] = await Promise.all([goalsSvc.listWithProgress(companyId), pastDueTasks(companyId, today)]);
    const [ownerNames, lastPack, openWhy, unsentAlerts] = await Promise.all([
      loadOwnerNames(companyGoals, dueTasks),
      latestPackRow(companyId),
      openWhyCounts(companyId),
      db
        .select({ id: goalKpiAlerts.id })
        .from(goalKpiAlerts)
        .where(and(eq(goalKpiAlerts.companyId, companyId), isNull(goalKpiAlerts.clearedAt), isNull(goalKpiAlerts.recipientUserId)))
        .then((rows) => rows.length),
    ]);
    const statusById = new Map<string, KpiStatus>();
    const latestReadingById = new Map<string, { readingDate: string; source: KpiReadingSource }>();
    const rollup = new Map(companyGoals.map((goal) => [goal.id, goal.ragRollup]));
    for (const goal of companyGoals) {
      if (goal.kpiStatus) statusById.set(goal.id, goal.kpiStatus);
      if (goal.latestReading) latestReadingById.set(goal.id, { readingDate: goal.latestReading.readingDate, source: goal.latestReading.source });
    }
    const lastSnapshot = lastPack ? toPack(lastPack).snapshot : null;
    const snapshotById = lastSnapshot
      ? new Map(lastSnapshot.kpis.map((kpi) => [kpi.goalId, { status: kpi.status, latestValue: kpi.latestValue }]))
      : null;
    const kpis = buildStrategyBoardKpis({
      goals: companyGoals,
      statusById,
      latestReadingById,
      snapshotById,
      openWhyById: openWhy,
      ownerNames,
      today,
    });
    return {
      kpis,
      overdueActions: buildStrategyBoardOverdueActions({ goals: companyGoals, tasks: dueTasks, ownerNames, today }),
      areas: buildStrategyBoardAreas(companyGoals, rollup, ownerNames),
      lastPack,
      unsentAlerts,
      ownerNames,
    };
  }

  async function summary(companyId: string, viewer: StrategyBoardViewerRights): Promise<StrategyBoardSummary> {
    const today = todayIso();
    const [board, chairUserId] = await Promise.all([buildBoard(companyId, today), findChairUserId(companyId)]);
    return {
      companyId,
      asOf: today,
      lastSnapshot: board.lastPack
        ? {
            packId: board.lastPack.id,
            title: board.lastPack.title,
            periodStart: board.lastPack.periodStart,
            periodEnd: board.lastPack.periodEnd,
            createdAt: board.lastPack.createdAt,
          }
        : null,
      counts: countStrategyBoardKpis(board.kpis),
      attention: rankStrategyBoardAttention(board.kpis),
      areas: board.areas,
      overdueActions: board.overdueActions,
      changes: board.lastPack ? board.kpis.filter((kpi) => kpi.changedSinceSnapshot) : [],
      kpis: board.kpis,
      unsentAlerts: board.unsentAlerts,
      hasChair: chairUserId != null,
      viewer,
    };
  }

  async function companyLink(companyId: string) {
    const company = await db
      .select({ name: companies.name, issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    return { name: company?.name ?? "Company", prefix: company?.issuePrefix ?? null };
  }

  function goalHref(prefix: string | null, goalId: string) {
    return prefix ? `/${prefix}/goals/${goalId}` : `/goals/${goalId}`;
  }

  async function closeIssue(issueId: string | null, comment: string) {
    if (!issueId) return;
    try {
      await issuesSvc.addComment(issueId, comment, {});
      await issuesSvc.update(issueId, { status: "done" });
    } catch (err) {
      logger.warn({ err, issueId }, "strategy board: could not close a board task");
    }
  }

  /**
   * Opens or clears KPI red spells for the company (or only `goalIds`) and
   * alerts the chair once per spell. Safe to run often: the open-spell unique
   * index means one alert per red state, even when two writes race.
   */
  async function evaluateAlerts(companyId: string, opts: { goalIds?: string[]; readingId?: string | null } = {}) {
    const companyGoals = await goalsSvc.listWithProgress(companyId);
    const kpis = companyGoals.filter(
      (goal) => goal.kind === "kpi" && goal.status !== "cancelled" && (!opts.goalIds || opts.goalIds.includes(goal.id)),
    );
    if (kpis.length === 0) return { opened: 0, cleared: 0 };
    const openRows = await db
      .select()
      .from(goalKpiAlerts)
      .where(and(eq(goalKpiAlerts.companyId, companyId), isNull(goalKpiAlerts.clearedAt), inArray(goalKpiAlerts.goalId, kpis.map((kpi) => kpi.id))));
    const openByGoal = new Map(openRows.map((row) => [row.goalId, row]));
    let opened = 0;
    let cleared = 0;
    let chair: { userId: string | null } | null = null;
    let link: Awaited<ReturnType<typeof companyLink>> | null = null;
    for (const kpi of kpis) {
      const open = openByGoal.get(kpi.id) ?? null;
      const status = kpi.kpiStatus?.status ?? null;
      const action = kpiAlertAction(status, open != null);
      if (action === "open") {
        chair ??= { userId: await findChairUserId(companyId) };
        const [row] = await db
          .insert(goalKpiAlerts)
          .values({
            companyId,
            goalId: kpi.id,
            readingId: opts.readingId ?? null,
            recipientUserId: chair.userId,
            gapPercent: kpi.kpiStatus?.gapPercent ?? null,
            latestValue: kpi.kpiStatus?.latestValue ?? null,
          })
          .onConflictDoNothing()
          .returning();
        // Another write opened this spell first: it sends the alert.
        if (!row) continue;
        opened += 1;
        if (!chair.userId) {
          logger.warn({ companyId, goalId: kpi.id }, "strategy board: KPI turned red but the board has no chair to alert");
          continue;
        }
        link ??= await companyLink(companyId);
        const s = kpi.kpiStatus!;
        const unit = kpi.unit ? ` ${kpi.unit}` : "";
        const issue = await issuesSvc.create(companyId, {
          title: `KPI turned red: ${kpi.title}`,
          description: [
            `**${kpi.title}** is off track.`,
            "",
            s.reason === "deadline_missed"
              ? `The deadline has passed and the target is not met: ${s.latestValue}${unit} against a target of ${s.plannedValue}${unit}.`
              : `${s.gapPercent}% behind plan: ${s.latestValue}${unit} against a plan of ${Math.round((s.plannedValue ?? 0) * 100) / 100}${unit} on ${s.latestDate}.`,
            "",
            `[Open the KPI](${goalHref(link.prefix, kpi.id)}) to see the readings and their source, or ask the owner "Why?" from the board control panel.`,
            "",
            "This task closes by itself when the KPI is no longer red.",
          ].join("\n"),
          status: "todo",
          priority: "high",
          assigneeUserId: chair.userId,
          goalId: kpi.id,
          originKind: KPI_ALERT_ORIGIN_KIND,
          originId: row.id,
        });
        await db.update(goalKpiAlerts).set({ alertIssueId: issue.id }).where(eq(goalKpiAlerts.id, row.id));
      } else if (action === "clear" && open) {
        await db.update(goalKpiAlerts).set({ clearedAt: new Date() }).where(eq(goalKpiAlerts.id, open.id));
        cleared += 1;
        await closeIssue(open.alertIssueId, `The KPI is no longer red (now ${status ?? "without a status"}).`);
      }
    }
    return { opened, cleared };
  }

  async function listAlerts(companyId: string): Promise<GoalKpiAlert[]> {
    return db
      .select()
      .from(goalKpiAlerts)
      .where(eq(goalKpiAlerts.companyId, companyId))
      .orderBy(desc(goalKpiAlerts.openedAt))
      .limit(200)
      .then((rows) => rows.map(toAlert));
  }

  async function createWhyRequest(
    goal: Pick<typeof goals.$inferSelect, "id" | "companyId" | "title" | "kind" | "ownerUserId" | "ownerAgentId">,
    question: string,
    askedByUserId: string,
  ): Promise<GoalWhyRequest> {
    if (goal.kind !== "kpi") throw unprocessable("\"Why?\" requests can only be sent on a KPI");
    if (!goal.ownerUserId && !goal.ownerAgentId) {
      throw unprocessable("This KPI has no owner to answer. Ask an owner or admin to set one first.", { code: "kpi_has_no_owner" });
    }
    const [row] = await db
      .insert(goalWhyRequests)
      .values({
        companyId: goal.companyId,
        goalId: goal.id,
        question,
        askedByUserId,
        ownerUserId: goal.ownerUserId,
        ownerAgentId: goal.ownerUserId ? null : goal.ownerAgentId,
      })
      .returning();
    const link = await companyLink(goal.companyId);
    // The owner's task, so the request lands in their inbox (a person) or
    // their queue (an agent). It is not a run: an agent takes it up on its
    // next heartbeat.
    const issue = await issuesSvc.create(goal.companyId, {
      title: `The board asks why: ${goal.title}`,
      description: [
        `A board member asks you to explain the slippage on **${goal.title}**:`,
        "",
        `> ${question.replace(/\r?\n/g, "\n> ")}`,
        "",
        `Answer on the [KPI page](${goalHref(link.prefix, goal.id)}) under "Why? requests", or with \`POST /api/why-requests/${row.id}/answer\` and \`{ "answer": "..." }\`.`,
        "Your answer is logged on the KPI and goes into the next board pack. This task closes when you answer.",
      ].join("\n"),
      status: "todo",
      priority: "high",
      assigneeUserId: goal.ownerUserId ?? null,
      assigneeAgentId: goal.ownerUserId ? null : goal.ownerAgentId,
      goalId: goal.id,
      originKind: WHY_REQUEST_ORIGIN_KIND,
      originId: row.id,
    });
    const [updated] = await db
      .update(goalWhyRequests)
      .set({ ownerIssueId: issue.id })
      .where(eq(goalWhyRequests.id, row.id))
      .returning();
    return toWhyRequest(updated);
  }

  async function answerWhyRequest(
    request: GoalWhyRequest,
    answer: string,
    by: { userId: string | null; agentId: string | null },
  ): Promise<GoalWhyRequest | null> {
    const [row] = await db
      .update(goalWhyRequests)
      .set({ status: "answered", answer, answeredByUserId: by.userId, answeredByAgentId: by.agentId, answeredAt: new Date() })
      .where(and(eq(goalWhyRequests.id, request.id), eq(goalWhyRequests.status, "open")))
      .returning();
    if (!row) return null;
    await closeIssue(row.ownerIssueId, `Answered:\n\n> ${answer.replace(/\r?\n/g, "\n> ")}`);
    return toWhyRequest(row);
  }

  async function createPack(companyId: string, input: CreateStrategyBoardPack, maker: BoardPackMaker): Promise<StrategyBoardPack> {
    const today = todayIso();
    const board = await buildBoard(companyId, today);
    const kpiIds = board.kpis.map((kpi) => kpi.goalId);
    const periodEndExclusive = new Date(`${input.periodEnd}T00:00:00Z`);
    periodEndExclusive.setUTCDate(periodEndExclusive.getUTCDate() + 1);
    const periodStartAt = new Date(`${input.periodStart}T00:00:00Z`);
    const [company, readings, whyRows] = await Promise.all([
      companyLink(companyId),
      kpiIds.length
        ? db
            .select()
            .from(goalKpiReadings)
            .where(
              and(
                eq(goalKpiReadings.companyId, companyId),
                inArray(goalKpiReadings.goalId, kpiIds),
                gte(goalKpiReadings.readingDate, input.periodStart),
                lte(goalKpiReadings.readingDate, input.periodEnd),
              ),
            )
            .orderBy(asc(goalKpiReadings.goalId), desc(goalKpiReadings.readingDate), desc(goalKpiReadings.createdAt))
        : [],
      db
        .select()
        .from(goalWhyRequests)
        .where(
          and(
            eq(goalWhyRequests.companyId, companyId),
            or(
              and(gte(goalWhyRequests.createdAt, periodStartAt), lt(goalWhyRequests.createdAt, periodEndExclusive)),
              and(gte(goalWhyRequests.answeredAt, periodStartAt), lt(goalWhyRequests.answeredAt, periodEndExclusive)),
            ),
          ),
        )
        .orderBy(asc(goalWhyRequests.createdAt)),
    ]);
    const kpiOwner = new Map(board.kpis.map((kpi) => [kpi.goalId, kpi.owner]));
    const title = input.title ?? `Board pack ${input.periodStart} to ${input.periodEnd}`;
    const snapshot: StrategyBoardPackSnapshot = {
      version: 1,
      companyName: company.name,
      title,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      asOf: today,
      counts: countStrategyBoardKpis(board.kpis),
      areas: board.areas,
      kpis: board.kpis,
      overdueActions: board.overdueActions,
      readings: readings.map((reading) => ({
        goalId: reading.goalId,
        value: reading.value,
        readingDate: reading.readingDate,
        source: reading.source as KpiReadingSource,
        note: reading.note,
      })),
      whyRequests: whyRows
        .filter((row) => kpiOwner.has(row.goalId))
        .map((row) => {
          const owner = row.ownerUserId
            ? { name: board.ownerNames.users.get(row.ownerUserId) ?? null }
            : row.ownerAgentId
              ? { name: board.ownerNames.agents.get(row.ownerAgentId) ?? kpiOwner.get(row.goalId)?.name ?? null }
              : null;
          return {
            goalId: row.goalId,
            question: row.question,
            status: row.status as GoalWhyRequestStatus,
            answer: row.answer,
            askedAt: row.createdAt.toISOString(),
            answeredAt: row.answeredAt?.toISOString() ?? null,
            ownerName: owner?.name ?? null,
          };
        }),
    };
    const [row] = await db
      .insert(strategyBoardPacks)
      .values({
        companyId,
        title,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        ...(maker.kind === "secretary"
          ? { status: "draft", createdByUserId: null, createdByAgentId: maker.agentId }
          : { status: "accepted", createdByUserId: maker.userId, acceptedByUserId: maker.userId, acceptedAt: new Date() }),
        snapshot: JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>,
        body: renderStrategyBoardPackMarkdown(snapshot),
      })
      .returning();
    return toPack(row);
  }

  /** A board member accepts a draft. Null when the pack is not a draft any more. */
  async function acceptPack(packId: string, userId: string | null): Promise<StrategyBoardPack | null> {
    const [row] = await db
      .update(strategyBoardPacks)
      .set({ status: "accepted", acceptedByUserId: userId, acceptedAt: new Date() })
      .where(and(eq(strategyBoardPacks.id, packId), eq(strategyBoardPacks.status, "draft")))
      .returning();
    return row ? toPack(row) : null;
  }

  async function listMembers(companyId: string): Promise<StrategyBoardMember[]> {
    const memberships = await db
      .select({ userId: companyMemberships.principalId, role: companyMemberships.membershipRole, name: authUsers.name, email: authUsers.email })
      .from(companyMemberships)
      .leftJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
        ),
      )
      .orderBy(asc(companyMemberships.createdAt));
    const grants = await db
      .select({ userId: principalPermissionGrants.principalId, key: principalPermissionGrants.permissionKey, scope: principalPermissionGrants.scope })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, "user"),
          inArray(principalPermissionGrants.permissionKey, BOARD_PERMISSIONS),
        ),
      );
    const keysByUser = new Map<string, Set<string>>();
    const agentIdsByUser = new Map<string, string[]>();
    for (const grant of grants) {
      const keys = keysByUser.get(grant.userId) ?? new Set<string>();
      keys.add(grant.key);
      keysByUser.set(grant.userId, keys);
      if (grant.key === BOARD_MEMBER_PERMISSION) agentIdsByUser.set(grant.userId, boardAgentIdsFromScope(grant.scope));
    }
    return memberships.map((member) => {
      const standing = standingFrom(member.role, keysByUser.get(member.userId) ?? new Set());
      return {
        userId: member.userId,
        name: member.name ?? null,
        email: member.email ?? null,
        role: member.role ?? "operator",
        isBoardMember: standing.isBoardMember,
        isChair: standing.isChair,
        agentIds: standing.isBoardMember ? agentIdsByUser.get(member.userId) ?? [] : [],
      };
    });
  }

  /**
   * Replaces the board: listed viewers become board members, the one marked
   * chair also gets the chair right. A company owner may be listed only as the
   * chair (owners are on the board already). Other roles are refused, so a
   * board member is always read-only outside the board actions.
   */
  async function setMembers(companyId: string, input: SetStrategyBoardMembers, grantedByUserId: string | null) {
    const members = await listMembers(companyId);
    const byId = new Map(members.map((member) => [member.userId, member]));
    for (const entry of input.members) {
      const member = byId.get(entry.userId);
      if (!member) throw unprocessable("Only active company members can sit on the board", { code: "board_member_not_found", userId: entry.userId });
      if (member.role === "owner" && !entry.chair) {
        throw unprocessable("Company owners are on the board already; list an owner only to make them chair", { code: "board_owner_not_chair", userId: entry.userId });
      }
      if (member.role !== "viewer" && member.role !== "owner") {
        throw unprocessable(
          "A board member must have the Viewer role, so they cannot edit goals, run agents or change settings. Change their role to Viewer first.",
          { code: "board_member_must_be_viewer", userId: entry.userId },
        );
      }
    }
    const keptScope = new Map(members.filter((member) => member.isBoardMember).map((member) => [member.userId, member.agentIds]));
    await db.transaction(async (tx) => {
      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, "user"),
            inArray(principalPermissionGrants.permissionKey, BOARD_PERMISSIONS),
          ),
        );
      const rows = input.members.flatMap((entry) => {
        const role = byId.get(entry.userId)!.role;
        const keys = [
          ...(role === "viewer" ? [BOARD_MEMBER_PERMISSION] : []),
          ...(entry.chair ? [BOARD_CHAIR_PERMISSION] : []),
        ];
        // A member who stays on the board keeps the agents they may ask (GRE-1186).
        const agentIds = keptScope.get(entry.userId) ?? [];
        return keys.map((permissionKey) => ({
          companyId,
          principalType: "user",
          principalId: entry.userId,
          permissionKey,
          scope: permissionKey === BOARD_MEMBER_PERMISSION && agentIds.length ? { agentIds } : null,
          grantedByUserId,
        }));
      });
      if (rows.length) await tx.insert(principalPermissionGrants).values(rows);
    });
    return listMembers(companyId);
  }

  return {
    getStanding,
    findChairUserId,
    buildBoard,
    companyLink,
    summary,
    evaluateAlerts,
    listAlerts,
    createWhyRequest,
    answerWhyRequest,
    getWhyRequest: (id: string) =>
      db
        .select()
        .from(goalWhyRequests)
        .where(eq(goalWhyRequests.id, id))
        .then((rows) => (rows[0] ? toWhyRequest(rows[0]) : null)),
    listWhyRequests: (goalId: string) =>
      db
        .select()
        .from(goalWhyRequests)
        .where(eq(goalWhyRequests.goalId, goalId))
        .orderBy(desc(goalWhyRequests.createdAt), desc(goalWhyRequests.id))
        .then((rows) => rows.map(toWhyRequest)),
    createPack,
    acceptPack,
    listPacks: (companyId: string): Promise<StrategyBoardPackListItem[]> =>
      db
        .select({
          id: strategyBoardPacks.id,
          companyId: strategyBoardPacks.companyId,
          title: strategyBoardPacks.title,
          periodStart: strategyBoardPacks.periodStart,
          periodEnd: strategyBoardPacks.periodEnd,
          status: strategyBoardPacks.status,
          createdByUserId: strategyBoardPacks.createdByUserId,
          createdByAgentId: strategyBoardPacks.createdByAgentId,
          acceptedByUserId: strategyBoardPacks.acceptedByUserId,
          acceptedAt: strategyBoardPacks.acceptedAt,
          createdAt: strategyBoardPacks.createdAt,
        })
        .from(strategyBoardPacks)
        .where(eq(strategyBoardPacks.companyId, companyId))
        .orderBy(desc(strategyBoardPacks.createdAt), desc(strategyBoardPacks.id))
        .then((rows) => rows.map((row) => ({ ...row, status: row.status as StrategyBoardPackStatus }))),
    getPack: (id: string) =>
      db
        .select()
        .from(strategyBoardPacks)
        .where(eq(strategyBoardPacks.id, id))
        .then((rows) => (rows[0] ? toPack(rows[0]) : null)),
    listMembers,
    setMembers,
  };
}

const ALERT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let lastAlertSweepAt = 0;

/**
 * Hourly: a KPI can turn red with no new reading (its deadline passes), so
 * every company's KPIs are checked once an hour while the switch is on.
 */
export async function runScheduledStrategyBoardAlerts(db: Db, now = Date.now()) {
  if (now - lastAlertSweepAt < ALERT_SWEEP_INTERVAL_MS) return;
  lastAlertSweepAt = now;
  if (!(await isEntitled(db, "enableStrategyBoard"))) return;
  const companyRows = await db.selectDistinct({ companyId: goals.companyId }).from(goals).where(eq(goals.kind, "kpi"));
  const svc = strategyBoardService(db);
  for (const { companyId } of companyRows) {
    try {
      await svc.evaluateAlerts(companyId);
    } catch (err) {
      logger.error({ err, companyId }, "strategy board: KPI alert sweep failed for a company");
    }
  }
}

