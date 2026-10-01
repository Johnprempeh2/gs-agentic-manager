import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  activityLog,
  agents,
  connectionGrants,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
  toolConnections,
} from "@greatstone/db";
import {
  DECISION_CARD_KINDS,
  aiConnectionMetadataSchema,
  aiCredentialExpiryState,
  readAiCredentialRecord,
} from "@greatstone/shared";
import type {
  AttentionItem,
  AttentionSeverity,
  AttentionSubject,
  DecisionCard,
  DecisionCardAction,
  DecisionCardAgentRef,
  DecisionCardClarity,
  DecisionCardKind,
  DecisionsFeed,
} from "@greatstone/shared";
import { attentionService, type AttentionServiceOptions } from "./attention.js";
import { evaluateAgentInvokability, type AgentOrgRow } from "./agent-invokability.js";
import { isExplicitResumeCapableStatus } from "./issue-comment-wakeup.js";

/** activity_log.details.source on the comment a clarity question writes. */
export const DECISIONS_CLARITY_SOURCE = "decisions_clarity";

const CLOSED_ISSUE_STATUSES = new Set(["done", "cancelled"]);
const SEVERITY_RANK: Record<AttentionSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const KIND_RANK = new Map<DecisionCardKind, number>(DECISION_CARD_KINDS.map((kind, index) => [kind, index]));
const REASON_LIMIT = 600;

type TaskRow = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

/** An agent's open cards for one missing connection, shown as one card. */
type SharedConnection = { agentId: string; serviceName: string; tasks: TaskRow[] };

type AiHealth = {
  /** Newest time a healthy connection was saved, per provider. */
  byProvider: Map<string, number>;
  any: number | null;
};

function cardKind(item: AttentionItem): DecisionCardKind {
  switch (item.sourceKind) {
    case "approval": return "approval";
    case "issue_thread_interaction":
      return item.subject.metadata?.kind === "connection_intent" ? "connection" : "question";
    case "join_request": return "join_request";
    case "recovery_action": return "recovery";
    case "blocker_attention": return "blocked";
    case "review": return "review";
    case "failed_run": return "failed_run";
    case "budget_alert": return "budget";
    case "agent_error_alert": return "agent_error";
    case "ai_connection_alert": return "connection";
    default: return "decision";
  }
}

