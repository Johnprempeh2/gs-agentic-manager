import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { issueRelations, issues } from "@greatstone/db";
import type {
  BlockedWorkIssueRef,
  BlockedWorkItem,
  BlockedWorkOverview,
  BlockedWorkOwner,
  BlockedWorkRootCause,
  BlockedWorkTidyReason,
  IssueStatus,
  IssueUnblockDescriptor,
} from "@greatstone/shared";

/** Blocked tasks read per overview; keeps one request bounded for a large company. */
export const BLOCKED_WORK_LIMIT = 1000;

const CLOSED_STATUSES = new Set<string>(["done", "cancelled"]);

export type BlockedWorkIssueRow = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  unblockDescriptor: IssueUnblockDescriptor | null;
  blockedTransitionAt: Date | null;
  updatedAt: Date;
};

/** `blockerId` blocks `blockedId`. */
export type BlockedWorkEdge = { blockerId: string; blockedId: string };

function issueRef(row: BlockedWorkIssueRow): BlockedWorkIssueRef {
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    status: row.status as IssueStatus,
  };
}

function ownerOf(row: BlockedWorkIssueRow): BlockedWorkOwner {
  // A blocked task can name who must act; that beats its assignee, who is the one waiting.
  const named = row.status === "blocked" ? row.unblockDescriptor?.owner : null;
  if (named === "board") return { type: "board", agentId: null, userId: null };
  if (named && "agentId" in named) return { type: "agent", agentId: named.agentId, userId: null };
  if (named && "userId" in named) return { type: "user", agentId: null, userId: named.userId };
  if (row.assigneeAgentId) return { type: "agent", agentId: row.assigneeAgentId, userId: null };
  if (row.assigneeUserId) return { type: "user", agentId: null, userId: row.assigneeUserId };
  return { type: "nobody", agentId: null, userId: null };
}

function waitingSince(row: BlockedWorkIssueRow): Date {
  return row.blockedTransitionAt ?? row.updatedAt;
}

function earliest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() <= b.getTime() ? a : b;
}

/**
 * Turns the blocked tasks and their blocker links into the overview the board reads:
 * how long each task has waited, who must act, and which single task holds each chain.
 */
