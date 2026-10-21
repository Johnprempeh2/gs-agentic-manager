import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { issueFollows, issueRecentViews, issues } from "@greatstone/db";
import type {
  IssueFollowRollupUpdate,
  IssueFollowTaskSummary,
  IssueFollowWithRollup,
  IssuePriority,
  IssueStatus,
  RecentlyOpenedIssue,
} from "@greatstone/shared";

/** How many recently opened tasks each user keeps per company. */
export const RECENT_ISSUE_VIEWS_LIMIT = 10;
/** Latest comments or status changes shown per followed task. */
export const FOLLOW_ROLLUP_UPDATES_LIMIT = 3;
/** A subtree walk stops this deep, so a bad parent loop cannot run away. */
const SUBTREE_MAX_DEPTH = 20;
const COMMENT_EXCERPT_LENGTH = 140;

/** The fields an issue read-access decision needs. */
export interface IssueAccessFields {
  id: string;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  status: string;
}

export type CanReadIssue = (issue: IssueAccessFields) => Promise<boolean>;

const summaryColumns = {
  id: issues.id,
  companyId: issues.companyId,
  projectId: issues.projectId,
  parentId: issues.parentId,
  assigneeAgentId: issues.assigneeAgentId,
  assigneeUserId: issues.assigneeUserId,
  identifier: issues.identifier,
  title: issues.title,
  status: issues.status,
  priority: issues.priority,
  originKind: issues.originKind,
  updatedAt: issues.updatedAt,
};

type SummaryRow = {
  [K in keyof typeof summaryColumns]: (typeof summaryColumns)[K]["_"]["data"];
};

function toSummary(row: SummaryRow): IssueFollowTaskSummary {
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    status: row.status as IssueStatus,
    priority: row.priority as IssuePriority,
    originKind: row.originKind,
    updatedAt: row.updatedAt,
  };
}

function excerpt(body: string) {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > COMMENT_EXCERPT_LENGTH ? `${flat.slice(0, COMMENT_EXCERPT_LENGTH - 3)}...` : flat;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
}

function uuidList(ids: readonly string[]) {
  return sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
}

/** Every task under the given roots (and the roots), with the root it hangs from. */
function subtreeCte(companyId: string, rootIds: readonly string[]) {
  return sql`
    WITH RECURSIVE tree(root_id, id, depth) AS (
      SELECT id, id, 0
      FROM issues
      WHERE company_id = ${companyId}::uuid
        AND id IN (${uuidList(rootIds)})
      UNION ALL
      SELECT tree.root_id, child.id, tree.depth + 1
      FROM issues child
      JOIN tree ON child.parent_id = tree.id
      WHERE child.company_id = ${companyId}::uuid
        AND child.hidden_at IS NULL
        AND tree.depth < ${SUBTREE_MAX_DEPTH}
    )
  `;
}

