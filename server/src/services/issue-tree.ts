import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { issueRelations, issues } from "@greatstone/db";
import type {
  IssuePriority,
  IssueStatus,
  IssueTree,
  IssueTreeExternalBlocker,
  IssueTreeNode,
} from "@greatstone/shared";
import type { CanReadIssue } from "./issue-follows.js";
import { issueService } from "./issues.js";

/** A task tree stops at this many tasks; the page says so when it does. */
export const ISSUE_TREE_MAX_NODES = 300;
/** And this many levels below the root, so a bad parent loop cannot run away. */
export const ISSUE_TREE_MAX_DEPTH = 12;

const TERMINAL = new Set(["done", "cancelled"]);

const nodeColumns = {
  id: issues.id,
  companyId: issues.companyId,
  projectId: issues.projectId,
  parentId: issues.parentId,
  identifier: issues.identifier,
  title: issues.title,
  status: issues.status,
  priority: issues.priority,
  assigneeAgentId: issues.assigneeAgentId,
  assigneeUserId: issues.assigneeUserId,
  executionRunId: issues.executionRunId,
  unblockDescriptor: issues.unblockDescriptor,
  updatedAt: issues.updatedAt,
};

function rowsOf(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
}

export function issueTreeService(db: Db, limits = { maxNodes: ISSUE_TREE_MAX_NODES, maxDepth: ISSUE_TREE_MAX_DEPTH }) {
  const issuesSvc = issueService(db);

  /** The root and everything under it, breadth first, cut at the limits. */
  async function subtreeIds(companyId: string, rootId: string) {
    const result = await db.execute(sql`
      WITH RECURSIVE tree(id, depth) AS (
        SELECT id, 0 FROM issues
        WHERE company_id = ${companyId}::uuid AND id = ${rootId}::uuid
        UNION ALL
        SELECT child.id, tree.depth + 1
        FROM issues child
        JOIN tree ON child.parent_id = tree.id
        WHERE child.company_id = ${companyId}::uuid
          AND child.hidden_at IS NULL
          AND tree.depth < ${limits.maxDepth + 1}
      )
      SELECT id::text AS id, min(depth)::int AS depth FROM tree
      GROUP BY id
      ORDER BY min(depth), id
      LIMIT ${limits.maxNodes + 1}
    `);
    const rows = rowsOf(result).map((row) => ({ id: String(row.id), depth: Number(row.depth) }));
    const tooDeep = rows.some((row) => row.depth > limits.maxDepth);
    const kept = rows.filter((row) => row.depth <= limits.maxDepth).slice(0, limits.maxNodes);
    return { rows: kept, truncated: tooDeep || rows.length > limits.maxNodes };
  }

  return {
    async getTree(companyId: string, rootId: string, canRead?: CanReadIssue): Promise<IssueTree | null> {
      const { rows: idRows, truncated: cut } = await subtreeIds(companyId, rootId);
      if (idRows.length === 0) return null;
      const depthById = new Map(idRows.map((row) => [row.id, row.depth]));
      const loaded = await db
        .select(nodeColumns)
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, [...depthById.keys()])));
      const byId = new Map(loaded.map((row) => [row.id, row]));

      // Breadth first, so a parent is always decided before its children:
      // a task the viewer cannot read hides its whole branch.
      const kept: typeof loaded = [];
      const keptIds = new Set<string>();
      const readable = canRead ? await Promise.all(idRows.map((row) => byId.get(row.id)).map((row) => (row ? canRead(row) : false))) : null;
      idRows.forEach((entry, index) => {
        const row = byId.get(entry.id);
        if (!row || (readable && !readable[index])) return;
        if (entry.id !== rootId && (!row.parentId || !keptIds.has(row.parentId))) return;
        kept.push(row);
        keptIds.add(row.id);
      });
      if (!keptIds.has(rootId)) return null;
      const ids = [...keptIds];

      const [childCounts, relations, attention] = await Promise.all([
        db
          .select({
            parentId: issues.parentId,
            total: sql<number>`count(*) FILTER (WHERE ${issues.status} <> 'cancelled')::int`,
            done: sql<number>`count(*) FILTER (WHERE ${issues.status} = 'done')::int`,
          })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), inArray(issues.parentId, ids), isNull(issues.hiddenAt)))
          .groupBy(issues.parentId),
        db
          .select({
            blockedId: issueRelations.relatedIssueId,
            blocker: {
              id: issues.id,
              companyId: issues.companyId,
              projectId: issues.projectId,
              parentId: issues.parentId,
              identifier: issues.identifier,
              title: issues.title,
              status: issues.status,
              assigneeAgentId: issues.assigneeAgentId,
              assigneeUserId: issues.assigneeUserId,
              hiddenAt: issues.hiddenAt,
            },
          })
          .from(issueRelations)
          .innerJoin(issues, eq(issueRelations.issueId, issues.id))
          .where(
            and(
              eq(issueRelations.companyId, companyId),
              eq(issueRelations.type, "blocks"),
              inArray(issueRelations.relatedIssueId, ids),
              eq(issues.companyId, companyId),
            ),
          ),
        issuesSvc.listBlockerAttention(
          companyId,
          kept.filter((row) => row.status === "blocked"),
        ),
      ]);

      const counts = new Map(childCounts.map((row) => [row.parentId!, row]));
      const blockedBy = new Map<string, string[]>();
      const external = new Map<string, IssueTreeExternalBlocker>();
      for (const { blockedId, blocker } of relations) {
        if (blocker.hiddenAt) continue;
        if (!keptIds.has(blocker.id)) {
          // A blocker outside the tree is named only while it is open and the
          // viewer may read it.
          if (TERMINAL.has(blocker.status)) continue;
          if (canRead && !(await canRead(blocker))) continue;
          external.set(blocker.id, {
            id: blocker.id,
            identifier: blocker.identifier,
            title: blocker.title,
            status: blocker.status as IssueStatus,
            assigneeAgentId: blocker.assigneeAgentId,
            assigneeUserId: blocker.assigneeUserId,
          });
        }
        const list = blockedBy.get(blockedId) ?? [];
        list.push(blocker.id);
        blockedBy.set(blockedId, list);
      }

      const nodes: IssueTreeNode[] = kept.map((row) => {
        const terminalBlockerId = attention.get(row.id)?.terminalBlockerIssueId ?? null;
        return {
          id: row.id,
          identifier: row.identifier,
          title: row.title,
          status: row.status as IssueStatus,
          priority: row.priority as IssuePriority,
          assigneeAgentId: row.assigneeAgentId,
          assigneeUserId: row.assigneeUserId,
          parentId: row.id === rootId ? null : row.parentId,
          depth: depthById.get(row.id) ?? 0,
          blockedByIds: (blockedBy.get(row.id) ?? []).sort(),
          childCount: counts.get(row.id)?.total ?? 0,
          doneChildCount: counts.get(row.id)?.done ?? 0,
          terminalBlockerId:
            terminalBlockerId && (keptIds.has(terminalBlockerId) || external.has(terminalBlockerId))
              ? terminalBlockerId
              : null,
          unblockAction: row.status === "blocked" ? row.unblockDescriptor?.action?.trim() || null : null,
          updatedAt: row.updatedAt,
        };
      });

      return {
        rootId,
        nodes,
        externalBlockers: [...external.values()],
        truncated: cut,
        limits: { ...limits },
      };
    },
  };
}
