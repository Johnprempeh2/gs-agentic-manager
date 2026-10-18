import { and, asc, desc, eq, gt, gte, isNotNull, isNull, lt, lte, ne, notInArray, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Db } from "@greatstone/db";
import {
  activityLog,
  agentDailyDigests,
  agents,
  companies,
  costEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@greatstone/db";
import type {
  AgentDailyDigest,
  AgentDailyDigestAgent,
  AgentDailyDigestCounts,
  AgentDailyDigestItem,
  AgentDailyDigestMove,
  AgentDailyDigestPayload,
  WeeklyReportDay,
} from "@greatstone/shared";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { HOUSEKEEPING_ISSUE_ORIGIN_KINDS } from "./agent-work-digest.js";
import { documentService } from "./documents.js";
import { getCompanyLeadAgentId } from "./goals.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { issueService } from "./issues.js";

/** Marks the lead agent's standing "Daily digest" task; its originId is the company id. */
export const AGENT_DAILY_DIGEST_ORIGIN_KIND = "agent_daily_digest";
/** The document on the standing task; each night adds a new revision. */
export const AGENT_DAILY_DIGEST_DOCUMENT_KEY = "daily-digest";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Tasks listed per agent in each part of the digest. */
const ITEM_LIMIT = 3;
/** Rows read per source; keeps one night bounded on a very busy day. */
const SOURCE_ROW_LIMIT = 2000;
/** Longest range the read API returns in one call. */
export const AGENT_DAILY_DIGEST_MAX_RANGE_DAYS = 92;

const FAILED_RUN_STATUSES = new Set(["failed", "timed_out"]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const AGENT_DAILY_DIGEST_TASK_DESCRIPTION = [
  "Each night the platform writes what every agent did the day before, with what it cost, to the `daily-digest` document on this task.",
  "",
  "Read the latest revision when you plan your day. Follow up on failures and stuck work by creating or reassigning tasks.",
  "",
  "This task stays in the backlog on purpose, so it never wakes you. Leave it open: the next digest is written here.",
].join("\n");

// ---------------------------------------------------------------------------
// Pure parts: the window, the digest and its markdown.
// ---------------------------------------------------------------------------

/** The UTC day before `now`, YYYY-MM-DD: the day a nightly round reports on. */
export function previousUtcDay(now: Date): string {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(today - DAY_MS).toISOString().slice(0, 10);
}

/** 00:00 UTC on `date` to 00:00 UTC the next day. */
export function utcDayWindow(date: string): { start: Date; end: Date } {
  const start = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== date) {
    throw new Error(`Not a calendar date: ${date}`);
  }
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/** "15 Oct 2026". */
export function digestDateLabel(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${day} ${MONTHS[(month ?? 1) - 1]} ${year}`;
}

export interface AgentDailyDigestRows {
  agents: Array<{ id: string; name: string }>;
  completed: Array<{ agentId: string; identifier: string | null; title: string; at: Date }>;
  moves: Array<{ agentId: string; identifier: string | null; title: string; toStatus: string; at: Date }>;
  comments: Array<{ agentId: string; count: number }>;
  runs: Array<{ agentId: string; status: string; identifier: string | null; title: string | null; at: Date }>;
  costs: Array<{ agentId: string; cents: number }>;
}

function emptyCounts(): AgentDailyDigestCounts {
  return { tasksCompleted: 0, tasksMoved: 0, comments: 0, runs: 0, failures: 0, spendCents: 0 };
}

const activityScore = (counts: AgentDailyDigestCounts) =>
  counts.tasksCompleted + counts.tasksMoved + counts.comments + counts.runs + counts.failures;

const newestFirst = <T extends { at: Date }>(rows: T[]) => [...rows].sort((a, b) => b.at.getTime() - a.at.getTime());

/** Build one day's digest from the rows read for it. Pure: no database, no clock. */
export function buildAgentDailyDigest(date: string, rows: AgentDailyDigestRows): AgentDailyDigestPayload {
  const { start, end } = utcDayWindow(date);
  const nameById = new Map(rows.agents.map((agent) => [agent.id, agent.name]));
  const byAgent = new Map<string, AgentDailyDigestAgent>();
  const entry = (agentId: string) => {
    let found = byAgent.get(agentId);
    if (!found) {
      found = {
        agentId,
        name: nameById.get(agentId) ?? "Unknown agent",
        counts: emptyCounts(),
        completed: [],
        moved: [],
        failed: [],
      };
      byAgent.set(agentId, found);
    }
    return found;
  };
  const item = (row: { identifier: string | null; title: string | null }): AgentDailyDigestItem => ({
    identifier: row.identifier,
    title: row.title ?? "a task",
  });

  for (const row of newestFirst(rows.completed)) {
    const agent = entry(row.agentId);
    agent.counts.tasksCompleted += 1;
    if (agent.completed.length < ITEM_LIMIT) agent.completed.push(item(row));
  }
  for (const row of newestFirst(rows.moves)) {
    const agent = entry(row.agentId);
    agent.counts.tasksMoved += 1;
    if (agent.moved.length < ITEM_LIMIT) agent.moved.push({ ...item(row), toStatus: row.toStatus } satisfies AgentDailyDigestMove);
  }
  for (const row of rows.comments) {
    if (row.count > 0) entry(row.agentId).counts.comments += row.count;
  }
  for (const row of newestFirst(rows.runs)) {
    const agent = entry(row.agentId);
    agent.counts.runs += 1;
    if (!FAILED_RUN_STATUSES.has(row.status)) continue;
    agent.counts.failures += 1;
    if (agent.failed.length < ITEM_LIMIT && (row.identifier || row.title)) agent.failed.push(item(row));
  }
  for (const row of rows.costs) {
    if (row.cents > 0) entry(row.agentId).counts.spendCents += row.cents;
  }

  const list = [...byAgent.values()].sort(
    (a, b) =>
      activityScore(b.counts) - activityScore(a.counts) ||
      b.counts.spendCents - a.counts.spendCents ||
      a.name.localeCompare(b.name),
  );
  const totals = emptyCounts();
  for (const agent of list) {
    for (const key of Object.keys(totals) as (keyof AgentDailyDigestCounts)[]) totals[key] += agent.counts[key];
  }
  return { date, windowStart: start.toISOString(), windowEnd: end.toISOString(), totals, agents: list };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "$3.20": cents as dollars, the same way the board shows spend. */
export function centsLabel(cents: number): string {
  return `$${(cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function itemLabel(item: AgentDailyDigestItem): string {
  return item.identifier ? `${item.identifier} ${item.title}` : item.title;
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

function more(shown: number, total: number) {
  return total > shown ? `, and ${total - shown} more` : "";
}

/** One line on all the agents together. */
export function digestTotalsLine(totals: AgentDailyDigestCounts): string {
  const runs = totals.failures > 0
    ? `${plural(totals.runs, "run", "runs")} (${totals.failures} failed)`
    : plural(totals.runs, "run", "runs");
  return [
    `${plural(totals.tasksCompleted, "task", "tasks")} finished`,
    `${totals.tasksMoved} moved`,
    plural(totals.comments, "comment", "comments"),
    runs,
  ].join(", ") + `. Spend ${centsLabel(totals.spendCents)}.`;
}

/** The digest as markdown, for the lead agent. Task identifiers only; no internal ids. */
export function renderAgentDailyDigestMarkdown(payload: AgentDailyDigestPayload, companyName: string): string {
  const lines = [
    `# Daily digest for ${digestDateLabel(payload.date)}`,
    "",
    `What each agent at ${companyName || "the company"} did on ${digestDateLabel(payload.date)} (UTC), with what it cost.`,
    "",
    `**All agents:** ${digestTotalsLine(payload.totals)}`,
  ];
  if (payload.agents.length === 0) {
    lines.push("", "No agent did any work this day.");
    return lines.join("\n");
  }
  for (const agent of payload.agents) {
    const { counts } = agent;
    lines.push("", `## ${agent.name}`);
    if (counts.tasksCompleted > 0) {
      lines.push(
        `- Finished ${plural(counts.tasksCompleted, "task", "tasks")}: ${agent.completed.map(itemLabel).join("; ")}${more(agent.completed.length, counts.tasksCompleted)}`,
      );
    }
    if (counts.tasksMoved > 0) {
      lines.push(
        `- Moved ${plural(counts.tasksMoved, "task", "tasks")}: ${agent.moved
          .map((move) => `${itemLabel(move)} to ${statusLabel(move.toStatus)}`)
          .join("; ")}${more(agent.moved.length, counts.tasksMoved)}`,
      );
    }
    if (counts.comments > 0 || counts.runs > 0) {
      lines.push(`- ${plural(counts.comments, "comment", "comments")}, ${plural(counts.runs, "run", "runs")}`);
    }
    if (counts.failures > 0) {
      const where = agent.failed.length > 0 ? ` on ${agent.failed.map(itemLabel).join("; ")}` : "";
      lines.push(`- ${plural(counts.failures, "run", "runs")} failed${where}`);
    }
    lines.push(`- Spend ${centsLabel(counts.spendCents)}`);
  }
  return lines.join("\n");
}

/** One stored day, as the weekly report shows it. */
export function weeklyReportDay(payload: AgentDailyDigestPayload): WeeklyReportDay {
  const { totals } = payload;
  const busiest = payload.agents.find((agent) => activityScore(agent.counts) > 0);
  return {
    date: payload.date,
    tasksCompleted: totals.tasksCompleted,
    tasksMoved: totals.tasksMoved,
    comments: totals.comments,
    runs: totals.runs,
    failures: totals.failures,
    spendCents: totals.spendCents,
    busiestAgent: busiest?.name ?? null,
  };
}

// ---------------------------------------------------------------------------
// The service: read the day, store it once, write it to the lead agent's task.
// ---------------------------------------------------------------------------

/** Work the agents did for people: not hidden, not a task the platform opened for itself. */
const userFacingIssue = and(
  isNull(issues.hiddenAt),
  or(isNull(issues.originKind), notInArray(issues.originKind, [...HOUSEKEEPING_ISSUE_ORIGIN_KINDS])),
);

export type AgentDailyDigestRunResult =
  | { status: "exists"; digestId: string }
  | { status: "delivered"; digestId: string; issueId: string }
  | { status: "skipped"; digestId: string; reason: string };

type DigestRow = typeof agentDailyDigests.$inferSelect;

export function agentDailyDigestService(db: Db) {
  async function readRows(companyId: string, start: Date, end: Date): Promise<AgentDailyDigestRows> {
    const inWindow = (column: AnyPgColumn) => and(gte(column, start), lt(column, end));
    const status = sql<string>`${activityLog.details} ->> 'status'`;
    const previousStatus = sql<string | null>`${activityLog.details} -> '_previous' ->> 'status'`;
    const [agentRows, completed, moves, comments, runs, costs] = await Promise.all([
      db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.companyId, companyId)),
      db
        .select({ agentId: issues.assigneeAgentId, identifier: issues.identifier, title: issues.title, at: issues.completedAt })
        .from(issues)
        .where(and(
          eq(issues.companyId, companyId),
          eq(issues.status, "done"),
          isNotNull(issues.assigneeAgentId),
          inWindow(issues.completedAt),
          userFacingIssue,
        ))
        .limit(SOURCE_ROW_LIMIT),
      db
        .select({ agentId: activityLog.agentId, identifier: issues.identifier, title: issues.title, toStatus: status, at: activityLog.createdAt })
        .from(activityLog)
        .innerJoin(issues, and(eq(issues.companyId, activityLog.companyId), sql`${issues.id}::text = ${activityLog.entityId}`))
        .where(and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "issue.updated"),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.actorType, "agent"),
          isNotNull(activityLog.agentId),
          inWindow(activityLog.createdAt),
          sql`${status} is not null`,
          sql`${status} <> 'done'`,
          sql`${status} is distinct from ${previousStatus}`,
          userFacingIssue,
        ))
        .limit(SOURCE_ROW_LIMIT),
      db
        .select({ agentId: issueComments.authorAgentId, count: sql<number>`count(*)::int` })
        .from(issueComments)
        .innerJoin(issues, eq(issues.id, issueComments.issueId))
        .where(and(
          eq(issueComments.companyId, companyId),
          isNotNull(issueComments.authorAgentId),
          isNull(issueComments.deletedAt),
          inWindow(issueComments.createdAt),
          userFacingIssue,
        ))
        .groupBy(issueComments.authorAgentId),
      db
        .select({
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          identifier: issues.identifier,
          title: issues.title,
          at: heartbeatRuns.finishedAt,
        })
        .from(heartbeatRuns)
        .leftJoin(issues, sql`${issues.id}::text = ${heartbeatRuns.contextSnapshot} ->> 'issueId'`)
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          inWindow(heartbeatRuns.finishedAt),
          // A run on a housekeeping task is housekeeping too.
          or(isNull(issues.id), userFacingIssue),
        ))
        .limit(SOURCE_ROW_LIMIT),
      db
        .select({ agentId: costEvents.agentId, cents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
        .from(costEvents)
        .where(and(eq(costEvents.companyId, companyId), inWindow(costEvents.occurredAt)))
        .groupBy(costEvents.agentId),
    ]);
    return {
      agents: agentRows,
      completed: completed.flatMap((row) => (row.agentId && row.at ? [{ ...row, agentId: row.agentId, at: row.at }] : [])),
      moves: moves.flatMap((row) => (row.agentId ? [{ ...row, agentId: row.agentId }] : [])),
      comments: comments.flatMap((row) => (row.agentId ? [{ agentId: row.agentId, count: row.count }] : [])),
      runs: runs.flatMap((row) => (row.at ? [{ ...row, at: row.at }] : [])),
      costs,
    };
  }

  /** The open standing "Daily digest" task for the lead agent, created when missing. */
  async function ensureDigestTask(companyId: string, leadAgentId: string) {
    const existing = await db
      .select({ id: issues.id, identifier: issues.identifier, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, AGENT_DAILY_DIGEST_ORIGIN_KIND),
        eq(issues.originId, companyId),
        notInArray(issues.status, ["done", "cancelled"]),
        isNull(issues.hiddenAt),
      ))
      .orderBy(desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) {
      if (existing.assigneeAgentId !== leadAgentId) {
        // The lead changed: hand the standing task over without a wake.
        await db
          .update(issues)
          .set({ assigneeAgentId: leadAgentId, updatedAt: new Date() })
          .where(eq(issues.id, existing.id));
      }
      return { id: existing.id, identifier: existing.identifier };
    }
    const created = await issueService(db).create(companyId, {
      title: "Daily digest",
      description: AGENT_DAILY_DIGEST_TASK_DESCRIPTION,
      // Backlog, so the stranded-task recovery never wakes the lead for it at night.
      status: "backlog",
      priority: "low",
      assigneeAgentId: leadAgentId,
      originKind: AGENT_DAILY_DIGEST_ORIGIN_KIND,
      originId: companyId,
    });
    return { id: created.id, identifier: created.identifier };
  }

  async function finish(
    row: DigestRow,
    patch: { deliveredIssueId?: string; skippedReason?: string },
    activity: { issueId: string | null; identifier: string | null; leadAgentId: string | null },
  ) {
    const deliveredAt = patch.deliveredIssueId ? new Date() : null;
    await db
      .update(agentDailyDigests)
      .set({
        deliveredIssueId: patch.deliveredIssueId ?? null,
        deliveredAt,
        skippedReason: patch.skippedReason ?? null,
      })
      .where(eq(agentDailyDigests.id, row.id));
    await logActivity(db, {
      companyId: row.companyId,
      actorType: "system",
      actorId: "agent_daily_digest",
      action: patch.deliveredIssueId ? "agent_daily_digest.delivered" : "agent_daily_digest.skipped",
      entityType: activity.issueId ? "issue" : "agent_daily_digest",
      entityId: activity.issueId ?? row.id,
      agentId: activity.leadAgentId,
      issueId: activity.issueId,
      details: {
        date: row.digestDate,
        identifier: activity.identifier,
        agents: row.payload.agents.length,
        totals: row.payload.totals,
        ...(patch.skippedReason ? { skippedReason: patch.skippedReason } : {}),
      },
    });
  }

  /**
   * Store and deliver one company's digest for one UTC day. The unique row per
   * company and day is claimed first, so a second call (a restart, a second
   * server) finds it and does nothing.
   */
  async function runForCompany(companyId: string, date: string): Promise<AgentDailyDigestRunResult> {
    const already = await db
      .select({ id: agentDailyDigests.id })
      .from(agentDailyDigests)
      .where(and(eq(agentDailyDigests.companyId, companyId), eq(agentDailyDigests.digestDate, date)))
      .then((rows) => rows[0] ?? null);
    if (already) return { status: "exists", digestId: already.id };

    const company = await db
      .select({ name: companies.name, status: companies.status })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) throw new Error("Company not found");

    const { start, end } = utcDayWindow(date);
    const payload = buildAgentDailyDigest(date, await readRows(companyId, start, end));
    const body = renderAgentDailyDigestMarkdown(payload, company.name);
    const leadAgentId = await getCompanyLeadAgentId(db, companyId);

    const [row] = await db
      .insert(agentDailyDigests)
      .values({ companyId, digestDate: date, windowStart: start, windowEnd: end, payload, body, leadAgentId })
      .onConflictDoNothing({ target: [agentDailyDigests.companyId, agentDailyDigests.digestDate] })
      .returning();
    if (!row) {
      const winner = await db
        .select({ id: agentDailyDigests.id })
        .from(agentDailyDigests)
        .where(and(eq(agentDailyDigests.companyId, companyId), eq(agentDailyDigests.digestDate, date)))
        .then((rows) => rows[0]!);
      return { status: "exists", digestId: winner.id };
    }

    const skip = async (reason: string, issue: { id: string; identifier: string | null } | null = null) => {
      await finish(row, { skippedReason: reason }, { issueId: issue?.id ?? null, identifier: issue?.identifier ?? null, leadAgentId });
      return { status: "skipped" as const, digestId: row.id, reason };
    };
    if (company.status !== "active") return skip("company_paused");
    if (!leadAgentId) return skip("no_lead_agent");

    try {
      const task = await ensureDigestTask(companyId, leadAgentId);
      if (await issueTreeControlService(db).getActivePauseHoldGate(companyId, task.id)) return skip("pause_hold", task);
      const docs = documentService(db);
      const current = await docs.getIssueDocumentByKey(task.id, AGENT_DAILY_DIGEST_DOCUMENT_KEY);
      await docs.upsertIssueDocument({
        issueId: task.id,
        baseRevisionId: current?.latestRevisionId ?? null,
        key: AGENT_DAILY_DIGEST_DOCUMENT_KEY,
        title: "Daily digest",
        format: "markdown",
        body,
        changeSummary: `Digest for ${digestDateLabel(date)}`,
        lockedDocumentStrategy: "create_new_document",
      });
      await finish(row, { deliveredIssueId: task.id }, { issueId: task.id, identifier: task.identifier, leadAgentId });
      return { status: "delivered", digestId: row.id, issueId: task.id };
    } catch (error) {
      // Stored but not delivered: marked, so no later round sends it twice.
      logger.warn({ err: error, companyId, date }, "daily digest delivery failed");
      return skip("delivery_failed");
    }
  }

  return {
    readRows,
    runForCompany,

    /**
     * One round: for every live company without a digest for yesterday (UTC),
     * build, store and deliver it. Safe to call as often as you like.
     */
    async runDue(now = new Date()): Promise<{ date: string; delivered: number; skipped: number }> {
      const date = previousUtcDay(now);
      const { end } = utcDayWindow(date);
      const due = await db
        .select({ id: companies.id })
        .from(companies)
        .where(and(
          ne(companies.status, "archived"),
          lt(companies.createdAt, end),
          sql`not exists (select 1 from ${agentDailyDigests} where ${agentDailyDigests.companyId} = ${companies.id} and ${agentDailyDigests.digestDate} = ${date})`,
        ))
        .orderBy(asc(companies.createdAt));
      let delivered = 0;
      let skipped = 0;
      for (const { id } of due) {
        try {
          const result = await runForCompany(id, date);
          if (result.status === "delivered") delivered += 1;
          if (result.status === "skipped") skipped += 1;
        } catch (error) {
          logger.warn({ err: error, companyId: id, date }, "daily digest failed for one company");
        }
      }
      return { date, delivered, skipped };
    },

    /** Stored digests from `from` to `to` (both YYYY-MM-DD, inclusive), newest first. */
    async list(companyId: string, from: string, to: string): Promise<AgentDailyDigest[]> {
      const rows = await db
        .select({ digest: agentDailyDigests, identifier: issues.identifier })
        .from(agentDailyDigests)
        .leftJoin(issues, eq(issues.id, agentDailyDigests.deliveredIssueId))
        .where(and(
          eq(agentDailyDigests.companyId, companyId),
          gte(agentDailyDigests.digestDate, from),
          lte(agentDailyDigests.digestDate, to),
        ))
        .orderBy(desc(agentDailyDigests.digestDate));
      return rows.map(({ digest, identifier }) => ({
        id: digest.id,
        companyId: digest.companyId,
        date: digest.digestDate,
        payload: digest.payload,
        body: digest.body,
        leadAgentId: digest.leadAgentId,
        deliveredIssueId: digest.deliveredIssueId,
        deliveredIssueIdentifier: identifier ?? null,
        deliveredAt: digest.deliveredAt?.toISOString() ?? null,
        skippedReason: digest.skippedReason,
        createdAt: digest.createdAt.toISOString(),
      }));
    },

    /** The stored days from `since` up to `now`, oldest first, for the weekly report. */
    async weekDays(companyId: string, since: Date, now: Date): Promise<WeeklyReportDay[]> {
      const rows = await db
        .select({ payload: agentDailyDigests.payload })
        .from(agentDailyDigests)
        .where(and(
          eq(agentDailyDigests.companyId, companyId),
          // Every stored day that ends inside the week.
          gt(agentDailyDigests.windowEnd, since),
          lte(agentDailyDigests.windowEnd, now),
        ))
        .orderBy(asc(agentDailyDigests.digestDate));
      return rows.map((row) => weeklyReportDay(row.payload));
    },
  };
}
