import { and, eq, gte, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  agents,
  approvals,
  companyUserVisits,
  decisions,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@greatstone/db";
import type {
  AgentWorkDigest,
  AgentWorkDigestAgent,
  AgentWorkDigestCounts,
  AgentWorkDigestItem,
  AgentWorkDigestItemKind,
  AgentWorkDigestSinceSource,
  AgentWorkDigestVisit,
} from "@greatstone/shared";

/** Used when the user has no stored visit yet. */
export const AGENT_WORK_DIGEST_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Rows read per source; keeps one digest request bounded after a long absence. */
const SOURCE_ROW_LIMIT = 500;

/**
 * Tasks the platform opens for itself (recovery, watchdog, liveness checks).
 * They are housekeeping, not agent work the user asked for, so the digest leaves them out.
 */
export const HOUSEKEEPING_ISSUE_ORIGIN_KINDS = [
  "stale_active_run_evaluation",
  "task_watchdog",
  "task_watchdog_product_bug",
  "stranded_issue_recovery",
  "issue_productivity_review",
  "harness_liveness_escalation",
  "skill_test",
] as const;

const FAILED_RUN_STATUSES = ["failed", "timed_out"] as const;

type DigestEntry = AgentWorkDigestItem & { agentId: string };

function emptyCounts(): AgentWorkDigestCounts {
  return { tasksFinished: 0, tasksStarted: 0, decisionsRaised: 0, failures: 0 };
}

const COUNT_KEY: Record<AgentWorkDigestItemKind, keyof AgentWorkDigestCounts> = {
  task_finished: "tasksFinished",
  task_started: "tasksStarted",
  decision_raised: "decisionsRaised",
  run_failed: "failures",
};

function taskName(identifier: string | null, title: string | null) {
  if (identifier && title) return `${identifier}: ${title}`;
  return identifier ?? title ?? "a task";
}

function humanize(code: string) {
  const words = code.replace(/[_.]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "request";
}

function iso(value: Date) {
  return value.toISOString();
}

/** Agent-work rows only: hidden tasks and housekeeping tasks are excluded. */
const userFacingIssue = and(
  isNull(issues.hiddenAt),
  notInArray(issues.originKind, [...HOUSEKEEPING_ISSUE_ORIGIN_KINDS]),
);

export function agentWorkDigestService(db: Db) {
  async function getLastVisit(companyId: string, userId: string): Promise<Date | null> {
    const row = await db.query.companyUserVisits.findFirst({
      where: and(eq(companyUserVisits.companyId, companyId), eq(companyUserVisits.userId, userId)),
    });
    return row?.lastVisitedAt ?? null;
  }

  async function recordVisit(companyId: string, userId: string, at = new Date()): Promise<AgentWorkDigestVisit> {
    const [row] = await db
      .insert(companyUserVisits)
      .values({ companyId, userId, lastVisitedAt: at })
      .onConflictDoUpdate({
        target: [companyUserVisits.companyId, companyUserVisits.userId],
        // Never move the marker backwards if two tabs report out of order.
        set: { lastVisitedAt: sql`greatest(${companyUserVisits.lastVisitedAt}, excluded.last_visited_at)` },
      })
      .returning();
    return { companyId, lastVisitedAt: iso(row?.lastVisitedAt ?? at) };
  }

  async function collect(companyId: string, since: Date): Promise<DigestEntry[]> {
    const [finished, started, failedRuns, raisedDecisions, raisedApprovals, raisedInteractions] = await Promise.all([
      db
        .select({ id: issues.id, identifier: issues.identifier, title: issues.title, agentId: issues.assigneeAgentId, at: issues.completedAt })
        .from(issues)
        .where(and(
          eq(issues.companyId, companyId),
          eq(issues.status, "done"),
          isNotNull(issues.assigneeAgentId),
          gte(issues.completedAt, since),
          userFacingIssue,
        ))
        .limit(SOURCE_ROW_LIMIT),
      db
        .select({ id: issues.id, identifier: issues.identifier, title: issues.title, agentId: issues.assigneeAgentId, at: issues.startedAt })
        .from(issues)
        .where(and(
          eq(issues.companyId, companyId),
          isNotNull(issues.assigneeAgentId),
          gte(issues.startedAt, since),
          userFacingIssue,
        ))
        .limit(SOURCE_ROW_LIMIT),
      db
        .select({
          runId: heartbeatRuns.id,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          at: heartbeatRuns.finishedAt,
          issueId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
        })
        .from(heartbeatRuns)
        .leftJoin(issues, sql`${issues.id}::text = ${heartbeatRuns.contextSnapshot} ->> 'issueId'`)
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, [...FAILED_RUN_STATUSES]),
          gte(heartbeatRuns.finishedAt, since),
          // A failed run on a housekeeping task is housekeeping too.
          or(isNull(issues.id), userFacingIssue),
        ))
        .limit(SOURCE_ROW_LIMIT),
      db
        .select({
          agentId: decisions.originAgentId,
          title: decisions.title,
          at: decisions.createdAt,
          runId: decisions.originRunId,
          issueId: issues.id,
          identifier: issues.identifier,
        })
        .from(decisions)
        .innerJoin(issues, eq(issues.id, decisions.originIssueId))
        .where(and(eq(decisions.companyId, companyId), gte(decisions.createdAt, since), userFacingIssue))
        .limit(SOURCE_ROW_LIMIT),
      db
        .select({ agentId: approvals.requestedByAgentId, type: approvals.type, at: approvals.createdAt })
        .from(approvals)
        .where(and(
          eq(approvals.companyId, companyId),
          isNotNull(approvals.requestedByAgentId),
          gte(approvals.createdAt, since),
        ))
        .limit(SOURCE_ROW_LIMIT),
      db
        .select({
          agentId: issueThreadInteractions.createdByAgentId,
          runId: issueThreadInteractions.sourceRunId,
          at: issueThreadInteractions.createdAt,
          issueId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
        })
        .from(issueThreadInteractions)
        .innerJoin(issues, eq(issues.id, issueThreadInteractions.issueId))
        .where(and(
          eq(issueThreadInteractions.companyId, companyId),
          isNotNull(issueThreadInteractions.createdByAgentId),
          gte(issueThreadInteractions.createdAt, since),
          userFacingIssue,
        ))
        .limit(SOURCE_ROW_LIMIT),
    ]);

    const entries: DigestEntry[] = [];
    for (const row of finished) {
      if (!row.agentId || !row.at) continue;
      entries.push({
        agentId: row.agentId,
        kind: "task_finished",
        label: `Finished ${taskName(row.identifier, row.title)}`,
        at: iso(row.at),
        issueId: row.id,
        issueIdentifier: row.identifier,
        runId: null,
      });
    }
    for (const row of started) {
      if (!row.agentId || !row.at) continue;
      entries.push({
        agentId: row.agentId,
        kind: "task_started",
        label: `Started ${taskName(row.identifier, row.title)}`,
        at: iso(row.at),
        issueId: row.id,
        issueIdentifier: row.identifier,
        runId: null,
      });
    }
    for (const row of failedRuns) {
      if (!row.at) continue;
      const verb = row.status === "timed_out" ? "Run timed out" : "Run failed";
      entries.push({
        agentId: row.agentId,
        kind: "run_failed",
        label: row.issueId ? `${verb} on ${taskName(row.identifier, row.title)}` : verb,
        at: iso(row.at),
        issueId: row.issueId,
        issueIdentifier: row.identifier,
        runId: row.runId,
      });
    }
    for (const row of raisedDecisions) {
      entries.push({
        agentId: row.agentId,
        kind: "decision_raised",
        label: `Asked you to decide: ${row.title}`,
        at: iso(row.at),
        issueId: row.issueId,
        issueIdentifier: row.identifier,
        runId: row.runId,
      });
    }
    for (const row of raisedApprovals) {
      if (!row.agentId) continue;
      entries.push({
        agentId: row.agentId,
        kind: "decision_raised",
        label: `Asked for approval: ${humanize(row.type)}`,
        at: iso(row.at),
        issueId: null,
        issueIdentifier: null,
        runId: null,
      });
    }
    for (const row of raisedInteractions) {
      if (!row.agentId) continue;
      entries.push({
        agentId: row.agentId,
        kind: "decision_raised",
        label: `Asked you a question on ${taskName(row.identifier, row.title)}`,
        at: iso(row.at),
        issueId: row.issueId,
        issueIdentifier: row.identifier,
        runId: row.runId,
      });
    }
    return entries;
  }

  async function groupByAgent(companyId: string, entries: DigestEntry[]): Promise<AgentWorkDigestAgent[]> {
    const agentIds = [...new Set(entries.map((entry) => entry.agentId))];
    const names = agentIds.length === 0
      ? []
      : await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)));
    const nameById = new Map(names.map((row) => [row.id, row.name]));

    const groups = new Map<string, AgentWorkDigestAgent>();
    for (const { agentId, ...item } of entries) {
      let group = groups.get(agentId);
      if (!group) {
        group = { agentId, agentName: nameById.get(agentId) ?? "Unknown agent", counts: emptyCounts(), items: [] };
        groups.set(agentId, group);
      }
      group.counts[COUNT_KEY[item.kind]] += 1;
      group.items.push(item);
    }
    const result = [...groups.values()];
    for (const group of result) group.items.sort((a, b) => b.at.localeCompare(a.at));
    result.sort((a, b) => b.items.length - a.items.length || a.agentName.localeCompare(b.agentName));
    return result;
  }

  return {
    getLastVisit,
    recordVisit,

    async build(
      companyId: string,
      opts: { userId: string; since?: Date | null; now?: Date },
    ): Promise<AgentWorkDigest> {
      const now = opts.now ?? new Date();
      let since: Date;
      let sinceSource: AgentWorkDigestSinceSource;
      if (opts.since) {
        since = opts.since;
        sinceSource = "query";
      } else {
        const lastVisit = await getLastVisit(companyId, opts.userId);
        since = lastVisit ?? new Date(now.getTime() - AGENT_WORK_DIGEST_DEFAULT_WINDOW_MS);
        sinceSource = lastVisit ? "last_visit" : "default_window";
      }

      const agentGroups = await groupByAgent(companyId, await collect(companyId, since));
      const counts = emptyCounts();
      for (const group of agentGroups) {
        for (const key of Object.keys(counts) as (keyof AgentWorkDigestCounts)[]) counts[key] += group.counts[key];
      }
      return {
        companyId,
        since: iso(since),
        sinceSource,
        generatedAt: iso(now),
        counts,
        agents: agentGroups,
      };
    },
  };
}
