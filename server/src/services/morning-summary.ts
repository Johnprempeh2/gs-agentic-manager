import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { companies, heartbeatRuns, issues, pipelineCases, pipelines, pushSubscriptions } from "@greatstone/db";
import type { MorningSummary, MorningSummaryDeal, MorningSummaryTask, NeedsMe, NotificationPreferences } from "@greatstone/shared";
import { logger } from "../middleware/logger.js";
import { HOUSEKEEPING_ISSUE_ORIGIN_KINDS } from "./agent-work-digest.js";
import { executionIssueCondition } from "./issue-visibility.js";
import { needsMeService } from "./needs-me.js";
import { isHeld, localClock, notificationPreferencesService } from "./notification-preferences.js";
import type { DecisionPushMessage } from "./push-notifications.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Lines shown per section; the counts are always the full numbers. */
const ITEM_LIMIT = 3;
/**
 * Hours after the chosen hour in which a missed summary still goes out (the
 * server was asleep, or quiet hours ran past it). Later than that, the day
 * is skipped: a "morning" summary at tea time is noise.
 */
const CATCH_UP_HOURS = 3;

/** Work the user asked for: not a task the platform opened for itself. */
function userWork() {
  return and(
    executionIssueCondition(),
    or(isNull(issues.originKind), notInArray(issues.originKind, [...HOUSEKEEPING_ISSUE_ORIGIN_KINDS])),
  );
}

/** Needs you, in the order Decisions shows it: decisions, then assigned tasks, then overdue waits. */
export function needsYouItems(needsMe: NeedsMe): MorningSummaryTask[] {
  const items: MorningSummaryTask[] = [];
  const seen = new Set<string>();
  const push = (item: MorningSummaryTask) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    items.push(item);
  };
  for (const card of needsMe.decisions) {
    if (card.kind === "outage") continue;
    push({ id: card.task?.id ?? card.id, identifier: card.task?.identifier ?? null, title: card.task?.title ?? card.title });
  }
  for (const task of needsMe.assignedTasks) push({ id: task.id, identifier: task.identifier, title: task.title });
  for (const wait of needsMe.overdueWaits) push({ id: wait.id, identifier: wait.identifier, title: wait.title });
  return items;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The phone message: the headline is what needs you; the body is what got done and what is stuck. */
export function morningSummaryMessage(summary: MorningSummary, prefix: string): DecisionPushMessage {
  const needs = summary.needsYou.count;
  const title = needs === 0 ? "Good morning. Nothing needs you" : `Good morning. ${plural(needs, "thing needs", "things need")} you`;
  const parts = [
    ...(summary.dueToday.count > 0 ? [`${plural(summary.dueToday.count, "task is", "tasks are")} due today.`] : []),
    summary.finished.count === 0 ? "No tasks finished since yesterday." : `${plural(summary.finished.count, "task", "tasks")} finished since yesterday.`,
    summary.stuck.count === 0 ? "Nothing is stuck." : `${plural(summary.stuck.count, "task is", "tasks are")} stuck.`,
    ...(summary.deals && summary.deals.won > 0 ? [`${plural(summary.deals.won, "deal", "deals")} won.`] : []),
  ];
  return { title, body: parts.join(" "), url: `/${prefix}/morning`, tag: "morning-summary", badge: summary.needsYou.count };
}

/** True when this round should send today's summary to this person. */
export function morningSummaryDue(
  prefs: NotificationPreferences,
  lastSentOn: string | null,
  now: Date,
): { due: boolean; localDate: string } {
  const { hour, date } = localClock(prefs.timeZone, now);
  if (!prefs.morningSummary || lastSentOn === date) return { due: false, localDate: date };
  const sinceChosen = hour - prefs.morningSummaryHour;
  if (sinceChosen < 0 || sinceChosen > CATCH_UP_HOURS) return { due: false, localDate: date };
  return { due: !isHeld(prefs, now), localDate: date };
}

type Deliver = (companyId: string, userId: string, message: DecisionPushMessage) => Promise<{ targets: number; delivered: number }>;

/**
 * The morning summary: one message a day saying what needs you, what the
 * agents finished since yesterday and what is stuck. The same summary is a
 * page in the app, so the notification opens straight onto it.
 */
