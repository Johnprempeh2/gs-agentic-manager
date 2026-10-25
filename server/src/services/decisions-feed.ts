import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  connectionGrants,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
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
  DecisionCardQuestion,
  DecisionCardRecommendation,
  DecisionCardReviewer,
  DecisionCardSetup,
  DecisionCardTaskRef,
  DecisionsFeed,
} from "@greatstone/shared";
import { attentionService, type AttentionServiceOptions } from "./attention.js";
import {
  STALL_ESCALATION_MS,
  commentExcerpt,
  listTasks,
  namedAskSentence,
  recommendationFromComment,
  recommendedActionId,
  viewerNames,
} from "./decision-card-content.js";
import { findLeadAgentId } from "./looks-finished.js";
import { principalIdsInclude, viewerPrincipalUserIds } from "./board-identity.js";
import { evaluateAgentInvokability, type AgentOrgRow } from "./agent-invokability.js";
import { isExplicitResumeCapableStatus } from "./issue-comment-wakeup.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { isReleaseTask } from "./release-task.js";

/** activity_log.details.source on the comment a clarity question writes. */
export const DECISIONS_CLARITY_SOURCE = "decisions_clarity";
/** activity_log.action written when an agent stall is handed to the lead agent. */
export const STALL_ROUTED_ACTION = "issue.stall_routed_to_lead";

const CLOSED_ISSUE_STATUSES = new Set(["done", "cancelled"]);
const SEVERITY_RANK: Record<AttentionSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const KIND_RANK = new Map<DecisionCardKind, number>(DECISION_CARD_KINDS.map((kind, index) => [kind, index]));
const REASON_LIMIT = 600;
const CONFIGURATION_INCOMPLETE = "configuration_incomplete";
/** How far back a repeated setup failure is counted (GRE-504). */
const SETUP_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;

type TaskRow = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  executionState: unknown;
  /** Set on a chat thread: no reassign or cancel there (conversation identity is fixed). */
  conversationAgentId: string | null;
  updatedAt: Date;
};

/** What the card builder needs beyond the rows: names, comments and links between tasks. */
type CardContext = {
  prefix: string;
  lead: DecisionCardAgentRef | null;
  names: string[];
  latestAgentComment: Map<string, { agentId: string; body: string; at: Date }>;
  latestLeadComment: Map<string, { body: string; at: Date }>;
  /** Newest comment per task per agent, keyed "<issueId>:<agentId>". */
  latestCommentBy: Map<string, { agentId: string; body: string; at: Date }>;
  holdsUp: Map<string, DecisionCardTaskRef[]>;
  blockerChain: Map<string, DecisionCardTaskRef[]>;
  /** Who owns each open blocker in `blockerChain`, by blocker id. */
  blockerOwner: Map<string, { agentId: string | null; userId: string | null }>;
  interactionCreatedBy: Map<string, string | null>;
  interactionPayload: Map<string, Record<string, unknown>>;
  /** Newest comment a person wrote on each task. */
  latestPersonComment: Map<string, Date>;
  /** Working tool connections: a squashed name/uid and when they last changed. */
  workingTools: Array<{ key: string; at: number }>;
  /** When each stalled task was last handed to the lead agent. */
  routedAt: Map<string, Date>;
};

/** "Google Drive", "google-drive" and "googledrive" all read "googledrive". */
function squash(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** A task's pending review stage: who reviews it and who gets it back (GRE-870). */
type PendingReview = {
  reviewer: DecisionCardReviewer;
  returnAgentId: string | null;
  canReturn: boolean;
};

/** An interaction that needs the board user at the computer (GRE-450). */
type DeskAsk = { interactionId: string; issueId: string; kind: string; command: string | null };

/** An agent's open cards for one missing connection, shown as one card. */
type SharedConnection = { agentId: string; serviceName: string; tasks: TaskRow[] };

/**
 * One setup gap of one agent (GRE-504): a `configuration_incomplete` run, keyed
 * by the agent, the recorded reason and the failure message.
 */
type SetupIdentity = { key: string; runId: string; agentId: string; cause: string; fixHref: string; runAt: number };

type Group = {
  key: string;
  taskId: string | null;
  items: AttentionItem[];
  cleared: AttentionItem[];
  aiRepairedAt: number | null;
  /** The agent finished a run after the setup failure (GRE-504). */
  setupFixedAt: number | null;
  shared?: SharedConnection;
  setup?: DecisionCardSetup;
  /** Every task stopped by the setup gap, closed ones included. */
  setupTasks?: TaskRow[];
};

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
    case "connectivity_outage": return "outage";
    default: return "decision";
  }
}