export function buildBlockedWorkOverview(input: {
  blocked: BlockedWorkIssueRow[];
  /** Every issue an edge points at, blocked or not. */
  issuesById: Map<string, BlockedWorkIssueRow>;
  edges: BlockedWorkEdge[];
  now: Date;
  truncated?: boolean;
}): BlockedWorkOverview {
  const blockedIds = new Set(input.blocked.map((row) => row.id));
  const blockersOf = new Map<string, string[]>();
  for (const edge of input.edges) {
    const list = blockersOf.get(edge.blockedId) ?? [];
    list.push(edge.blockerId);
    blockersOf.set(edge.blockedId, list);
  }

  const rootsMemo = new Map<string, string[]>();
  // Walks the open blockers down to the work nothing else open holds up.
  // A cycle stops at the task that closes it, which then counts as a root.
  const rootsOf = (issueId: string, path: Set<string>): string[] => {
    const memo = rootsMemo.get(issueId);
    if (memo) return memo;
    const openBlockers = (blockersOf.get(issueId) ?? []).filter((blockerId) => {
      const blocker = input.issuesById.get(blockerId);
      return blocker && !CLOSED_STATUSES.has(blocker.status);
    });
    if (openBlockers.length === 0) {
      rootsMemo.set(issueId, [issueId]);
      return [issueId];
    }
    path.add(issueId);
    const roots = new Set<string>();
    for (const blockerId of openBlockers) {
      if (path.has(blockerId)) {
        roots.add(blockerId);
        continue;
      }
      if (blockedIds.has(blockerId)) {
        for (const root of rootsOf(blockerId, path)) roots.add(root);
      } else {
        roots.add(blockerId);
      }
    }
    path.delete(issueId);
    const result = [...roots].sort();
    rootsMemo.set(issueId, result);
    return result;
  };

  const items: BlockedWorkItem[] = [];
  const rootStats = new Map<string, { held: Set<string>; oldest: Date | null }>();
  let oldestOverall: Date | null = null;

  for (const row of input.blocked) {
    const since = waitingSince(row);
    oldestOverall = earliest(oldestOverall, since);
    const rootIssueIds = rootsOf(row.id, new Set());

    let tidyReason: BlockedWorkTidyReason | null = null;
    const blockerRows = (blockersOf.get(row.id) ?? [])
      .map((id) => input.issuesById.get(id))
      .filter((blocker): blocker is BlockedWorkIssueRow => Boolean(blocker));
    if (blockerRows.length > 0 && blockerRows.every((blocker) => CLOSED_STATUSES.has(blocker.status))) {
      tidyReason = blockerRows.some((blocker) => blocker.status === "done")
        ? "waiting_on_finished_work"
        : "waiting_on_cancelled_work";
    }

    items.push({
      issue: issueRef(row),
      waitingSince: since.toISOString(),
      owner: ownerOf(row),
      rootIssueIds,
      tidyReason,
    });

    for (const rootId of rootIssueIds) {
      const stats = rootStats.get(rootId) ?? { held: new Set<string>(), oldest: null };
      if (rootId !== row.id) stats.held.add(row.id);
      stats.oldest = earliest(stats.oldest, since);
      rootStats.set(rootId, stats);
    }
  }

  const rootCauses: BlockedWorkRootCause[] = [];
  for (const [rootId, stats] of rootStats) {
    if (stats.held.size === 0) continue;
    const root = input.issuesById.get(rootId);
    if (!root) continue;
    const rootSince = blockedIds.has(rootId) ? waitingSince(root) : null;
    const oldest = earliest(stats.oldest, rootSince);
    rootCauses.push({
      issue: issueRef(root),
      owner: ownerOf(root),
      action: root.status === "blocked" ? root.unblockDescriptor?.action?.trim() || null : null,
      heldIssueIds: [...stats.held].sort(),
      oldestWaitingSince: oldest ? oldest.toISOString() : null,
    });
  }

  rootCauses.sort((a, b) => {
    const sizeDiff = b.heldIssueIds.length - a.heldIssueIds.length;
    if (sizeDiff !== 0) return sizeDiff;
    return (a.oldestWaitingSince ?? "").localeCompare(b.oldestWaitingSince ?? "");
  });
  items.sort((a, b) => (a.waitingSince ?? "").localeCompare(b.waitingSince ?? ""));

  return {
    generatedAt: input.now.toISOString(),
    totalBlocked: input.blocked.length,
    oldestWaitingSince: oldestOverall ? oldestOverall.toISOString() : null,
    rootCauses,
    items,
    truncated: input.truncated ?? false,
  };
}

const issueColumns = {
  id: issues.id,
  identifier: issues.identifier,
  title: issues.title,
  status: issues.status,
  assigneeAgentId: issues.assigneeAgentId,
  assigneeUserId: issues.assigneeUserId,
  unblockDescriptor: issues.unblockDescriptor,
  blockedTransitionAt: issues.blockedTransitionAt,
  updatedAt: issues.updatedAt,
};

export function blockedWorkService(db: Db) {
  return {
    async overview(companyId: string, now: Date = new Date()): Promise<BlockedWorkOverview> {
      const blockedRows = await db
        .select(issueColumns)
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.status, "blocked"), isNull(issues.hiddenAt)))
        .orderBy(issues.updatedAt)
        .limit(BLOCKED_WORK_LIMIT + 1);
      const truncated = blockedRows.length > BLOCKED_WORK_LIMIT;
      const blocked = (truncated ? blockedRows.slice(0, BLOCKED_WORK_LIMIT) : blockedRows) as BlockedWorkIssueRow[];
      const issuesById = new Map(blocked.map((row) => [row.id, row]));
      if (blocked.length === 0) {
        return buildBlockedWorkOverview({ blocked, issuesById, edges: [], now, truncated });
      }

      const edgeRows = await db
        .select({ blockerId: issueRelations.issueId, blockedId: issueRelations.relatedIssueId })
        .from(issueRelations)
        .where(
          and(
            eq(issueRelations.companyId, companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.relatedIssueId, [...issuesById.keys()]),
          ),
        );

      const missing = [...new Set(edgeRows.map((edge) => edge.blockerId))].filter((id) => !issuesById.has(id));
      if (missing.length > 0) {
        const blockerRows = await db
          .select(issueColumns)
          .from(issues)
          .where(and(eq(issues.companyId, companyId), inArray(issues.id, missing)));
        for (const row of blockerRows as BlockedWorkIssueRow[]) issuesById.set(row.id, row);
      }

      return buildBlockedWorkOverview({ blocked, issuesById, edges: edgeRows, now, truncated });
    },
  };
}
