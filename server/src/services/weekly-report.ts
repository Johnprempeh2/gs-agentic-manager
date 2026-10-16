import { and, desc, eq, gte, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@greatstone/db";
import { agents, companies, costEvents, issues, pipelineCaseEvents, pipelineCases, pipelineStages, pipelines } from "@greatstone/db";
import type { NeedsMe, WeeklyReport, WeeklyReportAgentWork } from "@greatstone/shared";
import { HOUSEKEEPING_ISSUE_ORIGIN_KINDS } from "./agent-work-digest.js";
import { executionIssueCondition } from "./issue-visibility.js";
import { needsYouItems } from "./morning-summary.js";
import { needsMeService } from "./needs-me.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const AGENT_ITEM_LIMIT = 3;
const STUCK_LIMIT = 10;
const MOVE_LIMIT = 8;
const NEEDS_YOU_LIMIT = 5;
const STAGE_MOVE_TYPES = ["transitioned", "transition_forced"];

/** Work the user asked for: not a task the platform opened for itself. */
function userWork() {
  return and(
    executionIssueCondition(),
    or(isNull(issues.originKind), notInArray(issues.originKind, [...HOUSEKEEPING_ISSUE_ORIGIN_KINDS])),
  );
}

const iso = (value: Date | string) => (value instanceof Date ? value : new Date(value)).toISOString();

/**
 * The weekly executive report: one page on the last seven days, for one
 * reader in one company ("needs you" is theirs; the rest is the company's).
 */
export function weeklyReportService(db: Db, options: { buildNeedsMe?: (companyId: string, userId: string) => Promise<NeedsMe> } = {}) {
  const needsMe = needsMeService(db);
  const buildNeedsMe = options.buildNeedsMe ?? ((companyId: string, userId: string) => needsMe.build(companyId, { userId }));
  const fromStage = alias(pipelineStages, "from_stage");
  const toStage = alias(pipelineStages, "to_stage");

  async function build(companyId: string, userId: string, now = new Date()): Promise<WeeklyReport> {
    const since = new Date(now.getTime() - WEEK_MS);
    const stuckSince = sql<Date>`coalesce(${issues.blockedTransitionAt}, ${issues.updatedAt})`;
    const [company, mine, finishedRows, stuckRows, stuckCount, moveRows, moveCounts, addedCount, costRows] = await Promise.all([
      db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)).then((rows) => rows[0]),
      buildNeedsMe(companyId, userId),
      db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          agentId: issues.assigneeAgentId,
          agentName: agents.name,
        })
        .from(issues)
        .innerJoin(agents, eq(agents.id, issues.assigneeAgentId))
        .where(and(eq(issues.companyId, companyId), eq(issues.status, "done"), gte(issues.completedAt, since), userWork()))
        .orderBy(desc(issues.completedAt)),
      db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          agentName: agents.name,
          stuckSince,
        })
        .from(issues)
        .leftJoin(agents, eq(agents.id, issues.assigneeAgentId))
        .where(and(eq(issues.companyId, companyId), eq(issues.status, "blocked"), userWork()))
        .orderBy(stuckSince)
        .limit(STUCK_LIMIT),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.status, "blocked"), userWork())),
      db
        .select({
          caseId: pipelineCases.id,
          title: pipelineCases.title,
          pipelineName: pipelines.name,
          fromStage: fromStage.name,
          toStage: toStage.name,
          at: pipelineCaseEvents.createdAt,
        })
        .from(pipelineCaseEvents)
        .innerJoin(pipelineCases, eq(pipelineCases.id, pipelineCaseEvents.caseId))
        .innerJoin(pipelines, eq(pipelines.id, pipelineCases.pipelineId))
        .innerJoin(toStage, eq(toStage.id, pipelineCaseEvents.toStageId))
        .leftJoin(fromStage, eq(fromStage.id, pipelineCaseEvents.fromStageId))
        .where(
          and(
            eq(pipelineCaseEvents.companyId, companyId),
            inArray(pipelineCaseEvents.type, STAGE_MOVE_TYPES),
            gte(pipelineCaseEvents.createdAt, since),
            isNull(pipelineCases.retiredAt),
          ),
        )
        .orderBy(desc(pipelineCaseEvents.createdAt))
        .limit(MOVE_LIMIT),
      db
        .select({
          moved: sql<number>`count(*)::int`,
          won: sql<number>`count(*) filter (where ${toStage.kind} = 'done')::int`,
          lost: sql<number>`count(*) filter (where ${toStage.kind} = 'cancelled')::int`,
        })
        .from(pipelineCaseEvents)
        .innerJoin(pipelineCases, eq(pipelineCases.id, pipelineCaseEvents.caseId))
        .innerJoin(toStage, eq(toStage.id, pipelineCaseEvents.toStageId))
        .where(
          and(
            eq(pipelineCaseEvents.companyId, companyId),
            inArray(pipelineCaseEvents.type, STAGE_MOVE_TYPES),
            gte(pipelineCaseEvents.createdAt, since),
            isNull(pipelineCases.retiredAt),
          ),
        ),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(pipelineCases)
        .where(and(eq(pipelineCases.companyId, companyId), gte(pipelineCases.createdAt, since), isNull(pipelineCases.retiredAt))),
      db
        .select({ agentId: costEvents.agentId, name: agents.name, cents: sql<number>`sum(${costEvents.costCents})::int` })
        .from(costEvents)
        .innerJoin(agents, eq(agents.id, costEvents.agentId))
        .where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, since)))
        .groupBy(costEvents.agentId, agents.name),
    ]);

    const byAgent = new Map<string, WeeklyReportAgentWork>();
    for (const row of finishedRows) {
      const entry = byAgent.get(row.agentId!) ?? { agentId: row.agentId!, name: row.agentName, finished: 0, items: [] };
      entry.finished += 1;
      if (entry.items.length < AGENT_ITEM_LIMIT) entry.items.push({ id: row.id, identifier: row.identifier, title: row.title });
      byAgent.set(entry.agentId, entry);
    }
    const workers = [...byAgent.values()].sort((a, b) => b.finished - a.finished || a.name.localeCompare(b.name));
    const costs = costRows.filter((row) => row.cents > 0).sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name));

    return {
      companyId,
      companyName: company?.name ?? "",
      generatedAt: now.toISOString(),
      since: since.toISOString(),
      finished: { count: finishedRows.length, agents: workers },
      stuck: {
        count: stuckCount[0]?.count ?? 0,
        items: stuckRows.map((row) => ({
          id: row.id,
          identifier: row.identifier,
          title: row.title,
          agentName: row.agentName ?? null,
          stuckSince: iso(row.stuckSince),
        })),
      },
      pipeline: {
        added: addedCount[0]?.count ?? 0,
        moved: moveCounts[0]?.moved ?? 0,
        won: moveCounts[0]?.won ?? 0,
        lost: moveCounts[0]?.lost ?? 0,
        moves: moveRows.map((row) => ({ ...row, fromStage: row.fromStage ?? null, at: iso(row.at) })),
      },
      needsYou: { count: mine.count, items: needsYouItems(mine).slice(0, NEEDS_YOU_LIMIT) },
      costs: {
        totalCents: costs.reduce((sum, row) => sum + row.cents, 0),
        agents: costs.map((row) => ({ agentId: row.agentId, name: row.name, cents: row.cents })),
      },
    };
  }

  return { build };
}
