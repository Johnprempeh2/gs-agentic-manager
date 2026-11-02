import {
  ROUTINE_ISSUE_ORIGIN_KINDS,
  computeApiEquivalentCents,
  type UsageBreakdown,
  type UsageBreakdownRow,
  type UsageTurnaround,
  type UsageWorkKind,
} from "@greatstone/shared";
import { and, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { agents, costEvents, heartbeatRuns, issues } from "@greatstone/db";
import type { CostDateRange } from "./costs.js";

interface IssueFacts {
  assigneeAgentId: string | null;
  originKind: string | null;
  executionPolicy: unknown;
}

const ROUTINE_ORIGINS = new Set<string>(ROUTINE_ISSUE_ORIGIN_KINDS);

/** Agent ids named as participants in a task's review or approval stages. */
export function stageAgentIds(executionPolicy: unknown): string[] {
  const stages = (executionPolicy as { stages?: unknown } | null)?.stages;
  if (!Array.isArray(stages)) return [];
  const ids: string[] = [];
  for (const stage of stages) {
    const participants = (stage as { participants?: unknown } | null)?.participants;
    if (!Array.isArray(participants)) continue;
    for (const p of participants) {
      const agentId = (p as { type?: string; agentId?: string | null } | null)?.agentId;
      if ((p as { type?: string }).type === "agent" && agentId) ids.push(agentId);
    }
  }
  return ids;
}

/** What one run was spent on, judged from the agent's relation to the task it ran on. */
export function classifyRunWork(agentId: string, issue: IssueFacts | null): UsageWorkKind {
  if (!issue) return "housekeeping";
  if (issue.originKind && ROUTINE_ORIGINS.has(issue.originKind)) return "routine";
  if (issue.assigneeAgentId === agentId) return "doing";
  if (stageAgentIds(issue.executionPolicy).includes(agentId)) return "reviewing";
  return "coordinating";
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const emptyRow = (key: string): UsageBreakdownRow => ({ key, apiEquivalentCents: 0, outputTokens: 0, runCount: 0, runtimeMs: 0 });

/**
 * Where agent usage went: by role, by kind of work and by day, valued at API
 * list price so Claude and ChatGPT subscriptions compare fairly (ChatGPT counts
 * cached tokens inside input; Claude does not). Pass projectId for one client.
 */
export async function usageBreakdown(
  db: Db,
  companyId: string,
  range?: CostDateRange,
  projectId?: string | null,
): Promise<UsageBreakdown> {
  const conditions = [eq(costEvents.companyId, companyId)];
  if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
  if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));
  const day = sql<string>`to_char(${costEvents.occurredAt} at time zone 'UTC', 'YYYY-MM-DD')`;

  const events = await db
    .select({
      agentId: costEvents.agentId,
      issueId: costEvents.issueId,
      projectId: costEvents.projectId,
      runId: costEvents.heartbeatRunId,
      provider: costEvents.provider,
      model: costEvents.model,
      day,
      inputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::double precision`,
      cachedInputTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}), 0)::double precision`,
      outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::double precision`,
    })
    .from(costEvents)
    .where(and(...conditions))
    .groupBy(costEvents.agentId, costEvents.issueId, costEvents.projectId, costEvents.heartbeatRunId, costEvents.provider, costEvents.model, day);

  const issueIds = [...new Set(events.map((e) => e.issueId).filter((id): id is string => Boolean(id)))];
  const runIds = [...new Set(events.map((e) => e.runId).filter((id): id is string => Boolean(id)))];
  const [agentRows, issueRows, runRows] = await Promise.all([
    db.select({ id: agents.id, role: agents.role }).from(agents).where(eq(agents.companyId, companyId)),
    issueIds.length
      ? db
          .select({
            id: issues.id,
            projectId: issues.projectId,
            assigneeAgentId: issues.assigneeAgentId,
            originKind: issues.originKind,
            executionPolicy: issues.executionPolicy,
          })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)))
      : [],
    runIds.length
      ? db
          .select({
            id: heartbeatRuns.id,
            runtimeMs: sql<number>`coalesce(extract(epoch from (${heartbeatRuns.finishedAt} - ${heartbeatRuns.startedAt})) * 1000, 0)::double precision`,
          })
          .from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, runIds)))
      : [],
  ]);
  const roleByAgent = new Map(agentRows.map((a) => [a.id, a.role]));
  const issueById = new Map(issueRows.map((i) => [i.id, i]));
  const runtimeByRun = new Map(runRows.map((r) => [r.id, Number(r.runtimeMs)]));

  const total = emptyRow("total");
  const byRole = new Map<string, UsageBreakdownRow>();
  const byWork = new Map<string, UsageBreakdownRow>();
  const daily = new Map<string, UsageBreakdownRow & { day: string }>();
  // A run counts once per bucket even when it used several models.
  const countedRuns = new Set<string>();

  for (const event of events) {
    const issue = event.issueId ? issueById.get(event.issueId) ?? null : null;
    if (projectId && (event.projectId ?? issue?.projectId ?? null) !== projectId) continue;
    const role = roleByAgent.get(event.agentId) ?? "general";
    const work = classifyRunWork(event.agentId, issue);
    const cents = computeApiEquivalentCents(event, event.day) ?? 0;
    const output = Number(event.outputTokens);
    const dayKey = `${event.day}|${role}`;
    const dayRow = daily.get(dayKey) ?? { ...emptyRow(role), day: event.day };
    daily.set(dayKey, dayRow);
    const buckets: Array<[string, UsageBreakdownRow]> = [
      ["total", total],
      [`role:${role}`, byRole.get(role) ?? byRole.set(role, emptyRow(role)).get(role)!],
      [`work:${work}`, byWork.get(work) ?? byWork.set(work, emptyRow(work)).get(work)!],
      [`day:${dayKey}`, dayRow],
    ];
    for (const [bucketKey, row] of buckets) {
      row.apiEquivalentCents += cents;
      row.outputTokens += output;
      if (event.runId && !countedRuns.has(`${bucketKey}|${event.runId}`)) {
        countedRuns.add(`${bucketKey}|${event.runId}`);
        row.runCount += 1;
        row.runtimeMs += runtimeByRun.get(event.runId) ?? 0;
      }
    }
  }

  // Turnaround: start to done for tasks finished in the range, split by
  // whether other agents had to review them.
  const doneConditions = [
    eq(issues.companyId, companyId),
    eq(issues.status, "done"),
    isNotNull(issues.startedAt),
    isNotNull(issues.completedAt),
    isNull(issues.hiddenAt),
  ];
  if (range?.from) doneConditions.push(gte(issues.completedAt, range.from));
  if (range?.to) doneConditions.push(lte(issues.completedAt, range.to));
  if (projectId) doneConditions.push(eq(issues.projectId, projectId));
  const doneRows = await db
    .select({
      assigneeAgentId: issues.assigneeAgentId,
      executionPolicy: issues.executionPolicy,
      hours: sql<number>`extract(epoch from (${issues.completedAt} - ${issues.startedAt})) / 3600`,
    })
    .from(issues)
    .where(and(...doneConditions));
  const reviewed: number[] = [];
  const unreviewed: number[] = [];
  for (const row of doneRows) {
    const reviewers = stageAgentIds(row.executionPolicy).filter((id) => id !== row.assigneeAgentId);
    (reviewers.length ? reviewed : unreviewed).push(Number(row.hours));
  }
  const turnaround = (values: number[]): UsageTurnaround => ({ count: values.length, medianHours: median(values) });

  const byValue = (a: UsageBreakdownRow, b: UsageBreakdownRow) => b.apiEquivalentCents - a.apiEquivalentCents;
  return {
    from: range?.from?.toISOString() ?? null,
    to: range?.to?.toISOString() ?? null,
    projectId: projectId ?? null,
    total,
    byRole: [...byRole.values()].sort(byValue),
    byWork: [...byWork.values()].sort(byValue),
    daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day) || a.key.localeCompare(b.key)),
    turnaround: { withAgentReview: turnaround(reviewed), withoutAgentReview: turnaround(unreviewed) },
  };
}
