import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  issueComments,
  issueParticipants,
  issues,
  type Db,
} from "@greatstone/db";
import {
  TEAM_CHAT_AGENT_HOP_LIMIT,
  TEAM_CHAT_CONTEXT_MESSAGES,
  TEAM_CHAT_ORIGIN_KIND,
  directMessageOriginId,
  extractAgentMentionIds,
  extractUserMentionIds,
  teamChatAgentHops,
  teamChatAlertReason,
  teamChatSnippet,
  type TeamChatAlertReason,
  type IssueCommentPresentation,
  type TeamChatMember,
  type TeamChatSummary,
} from "@greatstone/shared";
import { notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { issueService } from "./issues.js";
import { pushNotificationService, type DecisionPushMessage } from "./push-notifications.js";

/**
 * Guidance an agent gets when a team chat wakes it (enableTeamChat). Kept
 * short: the recent thread follows it in the prompt.
 */
export const TEAM_CHAT_DIRECTIVE = `You were @mentioned in a team chat of people and agents. Reply only to what was asked of you, as one comment on this chat. Do not change this chat's status, assignee or documents, and do not create subtasks of it.

If the ask needs real work, create an ordinary task (with a project and an assignee), put a link to this chat and the message that asked in its description, then reply here with the task link. Small questions you answer directly.

Mention another agent only when you need its help, and only agents who are members of this chat. Agents wake only when mentioned, and after ${TEAM_CHAT_AGENT_HOP_LIMIT} agent-to-agent mentions in a row nobody wakes until a person speaks.`;

const DEAD_AGENT_STATUSES = ["terminated", "pending_approval"];
const PUSH_WINDOW_MS = 2 * 60_000;
const NOTICE_TITLE_LIMIT = 160;

export type TeamChatActor =
  | { type: "user"; id: string }
  | { type: "agent"; id: string };

type ChatIssue = { id: string; companyId: string; identifier: string | null; title: string; originKind: string; originId: string | null };

export function isTeamChat(issue: { originKind?: string | null } | null | undefined): boolean {
  return issue?.originKind === TEAM_CHAT_ORIGIN_KIND;
}

function isDirect(issue: { originId: string | null }) {
  return Boolean(issue.originId?.startsWith("dm:"));
}

function notice(title: string): IssueCommentPresentation {
  return { kind: "system_notice", tone: "info", title: title.slice(0, NOTICE_TITLE_LIMIT), detailsDefaultOpen: false, density: "compact" };
}

function authorTypeOf(row: { authorType: string | null; authorAgentId: string | null; authorUserId: string | null }) {
  if (row.authorAgentId) return "agent" as const;
  if (row.authorType === "system") return "system" as const;
  return row.authorUserId ? ("user" as const) : ("system" as const);
}

export function teamChatService(
  db: Db,
  options: { push?: Pick<ReturnType<typeof pushNotificationService>, "sendToUser">; now?: () => number } = {},
) {
  const issuesSvc = issueService(db);
  const push = options.push ?? pushNotificationService(db);
  const now = options.now ?? Date.now;
  // ponytail: in-process throttle, one push per person per chat per window;
  // move to a table if the server ever runs as more than one process.
  const lastPushAt = new Map<string, number>();

  async function getChat(issueId: string): Promise<ChatIssue | null> {
    const [row] = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        title: issues.title,
        originKind: issues.originKind,
        originId: issues.originId,
      })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.originKind, TEAM_CHAT_ORIGIN_KIND)));
    return row ?? null;
  }

  async function participants(issueId: string) {
    return db
      .select({ type: issueParticipants.principalType, id: issueParticipants.principalId, mutedAt: issueParticipants.mutedAt })
      .from(issueParticipants)
      .where(eq(issueParticipants.issueId, issueId));
  }

  async function isParticipant(issueId: string, actor: TeamChatActor) {
    const [row] = await db
      .select({ id: issueParticipants.id })
      .from(issueParticipants)
      .where(and(
        eq(issueParticipants.issueId, issueId),
        eq(issueParticipants.principalType, actor.type),
        eq(issueParticipants.principalId, actor.id),
      ));
    return Boolean(row);
  }

  /** People must be active company members; agents must belong to the company and be live. */
  async function assertMembersValid(companyId: string, userIds: string[], agentIds: string[]) {
    if (userIds.length) {
      const found = new Set((await db
        .select({ id: companyMemberships.principalId })
        .from(companyMemberships)
        .where(and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
          inArray(companyMemberships.principalId, userIds),
        ))).map((row) => row.id));
      const missing = userIds.filter((id) => !found.has(id));
      if (missing.length) throw unprocessable("Choose people who are members of this company", { code: "team_chat_member_not_found", userIds: missing });
    }
    if (agentIds.length) {
      const found = new Set((await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds), notInArray(agents.status, DEAD_AGENT_STATUSES))))
        .map((row) => row.id));
      const missing = agentIds.filter((id) => !found.has(id));
      if (missing.length) throw unprocessable("Choose active agents of this company", { code: "team_chat_agent_not_found", agentIds: missing });
    }
  }

  async function addParticipants(companyId: string, issueId: string, addedBy: string, members: TeamChatActor[]) {
    if (!members.length) return;
    await db
      .insert(issueParticipants)
      .values(members.map((member) => ({ companyId, issueId, principalType: member.type, principalId: member.id, addedBy })))
      .onConflictDoNothing();
  }

  async function createChat(companyId: string, actorUserId: string, input: { title: string; originId: string | null }) {
    const issue = await issuesSvc.create(companyId, {
      title: input.title,
      status: "backlog",
      originKind: TEAM_CHAT_ORIGIN_KIND,
      originId: input.originId,
      createdByUserId: actorUserId,
    });
    await logActivity(db, {
      companyId, actorType: "user", actorId: actorUserId,
      action: "issue.team_chat_opened", entityType: "issue", entityId: issue.id,
      details: { kind: input.originId ? "direct" : "group" },
    });
    return issue;
  }

  async function names(members: Array<{ type: string; id: string }>) {
    const userIds = [...new Set(members.filter((m) => m.type === "user").map((m) => m.id))];
    const agentIds = [...new Set(members.filter((m) => m.type === "agent").map((m) => m.id))];
    const [userRows, agentRows] = await Promise.all([
      userIds.length ? db.select({ id: authUsers.id, name: authUsers.name }).from(authUsers).where(inArray(authUsers.id, userIds)) : [],
      agentIds.length ? db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds)) : [],
    ]);
    const map = new Map<string, string>();
    for (const row of userRows) map.set(`user:${row.id}`, row.name);
    for (const row of agentRows) map.set(`agent:${row.id}`, row.name);
    return (type: string, id: string) => map.get(`${type}:${id}`) ?? (id === "local-board" ? "Board" : type === "agent" ? "Agent" : "Someone");
  }

  async function summarise(chats: ChatIssue[], userId: string): Promise<TeamChatSummary[]> {
    if (!chats.length) return [];
    const ids = chats.map((chat) => chat.id);
    const memberRows = await db
      .select({ issueId: issueParticipants.issueId, type: issueParticipants.principalType, id: issueParticipants.principalId, mutedAt: issueParticipants.mutedAt })
      .from(issueParticipants)
      .where(inArray(issueParticipants.issueId, ids));
    const nameOf = await names(memberRows);
    const stats = await db.execute<{ issue_id: string; last_at: string | null; unread: number }>(sql`
      select c.issue_id, max(c.created_at) as last_at,
        count(*) filter (
          where c.created_at > coalesce(r.last_read_at, to_timestamp(0))
            and c.author_user_id is distinct from ${userId}
        )::int as unread
      from issue_comments c
      left join issue_read_states r on r.issue_id = c.issue_id and r.user_id = ${userId}
      where c.issue_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}) and c.deleted_at is null
      group by c.issue_id
    `);
    const statRows = (Array.isArray(stats) ? stats : (stats as { rows?: unknown[] }).rows ?? []) as Array<{ issue_id: string; last_at: string | Date | null; unread: number }>;
    const byIssue = new Map(statRows.map((row) => [row.issue_id, row]));
    return chats
      .map((chat) => {
        const stat = byIssue.get(chat.id);
        const members: TeamChatMember[] = memberRows
          .filter((row) => row.issueId === chat.id)
          .map((row) => ({ type: row.type, id: row.id, name: nameOf(row.type, row.id) }));
        return {
          id: chat.id,
          identifier: chat.identifier,
          kind: isDirect(chat) ? ("direct" as const) : ("group" as const),
          title: chat.title,
          members,
          lastMessageAt: stat?.last_at ? new Date(stat.last_at).toISOString() : null,
          unreadCount: Number(stat?.unread ?? 0),
          muted: memberRows.some((row) => row.issueId === chat.id && row.type === "user" && row.id === userId && row.mutedAt !== null),
        };
      })
      .sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
  }

  async function postNotice(chat: { id: string; companyId: string }, text: string) {
    const comment = await issuesSvc.addComment(chat.id, text, {}, { authorType: "system", presentation: notice(text) });
    await logActivity(db, {
      companyId: chat.companyId, actorType: "system", actorId: "team_chat",
      action: "issue.comment_added", entityType: "issue", entityId: chat.id,
      details: { commentId: comment.id, teamChat: true },
    });
    return comment;
  }

  return {
    getChat,
    participants,
    isParticipant,

    async list(companyId: string, userId: string) {
      const chats = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          identifier: issues.identifier,
          title: issues.title,
          originKind: issues.originKind,
          originId: issues.originId,
        })
        .from(issues)
        .innerJoin(issueParticipants, and(
          eq(issueParticipants.issueId, issues.id),
          eq(issueParticipants.principalType, "user"),
          eq(issueParticipants.principalId, userId),
        ))
        .where(and(eq(issues.companyId, companyId), eq(issues.originKind, TEAM_CHAT_ORIGIN_KIND), isNull(issues.hiddenAt)));
      return summarise(chats, userId);
    },

    async summary(chat: ChatIssue, userId: string) {
      return (await summarise([chat], userId))[0]!;
    },

    async createGroup(companyId: string, actorUserId: string, input: { title: string; userIds: string[]; agentIds: string[] }) {
      const userIds = [...new Set(input.userIds)].filter((id) => id !== actorUserId);
      const agentIds = [...new Set(input.agentIds)];
      await assertMembersValid(companyId, userIds, agentIds);
      const issue = await createChat(companyId, actorUserId, { title: input.title, originId: null });
      await addParticipants(companyId, issue.id, actorUserId, [
        { type: "user", id: actorUserId },
        ...userIds.map((id) => ({ type: "user" as const, id })),
        ...agentIds.map((id) => ({ type: "agent" as const, id })),
      ]);
      return (await getChat(issue.id))!;
    },

    /** The one direct message between two people; reused, never duplicated. */
    async ensureDirect(companyId: string, actorUserId: string, otherUserId: string) {
      if (otherUserId === actorUserId) throw unprocessable("Choose someone else to message");
      await assertMembersValid(companyId, [otherUserId], []);
      const originId = directMessageOriginId(actorUserId, otherUserId);
      const [existing] = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.originKind, TEAM_CHAT_ORIGIN_KIND), eq(issues.originId, originId), isNull(issues.hiddenAt)))
        .limit(1);
      if (existing) return { chat: (await getChat(existing.id))!, created: false };
      // ponytail: lookup then insert; two people opening the same DM in the
      // same instant could make two. Add a partial unique index if that shows up.
      const issue = await createChat(companyId, actorUserId, { title: "Direct message", originId });
      await addParticipants(companyId, issue.id, actorUserId, [
        { type: "user", id: actorUserId },
        { type: "user", id: otherUserId },
      ]);
      return { chat: (await getChat(issue.id))!, created: true };
    },

    async addMembers(chat: ChatIssue, actorUserId: string, input: { userIds: string[]; agentIds: string[] }) {
      if (isDirect(chat)) throw unprocessable("A direct message is between two people. Start a group to add more.");
      const userIds = [...new Set(input.userIds)];
      const agentIds = [...new Set(input.agentIds)];
      await assertMembersValid(chat.companyId, userIds, agentIds);
      await addParticipants(chat.companyId, chat.id, actorUserId, [
        ...userIds.map((id) => ({ type: "user" as const, id })),
        ...agentIds.map((id) => ({ type: "agent" as const, id })),
      ]);
    },

    async removeMember(chat: ChatIssue, member: TeamChatActor) {
      if (isDirect(chat)) throw unprocessable("People cannot be removed from a direct message");
      const removed = await db
        .delete(issueParticipants)
        .where(and(
          eq(issueParticipants.issueId, chat.id),
          eq(issueParticipants.principalType, member.type),
          eq(issueParticipants.principalId, member.id),
        ))
        .returning({ id: issueParticipants.id });
      if (!removed.length) throw notFound("Not a member of this chat");
    },

    /** Mute or unmute the chat for one member. Mentions still alert a muted member. */
    async setMuted(chat: ChatIssue, userId: string, muted: boolean) {
      const updated = await db
        .update(issueParticipants)
        .set({ mutedAt: muted ? new Date() : null })
        .where(and(
          eq(issueParticipants.issueId, chat.id),
          eq(issueParticipants.principalType, "user"),
          eq(issueParticipants.principalId, userId),
        ))
        .returning({ id: issueParticipants.id });
      if (!updated.length) throw unprocessable("Only members can mute a chat");
    },

    /**
     * Which agents a message wakes: only mentioned members, never the author,
     * and nobody once agents have mentioned each other TEAM_CHAT_AGENT_HOP_LIMIT
     * times in a row without a person speaking. Posts a short notice when a
     * mention is ignored. Call after the message is saved.
     */
    async agentsToWake(chat: { id: string; companyId: string }, body: string, author: TeamChatActor): Promise<string[]> {
      const mentioned = [...new Set(extractAgentMentionIds(body))].filter((id) => !(author.type === "agent" && author.id === id));
      if (!mentioned.length) return [];
      const memberAgents = new Set((await participants(chat.id)).filter((row) => row.type === "agent").map((row) => row.id));
      const outside = mentioned.filter((id) => !memberAgents.has(id));
      let wake = mentioned.filter((id) => memberAgents.has(id));
      if (outside.length) {
        const nameOf = await names(outside.map((id) => ({ type: "agent", id })));
        const who = outside.map((id) => nameOf("agent", id)).join(", ");
        await postNotice(chat, `${who} ${outside.length === 1 ? "is" : "are"} not in this chat, so ${outside.length === 1 ? "was" : "were"} not asked. Add them to the chat first.`);
      }
      if (wake.length && author.type === "agent") {
        const recent = await db
          .select({ authorType: issueComments.authorType, authorAgentId: issueComments.authorAgentId, authorUserId: issueComments.authorUserId, body: issueComments.body })
          .from(issueComments)
          .where(and(eq(issueComments.issueId, chat.id), isNull(issueComments.deletedAt)))
          .orderBy(desc(issueComments.createdAt))
          .limit(TEAM_CHAT_AGENT_HOP_LIMIT * 4 + 10);
        const hops = teamChatAgentHops(recent.reverse().map((row) => ({
          authorType: authorTypeOf(row),
          mentionsAgent: extractAgentMentionIds(row.body).length > 0,
        })));
        if (hops > TEAM_CHAT_AGENT_HOP_LIMIT) {
          wake = [];
          await postNotice(chat, `Agents have mentioned each other ${TEAM_CHAT_AGENT_HOP_LIMIT} times in a row, so nobody was woken. Reply or mention an agent to carry on.`);
        }
      }
      return wake;
    },

    /** The last messages as quoted context for a woken agent. */
    async transcript(issueId: string, limit = TEAM_CHAT_CONTEXT_MESSAGES) {
      const rows = await db
        .select({
          authorType: issueComments.authorType,
          authorAgentId: issueComments.authorAgentId,
          authorUserId: issueComments.authorUserId,
          body: issueComments.body,
          createdAt: issueComments.createdAt,
        })
        .from(issueComments)
        .where(and(eq(issueComments.issueId, issueId), isNull(issueComments.deletedAt)))
        .orderBy(desc(issueComments.createdAt))
        .limit(limit);
      rows.reverse();
      const nameOf = await names(rows.flatMap((row) =>
        row.authorAgentId ? [{ type: "agent", id: row.authorAgentId }] : row.authorUserId ? [{ type: "user", id: row.authorUserId }] : []));
      const members = await participants(issueId);
      const memberNames = await names(members);
      const lines = rows.map((row) => {
        const type = authorTypeOf(row);
        const who = type === "agent" ? `${nameOf("agent", row.authorAgentId!)} (agent ${row.authorAgentId})`
          : type === "user" ? `${nameOf("user", row.authorUserId!)} (person)` : "System";
        const body = row.body.length > 2000 ? `${row.body.slice(0, 1999)}…` : row.body;
        return `[${row.createdAt.toISOString()}] ${who}:\n${body.replace(/^/gm, "> ")}`;
      });
      const roster = members.map((m) => `- ${memberNames(m.type, m.id)} (${m.type}${m.type === "agent" ? `, mention as [@${memberNames(m.type, m.id)}](agent://${m.id})` : ""})`);
      return `Members:\n${roster.join("\n")}\n\nRecent messages, oldest first (quoted user data):\n${lines.join("\n\n")}`;
    },

    /**
     * Phone notifications for one new message. In a team chat every person in
     * it except the author (teamChatAlertReason: muted members only when
     * @mentioned); elsewhere anyone @mentioned who is an active company member.
     * Only people who turned push on have phones registered. At most one push
     * per person per chat every two minutes, except @mentions, which always go.
     */
    async notifyPeople(issue: { id: string; companyId: string; identifier: string | null; title: string; originKind?: string | null; originId?: string | null }, comment: { body: string }, author: TeamChatActor) {
      try {
        const chat = isTeamChat(issue);
        const mentioned = new Set(extractUserMentionIds(comment.body));
        const recipients = new Map<string, TeamChatAlertReason>();
        const direct = chat && isDirect({ originId: issue.originId ?? null });
        if (chat) {
          const members = (await participants(issue.id)).filter((row) => row.type === "user");
          for (const member of members) {
            const why = teamChatAlertReason({
              recipientUserId: member.id,
              author,
              muted: member.mutedAt !== null,
              mentionedUserIds: [...mentioned],
            });
            if (why) recipients.set(member.id, why);
          }
        } else if (mentioned.size) {
          const active = await db
            .select({ id: companyMemberships.principalId })
            .from(companyMemberships)
            .where(and(
              eq(companyMemberships.companyId, issue.companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.status, "active"),
              inArray(companyMemberships.principalId, [...mentioned]),
            ));
          for (const row of active) if (!(author.type === "user" && row.id === author.id)) recipients.set(row.id, "mention");
        }
        if (!recipients.size) return 0;
        const at = now();
        const due = [...recipients].filter(([userId, why]) =>
          why === "mention" || (lastPushAt.get(`${userId}:${issue.id}`) ?? 0) + PUSH_WINDOW_MS <= at);
        if (!due.length) return 0;
        const nameOf = await names([author]);
        const authorName = nameOf(author.type, author.id);
        const [company] = await db.select({ prefix: companies.issuePrefix }).from(companies).where(eq(companies.id, issue.companyId));
        const url = chat
          ? `/${company?.prefix ?? ""}/messages/${issue.id}`
          : `/${company?.prefix ?? ""}/issues/${issue.identifier ?? issue.id}`;
        let sent = 0;
        for (const [userId, why] of due) {
          lastPushAt.set(`${userId}:${issue.id}`, at);
          const message: DecisionPushMessage = {
            title: why === "mention"
              ? chat && !direct ? `${authorName} mentioned you in ${issue.title}` : `${authorName} mentioned you`
              : direct ? authorName : `${authorName} in ${issue.title}`,
            body: teamChatSnippet(comment.body),
            url,
            tag: `chat:${issue.id}`,
          };
          const result = await push.sendToUser(issue.companyId, userId, message);
          sent += result.delivered;
        }
        return sent;
      } catch (err) {
        logger.warn({ err, issueId: issue.id }, "team chat push failed");
        return 0;
      }
    },
  };
}

export type TeamChatService = ReturnType<typeof teamChatService>;