function readString(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/** The task a row is about. Issue-subject rows (reviews, blockers) are about their subject. */
function taskIdOf(item: AttentionItem) {
  if (item.subject.kind === "issue") return item.subject.id;
  if (item.relatedIssue) return item.relatedIssue.id;
  return readString(item.subject.metadata, "issueId") ?? readString(item.subject.metadata, "sourceIssueId");
}

function clip(text: string) {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > REASON_LIMIT ? `${trimmed.slice(0, REASON_LIMIT - 1)}…` : trimmed;
}

function detailSummary(item: AttentionItem) {
  const detail = item.detail as { summaryExcerpt?: unknown; failureReasonExcerpt?: unknown } | null;
  if (typeof detail?.failureReasonExcerpt === "string" && detail.failureReasonExcerpt.trim()) return detail.failureReasonExcerpt;
  if (typeof detail?.summaryExcerpt === "string" && detail.summaryExcerpt.trim()) return detail.summaryExcerpt;
  return null;
}

function timeOf(value: Date | string | null | undefined) {
  if (!value) return 0;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function hhmm(time: number) {
  return `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function request(method: "POST" | "PATCH", path: string, body: Record<string, unknown> = {}) {
  return { method, path, body };
}

function requestAction(
  id: DecisionCardAction["id"],
  label: string,
  description: string,
  requests: DecisionCardAction["requests"],
  input: DecisionCardAction["input"] = null,
): DecisionCardAction {
  return { id, label, description, type: "request", requests, href: null, input };
}

function linkAction(id: DecisionCardAction["id"], label: string, description: string, href: string): DecisionCardAction {
  return { id, label, description, type: "link", requests: [], href, input: null };
}

export function decisionsFeedService(db: Db, serviceOptions: AttentionServiceOptions = {}) {
  const attention = attentionService(db, serviceOptions);

  async function loadAiHealth(companyId: string, userId: string, now: number): Promise<AiHealth> {
    const rows = await db
      .select({ connection: toolConnections, grant: connectionGrants })
      .from(toolConnections)
      .innerJoin(connectionGrants, and(
        eq(connectionGrants.companyId, toolConnections.companyId),
        eq(connectionGrants.connectionId, toolConnections.id),
      ))
      .where(and(
        eq(toolConnections.companyId, companyId),
        eq(toolConnections.connectionPurpose, "ai"),
        eq(toolConnections.enabled, true),
        eq(toolConnections.status, "active"),
        eq(connectionGrants.status, "active"),
      ));
    const health: AiHealth = { byProvider: new Map(), any: null };
    for (const { connection, grant } of rows) {
      if (grant.kind === "user" && grant.subjectUserId !== userId) continue;
      if (connection.healthStatus === "error") continue;
      const metadata = aiConnectionMetadataSchema.safeParse(connection.config.ai);
      if (!metadata.success) continue;
      const expiry = aiCredentialExpiryState(readAiCredentialRecord(connection.config)?.expiresAt, new Date(now));
      if (expiry === "expired") continue;
      const healthyAt = Math.max(timeOf(connection.updatedAt), timeOf(connection.healthCheckedAt));
      const provider = metadata.data.provider;
      health.byProvider.set(provider, Math.max(health.byProvider.get(provider) ?? 0, healthyAt));
      health.any = Math.max(health.any ?? 0, healthyAt);
    }
    return health;
  }

  return {
    build: async (companyId: string, options: { userId: string }): Promise<DecisionsFeed> => {
      const now = serviceOptions.now?.() ?? Date.now();
      const feed = await attention.list(companyId, {
        userId: options.userId,
        all: true,
        allowUnscopedAll: true,
      });
      const rawItems = feed.items;

      const taskIds = [...new Set(rawItems.map(taskIdOf).filter((id): id is string => Boolean(id)))];
      const recoveryIds = rawItems.filter((item) => item.sourceKind === "recovery_action").map((item) => item.subject.id);
      const intentIds = rawItems.filter((item) => cardKind(item) === "connection" && item.sourceKind === "issue_thread_interaction")
        .map((item) => item.subject.id);
      const failedRunIds = rawItems.filter((item) => item.sourceKind === "failed_run").map((item) => item.subject.id);

      const [taskRows, agentRows, recoveryRows, intentRows, aiHealth] = await Promise.all([
        taskIds.length === 0 ? Promise.resolve([] as TaskRow[]) : db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
            assigneeAgentId: issues.assigneeAgentId,
            assigneeUserId: issues.assigneeUserId,
          })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), inArray(issues.id, taskIds))),
        db
          .select({ id: agents.id, companyId: agents.companyId, name: agents.name, reportsTo: agents.reportsTo, status: agents.status, runtimeConfig: agents.runtimeConfig })
          .from(agents)
          .where(eq(agents.companyId, companyId))
          .orderBy(asc(agents.name)),
        recoveryIds.length === 0 ? Promise.resolve([]) : db
          .select({
            id: issueRecoveryActions.id,
            cause: issueRecoveryActions.cause,
            evidence: issueRecoveryActions.evidence,
            nextAction: issueRecoveryActions.nextAction,
            previousOwnerAgentId: issueRecoveryActions.previousOwnerAgentId,
            createdAt: issueRecoveryActions.createdAt,
          })
          .from(issueRecoveryActions)
          .where(and(eq(issueRecoveryActions.companyId, companyId), inArray(issueRecoveryActions.id, recoveryIds))),
        intentIds.length === 0 ? Promise.resolve([]) : db
          .select({
            id: issueThreadInteractions.id,
            payload: issueThreadInteractions.payload,
            createdAt: issueThreadInteractions.createdAt,
          })
          .from(issueThreadInteractions)
          .where(and(eq(issueThreadInteractions.companyId, companyId), inArray(issueThreadInteractions.id, intentIds))),
        loadAiHealth(companyId, options.userId, now),
      ]);
      const taskById = new Map(taskRows.map((row) => [row.id, row]));
      const agentById = new Map(agentRows.map((row) => [row.id, row]));
      const recoveryById = new Map(recoveryRows.map((row) => [row.id, row]));
      const intentById = new Map(intentRows.map((row) => [row.id, row]));

      // Which failing runs were an AI-connection failure, and when they ran.
      const runIds = [
        ...failedRunIds,
        ...recoveryRows.map((row) => readString(row.evidence as Record<string, unknown>, "latestRunId")).filter((id): id is string => Boolean(id)),
      ];
      const runRows = runIds.length === 0 ? [] : await db
        .select({
          id: heartbeatRuns.id,
          createdAt: heartbeatRuns.createdAt,
          gapReason: sql<string | null>`${heartbeatRuns.resultJson} -> 'configurationIncomplete' ->> 'reason'`,
        })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, [...new Set(runIds)])));
      const runById = new Map(runRows.map((row) => [row.id, row]));

      const agentRef = (agentId: string | null | undefined): DecisionCardAgentRef | null => {
        if (!agentId) return null;
        const agent = agentById.get(agentId);
        return agent ? { id: agent.id, name: agent.name } : null;
      };
      const agentProvider = (agentId: string | null | undefined) => {
        const binding = agentId ? agentById.get(agentId)?.runtimeConfig?.aiConnection : null;
        return binding && typeof binding === "object" ? readString(binding as Record<string, unknown>, "provider") : null;
      };
      const healthySince = (provider: string | null) =>
        provider ? aiHealth.byProvider.get(provider) ?? null : aiHealth.any;

      /**
       * When a row's cause is an AI connection that works again, the time it
       * became healthy. A connection saved before the failure does not count:
       * the failure is newer than the repair.
       */
      const aiRepairedAt = (item: AttentionItem): number | null => {
        if (item.sourceKind === "issue_thread_interaction") {
          const intent = intentById.get(item.subject.id);
          const payload = (intent?.payload ?? {}) as Record<string, unknown>;
          if (!intent || payload.purpose !== "ai") return null;
          const healthyAt = healthySince(readString(payload, "serviceSlug"));
          return healthyAt !== null && healthyAt > timeOf(intent.createdAt) ? healthyAt : null;
        }
        const task = taskById.get(taskIdOf(item) ?? "");
        if (item.sourceKind === "recovery_action") {
          const recovery = recoveryById.get(item.subject.id);
          if (!recovery || recovery.cause !== "configuration_incomplete") return null;
          const run = runById.get(readString(recovery.evidence as Record<string, unknown>, "latestRunId") ?? "");
          if (run?.gapReason !== "ai_connection_unavailable") return null;
          const healthyAt = healthySince(agentProvider(task?.assigneeAgentId ?? recovery.previousOwnerAgentId));
          return healthyAt !== null && healthyAt > timeOf(run.createdAt) ? healthyAt : null;
        }
        if (item.sourceKind === "failed_run") {
          const run = runById.get(item.subject.id);
          if (run?.gapReason !== "ai_connection_unavailable") return null;
          const healthyAt = healthySince(agentProvider(readString(item.subject.metadata, "agentId")));
          return healthyAt !== null && healthyAt > timeOf(run.createdAt) ? healthyAt : null;
        }
        return null;
      };

      /** A row whose cause is gone. Pending questions and approvals never go stale here. */
      const isClosedTaskRow = (item: AttentionItem) => {
        if (!["recovery_action", "failed_run", "blocker_attention"].includes(item.sourceKind)
          && cardKind(item) !== "connection") return false;
        const task = taskById.get(taskIdOf(item) ?? "");
        return task ? CLOSED_ISSUE_STATUSES.has(task.status) : false;
      };
      const blocksNothing = (item: AttentionItem) =>
        item.sourceKind === "blocker_attention"
        && (item.detail as { blockedTaskCount?: unknown } | null)?.blockedTaskCount === 0;

      /**
       * One agent waiting on one missing tool connection across several tasks
       * is one decision (GRE-316): the answer on any card answers them all.
       * AI accounts already fold into the company-level alert and keep a
       * per-task retry, so they stay on their task cards.
       */
      const sharedConnectionKey = (item: AttentionItem) => {
        if (item.sourceKind !== "issue_thread_interaction" || cardKind(item) !== "connection") return null;
        const payload = (intentById.get(item.subject.id)?.payload ?? {}) as Record<string, unknown>;
        const agentId = readString(payload, "requestingAgentId");
        const service = readString(payload, "serviceSlug");
        if (!agentId || !service || payload.purpose === "ai") return null;
        const upstream = readString(payload.upstreamService as Record<string, unknown> | undefined, "slug") ?? "";
        return `connection:${agentId}:${service}:${upstream}`;
      };
      const isOpenRow = (item: AttentionItem) => !isClosedTaskRow(item) && !blocksNothing(item) && aiRepairedAt(item) === null;
      const sharedTasks = new Map<string, Set<string>>();
      for (const item of rawItems) {
        const key = sharedConnectionKey(item);
        const taskId = taskIdOf(item);
        if (!key || !taskId || !isOpenRow(item)) continue;
        sharedTasks.set(key, (sharedTasks.get(key) ?? new Set()).add(taskId));
      }

      type Group = { key: string; taskId: string | null; items: AttentionItem[]; cleared: AttentionItem[]; aiRepairedAt: number | null; shared?: SharedConnection };
      const groups = new Map<string, Group>();
      let staleCleared = 0;
      for (const item of rawItems) {
        const sharedKey = sharedConnectionKey(item);
        const shared = sharedKey && isOpenRow(item) && (sharedTasks.get(sharedKey)?.size ?? 0) > 1 ? sharedKey : null;
        const taskId = shared ? null : taskIdOf(item);
        const key = shared ?? (taskId ? `task:${taskId}` : `item:${item.dedupKey}`);
        const group = groups.get(key) ?? { key, taskId, items: [], cleared: [], aiRepairedAt: null };
        if (shared && !group.shared) {
          const payload = (intentById.get(item.subject.id)?.payload ?? {}) as Record<string, unknown>;
          group.shared = {
            agentId: readString(payload, "requestingAgentId")!,
            serviceName: readString(payload, "serviceName") ?? readString(payload, "serviceSlug")!,
            tasks: [...sharedTasks.get(shared)!].map((id) => taskById.get(id)).filter((task): task is TaskRow => Boolean(task)),
          };
        }
        groups.set(key, group);
        if (isClosedTaskRow(item) || blocksNothing(item)) {
          staleCleared += 1;
          continue;
        }
        const repairedAt = aiRepairedAt(item);
        if (repairedAt !== null) {
          staleCleared += 1;
          group.aiRepairedAt = Math.max(group.aiRepairedAt ?? 0, repairedAt);
          group.cleared.push(item);
          continue;
        }
        group.items.push(item);
      }

      const clarityByTask = await loadClarity(companyId, [...groups.values()]
        .map((group) => group.taskId).filter((id): id is string => Boolean(id)));

      const assignableAgents = agentRows
        .filter((agent) => evaluateAgentInvokability(agent as AgentOrgRow, agentRows as AgentOrgRow[]).invokable)
        .map((agent) => ({ id: agent.id, name: agent.name }));

      const cards: DecisionCard[] = [];
      for (const group of groups.values()) {
        const task = group.taskId ? taskById.get(group.taskId) ?? null : null;
        // A fixed AI connection clears its cards. A task it left blocked keeps
        // one card so it is not stranded: it still needs a retry.
        const readyToRetry = group.items.length === 0 && group.aiRepairedAt !== null && task?.status === "blocked";
        if (group.items.length === 0 && !readyToRetry) continue;
        cards.push(buildCard({
          companyId,
          group,
          task,
          readyToRetry,
          taskSubject: task ? findTaskSubject(rawItems, task.id) : null,
          clarity: group.taskId ? clarityByTask.get(group.taskId) ?? null : null,
          agentRef,
          recoveryById,
        }));
      }
      cards.sort((left, right) =>
        SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
        || timeOf(right.activityAt) - timeOf(left.activityAt)
        || left.id.localeCompare(right.id));

      const countsByKind = Object.fromEntries(DECISION_CARD_KINDS.map((kind) => [kind, 0])) as Record<DecisionCardKind, number>;
      for (const card of cards) countsByKind[card.kind] += 1;

      return {
        companyId,
        generatedAt: new Date(now).toISOString(),
        count: cards.length,
        countsByKind,
        staleCleared,
        assignableAgents,
        cards,
      };
    },
  };

  /** The newest clarity question per task, with the owning agent's first answer. */
  async function loadClarity(companyId: string, taskIds: string[]) {
    const result = new Map<string, DecisionCardClarity>();
    if (taskIds.length === 0) return result;
    const asked = await db
      .select({ entityId: activityLog.entityId, details: activityLog.details, createdAt: activityLog.createdAt })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.action, "issue.comment_added"),
        inArray(activityLog.entityId, taskIds),
        sql`${activityLog.details} ->> 'source' = ${DECISIONS_CLARITY_SOURCE}`,
      ))
      .orderBy(desc(activityLog.createdAt));
    const newest = new Map<string, { commentId: string; question: string; agentId: string | null; askedAt: Date }>();
    for (const row of asked) {
      if (newest.has(row.entityId)) continue;
      const details = (row.details ?? {}) as Record<string, unknown>;
      const commentId = readString(details, "commentId");
      if (!commentId) continue;
      newest.set(row.entityId, {
        commentId,
        question: readString(details, "question") ?? "",
        agentId: readString(details, "agentId"),
        askedAt: row.createdAt,
      });
    }
    if (newest.size === 0) return result;
    const agentIds = [...new Set([...newest.values()].map((entry) => entry.agentId).filter((id): id is string => Boolean(id)))];
    const oldestAsk = new Date(Math.min(...[...newest.values()].map((entry) => entry.askedAt.getTime())));
    const [answerRows, agentRows] = await Promise.all([
      agentIds.length === 0 ? Promise.resolve([]) : db
        .select({
          id: issueComments.id,
          issueId: issueComments.issueId,
          authorAgentId: issueComments.authorAgentId,
          body: issueComments.body,
          createdAt: issueComments.createdAt,
        })
        .from(issueComments)
        .where(and(
          eq(issueComments.companyId, companyId),
          inArray(issueComments.issueId, [...newest.keys()]),
          inArray(issueComments.authorAgentId, agentIds),
          gt(issueComments.createdAt, oldestAsk),
          sql`${issueComments.deletedAt} is null`,
        ))
        .orderBy(asc(issueComments.createdAt)),
      agentIds.length === 0 ? Promise.resolve([]) : db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds))),
    ]);
    const agentNames = new Map(agentRows.map((row) => [row.id, row.name]));
    for (const [issueId, entry] of newest) {
      const answer = answerRows.find((row) =>
        row.issueId === issueId && row.authorAgentId === entry.agentId && row.createdAt > entry.askedAt);
      result.set(issueId, {
        questionCommentId: entry.commentId,
        question: entry.question,
        askedAt: entry.askedAt.toISOString(),
        agent: entry.agentId ? { id: entry.agentId, name: agentNames.get(entry.agentId) ?? "Agent" } : null,
        answer: answer ? { commentId: answer.id, body: answer.body, answeredAt: answer.createdAt.toISOString() } : null,
      });
    }
    return result;
  }
}

function findTaskSubject(items: AttentionItem[], taskId: string): AttentionSubject | null {
  for (const item of items) {
    if (item.subject.kind === "issue" && item.subject.id === taskId) return item.subject;
    if (item.relatedIssue?.id === taskId) return item.relatedIssue;
  }
  return null;
}

function buildCard(input: {
  companyId: string;
  group: { key: string; taskId: string | null; items: AttentionItem[]; cleared: AttentionItem[]; aiRepairedAt: number | null; shared?: SharedConnection };
  task: TaskRow | null;
  readyToRetry: boolean;
  taskSubject: AttentionSubject | null;
  clarity: DecisionCardClarity | null;
  agentRef: (agentId: string | null | undefined) => DecisionCardAgentRef | null;
  recoveryById: Map<string, { id: string; evidence: unknown; nextAction: string }>;
}): DecisionCard {
  const { companyId, group, task, readyToRetry, clarity, agentRef } = input;
  const items = [...group.items].sort((left, right) =>
    (KIND_RANK.get(cardKind(left)) ?? 99) - (KIND_RANK.get(cardKind(right)) ?? 99)
    || timeOf(right.activityAt) - timeOf(left.activityAt));
  const kinds = readyToRetry ? ["recovery" as const] : [...new Set(items.map(cardKind))];
  const kind = kinds[0]!;
  const main = items[0] ?? null;
  const taskOpen = task !== null && !CLOSED_ISSUE_STATUSES.has(task.status);
  const byKind = (wanted: DecisionCardKind) => items.find((item) => cardKind(item) === wanted) ?? null;

  const taskLabel = task ? `${task.identifier ?? task.id.slice(0, 8)} ${task.title}` : null;
  const shared = group.shared;
  const sharedAgent = shared ? agentRef(shared.agentId) : null;
  const sharedTaskList = shared?.tasks.map((row) => row.identifier ?? row.id.slice(0, 8)).sort().join(", ");
  const title = shared
    ? `${sharedAgent?.name ?? "An agent"} needs ${shared.serviceName} for ${shared.tasks.length} tasks`
    : taskLabel ?? main?.subject.title ?? "Needs your decision";

  // Who is waiting: the owner of the task. For a stalled blocker, the owner of
  // the blocked task behind it waits too, but the blocker's owner acts.
  const blockedItem = byKind("blocked");
  const blockedTaskAgentId = readString(blockedItem?.relatedIssue?.metadata, "assigneeAgentId");
  const waiting = sharedAgent
    ?? agentRef(task?.assigneeAgentId)
    ?? agentRef(blockedTaskAgentId)
    ?? agentRef(readString(main?.subject.metadata, "createdByAgentId"))
    ?? agentRef(readString(main?.subject.metadata, "agentId"))
    ?? agentRef(readString(main?.subject.metadata, "requestedByAgentId"));

  // A ready-to-retry card retries through the recovery the fixed connection left open.
  // A task the fixed connection left blocked keeps Retry even when other rows
  // (a question, a blocker) still hold the card open.
  const retryAfterRepair = group.aiRepairedAt !== null && task?.status === "blocked";
  const recoveryItem = byKind("recovery")
    ?? (retryAfterRepair ? group.cleared.find((item) => item.sourceKind === "recovery_action") ?? null : null);
  const recovery = recoveryItem ? input.recoveryById.get(recoveryItem.subject.id) ?? null : null;
  let reason: string;
  if (shared) {
    reason = `${shared.tasks.length} tasks wait for the same ${shared.serviceName} connection: ${sharedTaskList}. One answer covers all of them.`;
  } else if (readyToRetry) {
    reason = `The AI connection works again (since ${hhmm(group.aiRepairedAt!)}). The task is still stopped from the earlier failure.`;
  } else if (kind === "recovery" && recovery) {
    reason = readString(recovery.evidence as Record<string, unknown>, "failureSummary") ?? recovery.nextAction;
  } else if (kind === "failed_run") {
    reason = readString(main!.subject.metadata, "error")
      ?? readString(main!.subject.metadata, "retryExhaustedReason")
      ?? readString(main!.subject.metadata, "errorCode")
      ?? main!.whyNow;
  } else if (kind === "blocked") {
    const count = (main!.detail as { blockedTaskCount?: unknown } | null)?.blockedTaskCount;
    const owner = agentRef(task?.assigneeAgentId);
    reason = typeof count === "number"
      ? `${taskLabel ?? "This task"} has no live next step and blocks ${count} ${count === 1 ? "task" : "tasks"}. ${owner ? `Owner: ${owner.name}.` : "It has no agent owner."}`
      : main!.whyNow;
  } else if (kind === "question" || kind === "approval" || kind === "decision") {
    reason = main!.subject.title ?? main!.whyNow;
  } else {
    reason = detailSummary(main!) ?? main!.subject.title ?? main!.whyNow;
  }

  const blockedCount = (blockedItem?.detail as { blockedTaskCount?: unknown } | null)?.blockedTaskCount;
  const nextStepByKind: Record<DecisionCardKind, string> = {
    question: `${waiting?.name ?? "The agent"} waits for your answer, then continues.`,
    approval: "Nothing moves until you approve or reject it.",
    connection: task
      ? `${waiting?.name ?? "The agent"} stays stopped until the connection works. Reconnect it, then retry.`
      : "Runs that use this connection stay stopped until it is reconnected.",
    recovery: readyToRetry
      ? "Retry to continue the task, or reassign or cancel it."
      : "The task stays stopped until you retry, reassign, resolve or cancel it.",
    failed_run: "Automatic retries are used up. The task waits until you retry or reassign it.",
    blocked: typeof blockedCount === "number"
      ? `${blockedCount} blocked ${blockedCount === 1 ? "task waits" : "tasks wait"} until this task has a live owner. Reassign it, give an instruction, or cancel it.`
      : "The task stays blocked until you act.",
    review: "The task stays in review until you approve it or ask for changes.",
    decision: "The agent waits for your decision.",
    budget: "Paused work stays paused until the budget is raised.",
    agent_error: "The agent takes no work until the error is fixed.",
    join_request: "The request waits for your approval.",
  };
  if (shared) {
    nextStepByKind.connection = `${waiting?.name ?? "The agent"} stays stopped on these tasks until you answer. Connect ${shared.serviceName} once and each task continues one time.`;
  }
  const nextStep = clarity && !clarity.answer
    ? `Waiting for ${clarity.agent?.name ?? "the agent"} to answer your question. ${nextStepByKind[kind]}`
    : nextStepByKind[kind];

  const actions: DecisionCardAction[] = [];
  // Native decisions first: the card's own question or approval.
  for (const item of items) {
    if (item.sourceKind === "approval") {
      actions.push(
        requestAction("approve", "Approve", "Approve the request.", [request("POST", `/api/approvals/${item.subject.id}/approve`)]),
        requestAction("reject", "Reject", "Reject the request.", [request("POST", `/api/approvals/${item.subject.id}/reject`)]),
      );
    } else if (item.sourceKind === "issue_thread_interaction" && cardKind(item) === "question" && item.subject.href) {
      actions.push(linkAction("open", "Answer", "Open the question on the task.", item.subject.href));
    } else if (cardKind(item) === "connection" && item.subject.href && !actions.some((action) => action.id === "reconnect")) {
      actions.push(shared
        ? linkAction("reconnect", "Connect", `Open the request and connect ${shared.serviceName}. Every waiting task continues.`, item.subject.href)
        : linkAction("reconnect", "Reconnect", "Open the AI connection and reconnect it.", item.subject.href));
    }
  }

  if (task && taskOpen) {
    const issuePath = `/api/issues/${task.id}`;
    const failedRun = byKind("failed_run");
    const failedRunAgentId = readString(failedRun?.subject.metadata, "agentId");
    if (recoveryItem) {
      actions.push(requestAction("retry", "Retry", "Send the task back to its owner to try again.", [
        request("POST", `${issuePath}/recovery-actions/resolve`, {
          actionId: recoveryItem.subject.id,
          outcome: "restored",
          sourceIssueStatus: "todo",
          resolutionNote: "Retried from Decisions.",
        }),
      ]));
    } else if (failedRun && failedRunAgentId) {
      actions.push(requestAction("retry", "Retry", "Run the failed run again.", [
        request("POST", `/api/agents/${failedRunAgentId}/wakeup`, {
          source: "on_demand",
          triggerDetail: "manual",
          reason: "retry_failed_run",
          failedRunId: failedRun.subject.id,
        }),
      ]));
    } else if (retryAfterRepair) {
      actions.push(requestAction("retry", "Retry", "Move the task back to its owner to continue.", [
        request("PATCH", issuePath, { status: "todo" }),
      ]));
    }
    actions.push(requestAction(
      "reassign",
      "Reassign",
      "Give the task to another agent. The new owner is woken.",
      [request("PATCH", issuePath, { assigneeUserId: null })],
      { field: "assigneeAgentId", type: "agent", label: "New owner", required: true },
    ));
    actions.push(requestAction(
      "instruct",
      "Give an instruction",
      "Post an instruction on the task and wake its owner.",
      // in_review and backlog refuse resume intent; a plain comment there still
      // wakes the owner and leaves the status (and any review) alone. GRE-320.
      [request("POST", `${issuePath}/comments`, isExplicitResumeCapableStatus(task.status) ? { resume: true } : {})],
      { field: "body", type: "text", label: "Instruction", required: true },
    ));
    if (recoveryItem) {
      actions.push(requestAction(
        "resolve",
        "Mark resolved",
        "Record that the problem is fixed and choose where the task goes.",
        [request("POST", `${issuePath}/recovery-actions/resolve`, {
          actionId: recoveryItem.subject.id,
          outcome: "restored",
          resolutionNote: "Marked resolved from Decisions.",
        })],
        {
          field: "sourceIssueStatus",
          type: "choice",
          label: "Task goes to",
          required: true,
          options: [
            { value: "done", label: "Done" },
            { value: "in_review", label: "In review" },
            { value: "todo", label: "Back to its owner" },
          ],
        },
      ));
    } else if (items.some((item) => item.dedupKey.startsWith("blocked-owner:"))) {
      actions.push(requestAction("resolve", "Mark resolved", "The blocker is handled. The task goes back to its owner.", [
        request("PATCH", issuePath, { status: "todo" }),
      ]));
    } else if (items.length > 0 && items.every((item) => item.sourceKind === "failed_run")) {
      actions.push(dismissAction(companyId, items, "Mark resolved"));
    }
    if (task.assigneeAgentId) {
      actions.push(requestAction(
        "ask_clarity",
        "Ask for clarity",
        "Send a short question to the owning agent and wake it. The answer shows on this card.",
        [request("POST", `/api/companies/${companyId}/decisions-feed/cards/${encodeURIComponent(group.key)}/clarity`)],
        { field: "question", type: "text", label: "Your question", required: true },
      ));
    }
    // A cancelled blocker never resolves, so the close must say what happens to
    // the tasks that wait on it; without it the PATCH is refused with 409.
    const waitingNote = typeof blockedCount === "number" && blockedCount > 0
      ? blockedCount === 1
        ? " The task waiting on it stops waiting and can move on."
        : ` The ${blockedCount} tasks waiting on it stop waiting and can move on.`
      : " Any task waiting on it stops waiting and can move on.";
    actions.push(requestAction("cancel_task", "Cancel the task", `Stop the task for good.${waitingNote}`, [
      request("PATCH", issuePath, { status: "cancelled", blockedDependents: { action: "remove" } }),
    ]));
  } else if (!task && main) {
    if (main.subject.href && !actions.some((action) => action.type === "link")) {
      actions.push(linkAction("open", "Open", "Open the details.", main.subject.href));
    }
    if (["ai_connection_alert", "agent_error_alert", "failed_run"].includes(main.sourceKind)) {
      actions.push(dismissAction(companyId, items, "Dismiss"));
    }
  }

  const newest = items.reduce<AttentionItem | null>((best, item) =>
    !best || timeOf(item.activityAt) > timeOf(best.activityAt) ? item : best, null);
  const severity = items.reduce<AttentionSeverity>((best, item) =>
    SEVERITY_RANK[item.severity] < SEVERITY_RANK[best] ? item.severity : best, readyToRetry ? "high" : "low");
  const activityAt = newest?.activityAt ?? new Date(group.aiRepairedAt ?? 0).toISOString();
  const createdAt = items.reduce((oldest, item) => (item.createdAt < oldest ? item.createdAt : oldest), activityAt);

  return {
    id: group.key,
    kind,
    kinds,
    task: input.taskSubject,
    title,
    reason: clip(reason),
    waiting,
    nextStep,
    severity,
    activityAt,
    createdAt,
    actions,
    clarity,
    items,
  };
}

function dismissAction(companyId: string, items: AttentionItem[], label: string): DecisionCardAction {
  return requestAction("dismiss", label, "Hide this card. It comes back if the problem happens again.",
    items.map((item) => request("POST", `/api/companies/${companyId}/inbox-dismissals`, {
      itemKey: item.dismissalKey,
      kind: "dismiss",
    })));
}
