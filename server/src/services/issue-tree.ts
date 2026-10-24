import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { issueRelations, issueThreadInteractions, issues, projects } from "@greatstone/db";
import type {
  IssuePriority,
  IssueStatus,
  IssueTree,
  IssueTreeExternalBlocker,
  IssueTreeNode,
  IssueTreePendingCard,
  IssueUnblockDescriptor,
} from "@greatstone/shared";
import type { CanReadIssue } from "./issue-follows.js";
import { issueService, terminalExplicitBlockersByRoot } from "./issues.js";

/** A task tree stops at this many tasks; the page says so when it does. */
export const ISSUE_TREE_MAX_NODES = 300;
/** And this many levels below the root, so a bad parent loop cannot run away. */
export const ISSUE_TREE_MAX_DEPTH = 12;

const TERMINAL = new Set(["done", "cancelled"]);

/** The columns a tree node is built from. */
export const treeNodeColumns = {
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
  keyTaskAt: issues.keyTaskAt,
  updatedAt: issues.updatedAt,
};

export type TreeRow = Pick<typeof issues.$inferSelect, keyof typeof treeNodeColumns>;

export function rowsOf(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
}

/**
 * Tree nodes for tasks already chosen and read-checked: sub-task counts,
 * blockers (an outside one named only while open and readable), and what a
 * blocked task needs. Shared by the task tree and the project tree.
 */