export function issueFollowService(db: Db) {
  async function getSummaries(companyId: string, issueIds: readonly string[]) {
    if (issueIds.length === 0) return new Map<string, SummaryRow>();
    const rows = await db
      .select(summaryColumns)
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.id, [...issueIds]), isNull(issues.hiddenAt)));
    return new Map(rows.map((row) => [row.id, row as SummaryRow]));
  }

  async function readable(rows: SummaryRow[], canRead?: CanReadIssue) {
    if (!canRead) return rows;
    const allowed = await Promise.all(rows.map((row) => canRead(row)));
    return rows.filter((_, index) => allowed[index]);
  }

  async function rollupCounts(companyId: string, userId: string, rootIds: string[]) {
    const result = await db.execute(sql`
      ${subtreeCte(companyId, rootIds)}
      SELECT
        tree.root_id::text AS root_id,
        count(*)::int AS total,
        count(*) FILTER (WHERE i.status = 'done')::int AS done,
        count(*) FILTER (WHERE i.status IN ('in_progress', 'in_review'))::int AS in_progress,
        count(*) FILTER (WHERE i.status = 'blocked')::int AS blocked,
        count(*) FILTER (
          WHERE i.status NOT IN ('done', 'cancelled')
            AND (
              i.assignee_user_id = ${userId}
              OR EXISTS (
                SELECT 1 FROM issue_thread_interactions q
                WHERE q.issue_id = i.id AND q.company_id = i.company_id AND q.status = 'pending'
              )
            )
        )::int AS waiting_on_you
      FROM tree
      JOIN issues i ON i.id = tree.id
      GROUP BY tree.root_id
    `);
    return new Map(
      rowsOf(result).map((row) => [
        String(row.root_id),
        {
          total: Number(row.total ?? 0),
          done: Number(row.done ?? 0),
          inProgress: Number(row.in_progress ?? 0),
          waitingOnYou: Number(row.waiting_on_you ?? 0),
          blocked: Number(row.blocked ?? 0),
        },
      ]),
    );
  }

  async function rollupUpdates(companyId: string, rootIds: string[], canRead?: CanReadIssue) {
    const limit = FOLLOW_ROLLUP_UPDATES_LIMIT;
    const result = await db.execute(sql`
      ${subtreeCte(companyId, rootIds)},
      updates AS (
        SELECT tree.root_id, c.issue_id, 'comment' AS kind, c.body AS summary, c.created_at AS at
        FROM tree
        JOIN issue_comments c ON c.issue_id = tree.id AND c.company_id = ${companyId}::uuid
        WHERE c.deleted_at IS NULL
        UNION ALL
        SELECT tree.root_id, tree.id AS issue_id, 'status' AS kind, a.details ->> 'status' AS summary, a.created_at AS at
        FROM tree
        JOIN activity_log a ON a.entity_type = 'issue' AND a.entity_id = tree.id::text
        WHERE a.company_id = ${companyId}::uuid
          AND a.action = 'issue.updated'
          AND a.details ->> 'status' IS NOT NULL
          AND (a.details -> '_previous' ->> 'status') IS DISTINCT FROM (a.details ->> 'status')
      ),
      ranked AS (
        SELECT updates.*, row_number() OVER (PARTITION BY root_id ORDER BY at DESC) AS rn
        FROM updates
      )
      SELECT root_id::text AS root_id, issue_id::text AS issue_id, kind, summary, at
      FROM ranked
      WHERE rn <= ${limit * 2}
      ORDER BY root_id, at DESC
    `);
    const rows = rowsOf(result);
    const summaries = await getSummaries(companyId, [...new Set(rows.map((row) => String(row.issue_id)))]);
    const readableIds = new Set((await readable([...summaries.values()], canRead)).map((row) => row.id));
    const byRoot = new Map<string, IssueFollowRollupUpdate[]>();
    for (const row of rows) {
      const issueId = String(row.issue_id);
      const issue = summaries.get(issueId);
      if (!issue || !readableIds.has(issueId)) continue;
      const list = byRoot.get(String(row.root_id)) ?? [];
      if (list.length >= limit) continue;
      list.push({
        kind: row.kind === "status" ? "status" : "comment",
        issueId,
        issueIdentifier: issue.identifier,
        issueTitle: issue.title,
        summary: row.kind === "status" ? String(row.summary) : excerpt(String(row.summary ?? "")),
        at: new Date(row.at as string | Date),
      });
      byRoot.set(String(row.root_id), list);
    }
    return byRoot;
  }

  return {
    follow: async (companyId: string, userId: string, issueId: string) => {
      const [row] = await db
        .insert(issueFollows)
        .values({ companyId, userId, issueId })
        .onConflictDoNothing({ target: [issueFollows.companyId, issueFollows.issueId, issueFollows.userId] })
        .returning();
      return row ?? null;
    },

    unfollow: async (companyId: string, userId: string, issueId: string) => {
      const removed = await db
        .delete(issueFollows)
        .where(
          and(eq(issueFollows.companyId, companyId), eq(issueFollows.userId, userId), eq(issueFollows.issueId, issueId)),
        )
        .returning({ id: issueFollows.id });
      return removed.length > 0;
    },

    isFollowing: async (companyId: string, userId: string, issueId: string) => {
      const rows = await db
        .select({ id: issueFollows.id })
        .from(issueFollows)
        .where(
          and(eq(issueFollows.companyId, companyId), eq(issueFollows.userId, userId), eq(issueFollows.issueId, issueId)),
        )
        .limit(1);
      return rows.length > 0;
    },

    /** The user's followed tasks, newest follow first, each with its subtree rollup. */
    listWithRollups: async (
      companyId: string,
      userId: string,
      canRead?: CanReadIssue,
    ): Promise<IssueFollowWithRollup[]> => {
      const follows = await db
        .select({ issueId: issueFollows.issueId, createdAt: issueFollows.createdAt })
        .from(issueFollows)
        .where(and(eq(issueFollows.companyId, companyId), eq(issueFollows.userId, userId)))
        .orderBy(desc(issueFollows.createdAt));
      const summaries = await getSummaries(companyId, follows.map((follow) => follow.issueId));
      const allowed = new Set((await readable([...summaries.values()], canRead)).map((row) => row.id));
      const rootIds = follows.map((follow) => follow.issueId).filter((id) => allowed.has(id));
      if (rootIds.length === 0) return [];
      const [counts, updates] = await Promise.all([
        rollupCounts(companyId, userId, rootIds),
        rollupUpdates(companyId, rootIds, canRead),
      ]);
      return follows
        .filter((follow) => allowed.has(follow.issueId))
        .map((follow) => ({
          issueId: follow.issueId,
          followedAt: follow.createdAt,
          issue: toSummary(summaries.get(follow.issueId)!),
          counts: counts.get(follow.issueId) ?? { total: 1, done: 0, inProgress: 0, waitingOnYou: 0, blocked: 0 },
          latestUpdates: updates.get(follow.issueId) ?? [],
        }));
    },

    /** Records an open and keeps only the latest few per user and company. */
    recordView: async (companyId: string, userId: string, issueId: string, viewedAt = new Date()) => {
      await db.transaction(async (tx) => {
        await tx
          .insert(issueRecentViews)
          .values({ companyId, userId, issueId, viewedAt })
          .onConflictDoUpdate({
            target: [issueRecentViews.companyId, issueRecentViews.issueId, issueRecentViews.userId],
            set: { viewedAt },
          });
        const keep = await tx
          .select({ id: issueRecentViews.id })
          .from(issueRecentViews)
          .where(and(eq(issueRecentViews.companyId, companyId), eq(issueRecentViews.userId, userId)))
          .orderBy(desc(issueRecentViews.viewedAt))
          .limit(RECENT_ISSUE_VIEWS_LIMIT);
        await tx.delete(issueRecentViews).where(
          and(
            eq(issueRecentViews.companyId, companyId),
            eq(issueRecentViews.userId, userId),
            notInArray(issueRecentViews.id, keep.map((row) => row.id)),
          ),
        );
      });
    },

    listRecent: async (companyId: string, userId: string, canRead?: CanReadIssue): Promise<RecentlyOpenedIssue[]> => {
      const views = await db
        .select({ issueId: issueRecentViews.issueId, viewedAt: issueRecentViews.viewedAt })
        .from(issueRecentViews)
        .where(and(eq(issueRecentViews.companyId, companyId), eq(issueRecentViews.userId, userId)))
        .orderBy(desc(issueRecentViews.viewedAt))
        .limit(RECENT_ISSUE_VIEWS_LIMIT);
      const summaries = await getSummaries(companyId, views.map((view) => view.issueId));
      const allowed = new Set((await readable([...summaries.values()], canRead)).map((row) => row.id));
      return views
        .filter((view) => allowed.has(view.issueId))
        .map((view) => ({ issueId: view.issueId, viewedAt: view.viewedAt, issue: toSummary(summaries.get(view.issueId)!) }));
    },
  };
}