export function morningSummaryService(db: Db, options: { buildNeedsMe?: (companyId: string, userId: string) => Promise<NeedsMe> } = {}) {
  const needsMe = needsMeService(db);
  const buildNeedsMe = options.buildNeedsMe ?? ((companyId: string, userId: string) => needsMe.build(companyId, { userId }));
  const preferences = notificationPreferencesService(db);

  async function build(companyId: string, userId: string, now = new Date()): Promise<MorningSummary> {
    const since = new Date(now.getTime() - DAY_MS);
    // "Today" is the person's own date, not the server's.
    const { date: today } = localClock((await preferences.get(companyId, userId)).timeZone, now);
    const due = and(
      eq(issues.companyId, companyId),
      isNotNull(issues.dueDate),
      lte(issues.dueDate, today),
      notInArray(issues.status, ["done", "cancelled"]),
      userWork(),
    );
    // A task is being worked on when its execution run is still running.
    const working = and(
      eq(issues.companyId, companyId),
      notInArray(issues.status, ["done", "cancelled"]),
      inArray(heartbeatRuns.status, ["running", "queued"]),
      userWork(),
    );
    // Client deals (cases on pipelines that name an organisation) closed since yesterday.
    const closedDeals = and(
      eq(pipelineCases.companyId, companyId),
      eq(pipelines.requiresOrganisation, true),
      isNotNull(pipelineCases.terminalKind),
      gte(pipelineCases.terminalAt, since),
    );
    const [mine, finishedRows, finishedCount, stuckRows, stuckCount, dueRows, dueCount, workingRows, workingCount, dealRows, dealCounts] = await Promise.all([
      buildNeedsMe(companyId, userId),
      db
        .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.status, "done"), gte(issues.completedAt, since), userWork()))
        .orderBy(desc(issues.completedAt))
        .limit(ITEM_LIMIT),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.status, "done"), gte(issues.completedAt, since), userWork())),
      db
        .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.status, "blocked"), userWork()))
        .orderBy(desc(issues.updatedAt))
        .limit(ITEM_LIMIT),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.status, "blocked"), userWork())),
      db
        .select({ id: issues.id, identifier: issues.identifier, title: issues.title, dueDate: issues.dueDate })
        .from(issues)
        .where(due)
        .orderBy(asc(issues.dueDate), desc(issues.updatedAt))
        .limit(ITEM_LIMIT),
      db.select({ count: sql<number>`count(*)::int` }).from(issues).where(due),
      db
        .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
        .from(issues)
        .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, issues.executionRunId))
        .where(working)
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(ITEM_LIMIT),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(issues)
        .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, issues.executionRunId))
        .where(working),
      db
        .select({ id: pipelineCases.id, pipelineId: pipelineCases.pipelineId, title: pipelineCases.title, terminalKind: pipelineCases.terminalKind })
        .from(pipelineCases)
        .innerJoin(pipelines, eq(pipelines.id, pipelineCases.pipelineId))
        .where(closedDeals)
        .orderBy(desc(pipelineCases.terminalAt))
        .limit(ITEM_LIMIT),
      db
        .select({ terminalKind: pipelineCases.terminalKind, count: sql<number>`count(*)::int` })
        .from(pipelineCases)
        .innerJoin(pipelines, eq(pipelines.id, pipelineCases.pipelineId))
        .where(closedDeals)
        .groupBy(pipelineCases.terminalKind),
    ]);
    const dealCount = (kind: string) => dealCounts.find((row) => row.terminalKind === kind)?.count ?? 0;
    const dealItems: MorningSummaryDeal[] = dealRows.map((row) => ({
      id: row.id,
      pipelineId: row.pipelineId,
      title: row.title,
      outcome: row.terminalKind === "done" ? "won" : "lost",
    }));
    const needs = needsYouItems(mine);
    return {
      companyId,
      generatedAt: now.toISOString(),
      since: since.toISOString(),
      needsYou: { count: mine.count, items: needs.slice(0, ITEM_LIMIT) },
      dueToday: { count: dueCount[0]?.count ?? 0, items: dueRows },
      finished: { count: finishedCount[0]?.count ?? 0, items: finishedRows },
      stuck: { count: stuckCount[0]?.count ?? 0, items: stuckRows },
      workingNow: { count: workingCount[0]?.count ?? 0, items: workingRows },
      deals: { won: dealCount("done"), lost: dealCount("cancelled"), items: dealItems },
    };
  }

  return {
    build,

    /**
     * One round: send today's summary to each person with a phone registered
     * whose chosen hour has come. Each person gets it once a day per company.
     */
    async sendDue(deliver: Deliver, now = new Date()): Promise<number> {
      const audiences = await db
        .selectDistinct({ companyId: pushSubscriptions.companyId, userId: pushSubscriptions.userId, prefix: companies.issuePrefix })
        .from(pushSubscriptions)
        .innerJoin(companies, eq(companies.id, pushSubscriptions.companyId));
      let sent = 0;
      for (const { companyId, userId, prefix } of audiences) {
        try {
          const prefs = await preferences.get(companyId, userId);
          const { due, localDate } = morningSummaryDue(prefs, await preferences.lastMorningSummaryOn(companyId, userId), now);
          if (!due) continue;
          // Mark first: a slow or failing push service never sends it twice.
          await preferences.markMorningSummarySent(companyId, userId, localDate);
          const summary = await build(companyId, userId, now);
          const { delivered } = await deliver(companyId, userId, morningSummaryMessage(summary, prefix));
          sent += delivered;
        } catch (error) {
          logger.warn({ err: error, companyId }, "morning summary failed for one user");
        }
      }
      return sent;
    },
  };
}