export async function buildTreeNodes(
  db: Db,
  companyId: string,
  kept: TreeRow[],
  options: {
    depthOf: (row: TreeRow) => number;
    parentIdOf: (row: TreeRow) => string | null;
    canRead?: CanReadIssue;
  },
): Promise<{ nodes: IssueTreeNode[]; externalBlockers: IssueTreeExternalBlocker[] }> {
  const { canRead } = options;
  const keptIds = new Set(kept.map((row) => row.id));
  const ids = [...keptIds];
  if (ids.length === 0) return { nodes: [], externalBlockers: [] };

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
          unblockDescriptor: issues.unblockDescriptor,
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
    issueService(db).listBlockerAttention(
      companyId,
      kept.filter((row) => row.status === "blocked"),
    ),
  ]);

  const counts = new Map(childCounts.map((row) => [row.parentId!, row]));
  const blockedBy = new Map<string, string[]>();
  const external = new Map<string, IssueTreeExternalBlocker>();
  const externalDescriptors = new Map<string, IssueUnblockDescriptor | null>();
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
      externalDescriptors.set(blocker.id, blocker.unblockDescriptor);
    }
    const list = blockedBy.get(blockedId) ?? [];
    list.push(blocker.id);
    blockedBy.set(blockedId, list);
  }

  // The task at the bottom of each blocked task's chain: what the whole chain
  // waits on, even when that task is itself waiting on a card (GRE-2277).
  const firstOpenBlocker = new Map<string, (typeof relations)[number]["blocker"]>();
  for (const { blockedId, blocker } of [...relations].sort((a, b) => a.blocker.id.localeCompare(b.blocker.id))) {
    if (blocker.hiddenAt || TERMINAL.has(blocker.status) || firstOpenBlocker.has(blockedId)) continue;
    if (!keptIds.has(blocker.id) && !external.has(blocker.id)) continue;
    firstOpenBlocker.set(blockedId, blocker);
  }
  const chainEnds = await terminalExplicitBlockersByRoot(
    companyId,
    [...new Map([...firstOpenBlocker.values()].map((blocker) => [blocker.id, blocker])).values()].map((blocker) => ({
      id: blocker.id,
      identifier: blocker.identifier,
      title: blocker.title,
      status: blocker.status as IssueStatus,
      priority: "medium" as IssuePriority,
      assigneeAgentId: blocker.assigneeAgentId,
      assigneeUserId: blocker.assigneeUserId,
    })),
    db,
  );
  const rootBlockerOf = (rowId: string): string | null => {
    const direct = firstOpenBlocker.get(rowId);
    if (!direct) return null;
    return chainEnds.get(direct.id)?.find((end) => !TERMINAL.has(end.status))?.id ?? null;
  };

  // A root blocker further down a chain that leaves the tree is named too, so
  // a task high up can say what the whole chain waits on.
  const farTerminalIds = [
    ...new Set(
      [...[...attention.values()].map((entry) => entry.terminalBlockerIssueId), ...kept.map((row) => rootBlockerOf(row.id))]
        .filter((id): id is string => !!id && !keptIds.has(id) && !external.has(id)),
    ),
  ];
  if (farTerminalIds.length > 0) {
    const far = await db
      .select({ ...treeNodeColumns, hiddenAt: issues.hiddenAt })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.id, farTerminalIds)));
    for (const row of far) {
      if (row.hiddenAt || TERMINAL.has(row.status)) continue;
      if (canRead && !(await canRead(row))) continue;
      external.set(row.id, {
        id: row.id,
        identifier: row.identifier,
        title: row.title,
        status: row.status as IssueStatus,
        assigneeAgentId: row.assigneeAgentId,
        assigneeUserId: row.assigneeUserId,
      });
      externalDescriptors.set(row.id, row.unblockDescriptor);
    }
  }

  // The card each blocked task waits on, oldest first.
  const blockedIds = [
    ...kept.filter((row) => row.status === "blocked").map((row) => row.id),
    ...[...external.values()].filter((row) => row.status === "blocked").map((row) => row.id),
  ];
  const pendingCards = new Map<string, IssueTreePendingCard>();
  if (blockedIds.length > 0) {
    const cards = await db
      .select({
        issueId: issueThreadInteractions.issueId,
        id: issueThreadInteractions.id,
        kind: issueThreadInteractions.kind,
        title: issueThreadInteractions.title,
        summary: issueThreadInteractions.summary,
        addresseeAgentId: issueThreadInteractions.addresseeAgentId,
        addresseeUserId: issueThreadInteractions.addresseeUserId,
        createdAt: issueThreadInteractions.createdAt,
      })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, companyId),
          eq(issueThreadInteractions.status, "pending"),
          inArray(issueThreadInteractions.issueId, blockedIds),
        ),
      )
      .orderBy(asc(issueThreadInteractions.createdAt));
    for (const card of cards) {
      if (pendingCards.has(card.issueId)) continue;
      pendingCards.set(card.issueId, {
        id: card.id,
        kind: card.kind,
        title: card.title?.trim() || card.summary?.trim() || null,
        addresseeAgentId: card.addresseeAgentId,
        addresseeUserId: card.addresseeUserId,
        createdAt: card.createdAt,
      });
    }
  }
  for (const blocker of external.values()) {
    if (blocker.status !== "blocked") continue;
    const descriptor = externalDescriptors.get(blocker.id) ?? null;
    blocker.waitReason = {
      unblockAction: descriptor?.action?.trim() || null,
      unblockOwner: descriptor?.owner ?? null,
      pendingCard: pendingCards.get(blocker.id) ?? null,
    };
  }

  const named = (id: string | null) => (id && (keptIds.has(id) || external.has(id)) ? id : null);
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
      parentId: options.parentIdOf(row),
      depth: options.depthOf(row),
      blockedByIds: (blockedBy.get(row.id) ?? []).sort(),
      childCount: counts.get(row.id)?.total ?? 0,
      doneChildCount: counts.get(row.id)?.done ?? 0,
      terminalBlockerId: named(terminalBlockerId),
      rootBlockerId: row.status === "blocked" ? named(rootBlockerOf(row.id)) : null,
      unblockAction: row.status === "blocked" ? row.unblockDescriptor?.action?.trim() || null : null,
      unblockOwner: row.status === "blocked" ? row.unblockDescriptor?.owner ?? null : null,
      pendingCard: pendingCards.get(row.id) ?? null,
      isKeyTask: row.keyTaskAt != null,
      updatedAt: row.updatedAt,
    };
  });
  return { nodes, externalBlockers: [...external.values()] };
}

export function issueTreeService(db: Db, limits = { maxNodes: ISSUE_TREE_MAX_NODES, maxDepth: ISSUE_TREE_MAX_DEPTH }) {
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
        .select(treeNodeColumns)
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

      const root = byId.get(rootId)!;
      const [{ nodes, externalBlockers }, project] = await Promise.all([
        buildTreeNodes(db, companyId, kept, {
          depthOf: (row) => depthById.get(row.id) ?? 0,
          parentIdOf: (row) => (row.id === rootId ? null : row.parentId),
          canRead,
        }),
        root.projectId
          ? db
              .select({ id: projects.id, name: projects.name })
              .from(projects)
              .where(and(eq(projects.companyId, companyId), eq(projects.id, root.projectId)))
              .then((rows) => rows[0] ?? null)
          : null,
      ]);

      return {
        rootId,
        nodes,
        externalBlockers,
        truncated: cut,
        limits: { ...limits },
        project,
      };
    },
  };
}
