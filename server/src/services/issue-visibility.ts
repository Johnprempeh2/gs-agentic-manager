import { nonIdleSlackIssueCondition } from "./slack-conversation-state.js";
import { and, eq, isNull, ne, or, type SQL } from "drizzle-orm";
import { issues } from "@greatstone/db";
import { TEAM_CHAT_ORIGIN_KIND } from "@greatstone/shared";

/**
 * Task surfaces (lists, inbox, search, dashboards, activity, recovery sweeps)
 * omit hidden issues, test harness issues and team chats. A team chat is
 * private to its members; it is read only through the team chat routes and
 * the participant-checked issue routes.
 */
export function visibleIssueCondition(): SQL {
  return and(isNull(issues.hiddenAt), isNull(issues.harnessKind), ne(issues.originKind, TEAM_CHAT_ORIGIN_KIND))!;
}

export function visibleIssueSql(alias = "issues") {
  return `"${alias}"."hidden_at" IS NULL AND "${alias}"."harness_kind" IS NULL AND "${alias}"."origin_kind" <> '${TEAM_CHAT_ORIGIN_KIND}'`;
}

/** Work queues and execution totals omit persistent conversation containers. */
export function executionIssueCondition(): SQL {
  return and(visibleIssueCondition(), isNull(issues.conversationAgentId), nonIdleSlackIssueCondition())!;
}

/** Agent chats other people started stay out of this viewer's lists and search. Null viewer sees every chat. */
export function agentChatVisibleTo(viewerUserId: string | null | undefined): SQL | undefined {
  if (viewerUserId === null || viewerUserId === undefined) return undefined;
  return or(isNull(issues.conversationAgentId), isNull(issues.conversationUserId), eq(issues.conversationUserId, viewerUserId))!;
}