function readString(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/** The task a row is about. Issue-subject rows (reviews, blockers) are about their subject. */
export function taskIdOf(item: AttentionItem) {
  if (item.subject.kind === "issue") return item.subject.id;
  if (item.relatedIssue) return item.relatedIssue.id;
  return readString(item.subject.metadata, "issueId")
    ?? readString(item.subject.metadata, "sourceIssueId")
    ?? readString(item.subject.metadata, "originIssueId");
}

/**
 * A stalled-blocker row is about blocker Y, but the board sees it because
 * blocked task X waits on it. Returns X when the row names a different task.
 */
function blockedTaskIdOf(item: AttentionItem) {
  if (item.sourceKind !== "blocker_attention" || item.subject.kind !== "issue") return null;
  const blockedId = item.relatedIssue?.id;
  return blockedId && blockedId !== item.subject.id ? blockedId : null;
}

/**
 * A card that is only a stalled blocker with no live next step. Nothing on
 * it asks a person, so it is the agent side's to recover first.
 */
function isAgentStall(group: { items: AttentionItem[] }) {
  return group.items.length > 0
    && group.items.every((item) => item.sourceKind === "blocker_attention" && item.dedupKey.startsWith("blocker:"));
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

function setupKey(agentId: string, reason: string, cause: string) {
  return `setup:${agentId}:${reason}:${createHash("sha256").update(cause).digest("hex").slice(0, 12)}`;
}

/** The run's own fix page when it is an in-app path, else the agent's runtime page. */
function setupFixHref(actionUrl: string | null, agentId: string) {
  return actionUrl && actionUrl.startsWith("/") && !actionUrl.startsWith("//") ? actionUrl : `/agents/${agentId}/runtime`;
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
      // An owner also answers for the legacy `local-board` user (one rule, board-identity.ts).
      const viewerUserIds = await viewerPrincipalUserIds(db, companyId, options.userId);
      const feed = await attention.list(companyId, {
        userId: options.userId,
        userIdAliases: viewerUserIds.filter((id) => id !== options.userId),
        all: true,
        allowUnscopedAll: true,
      });
      const rawItems = feed.items;

      const taskIds = [...new Set(rawItems.map(taskIdOf).filter((id): id is string => Boolean(id)))];
      const recoveryIds = rawItems.filter((item) => item.sourceKind === "recovery_action").map((item) => item.subject.id);
      // Every interaction's payload: connection intents and "at your desk" asks.
      const interactionIds = rawItems.filter((item) => item.sourceKind === "issue_thread_interaction")
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
            executionState: issues.executionState,
            conversationAgentId: issues.conversationAgentId,
            updatedAt: issues.updatedAt,
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
        interactionIds.length === 0 ? Promise.resolve([]) : db
          .select({
            id: issueThreadInteractions.id,
            issueId: issueThreadInteractions.issueId,
            kind: issueThreadInteractions.kind,
            payload: issueThreadInteractions.payload,
            createdAt: issueThreadInteractions.createdAt,
            createdByAgentId: issueThreadInteractions.createdByAgentId,
          })
          .from(issueThreadInteractions)
          .where(and(eq(issueThreadInteractions.companyId, companyId), inArray(issueThreadInteractions.id, interactionIds))),
        loadAiHealth(companyId, options.userId, now),
      ]);
      const taskById = new Map(taskRows.map((row) => [row.id, row]));
      const agentById = new Map(agentRows.map((row) => [row.id, row]));
      const context = await loadCardContext(companyId, viewerUserIds, taskRows, intentRows);
      const recoveryById = new Map(recoveryRows.map((row) => [row.id, row]));
      const intentById = new Map(intentRows.map((row) => [row.id, row]));
      const deskById = new Map<string, DeskAsk>();
      for (const row of intentRows) {
        const atDesk = (row.payload as { atDesk?: unknown } | null)?.atDesk;
        if (!atDesk || typeof atDesk !== "object") continue;
        deskById.set(row.id, {
          interactionId: row.id,
          issueId: row.issueId,
          kind: row.kind,
          command: readString(atDesk as Record<string, unknown>, "command"),
        });
      }

      // Which failing runs were an AI-connection failure, and when they ran.
      const runIds = [
        ...failedRunIds,
        ...recoveryRows.map((row) => readString(row.evidence as Record<string, unknown>, "latestRunId")).filter((id): id is string => Boolean(id)),
      ];
      const runRows = runIds.length === 0 ? [] : await db
        .select({
          id: heartbeatRuns.id,
          agentId: heartbeatRuns.agentId,
          createdAt: heartbeatRuns.createdAt,
          errorCode: heartbeatRuns.errorCode,
          error: heartbeatRuns.error,
          gapReason: sql<string | null>`${heartbeatRuns.resultJson} -> 'configurationIncomplete' ->> 'reason'`,
          actionUrl: sql<string | null>`${heartbeatRuns.resultJson} -> 'configurationIncomplete' ->> 'actionUrl'`,
        })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, [...new Set(runIds)])));
      const runById = new Map(runRows.map((row) => [row.id, row]));

      // Repeated setup failures (GRE-504): one card per agent and cause.
      const setupIdentityOfRun = (run: (typeof runRows)[number] | undefined): SetupIdentity | null => {
        if (!run || run.errorCode !== CONFIGURATION_INCOMPLETE) return null;
        const cause = run.error?.replace(/\s+/g, " ").trim() || "Setup is not complete";
        return {
          key: setupKey(run.agentId, run.gapReason ?? "unknown", cause),
          runId: run.id,
          agentId: run.agentId,
          cause,
          fixHref: setupFixHref(run.actionUrl, run.agentId),
          runAt: timeOf(run.createdAt),
        };
      };
      const setupIdentityOf = (item: AttentionItem): SetupIdentity | null => {
        if (item.sourceKind === "recovery_action") {
          const recovery = recoveryById.get(item.subject.id);
          if (!recovery || recovery.cause !== CONFIGURATION_INCOMPLETE) return null;
          return setupIdentityOfRun(runById.get(readString(recovery.evidence as Record<string, unknown>, "latestRunId") ?? ""));
        }
        if (item.sourceKind === "failed_run") return setupIdentityOfRun(runById.get(item.subject.id));
        return null;
      };
      const setupAgentIds = [...new Set(rawItems.map((item) => setupIdentityOf(item)?.agentId).filter((id): id is string => Boolean(id)))];
      const setupHistory = setupAgentIds.length === 0 ? [] : await db
        .select({
          id: heartbeatRuns.id,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          createdAt: heartbeatRuns.createdAt,
          errorCode: heartbeatRuns.errorCode,
          error: heartbeatRuns.error,
          gapReason: sql<string | null>`${heartbeatRuns.resultJson} -> 'configurationIncomplete' ->> 'reason'`,
        })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.agentId, setupAgentIds),
          gt(heartbeatRuns.createdAt, new Date(now - SETUP_HISTORY_MS)),
          or(eq(heartbeatRuns.status, "succeeded"), eq(heartbeatRuns.errorCode, CONFIGURATION_INCOMPLETE)),
        ));
      const successesByAgent = new Map<string, number[]>();
      const failuresByKey = new Map<string, Array<{ id: string; at: number }>>();
      for (const row of setupHistory) {
        if (row.status === "succeeded") {
          successesByAgent.set(row.agentId, [...(successesByAgent.get(row.agentId) ?? []), timeOf(row.createdAt)]);
        } else {
          const cause = row.error?.replace(/\s+/g, " ").trim() || "Setup is not complete";
          const key = setupKey(row.agentId, row.gapReason ?? "unknown", cause);
          failuresByKey.set(key, [...(failuresByKey.get(key) ?? []), { id: row.id, at: timeOf(row.createdAt) }]);
        }
      }
      /** The agent's first successful run after a setup failure: the setup works again. */
      const setupFixedAt = (item: AttentionItem): number | null => {
        const identity = setupIdentityOf(item);
        if (!identity) return null;
        const after = (successesByAgent.get(identity.agentId) ?? []).filter((time) => time > identity.runAt);
        return after.length > 0 ? Math.min(...after) : null;
      };

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

      /**
       * A row on a done or cancelled task: nothing is left to decide. An
       * approval can govern more than its task, so it stays until decided.
       */
      const isClosedTaskRow = (item: AttentionItem) => {
        if (item.sourceKind === "approval") return false;
        const task = taskById.get(taskIdOf(item) ?? "");
        return task ? CLOSED_ISSUE_STATUSES.has(task.status) : false;
      };
      const blocksNothing = (item: AttentionItem) =>
        item.sourceKind === "blocker_attention"
        && (item.detail as { blockedTaskCount?: unknown } | null)?.blockedTaskCount === 0;
      /**
       * A tool connection request whose cause is gone: the tool now works (a
       * working connection by that name changed after the ask), or the chat it
       * was asked in moved on (the person wrote after it, as when Greatstone
       * chose OneDrive over Google Drive). AI connections clear through
       * `aiRepairedAt` instead.
       */
      const connectionSuperseded = (item: AttentionItem) => {
        if (item.sourceKind !== "issue_thread_interaction" || cardKind(item) !== "connection") return false;
        const intent = intentById.get(item.subject.id);
        const payload = (intent?.payload ?? {}) as Record<string, unknown>;
        if (!intent || payload.purpose === "ai") return false;
        const askedAt = timeOf(intent.createdAt);
        const service = squash(readString(payload, "serviceSlug") ?? readString(payload, "serviceName") ?? "");
        // ponytail: matches a connection by name, add a service slug column if names drift.
        if (service && context.workingTools.some((tool) => tool.at > askedAt && tool.key.includes(service))) return true;
        const task = taskById.get(intent.issueId);
        const spokeAt = context.latestPersonComment.get(intent.issueId);
        return Boolean(task?.conversationAgentId && spokeAt && spokeAt.getTime() > askedAt);
      };
      const isGoneRow = (item: AttentionItem) => isClosedTaskRow(item) || blocksNothing(item) || connectionSuperseded(item);

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
      const isOpenRow = (item: AttentionItem) =>
        !isGoneRow(item) && aiRepairedAt(item) === null && setupFixedAt(item) === null;
      const sharedTasks = new Map<string, Set<string>>();
      for (const item of rawItems) {
        const key = sharedConnectionKey(item);
        const taskId = taskIdOf(item);
        if (!key || !taskId || !isOpenRow(item)) continue;
        sharedTasks.set(key, (sharedTasks.get(key) ?? new Set()).add(taskId));
      }

      // One task, one card (GRE-431): a stalled-blocker row joins the card of
      // the task it blocks when that task already has its own open row (a
      // question, an approval), instead of opening a second card about it.
      const anchoredTasks = new Set<string>();
      const sharedKeyOf = (item: AttentionItem) => {
        const key = sharedConnectionKey(item);
        return key && isOpenRow(item) && (sharedTasks.get(key)?.size ?? 0) > 1 ? key : null;
      };
      for (const item of rawItems) {
        if (blockedTaskIdOf(item) || sharedKeyOf(item) || !isOpenRow(item)) continue;
        const taskId = taskIdOf(item);
        if (taskId) anchoredTasks.add(taskId);
      }
      const groupTaskIdOf = (item: AttentionItem) => {
        const blockedId = blockedTaskIdOf(item);
        return blockedId && anchoredTasks.has(blockedId) ? blockedId : taskIdOf(item);
      };

      const baseKeyOf = (item: AttentionItem) => {
        const shared = sharedKeyOf(item);
        if (shared) return shared;
        const taskId = groupTaskIdOf(item);
        return taskId ? `task:${taskId}` : `item:${item.dedupKey}`;
      };

      // A task (or task-less failed run) whose only rows are one setup gap of
      // one agent, plus that agent's AI connection request, joins that gap's
      // card (GRE-504). A task with anything else (a question, an approval, a
      // blocker) keeps its own card, so one task stays one card.
      const isAiRequest = (item: AttentionItem) =>
        item.sourceKind === "issue_thread_interaction" && cardKind(item) === "connection"
        && ((intentById.get(item.subject.id)?.payload ?? {}) as Record<string, unknown>).purpose === "ai";
      const unitSetup = new Map<string, { keys: Set<string>; other: boolean }>();
      for (const item of rawItems) {
        if (isGoneRow(item)) continue;
        const unit = baseKeyOf(item);
        const entry = unitSetup.get(unit) ?? { keys: new Set<string>(), other: false };
        const identity = setupIdentityOf(item);
        if (identity) entry.keys.add(identity.key);
        else if (!isAiRequest(item)) entry.other = true;
        unitSetup.set(unit, entry);
      }
      const setupKeyOfUnit = new Map<string, string>();
      const setupUnits = new Map<string, Set<string>>();
      for (const [unit, entry] of unitSetup) {
        if (entry.other || entry.keys.size !== 1 || unit.startsWith("connection:")) continue;
        const key = [...entry.keys][0]!;
        setupKeyOfUnit.set(unit, key);
        setupUnits.set(key, (setupUnits.get(key) ?? new Set()).add(unit));
      }

      /** Count, last seen and fix link of one setup gap, across every failed run of it. */
      const describeSetup = (key: string, units: Set<string>): DecisionCardSetup => {
        const identities = rawItems
          .filter((item) => units.has(baseKeyOf(item)))
          .map(setupIdentityOf)
          .filter((identity): identity is SetupIdentity => identity?.key === key)
          .sort((left, right) => right.runAt - left.runAt);
        const newest = identities[0]!;
        const failures = [
          ...(failuresByKey.get(key) ?? []),
          ...identities.map((identity) => ({ id: identity.runId, at: identity.runAt })),
        ];
        const lastSeen = Math.max(...failures.map((failure) => failure.at));
        // Count from the agent's last success before the newest failure, so a
        // fixed-then-broken setup starts a fresh count.
        const since = Math.max(0, ...(successesByAgent.get(newest.agentId) ?? []).filter((time) => time < lastSeen));
        const counted = new Set(failures.filter((failure) => failure.at > since).map((failure) => failure.id));
        return {
          agent: agentRef(newest.agentId),
          cause: newest.cause,
          failureCount: counted.size,
          lastSeenAt: new Date(lastSeen).toISOString(),
          fixHref: newest.fixHref,
          tasks: [...units]
            .map((unit) => (unit.startsWith("task:") ? taskById.get(unit.slice("task:".length)) : undefined))
            .filter((row): row is TaskRow => Boolean(row) && !CLOSED_ISSUE_STATUSES.has(row!.status))
            .map((row) => ({ id: row.id, identifier: row.identifier, title: row.title }))
            .sort((left, right) => (left.identifier ?? left.id).localeCompare(right.identifier ?? right.id)),
          fixedAt: null,
        };
      };

      const groups = new Map<string, Group>();
      let staleCleared = 0;
      for (const item of rawItems) {
        const shared = sharedKeyOf(item);
        const baseKey = baseKeyOf(item);
        const setup = setupKeyOfUnit.get(baseKey) ?? null;
        const mergedSetup = setup && (setupUnits.get(setup)?.size ?? 0) > 1 ? setup : null;
        const taskId = shared || mergedSetup ? null : groupTaskIdOf(item);
        const key = mergedSetup ?? baseKey;
        const group: Group = groups.get(key) ?? { key, taskId, items: [], cleared: [], aiRepairedAt: null, setupFixedAt: null };
        if (setup && !group.setup) {
          group.setup = describeSetup(setup, setupUnits.get(setup)!);
          group.setupTasks = [...setupUnits.get(setup)!]
            .map((unit) => (unit.startsWith("task:") ? taskById.get(unit.slice("task:".length)) : undefined))
            .filter((row): row is TaskRow => Boolean(row));
        }
        if (shared && !group.shared) {
          const payload = (intentById.get(item.subject.id)?.payload ?? {}) as Record<string, unknown>;
          group.shared = {
            agentId: readString(payload, "requestingAgentId")!,
            serviceName: readString(payload, "serviceName") ?? readString(payload, "serviceSlug")!,
            tasks: [...sharedTasks.get(shared)!].map((id) => taskById.get(id)).filter((task): task is TaskRow => Boolean(task)),
          };
        }
        groups.set(key, group);
        if (isGoneRow(item)) {
          staleCleared += 1;
          continue;
        }
        const repairedAt = aiRepairedAt(item);
        const fixedAt = repairedAt === null ? setupFixedAt(item) : null;
        if (repairedAt !== null || fixedAt !== null) {
          staleCleared += 1;
          if (repairedAt !== null) group.aiRepairedAt = Math.max(group.aiRepairedAt ?? 0, repairedAt);
          if (fixedAt !== null) group.setupFixedAt = Math.max(group.setupFixedAt ?? 0, fixedAt);
          group.cleared.push(item);
          continue;
        }
        group.items.push(item);
      }
      for (const group of groups.values()) {
        if (group.setup && group.items.length === 0) {
          group.setup.fixedAt = new Date(group.setupFixedAt ?? group.aiRepairedAt ?? now).toISOString();
        }
      }

      const clarityByTask = await loadClarity(companyId, [...groups.values()]
        .map((group) => group.taskId).filter((id): id is string => Boolean(id)));

      // Pending review stages: the reviewer by name, and whether it is the viewer (GRE-870).
      const reviewStates = new Map(taskRows.flatMap((row) => {
        const state = parseIssueExecutionState(row.executionState);
        return state?.status === "pending" && state.currentParticipant ? [[row.id, state] as const] : [];
      }));
      const reviewerUserIds = [...new Set([...reviewStates.values()]
        .map((state) => (state.currentParticipant?.type === "user" ? state.currentParticipant.userId : null))
        .filter((id): id is string => Boolean(id)))];
      const userRows = reviewerUserIds.length === 0 ? [] : await db
        .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
        .from(authUsers)
        .where(inArray(authUsers.id, reviewerUserIds));
      const userNameById = new Map(userRows.map((row) => [row.id, row.name.trim() || row.email]));
      const pendingReviewOf = (taskId: string): PendingReview | null => {
        const state = reviewStates.get(taskId);
        const participant = state?.currentParticipant;
        if (!state || !participant) return null;
        const id = participant.type === "user" ? participant.userId : participant.agentId;
        if (!id) return null;
        const name = participant.type === "user"
          ? userNameById.get(id) ?? (id === "local-board" ? "Board" : "A board user")
          : agentById.get(id)?.name ?? "An agent";
        const returnAssignee = state.returnAssignee;
        return {
          reviewer: { type: participant.type, id, name, isYou: participant.type === "user" && principalIdsInclude(viewerUserIds, id) },
          returnAgentId: returnAssignee?.type === "agent" ? returnAssignee.agentId ?? null : null,
          canReturn: Boolean(returnAssignee && (returnAssignee.agentId || returnAssignee.userId)),
        };
      };

      const assignableAgents = agentRows
        .filter((agent) => evaluateAgentInvokability(agent as AgentOrgRow, agentRows as AgentOrgRow[]).invokable)
        .map((agent) => ({ id: agent.id, name: agent.name }));

      const cards: DecisionCard[] = [];
      const routedToLead: NonNullable<DecisionsFeed["routedToLead"]> = [];
      for (const group of groups.values()) {
        const task = group.taskId ? taskById.get(group.taskId) ?? null : null;
        // The gate: a card shows only to someone who can move it. A stall on
        // the agent side (a stalled blocker owned by an agent, or by nobody,
        // and no ask of a person) goes to the lead agent first. It reaches a
        // person when the owning agent's latest comment names them and an
        // action, or when it outlives STALL_ESCALATION_MS with the lead.
        let escalation: DecisionCard["escalation"] = null;
        if (task && isAgentStall(group)) {
          if (task.assigneeUserId) {
            if (!principalIdsInclude(viewerUserIds, task.assigneeUserId)) continue;
          } else {
            const latest = context.latestAgentComment.get(task.id);
            const routedAt = context.routedAt.get(task.id) ?? null;
            const leadSummary = context.latestLeadComment.get(task.id);
            const summary = leadSummary ? commentExcerpt(leadSummary.body) : null;
            if (namedAskSentence(latest?.body, context.names)) {
              escalation = { reason: "named_in_comment", lead: context.lead, summary };
            } else if (routedAt && now - routedAt.getTime() >= STALL_ESCALATION_MS) {
              escalation = { reason: "stall_threshold", lead: context.lead, summary };
            } else {
              routedToLead.push({
                taskId: task.id,
                identifier: task.identifier,
                title: task.title,
                lead: context.lead,
                routedAt: routedAt?.toISOString() ?? null,
              });
              continue;
            }
          }
        }
        // A fixed AI connection or setup clears its cards. A task it left
        // blocked keeps one card so it is not stranded: it still needs a retry.
        const leftBlocked = task
          ? task.status === "blocked"
          : group.taskId === null && Boolean(group.setupTasks?.some((row) => row.status === "blocked"));
        const readyToRetry = group.items.length === 0
          && (group.aiRepairedAt !== null || group.setupFixedAt !== null) && leftBlocked;
        if (group.items.length === 0 && !readyToRetry) continue;
        // Releases run from Claude, not from Decisions (release-task.ts).
        if (task && isReleaseTask(task.title)) continue;
        cards.push(buildCard({
          companyId,
          group,
          task,
          readyToRetry,
          taskSubject: task ? findTaskSubject(rawItems, task.id) : null,
          clarity: group.taskId ? clarityByTask.get(group.taskId) ?? null : null,
          review: task && task.status === "in_review" ? pendingReviewOf(task.id) : null,
          agentRef,
          recoveryById,
          deskById,
          context,
          escalation,
        }));
      }
      cards.sort((left, right) =>
        SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
        || timeOf(right.activityAt) - timeOf(left.activityAt)
        || left.id.localeCompare(right.id));

      const countsByKind = Object.fromEntries(DECISION_CARD_KINDS.map((kind) => [kind, 0])) as Record<DecisionCardKind, number>;
      for (const card of cards) countsByKind[card.kind] += 1;

      // "At your desk" cards wait for John at the computer: not in the phone count (GRE-450).
      const atDeskCount = cards.filter((card) => card.atDesk).length;

      return {
        companyId,
        generatedAt: new Date(now).toISOString(),
        count: cards.length - atDeskCount,
        atDeskCount,
        countsByKind,
        staleCleared,
        assignableAgents,
        cards,
        routedToLead,
      };
    },
  };

  /** Names, comments and task links the cards need, in one round of queries. */
  async function loadCardContext(
    companyId: string,
    viewerUserIds: string[],
    taskRows: TaskRow[],
    intentRows: Array<{ id: string; payload: unknown; createdByAgentId: string | null }>,
  ): Promise<CardContext> {
    const taskIds = taskRows.map((row) => row.id);
    const none = Promise.resolve([] as never[]);
    const [company, leadId, viewerRows, agentComments, personComments, blocksRows, blockedByRows, toolRows, routedRows] = await Promise.all([
      db.select({ prefix: companies.issuePrefix }).from(companies).where(eq(companies.id, companyId)).then((rows) => rows[0] ?? null),
      findLeadAgentId(db, companyId),
      db.select({ id: authUsers.id, name: authUsers.name }).from(authUsers).where(inArray(authUsers.id, viewerUserIds)),
      // Newest agent comment per task, and newest per task per agent for the lead.
      taskIds.length === 0 ? none : db
        .selectDistinctOn([issueComments.issueId, issueComments.authorAgentId], {
          issueId: issueComments.issueId,
          agentId: issueComments.authorAgentId,
          body: issueComments.body,
          at: issueComments.createdAt,
        })
        .from(issueComments)
        .where(and(
          eq(issueComments.companyId, companyId),
          inArray(issueComments.issueId, taskIds),
          sql`${issueComments.authorAgentId} is not null`,
          sql`${issueComments.deletedAt} is null`,
        ))
        .orderBy(issueComments.issueId, issueComments.authorAgentId, desc(issueComments.createdAt)),
      taskIds.length === 0 ? none : db
        .select({ issueId: issueComments.issueId, at: sql<Date>`max(${issueComments.createdAt})` })
        .from(issueComments)
        .where(and(
          eq(issueComments.companyId, companyId),
          inArray(issueComments.issueId, taskIds),
          sql`${issueComments.authorUserId} is not null`,
          sql`${issueComments.deletedAt} is null`,
        ))
        .groupBy(issueComments.issueId),
      // What each task holds up, and what it waits on.
      taskIds.length === 0 ? none : db
        .select({ from: issueRelations.issueId, id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
        .from(issueRelations)
        .innerJoin(issues, eq(issues.id, issueRelations.relatedIssueId))
        .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks"), inArray(issueRelations.issueId, taskIds))),
      taskIds.length === 0 ? none : db
        .select({
          to: issueRelations.relatedIssueId,
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issues.id, issueRelations.issueId))
        .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks"), inArray(issueRelations.relatedIssueId, taskIds))),
      db
        .select({ name: toolConnections.name, uid: toolConnections.uid, updatedAt: toolConnections.updatedAt })
        .from(toolConnections)
        .where(and(
          eq(toolConnections.companyId, companyId),
          eq(toolConnections.connectionPurpose, "tool"),
          eq(toolConnections.enabled, true),
          eq(toolConnections.status, "active"),
          sql`${toolConnections.healthStatus} <> 'error'`,
        )),
      taskIds.length === 0 ? none : db
        .select({ issueId: activityLog.entityId, at: sql<Date>`max(${activityLog.createdAt})` })
        .from(activityLog)
        .where(and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, STALL_ROUTED_ACTION),
          inArray(activityLog.entityId, taskIds),
        ))
        .groupBy(activityLog.entityId),
    ]);
    const prefix = company?.prefix ?? "";
    const leadRow = leadId
      ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.id, leadId)).then((rows) => rows[0] ?? null)
      : null;
    const taskRef = (row: { id: string; identifier: string | null; title: string; status: string }): DecisionCardTaskRef => ({
      id: row.id,
      identifier: row.identifier,
      title: row.title,
      status: row.status,
      href: `/${prefix}/issues/${row.identifier ?? row.id}`,
    });
    const latestAgentComment = new Map<string, { agentId: string; body: string; at: Date }>();
    const latestLeadComment = new Map<string, { body: string; at: Date }>();
    const latestCommentBy = new Map<string, { agentId: string; body: string; at: Date }>();
    for (const row of agentComments as Array<{ issueId: string; agentId: string | null; body: string; at: Date }>) {
      if (!row.agentId) continue;
      const at = new Date(row.at);
      const current = latestAgentComment.get(row.issueId);
      if (!current || current.at < at) latestAgentComment.set(row.issueId, { agentId: row.agentId, body: row.body, at });
      if (row.agentId === leadId) latestLeadComment.set(row.issueId, { body: row.body, at });
      latestCommentBy.set(`${row.issueId}:${row.agentId}`, { agentId: row.agentId, body: row.body, at });
    }
    type RefRow = { key: string; id: string; identifier: string | null; title: string; status: string };
    const openRefsBy = (rows: RefRow[]) => {
      const map = new Map<string, DecisionCardTaskRef[]>();
      const sorted = [...rows].sort((left, right) =>
        (left.identifier ?? left.id).localeCompare(right.identifier ?? right.id, undefined, { numeric: true }));
      for (const row of sorted) {
        if (!CLOSED_ISSUE_STATUSES.has(row.status)) map.set(row.key, [...(map.get(row.key) ?? []), taskRef(row)]);
      }
      return map;
    };
    return {
      prefix,
      lead: leadRow ? { id: leadRow.id, name: leadRow.name } : null,
      names: viewerRows.flatMap((row) => viewerNames(row.name)).concat(viewerRows.length === 0 ? viewerNames(null) : []),
      latestAgentComment,
      latestLeadComment,
      latestCommentBy,
      holdsUp: openRefsBy(blocksRows.map((row) => ({ ...row, key: row.from }))),
      blockerChain: openRefsBy(blockedByRows.map((row) => ({ ...row, key: row.to }))),
      blockerOwner: new Map(blockedByRows.map((row) => [row.id, { agentId: row.assigneeAgentId, userId: row.assigneeUserId }])),
      interactionCreatedBy: new Map(intentRows.map((row) => [row.id, row.createdByAgentId])),
      interactionPayload: new Map(intentRows.map((row) => [row.id, (row.payload ?? {}) as Record<string, unknown>])),
      latestPersonComment: new Map((personComments as Array<{ issueId: string; at: Date }>).map((row) => [row.issueId, new Date(row.at)])),
      workingTools: toolRows.map((row) => ({ key: squash(`${row.name} ${row.uid}`), at: timeOf(row.updatedAt) })),
      routedAt: new Map((routedRows as Array<{ issueId: string; at: Date }>).map((row) => [row.issueId, new Date(row.at)])),
    };
  }

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
  group: Group;
  task: TaskRow | null;
  readyToRetry: boolean;
  taskSubject: AttentionSubject | null;
  clarity: DecisionCardClarity | null;
  review: PendingReview | null;
  agentRef: (agentId: string | null | undefined) => DecisionCardAgentRef | null;
  recoveryById: Map<string, { id: string; evidence: unknown; nextAction: string }>;
  deskById: Map<string, DeskAsk>;
  context: CardContext;
  escalation: DecisionCard["escalation"];
}): DecisionCard {
  const { companyId, group, task, readyToRetry, clarity, review, agentRef, context } = input;
  const items = [...group.items].sort((left, right) =>
    (KIND_RANK.get(cardKind(left)) ?? 99) - (KIND_RANK.get(cardKind(right)) ?? 99)
    || timeOf(right.activityAt) - timeOf(left.activityAt));
  const kinds = readyToRetry ? ["recovery" as const] : [...new Set(items.map(cardKind))];
  const kind = kinds[0]!;
  const main = items[0] ?? null;
  const taskOpen = task !== null && !CLOSED_ISSUE_STATUSES.has(task.status);
  const byKind = (wanted: DecisionCardKind) => items.find((item) => cardKind(item) === wanted) ?? null;

  const taskLabel = task ? `${task.identifier ?? task.id.slice(0, 8)} ${task.title}` : null;
  // A chat thread is not an execution task, so its rows carry no link: build it.
  const taskHref = task ? `/${context.prefix}/issues/${task.identifier ?? task.id}` : null;
  const interactionHref = (item: AttentionItem) => item.subject.href
    ?? (taskHref && item.sourceKind === "issue_thread_interaction" ? `${taskHref}#interaction-${item.subject.id}` : null);
  const shared = group.shared;
  const sharedAgent = shared ? agentRef(shared.agentId) : null;
  const sharedTaskList = shared?.tasks.map((row) => row.identifier ?? row.id.slice(0, 8)).sort().join(", ");
  // A setup card that stands for several tasks or task-less runs (GRE-504).
  const setup = group.setup ?? null;
  const setupCard = setup !== null && group.taskId === null;
  const setupAgentName = setup?.agent?.name ?? "The agent";
  const setupTaskCount = setup?.tasks.length ?? 0;
  const setupTasksLabel = setupTaskCount === 1 ? "1 task" : `${setupTaskCount} tasks`;
  const title = shared
    ? `${sharedAgent?.name ?? "An agent"} needs ${shared.serviceName} for ${shared.tasks.length} tasks`
    : setupCard
      ? readyToRetry
        ? `${setupAgentName}'s setup works again: ${setupTasksLabel} still stopped`
        : `${setupAgentName} cannot start: setup is not complete`
      : taskLabel ?? main?.subject.title ?? "Needs your decision";

  // Who is waiting: the owner of the task. For a stalled blocker, the owner of
  // the blocked task behind it waits too, but the blocker's owner acts.
  // A stalled blocker that joined this card is about another task: its own
  // actions target that blocker, and its counts are not this task's.
  const isForeignBlocker = (item: AttentionItem) =>
    cardKind(item) === "blocked" && task !== null && item.subject.id !== task.id;
  const foreignBlocker = items.find(isForeignBlocker) ?? null;
  const blockedItem = items.find((item) => cardKind(item) === "blocked" && !isForeignBlocker(item)) ?? null;
  const blockedTaskAgentId = readString(blockedItem?.relatedIssue?.metadata, "assigneeAgentId");
  const waiting = sharedAgent
    ?? (setupCard ? setup!.agent : null)
    ?? agentRef(task?.assigneeAgentId)
    ?? agentRef(blockedTaskAgentId)
    ?? agentRef(readString(main?.subject.metadata, "createdByAgentId"))
    ?? agentRef(readString(main?.subject.metadata, "agentId"))
    ?? agentRef(readString(main?.subject.metadata, "requestedByAgentId"))
    // A task in review waits on its reviewer; the agent who gets it back waits too.
    ?? agentRef(review?.returnAgentId);

  // A ready-to-retry card retries through the recovery the fixed connection left open.
  // A task the fixed connection left blocked keeps Retry even when other rows
  // (a question, a blocker) still hold the card open.
  const repairedAt = group.aiRepairedAt ?? group.setupFixedAt;
  const retryAfterRepair = repairedAt !== null && task?.status === "blocked";
  // An in-review task with no reviewer left: the board gives the verdict (GRE-1421).
  const stalledReview = review === null && byKind("review")?.subject.metadata?.reviewAttentionState === "stalled";
  const recoveryItem = byKind("recovery")
    ?? (retryAfterRepair ? group.cleared.find((item) => item.sourceKind === "recovery_action") ?? null : null);
  const recovery = recoveryItem ? input.recoveryById.get(recoveryItem.subject.id) ?? null : null;
  let reason: string;
  if (shared) {
    reason = `${shared.tasks.length} tasks wait for the same ${shared.serviceName} connection: ${sharedTaskList}. One answer covers all of them.`;
  } else if (readyToRetry && group.aiRepairedAt === null) {
    reason = `The setup works again: ${setup?.agent?.name ?? waiting?.name ?? "The agent"} finished a run at ${hhmm(group.setupFixedAt!)}. `
      + (setupCard
        ? `${setupTasksLabel} ${setupTaskCount === 1 ? "is" : "are"} still stopped from the earlier failure.`
        : "The task is still stopped from the earlier failure.");
  } else if (readyToRetry) {
    reason = `The AI connection works again (since ${hhmm(group.aiRepairedAt!)}). The task is still stopped from the earlier failure.`;
  } else if (setupCard) {
    reason = setup!.cause;
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
  } else if (kind === "review") {
    // Say what the board is asked to judge, not the task title again (GRE-1421).
    const sender = waiting?.name ?? "The agent";
    reason = stalledReview
      ? `${sender} says the work is finished. No reviewer is set, so the task waits for you.`
      : review && !review.reviewer.isYou
        ? `${sender} sent the work for review by ${review.reviewer.name}.`
        : `${sender} sent the work for your review.`;
  } else {
    reason = detailSummary(main!) ?? main!.subject.title ?? main!.whyNow;
  }

  const blockedCount = (blockedItem?.detail as { blockedTaskCount?: unknown } | null)?.blockedTaskCount;
  const nextStepByKind: Record<DecisionCardKind, string> = {
    question: readString(main?.subject.metadata, "askType")
      ? `${waiting?.name ?? "The agent"} is woken as soon as you answer, either way.`
      : `${waiting?.name ?? "The agent"} waits for your answer, then continues.`,
    approval: main?.subject.metadata?.type === "permission_grant"
      ? `${waiting?.name ?? "The agent"} stays blocked until you grant or deny the permission.`
      : "Nothing moves until you approve or reject it.",
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
    review: stalledReview
      ? "Check the result. Then approve it, ask for changes, or send it back to work."
      : !review || review.reviewer.isYou
      ? "The task stays in review until you approve it or ask for changes."
      : `The task stays in review until ${review.reviewer.name} approves it or asks for changes.`,
    decision: "The agent waits for your decision.",
    budget: "Paused work stays paused until the budget is raised.",
    agent_error: "The agent takes no work until the error is fixed.",
    join_request: "The request waits for your approval.",
    outage: "Nothing to decide. Retry the failed runs if their tasks still matter, then dismiss this card.",
  };
  if (setupCard && !readyToRetry) {
    nextStepByKind[kind] = `${setupAgentName} stops the same way on every run until the setup is fixed. Fix it, then retry.`;
  } else if (setupCard) {
    nextStepByKind[kind] = `Retry to continue ${setupTaskCount === 1 ? "the task" : "the tasks"}.`;
  }
  if (shared) {
    nextStepByKind.connection = `${waiting?.name ?? "The agent"} stays stopped on these tasks until you answer. Connect ${shared.serviceName} once and each task continues one time.`;
  }
  const blockerLabel = foreignBlocker
    ? foreignBlocker.subject.identifier ?? foreignBlocker.subject.title ?? "Its blocker"
    : null;
  const blockerNote = blockerLabel
    ? ` It is also blocked by ${blockerLabel}, which has no live next step.`
    : "";
  const nextStep = (clarity && !clarity.answer
    ? `Waiting for ${clarity.agent?.name ?? "the agent"} to answer your question. ${nextStepByKind[kind]}`
    : nextStepByKind[kind]) + blockerNote;

  // At your desk (GRE-450): every row asks for John at the computer. A card
  // that also holds phone work (an approval, a retry) stays a phone card.
  const deskAsks = items.map((item) =>
    item.sourceKind === "issue_thread_interaction" ? input.deskById.get(item.subject.id) ?? null : null);
  const atDesk = items.length > 0 && deskAsks.every(Boolean)
    ? { command: deskAsks.find((ask) => ask?.command)?.command ?? null }
    : null;

  const actions: DecisionCardAction[] = [];
  // The fix comes first while the setup is still broken (GRE-504).
  if (setup && !setup.fixedAt) {
    actions.push(linkAction("fix_setup", "Fix setup", `Open the page where ${setupAgentName}'s setup is fixed.`, setup.fixHref));
  }
  // Done accepts a desk confirmation; it wakes the agent to check the work.
  const doneRequests = atDesk
    ? deskAsks.filter((ask) => ask?.kind === "request_confirmation")
      .map((ask) => request("POST", `/api/issues/${ask!.issueId}/interactions/${ask!.interactionId}/accept`))
    : [];
  if (doneRequests.length > 0) {
    actions.push(requestAction(
      "done",
      "Done",
      `Tell ${waiting?.name ?? "the agent"} it is done. The agent is woken to check.`,
      doneRequests,
    ));
  }
  // Native decisions first: the card's own question or approval.
  for (const item of items) {
    if (item.sourceKind === "approval") {
      // The attention item names its verbs: a permission request says Grant / Deny (GRE-601).
      const approve = item.decisionVerbs.find((verb) => verb.id === "approve");
      const reject = item.decisionVerbs.find((verb) => verb.id === "reject");
      actions.push(
        requestAction("approve", approve?.label ?? "Approve", approve?.description ?? "Approve the request.", [request("POST", `/api/approvals/${item.subject.id}/approve`)]),
        requestAction("reject", reject?.label ?? "Reject", reject?.description ?? "Reject the request.", [request("POST", `/api/approvals/${item.subject.id}/reject`)]),
      );
    } else if (item.sourceKind === "issue_thread_interaction" && cardKind(item) === "question" && interactionHref(item)) {
      actions.push(linkAction("open", "Answer", "Open the question on the task and answer it there.", interactionHref(item)!));
    } else if (cardKind(item) === "connection" && interactionHref(item) && !actions.some((action) => action.id === "reconnect")) {
      const payload = context.interactionPayload.get(item.subject.id) ?? {};
      const service = readString(payload, "serviceName") ?? readString(payload, "serviceSlug");
      actions.push(shared
        ? linkAction("reconnect", "Connect", `Open the request and connect ${shared.serviceName}. Every waiting task continues.`, interactionHref(item)!)
        : payload.purpose === "ai" || !service
          ? linkAction("reconnect", "Reconnect", "Open the AI connection and reconnect it. The task can then be retried.", interactionHref(item)!)
          : linkAction("reconnect", "Connect", `Open the request and connect ${service}. ${waiting?.name ?? "The agent"} carries on once it works.`, interactionHref(item)!));
    }
  }

  // The review verdict, only for the user the stage waits on (GRE-870). The
  // PATCH is the issue's own stage decision; the server checks the reviewer again.
  // A linked approval on the card already gives its own Approve.
  if (task && taskOpen && review?.reviewer.isYou && !actions.some((action) => action.id === "approve")) {
    const issuePath = `/api/issues/${task.id}`;
    actions.push(requestAction("approve", "Approve", "Approve the review. The task moves to its next stage or is done.", [
      request("PATCH", issuePath, { status: "done", comment: "Approved from Decisions." }),
    ]));
    if (review.canReturn) {
      actions.push(requestAction(
        "request_changes",
        "Request changes",
        "Send the task back to its owner with what must change. The owner is woken.",
        [request("PATCH", issuePath, { status: "in_progress" })],
        { field: "comment", type: "text", label: "What must change", required: true },
      ));
    }
  }

  // No reviewer is left, so the board decides through the stalled-review
  // endpoint (PAP-16080 §4.4). Each description says what the choice does.
  if (task && taskOpen && stalledReview && !actions.some((action) => action.id === "approve")) {
    const decisionPath = `/api/issues/${task.id}/stalled-review-decision`;
    const owner = waiting?.name ?? "its owner";
    actions.push(
      requestAction("approve", "Approve", "The task is marked done.", [
        request("POST", decisionPath, { action: "approve" }),
      ]),
      requestAction(
        "request_changes",
        "Request changes",
        `The task goes back to ${owner} with your note. Write a note first.`,
        [request("POST", decisionPath, { action: "request_changes" })],
        { field: "note", type: "text", label: "What must change", required: true },
      ),
      requestAction("send_back", "Send back to work", `The task goes back to ${owner} to continue. No note is necessary.`, [
        request("POST", decisionPath, { action: "send_back" }),
      ]),
    );
  }

  // The blocker's own way forward, on the blocked task's card.
  if (foreignBlocker && blockerLabel) {
    const blockerPath = `/api/issues/${foreignBlocker.subject.id}`;
    actions.push(requestAction(
      "reassign_blocker",
      `Reassign ${blockerLabel}`,
      `Give the blocker ${blockerLabel} to another agent. The new owner is woken.`,
      [request("PATCH", blockerPath, { assigneeUserId: null })],
      { field: "assigneeAgentId", type: "agent", label: "New owner", required: true },
    ));
    actions.push(requestAction(
      "instruct_blocker",
      `Instruct ${blockerLabel}`,
      `Post an instruction on the blocker ${blockerLabel} and wake its owner.`,
      [request("POST", `${blockerPath}/comments`,
        isExplicitResumeCapableStatus(foreignBlocker.subject.status) ? { resume: true } : {})],
      { field: "body", type: "text", label: "Instruction", required: true },
    ));
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
    // What makes sense differs by kind (one place): an agent's own question or
    // approval is answered, not reassigned or instructed (a comment would
    // close the question unanswered); a chat thread keeps its agent and is
    // never cancelled; a connection is fixed by connecting, not by moving work.
    const answersAsk = kind === "question" || kind === "approval" || kind === "decision";
    const chatThread = Boolean(task.conversationAgentId);
    const movesOwner = !answersAsk && !chatThread && kind !== "connection" && kind !== "review";
    const owner = agentRef(task.assigneeAgentId)?.name ?? null;
    if (movesOwner) {
      // A blocked task with nothing open before it goes back to To do, so the
      // new owner starts at once instead of inheriting a dead stop.
      const restart = task.status === "blocked" && (context.blockerChain.get(task.id) ?? []).length === 0;
      actions.push(requestAction(
        "reassign",
        "Reassign",
        restart
          ? "Give it to another agent. The task goes back to To do and the new owner starts now."
          : "Give it to another agent. The new owner is woken and starts now.",
        [request("PATCH", issuePath, restart ? { assigneeUserId: null, status: "todo" } : { assigneeUserId: null })],
        { field: "assigneeAgentId", type: "agent", label: "New owner", required: true },
      ));
    }
    // An instruction needs an agent to wake; with none, Reassign is the way.
    if (!answersAsk && owner) {
      actions.push(requestAction(
        "instruct",
        "Give an instruction",
        `Post your instruction on the task and wake ${owner}, who carries on with it now.`,
        // Every instruction wakes the owner. Blocked, todo and in-progress tasks
        // resume; in_review and backlog refuse resume intent with a 409, and a
        // plain comment there still wakes the owner and leaves the status (and
        // any review) alone (GRE-320). A chat thread needs a clientRequestId.
        [{
          ...request("POST", `${issuePath}/comments`, isExplicitResumeCapableStatus(task.status) ? { resume: true } : {}),
          clientRequestId: true,
        }],
        { field: "body", type: "text", label: "Instruction", required: true },
      ));
    }
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
    if (!answersAsk) {
      actions.push({
        ...requestAction(
          "ask_clarity",
          "Ask for clarity",
          `Ask ${owner ?? "the owning agent"} a short question. It is woken and the answer shows on this card.`,
          [request("POST", `/api/companies/${companyId}/decisions-feed/cards/${encodeURIComponent(group.key)}/clarity`)],
          { field: "question", type: "text", label: "Your question", required: true },
        ),
        disabledReason: task.assigneeAgentId ? null : "No agent owns this task, so there is no one to ask. Reassign it first.",
      });
    }
    if (!chatThread && kind !== "connection") {
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
    }
    actions.push(requestAction(
      "not_now",
      "Not now",
      "Set the task aside. It leaves your Decisions and no agent works on it until it comes back on the day you choose.",
      [request("POST", `${issuePath}/table`, { returnAt: null })],
    ));
  } else if (setupCard) {
    actions.push(...setupRetryActions(companyId, group));
  } else if (!task && main) {
    if (main.subject.href && !actions.some((action) => action.type === "link")) {
      actions.push(linkAction("open", "Open", "Open the details.", main.subject.href));
    }
    if (["ai_connection_alert", "agent_error_alert", "failed_run", "connectivity_outage"].includes(main.sourceKind)) {
      actions.push(dismissAction(companyId, items, "Dismiss"));
    }
  }

  const newest = items.reduce<AttentionItem | null>((best, item) =>
    !best || timeOf(item.activityAt) > timeOf(best.activityAt) ? item : best, null);
  const severity = items.reduce<AttentionSeverity>((best, item) =>
    SEVERITY_RANK[item.severity] < SEVERITY_RANK[best] ? item.severity : best, readyToRetry ? "high" : "low");
  const activityAt = newest?.activityAt ?? new Date(group.aiRepairedAt ?? 0).toISOString();
  const createdAt = items.reduce((oldest, item) => (item.createdAt < oldest ? item.createdAt : oldest), activityAt);

  // ── What the person reads: the decision, why it matters, the facts, the
  // options with their consequences, and what the owning agent recommends.
  const questionItems = items.filter((item) => item.sourceKind === "issue_thread_interaction" && cardKind(item) === "question");
  const questions = questionItems.flatMap((item) => questionsOf(context.interactionPayload.get(item.subject.id) ?? {}, item));
  const latestComment = task ? context.latestAgentComment.get(task.id) ?? null : null;
  const recommendation = recommendationOf({
    items: questionItems.concat(items.filter((item) => cardKind(item) === "connection")),
    questions,
    context,
    // The owning agent recommends, even when the lead commented after it.
    latestComment: (task?.assigneeAgentId ? context.latestCommentBy.get(`${task.id}:${task.assigneeAgentId}`) : null) ?? latestComment,
    agentRef,
  });
  if (recommendation?.actionId) {
    const target = actions.find((action) => action.id === recommendation.actionId);
    if (target) target.recommended = true;
  }
  const holdsUp = task ? context.holdsUp.get(task.id) ?? [] : [];
  const blockerChain = task ? context.blockerChain.get(task.id) ?? [] : [];
  const holdsUpText = holdsUp.length > 0
    ? `It holds up ${listTasks(holdsUp.map((ref) => `${ref.identifier ?? ""} ${ref.title}`.trim()))}.`
    : shared
      ? `${shared.tasks.length} tasks of ${sharedAgent?.name ?? "one agent"} wait on it.`
      : waiting && taskLabel
        ? `${waiting.name} cannot carry on with ${taskLabel} until this is decided.`
        : taskLabel
          ? `${taskLabel} cannot move on until this is decided.`
          : reason;
  const links: Array<{ label: string; href: string }> = [];
  if (taskHref && taskLabel) links.push({ label: `Open ${task!.identifier ?? "the task"}`, href: taskHref });
  for (const item of items) {
    const href = item.sourceKind === "issue_thread_interaction" ? interactionHref(item) : null;
    if (href && !links.some((link) => link.href === href)) links.push({ label: "Open the request", href });
  }

  return {
    id: group.key,
    kind,
    kinds,
    ...(setup ? { setup } : {}),
    task: input.taskSubject ?? (task && taskHref ? {
      kind: "issue",
      id: task.id,
      companyId,
      title: task.title,
      identifier: task.identifier,
      status: task.status,
      href: taskHref,
    } : null),
    title,
    decision: clip(decisionSentence({
      kind,
      main,
      task,
      taskLabel,
      titleShowsTask: taskLabel !== null && title === taskLabel,
      waiting,
      review,
      stalledReview,
      questions,
      shared,
      setupCard,
      setupAgentName,
      setupCause: setup?.cause ?? null,
      readyToRetry,
      kinds,
      escalation: input.escalation,
      blockerChain,
      agentRef,
      context,
      reason,
    })),
    why: {
      text: holdsUpText,
      holdsUp,
      // A stall is measured from the task's last movement; everything else from the ask.
      waitingSince: kind === "blocked" ? activityAt : createdAt,
    },
    facts: {
      latestComment: latestComment
        ? { agent: agentRef(latestComment.agentId), excerpt: commentExcerpt(latestComment.body), at: latestComment.at.toISOString() }
        : null,
      blockerChain,
      links,
    },
    recommendation,
    questions,
    escalation: input.escalation ?? (items.some((item) => cardKind(item) === "blocked")
      && context.lead && items.some((item) => context.interactionCreatedBy.get(item.subject.id) === context.lead!.id)
      ? {
        reason: "lead_asked" as const,
        lead: context.lead,
        summary: task && context.latestLeadComment.get(task.id) ? commentExcerpt(context.latestLeadComment.get(task.id)!.body) : null,
      }
      : null),
    reason: clip(reason),
    waiting,
    reviewer: review?.reviewer ?? null,
    nextStep,
    severity,
    activityAt,
    createdAt,
    actions,
    clarity,
    items,
    atDesk,
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** A question card's questions and options, read from the interaction payload. */
function questionsOf(payload: Record<string, unknown>, item: AttentionItem): DecisionCardQuestion[] {
  const kind = item.subject.metadata?.kind;
  if (kind === "ask_user_questions") {
    const recommended = new Set<string>();
    for (const question of Array.isArray(readRecord(payload.questionSet).questions) ? readRecord(payload.questionSet).questions as unknown[] : []) {
      for (const option of Array.isArray(readRecord(question).options) ? readRecord(question).options as unknown[] : []) {
        const record = readRecord(option);
        if (record.recommended === true && typeof record.id === "string") recommended.add(`${readRecord(question).id}:${record.id}`);
      }
    }
    return (Array.isArray(payload.questions) ? payload.questions : []).map((raw) => {
      const question = readRecord(raw);
      return {
        prompt: readString(question, "prompt") ?? item.subject.title ?? "",
        options: (Array.isArray(question.options) ? question.options : []).map((rawOption) => {
          const option = readRecord(rawOption);
          const id = readString(option, "id") ?? "";
          return {
            id,
            label: readString(option, "label") ?? id,
            description: readString(option, "description"),
            recommended: recommended.has(`${question.id}:${id}`),
          };
        }),
      };
    }).filter((question) => question.prompt);
  }
  if (kind === "request_confirmation" || kind === "request_checkbox_confirmation") {
    const prompt = readString(payload, "prompt") ?? item.subject.title;
    if (!prompt) return [];
    const options = kind === "request_confirmation"
      ? [
        { id: "accept", label: readString(payload, "acceptLabel") ?? "Confirm", description: null, recommended: false },
        { id: "reject", label: readString(payload, "rejectLabel") ?? "Decline", description: null, recommended: false },
      ]
      : (Array.isArray(payload.options) ? payload.options : []).map((rawOption) => {
        const option = readRecord(rawOption);
        return { id: readString(option, "id") ?? "", label: readString(option, "label") ?? "", description: readString(option, "description"), recommended: false };
      });
    return [{ prompt, options }];
  }
  return [];
}

/**
 * What the owning agent recommends, best source first: the interaction's own
 * `recommendation`, a recommended question option, then a "Recommendation:"
 * line in its latest comment.
 */
function recommendationOf(input: {
  items: AttentionItem[];
  questions: DecisionCardQuestion[];
  context: CardContext;
  latestComment: { agentId: string; body: string } | null;
  agentRef: (agentId: string | null | undefined) => DecisionCardAgentRef | null;
}): DecisionCardRecommendation | null {
  for (const item of input.items) {
    const text = readString(input.context.interactionPayload.get(item.subject.id), "recommendation");
    if (text) {
      return {
        by: input.agentRef(input.context.interactionCreatedBy.get(item.subject.id)),
        text: clip(text),
        actionId: recommendedActionId(text),
        source: "interaction",
      };
    }
  }
  const asker = input.items[0] ? input.agentRef(input.context.interactionCreatedBy.get(input.items[0].subject.id)) : null;
  for (const question of input.questions) {
    const option = question.options.find((candidate) => candidate.recommended);
    if (option) {
      return { by: asker, text: `${asker?.name ?? "The agent"} recommends ${option.label}.`, actionId: null, source: "interaction" };
    }
  }
  const fromComment = recommendationFromComment(input.latestComment?.body);
  return fromComment
    ? { by: input.agentRef(input.latestComment!.agentId), text: fromComment, actionId: recommendedActionId(fromComment), source: "comment" }
    : null;
}

/** Card kinds that are an ask addressed to the person: an interaction or an approval. */
const PERSON_ASK_KINDS = new Set<DecisionCardKind>(["question", "approval", "connection"]);

/**
 * The decision in one sentence: exactly what is asked of the person.
 *
 * "Waiting on you" comes only from facts (GRE-2342): a pending ask or approval
 * on a blocked task, or an unblock step assigned to the person. Never from
 * comment text: an agent's plan that says "John: accept the card" is not an
 * ask of John, and the card names the real blocker instead.
 */
function decisionSentence(input: Parameters<typeof askSentence>[0] & { kinds: DecisionCardKind[] }): string {
  const ask = askSentence(input);
  if (input.kind !== "blocked" && input.kinds.includes("blocked") && PERSON_ASK_KINDS.has(input.kind)) {
    return `${input.waiting?.name ?? "The agent"} is waiting on you: ${ask}`;
  }
  return ask;
}

function askSentence(input: {
  kind: DecisionCardKind;
  main: AttentionItem | null;
  task: TaskRow | null;
  taskLabel: string | null;
  /** The card heading already names the task, so the sentence starts with the ask, not the task again. */
  titleShowsTask: boolean;
  waiting: DecisionCardAgentRef | null;
  review: PendingReview | null;
  stalledReview: boolean;
  questions: DecisionCardQuestion[];
  shared: SharedConnection | undefined;
  setupCard: boolean;
  setupAgentName: string;
  setupCause: string | null;
  readyToRetry: boolean;
  escalation: DecisionCard["escalation"];
  blockerChain: DecisionCardTaskRef[];
  agentRef: (agentId: string | null | undefined) => DecisionCardAgentRef | null;
  context: CardContext;
  reason: string;
}): string {
  const { kind, main, task, taskLabel, waiting, review, questions, context } = input;
  const agent = waiting?.name ?? "The agent";
  const shown = input.titleShowsTask;
  const label = shown ? "this task" : taskLabel ?? "this task";
  if (input.setupCard) {
    return input.readyToRetry
      ? `${input.setupAgentName}'s setup works again: retry the stopped work.`
      : `Fix ${input.setupAgentName}'s setup so it can start: ${input.setupCause ?? "setup is not complete"}.`;
  }
  if (input.readyToRetry) return `The connection works again: retry ${label} so ${agent} carries on.`;
  switch (kind) {
    case "question": {
      if (questions.length === 1) return questions[0]!.prompt;
      if (questions.length > 1) return `Answer ${agent}'s ${questions.length} questions: ${main?.subject.title ?? label}.`;
      if (main?.subject.metadata?.kind === "suggest_tasks") return `Choose which of ${agent}'s suggested tasks to create for ${label}.`;
      return main?.subject.title ?? `Answer ${agent} on ${label}.`;
    }
    case "approval":
      return main?.subject.metadata?.type === "permission_grant"
        ? `Grant or deny ${agent}'s request: ${main.subject.title ?? "a permission"}.`
        : `Approve or reject: ${main?.subject.title ?? label}.`;
    case "decision":
      return main?.subject.title ?? `Decide for ${agent}: ${label}.`;
    case "connection": {
      if (input.shared) return `Connect ${input.shared.serviceName} so ${agent} can carry on with ${input.shared.tasks.length} tasks.`;
      const payload = main ? context.interactionPayload.get(main.subject.id) ?? {} : {};
      const service = readString(payload, "serviceName") ?? readString(payload, "serviceSlug");
      if (main?.sourceKind === "ai_connection_alert" || payload.purpose === "ai" || !service) {
        return task ? `Reconnect the AI account so ${agent} can carry on with ${label}.` : `Reconnect the AI account: ${input.reason}`;
      }
      return `Connect ${service} so ${agent} can carry on with ${label}, or tell ${agent} to do without it.`;
    }
    case "review":
      if (input.stalledReview) return `Check ${agent}'s finished work on ${label}, then approve it, ask for changes or send it back.`;
      return review && !review.reviewer.isYou
        ? `${review.reviewer.name} reviews ${agent}'s work on ${label}; step in only if it must move without them.`
        : `Review ${agent}'s work on ${label}: approve it or ask for changes.`;
    case "blocked": {
      if (main?.dedupKey.startsWith("blocked-owner:")) return `${agent} is waiting on you to unblock ${label}: ${main.whyNow}`;
      // The real blocker by task and owner, for example "GRE-2338 (Keystone)".
      const blockers = input.blockerChain.length === 0 ? null : listTasks(input.blockerChain.map((ref) => {
        const owner = context.blockerOwner.get(ref.id);
        const who = input.agentRef(owner?.agentId)?.name ?? (owner?.userId ? "a person" : "no owner");
        return `${ref.identifier ?? ref.title} (${who})`;
      }));
      const owner = task?.assigneeAgentId ? agent : "No agent";
      const lead = input.escalation?.lead?.name ?? context.lead?.name ?? "The lead agent";
      if (input.escalation?.reason === "stall_threshold") {
        const ask = `choose who takes it on, tell ${owner === "No agent" ? "an agent" : owner} what to do, or cancel it.`;
        const stuck = shown
          ? `Not moved for over a day and ${lead} could not get it going`
          : `${label} has not moved for over a day and ${lead} could not get it going`;
        return blockers ? `${stuck}. It is blocked by ${blockers}: ${ask}` : `${stuck}: ${ask}`;
      }
      const ask = "choose who takes it on, give an instruction, or cancel it.";
      if (blockers) return `${shown ? "Blocked" : `${label} is blocked`} by ${blockers}: ${ask}`;
      if (owner === "No agent") return `${shown ? "No live next step" : `${label} has no live next step`}: ${ask}`;
      return `${shown ? `${agent} has no live next step on this task` : `${label} (${agent}) has no live next step`}: ${ask}`;
    }
    case "recovery":
      return `${shown ? "Stopped" : `${label} stopped`}: retry it, give it to another agent, or cancel it.`;
    case "failed_run":
      return `${shown ? "Failed" : `${label} failed`} and its automatic retries are used up: retry it or give it to another agent.`;
    case "budget":
      return `Raise the budget or leave the work paused: ${main?.subject.title ?? input.reason}`;
    case "agent_error":
      return `Fix ${agent}'s error so it can take work again: ${input.reason}`;
    case "join_request":
      return `Approve or reject the request to join: ${main?.subject.title ?? input.reason}`;
    case "outage":
      return "Nothing to decide: retry the failed runs if their tasks still matter, then dismiss this.";
    default:
      return input.reason;
  }
}

/**
 * Retry for a setup card that stands for several tasks: one call per stopped
 * task, through the same endpoints as the task card's own Retry. Task-less
 * failed runs are dismissed instead; their next run starts on its own.
 */
function setupRetryActions(companyId: string, group: Group): DecisionCardAction[] {
  const tasks = group.setupTasks ?? [];
  // A recovery only goes back to its owner from blocked; a task that moved on keeps its status.
  const blockedTasks = new Set(tasks.filter((row) => row.status === "blocked").map((row) => row.id));
  const openTasks = new Set(tasks.filter((row) => !CLOSED_ISSUE_STATUSES.has(row.status)).map((row) => row.id));
  const rows = [...group.items, ...group.cleared];
  const retried = new Set<string>();
  const requests: DecisionCardAction["requests"] = [];
  for (const item of rows) {
    const taskId = taskIdOf(item);
    if (!taskId || !blockedTasks.has(taskId) || retried.has(taskId)) continue;
    if (item.sourceKind === "recovery_action") {
      retried.add(taskId);
      requests.push(request("POST", `/api/issues/${taskId}/recovery-actions/resolve`, {
        actionId: item.subject.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        resolutionNote: "Retried from Decisions.",
      }));
    }
  }
  for (const item of rows) {
    const taskId = taskIdOf(item);
    const agentId = readString(item.subject.metadata, "agentId");
    if (item.sourceKind !== "failed_run" || !taskId || !openTasks.has(taskId) || retried.has(taskId) || !agentId) continue;
    retried.add(taskId);
    requests.push(request("POST", `/api/agents/${agentId}/wakeup`, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "retry_failed_run",
      failedRunId: item.subject.id,
    }));
  }
  const actions: DecisionCardAction[] = [];
  if (requests.length > 0) {
    actions.push(requestAction(
      "retry",
      requests.length === 1 ? "Retry" : `Retry all ${requests.length}`,
      requests.length === 1 ? "Send the task back to its owner to try again." : "Send each stopped task back to its owner to try again.",
      requests,
    ));
  }
  const failedRuns = group.items.filter((item) => item.sourceKind === "failed_run");
  if (failedRuns.length > 0 && failedRuns.length === group.items.length) {
    actions.push(dismissAction(companyId, failedRuns, "Dismiss"));
  }
  return actions;
}

function dismissAction(companyId: string, items: AttentionItem[], label: string): DecisionCardAction {
  return requestAction("dismiss", label, "Hide this card. It comes back if the problem happens again.",
    items.map((item) => request("POST", `/api/companies/${companyId}/inbox-dismissals`, {
      itemKey: item.dismissalKey,
      kind: "dismiss",
    })));
}
