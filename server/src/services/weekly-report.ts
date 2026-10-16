import { and, desc, eq, gte, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@greatstone/db";
import { agents, companies, costEvents, issues, pipelineCaseEvents, pipelineCases, pipelineStages, pipelines, pushSubscriptions } from "@greatstone/db";
import type { NeedsMe, NotificationPreferences, WeeklyReport, WeeklyReportAgentWork } from "@greatstone/shared";
import { logger } from "../middleware/logger.js";
import { HOUSEKEEPING_ISSUE_ORIGIN_KINDS } from "./agent-work-digest.js";
import { executionIssueCondition } from "./issue-visibility.js";
import { needsYouItems } from "./morning-summary.js";
import { needsMeService } from "./needs-me.js";
import { isQuietHour, localClock, notificationPreferencesService } from "./notification-preferences.js";
import type { DecisionPushMessage } from "./push-notifications.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const AGENT_ITEM_LIMIT = 3;
const STUCK_LIMIT = 10;
const MOVE_LIMIT = 8;
const NEEDS_YOU_LIMIT = 5;
const STAGE_MOVE_TYPES = ["transitioned", "transition_forced"];
/** Hours after the chosen hour in which a missed Monday report still goes out. */
const CATCH_UP_HOURS = 3;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Monday (1) to Sunday (7) for a local YYYY-MM-DD date. */
function isoWeekday(localDate: string): number {
  const day = new Date(`${localDate}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** True when this round should send this week's report: Monday, at the morning summary hour, once. */
export function weeklyReportDue(
  prefs: NotificationPreferences,
  lastSentOn: string | null,
  now: Date,
): { due: boolean; localDate: string } {
  const { hour, date } = localClock(prefs.timeZone, now);
  if (!prefs.weeklyReport || lastSentOn === date || isoWeekday(date) !== 1) return { due: false, localDate: date };
  const sinceChosen = hour - prefs.morningSummaryHour;
  if (sinceChosen < 0 || sinceChosen > CATCH_UP_HOURS) return { due: false, localDate: date };
  return { due: !isQuietHour(prefs, now), localDate: date };
}

/** The phone message: the week in one line; tapping it opens the full report. */
export function weeklyReportMessage(report: WeeklyReport, prefix: string): DecisionPushMessage {
  const parts = [
    `${plural(report.finished.count, "task", "tasks")} finished.`,
    report.stuck.count === 0 ? "Nothing stuck." : `${report.stuck.count} stuck.`,
  ];
  if (report.pipeline.moved > 0 || report.pipeline.added > 0) {
    parts.push(`Pipeline: ${report.pipeline.added} new, ${plural(report.pipeline.moved, "move", "moves")}.`);
  }
  parts.push(report.needsYou.count === 0 ? "Nothing needs you." : `${plural(report.needsYou.count, "thing needs", "things need")} you.`);
  return {
    title: `Your week at ${report.companyName || "the company"}`,
    body: parts.join(" "),
    url: `/${prefix}/weekly-report`,
    tag: "weekly-report",
    badge: report.needsYou.count,
  };
}

type Deliver = (companyId: string, userId: string, message: DecisionPushMessage) => Promise<{ targets: number; delivered: number }>;

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

  const preferences = notificationPreferencesService(db);

  return {
    build,

    /** One round: send this week's report to each person who chose it, with a phone registered, on Monday morning. */
    async sendDue(deliver: Deliver, now = new Date()): Promise<number> {
      const audiences = await db
        .selectDistinct({ companyId: pushSubscriptions.companyId, userId: pushSubscriptions.userId, prefix: companies.issuePrefix })
        .from(pushSubscriptions)
        .innerJoin(companies, eq(companies.id, pushSubscriptions.companyId));
      let sent = 0;
      for (const { companyId, userId, prefix } of audiences) {
        try {
          const prefs = await preferences.get(companyId, userId);
          if (!prefs.weeklyReport) continue;
          const { due, localDate } = weeklyReportDue(prefs, await preferences.lastWeeklyReportOn(companyId, userId), now);
          if (!due) continue;
          // Mark first: a slow or failing push service never sends it twice.
          await preferences.markWeeklyReportSent(companyId, userId, localDate);
          const report = await build(companyId, userId, now);
          const { delivered } = await deliver(companyId, userId, weeklyReportMessage(report, prefix));
          sent += delivered;
        } catch (error) {
          logger.warn({ err: error, companyId }, "weekly report failed for one user");
        }
      }
      return sent;
    },
  };
}
