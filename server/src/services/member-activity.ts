import { and, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import {
  activityLog,
  agents,
  authSignInEvents,
  heartbeatRuns,
  issues,
  type Db,
} from "@greatstone/db";

/**
 * One person's trail for the owner (Ben's access, Nov 2026): what they did,
 * what they decided, what they escalated, their comments, the agent runs and
 * chats they started (titles only, never another person's chat content) and
 * their sign-ins. Read-only.
 */
export const MEMBER_ACTIVITY_TYPES = ["action", "decision", "escalation", "comment", "run", "chat", "sign_in"] as const;
export type MemberActivityType = (typeof MEMBER_ACTIVITY_TYPES)[number];

export type MemberActivityEntry = {
  id: string;
  at: string;
  type: MemberActivityType;
  title: string;
  detail: string | null;
  entityType: string | null;
  entityId: string | null;
};

const DECISION_ACTIONS = new Set([
  "approval.approved",
  "approval.rejected",
  "approval.revision_requested",
  "approval.taken_over",
  "join.approved",
  "join.rejected",
]);

export function activityTypeFor(action: string): MemberActivityType {
  if (action.endsWith(".escalated")) return "escalation";
  if (DECISION_ACTIONS.has(action) || action.startsWith("issue.review_")) return "decision";
  if (action.endsWith(".comment_added")) return "comment";
  return "action";
}

function words(action: string) {
  return action.replace(/[._]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function memberActivityService(db: Db) {
  return {
    list: async (
      companyId: string,
      userId: string,
      opts: { from?: Date | null; to?: Date | null; types?: MemberActivityType[]; limit?: number } = {},
    ): Promise<MemberActivityEntry[]> => {
      const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
      const want = (type: MemberActivityType) => !opts.types?.length || opts.types.includes(type);
      const range = (column: Parameters<typeof gte>[0]): SQL[] => [
        ...(opts.from ? [gte(column, opts.from)] : []),
        ...(opts.to ? [lte(column, opts.to)] : []),
      ];
      const entries: MemberActivityEntry[] = [];

      if (["action", "decision", "escalation", "comment"].some((type) => want(type as MemberActivityType))) {
        const rows = await db
          .select({
            id: activityLog.id,
            action: activityLog.action,
            entityType: activityLog.entityType,
            entityId: activityLog.entityId,
            details: activityLog.details,
            createdAt: activityLog.createdAt,
          })
          .from(activityLog)
          .where(and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.actorType, "user"),
            eq(activityLog.actorId, userId),
            ...range(activityLog.createdAt),
          ))
          .orderBy(desc(activityLog.createdAt))
          .limit(limit);
        const issueIds = [...new Set(rows.filter((row) => row.entityType === "issue").map((row) => row.entityId))];
        const titles = issueIds.length
          ? new Map((await db
            .select({ id: issues.id, title: issues.title, identifier: issues.identifier, conversationUserId: issues.conversationUserId })
            .from(issues)
            .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id))))))
            .map((row) => [row.id, row]))
          : new Map();
        for (const row of rows) {
          const type = activityTypeFor(row.action);
          if (!want(type)) continue;
          const issue = row.entityType === "issue" ? titles.get(row.entityId) : null;
          const note = (row.details as { note?: unknown } | null)?.note;
          entries.push({
            id: `activity:${row.id}`,
            at: row.createdAt.toISOString(),
            type,
            title: issue ? `${words(row.action)}: ${issue.identifier ? `${issue.identifier} ` : ""}${issue.title}` : words(row.action),
            // Never a comment body: the trail names what was done, not what was said in a chat.
            detail: typeof note === "string" ? note : null,
            entityType: row.entityType,
            entityId: row.entityId,
          });
        }
      }

      if (want("run")) {
        const rows = await db
          .select({
            id: heartbeatRuns.id,
            status: heartbeatRuns.status,
            createdAt: heartbeatRuns.createdAt,
            agentName: agents.name,
            issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
          })
          .from(heartbeatRuns)
          .leftJoin(agents, eq(agents.id, heartbeatRuns.agentId))
          .where(and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.responsibleUserId, userId),
            ...range(heartbeatRuns.createdAt),
          ))
          .orderBy(desc(heartbeatRuns.createdAt))
          .limit(limit);
        const ids = [...new Set(rows.map((row) => row.issueId).filter((id): id is string => Boolean(id && /^[0-9a-f-]{36}$/i.test(id))))];
        const titles = ids.length
          ? new Map((await db.select({ id: issues.id, title: issues.title }).from(issues)
            .where(and(eq(issues.companyId, companyId), inArray(issues.id, ids)))).map((row) => [row.id, row.title]))
          : new Map<string, string>();
        for (const row of rows) {
          entries.push({
            id: `run:${row.id}`,
            at: row.createdAt.toISOString(),
            type: "run",
            title: `${row.agentName ?? "An agent"} ran${row.issueId && titles.get(row.issueId) ? ` on ${titles.get(row.issueId)}` : ""}`,
            detail: row.status,
            entityType: "heartbeat_run",
            entityId: row.id,
          });
        }
      }

      if (want("chat")) {
        const rows = await db
          .select({ id: issues.id, title: issues.title, createdAt: issues.createdAt })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), eq(issues.conversationUserId, userId), ...range(issues.createdAt)))
          .orderBy(desc(issues.createdAt))
          .limit(limit);
        for (const row of rows) {
          entries.push({
            id: `chat:${row.id}`,
            at: row.createdAt.toISOString(),
            type: "chat",
            title: row.title,
            detail: null,
            entityType: "issue",
            entityId: row.id,
          });
        }
      }

      if (want("sign_in")) {
        const rows = await db
          .select({ id: authSignInEvents.id, outcome: authSignInEvents.outcome, userAgent: authSignInEvents.userAgent, createdAt: authSignInEvents.createdAt })
          .from(authSignInEvents)
          .where(and(eq(authSignInEvents.userId, userId), ...range(authSignInEvents.createdAt)))
          .orderBy(desc(authSignInEvents.createdAt))
          .limit(limit);
        for (const row of rows) {
          entries.push({
            id: `sign_in:${row.id}`,
            at: row.createdAt.toISOString(),
            type: "sign_in",
            title: row.outcome === "signed_in" ? "Signed in" : row.outcome === "wrong_password" ? "Wrong password" : "Password right, waiting for the code",
            detail: row.userAgent,
            entityType: null,
            entityId: null,
          });
        }
      }

      return entries.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
    },
  };
}
