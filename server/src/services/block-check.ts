import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, lt, notInArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { issueRelations, issueThreadInteractions, issues, projects } from "@greatstone/db";
import type {
  BlockCheckIssueRef,
  BlockCheckItem,
  BlockCheckKind,
  BlockCheckProject,
  BlockCheckResult,
  IssueStatus,
  IssueUnblockDescriptor,
  IssueUnblockOwner,
} from "@greatstone/shared";

/** Tasks read per kind of row in one check; keeps one request bounded. */
export const BLOCK_CHECK_LIMIT = 1000;

/** A person's ask is old, and worth a nudge, after this long. */
export const BLOCK_CHECK_HUMAN_ASK_AGE_MS = 24 * 60 * 60 * 1000;

const CLOSED_STATUSES = ["done", "cancelled"];
const CLOSED = new Set<string>(CLOSED_STATUSES);

/**
 * A condition in brackets in a title, such as "(after John accepts the proof)"
 * or "[once the keys arrive]". `TITLE_CONDITION_SQL` is the loose database
 * filter; this one picks out the words.
 */
const TITLE_CONDITION = /[([]\s*((?:after|once|when|until|pending|waiting (?:on|for)|blocked (?:on|by))\b[^)\]]*)[)\]]/i;
const TITLE_CONDITION_SQL = "[([][[:space:]]*(after|once|when|until|pending|waiting|blocked)[[:space:]]";

export type BlockCheckTaskRow = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  projectId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  unblockDescriptor: IssueUnblockDescriptor | null;
  blockedTransitionAt: Date | null;
  updatedAt: Date;
};

export type BlockCheckBlockerRow = { id: string; status: string; hiddenAt: Date | null };

export type BlockCheckCardRow = {
  id: string;
  issueId: string;
  status: string;
  title: string | null;
  summary: string | null;
  addresseeAgentId: string | null;
  addresseeUserId: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
};

export type BlockCheckProjectRow = { id: string; name: string; leadAgentId: string | null };

function issueRef(row: BlockCheckTaskRow): BlockCheckIssueRef {
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    status: row.status as IssueStatus,
    assigneeAgentId: row.assigneeAgentId,
    assigneeUserId: row.assigneeUserId,
  };
}

function cardName(card: BlockCheckCardRow) {
  const text = card.title?.trim() || card.summary?.trim();
  return text ? `"${text}"` : "a card";
}

function blockedSince(row: BlockCheckTaskRow) {
  return row.blockedTransitionAt ?? row.updatedAt;
}

function isPerson(owner: IssueUnblockOwner | null | undefined): owner is IssueUnblockOwner {
  return owner === "board" || (!!owner && "userId" in owner);
}

/** The condition named in a title, or null. */
export function titleCondition(title: string): string | null {
  return TITLE_CONDITION.exec(title)?.[1]?.trim() ?? null;
}

function fingerprintOf(items: BlockCheckItem[]) {
  const lines = items.map((item) => `${item.kind}:${item.issue.id}:${item.cardId ?? ""}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

/**
 * Finds the blocks a project lead should look at (GRE-2287): blocked tasks
 * nothing recorded holds, blocks whose blocker or card is already closed or
 * answered, titles that name a condition, and asks a person has sat on for
 * over a day. Grouped by project, so each lead reads only their own.
 */
export function buildBlockCheck(input: {
  /** Open tasks to check: every blocked task, and any with a title condition. */
  tasks: BlockCheckTaskRow[];
  /** Every task an edge points at. */
  blockersById: Map<string, BlockCheckBlockerRow>;
  /** `blockerId` blocks `blockedId`. */
  edges: { blockerId: string; blockedId: string }[];
  /** Cards on the tasks, any status. */
  cards: BlockCheckCardRow[];
  projectsById: Map<string, BlockCheckProjectRow>;
  now: Date;
  truncated?: boolean;
}): BlockCheckResult {
  const blockersOf = new Map<string, BlockCheckBlockerRow[]>();
  for (const edge of input.edges) {
    const blocker = input.blockersById.get(edge.blockerId);
    // A hidden blocker does not count, as in the tree.
    if (!blocker || blocker.hiddenAt) continue;
    const list = blockersOf.get(edge.blockedId) ?? [];
    list.push(blocker);
    blockersOf.set(edge.blockedId, list);
  }
  const cardsOf = new Map<string, BlockCheckCardRow[]>();
  for (const card of [...input.cards].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const list = cardsOf.get(card.issueId) ?? [];
    list.push(card);
    cardsOf.set(card.issueId, list);
  }

  const askCutoff = input.now.getTime() - BLOCK_CHECK_HUMAN_ASK_AGE_MS;
  const byProject = new Map<string | null, BlockCheckItem[]>();
  const add = (row: BlockCheckTaskRow, item: Omit<BlockCheckItem, "issue" | "cardId" | "blockerIds" | "waitingOn"> & Partial<BlockCheckItem>) => {
    const list = byProject.get(row.projectId) ?? [];
    list.push({ cardId: null, blockerIds: [], waitingOn: null, ...item, issue: issueRef(row) });
    byProject.set(row.projectId, list);
  };

  const seen = new Set<string>();
  for (const row of input.tasks) {
    if (seen.has(row.id) || CLOSED.has(row.status)) continue;
    seen.add(row.id);
    const cards = cardsOf.get(row.id) ?? [];
    const pending = cards.filter((card) => card.status === "pending");

    if (row.status === "blocked") {
      const blockers = blockersOf.get(row.id) ?? [];
      const openBlockers = blockers.filter((blocker) => !CLOSED.has(blocker.status));
      const since = blockedSince(row);
      const action = row.unblockDescriptor?.action?.trim() || null;
      if (openBlockers.length === 0 && pending.length === 0) {
        const answered = cards
          .filter((card) => card.status !== "pending" && card.resolvedAt)
          .filter((card) => !row.blockedTransitionAt || card.resolvedAt!.getTime() >= row.blockedTransitionAt.getTime())
          .at(-1);
        if (blockers.length > 0) {
          add(row, {
            kind: "blockers_closed",
            detail: `Every task it waits on is ${blockers.every((b) => b.status === "cancelled") ? "cancelled" : "done or cancelled"}.`,
            since: since.toISOString(),
            blockerIds: blockers.map((blocker) => blocker.id).sort(),
          });
        } else if (answered) {
          add(row, {
            kind: "card_answered",
            detail: `Still blocked, but ${cardName(answered)} was answered (${answered.status}).`,
            since: answered.resolvedAt!.toISOString(),
            cardId: answered.id,
          });
        } else if (!action) {
          add(row, {
            kind: "unexplained",
            detail: "Blocked, but nothing recorded is blocking it.",
            since: since.toISOString(),
          });
        } else if (isPerson(row.unblockDescriptor?.owner) && since.getTime() < askCutoff) {
          add(row, {
            kind: "old_human_ask",
            detail: `Waiting on a person for over a day: ${action}`,
            since: since.toISOString(),
            waitingOn: row.unblockDescriptor!.owner,
          });
        }
      }
    }

    // A card that asks a person (not an agent) and has waited over a day.
    for (const card of pending) {
      if (card.addresseeAgentId || card.createdAt.getTime() >= askCutoff) continue;
      add(row, {
        kind: "old_human_ask",
        detail: `${cardName(card)} has waited for a reply for over a day.`,
        since: card.createdAt.toISOString(),
        cardId: card.id,
        waitingOn: card.addresseeUserId ? { userId: card.addresseeUserId } : "board",
      });
    }

    const condition = titleCondition(row.title);
    if (condition) {
      add(row, {
        kind: "condition_in_title",
        detail: `The title waits on "${condition}". Check if that is met.`,
        since: null,
      });
    }
  }

  const kindOrder: BlockCheckKind[] = ["blockers_closed", "card_answered", "unexplained", "condition_in_title", "old_human_ask"];
  const result: BlockCheckProject[] = [];
  for (const [projectId, items] of byProject) {
    items.sort(
      (a, b) =>
        kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) || (a.since ?? "").localeCompare(b.since ?? ""),
    );
    const project = projectId ? input.projectsById.get(projectId) : null;
    result.push({
      projectId,
      projectName: project?.name ?? null,
      leadAgentId: project?.leadAgentId ?? null,
      items,
      fingerprint: fingerprintOf(items),
    });
  }
  result.sort((a, b) => b.items.length - a.items.length || (a.projectName ?? "~").localeCompare(b.projectName ?? "~"));

  return {
    generatedAt: input.now.toISOString(),
    projects: result,
    totalItems: result.reduce((sum, project) => sum + project.items.length, 0),
    truncated: input.truncated ?? false,
  };
}

const taskColumns = {
  id: issues.id,
  identifier: issues.identifier,
  title: issues.title,
  status: issues.status,
  projectId: issues.projectId,
  assigneeAgentId: issues.assigneeAgentId,
  assigneeUserId: issues.assigneeUserId,
  unblockDescriptor: issues.unblockDescriptor,
  blockedTransitionAt: issues.blockedTransitionAt,
  updatedAt: issues.updatedAt,
};

const cardColumns = {
  id: issueThreadInteractions.id,
  issueId: issueThreadInteractions.issueId,
  status: issueThreadInteractions.status,
  title: issueThreadInteractions.title,
  summary: issueThreadInteractions.summary,
  addresseeAgentId: issueThreadInteractions.addresseeAgentId,
  addresseeUserId: issueThreadInteractions.addresseeUserId,
  createdAt: issueThreadInteractions.createdAt,
  resolvedAt: issueThreadInteractions.resolvedAt,
};

export interface BlockCheckFilter {
  projectId?: string;
  /** Only projects this agent leads. */
  leadAgentId?: string;
}

export function blockCheckService(db: Db) {
  return {
    async check(companyId: string, filter: BlockCheckFilter = {}, now: Date = new Date()): Promise<BlockCheckResult> {
      const projectConditions: SQL[] = [eq(projects.companyId, companyId)];
      if (filter.projectId) projectConditions.push(eq(projects.id, filter.projectId));
      if (filter.leadAgentId) projectConditions.push(eq(projects.leadAgentId, filter.leadAgentId));
      const projectRows = await db
        .select({ id: projects.id, name: projects.name, leadAgentId: projects.leadAgentId })
        .from(projects)
        .where(and(...projectConditions));
      const projectsById = new Map(projectRows.map((row) => [row.id, row]));
      const scoped = !!(filter.projectId || filter.leadAgentId);
      if (scoped && projectRows.length === 0) {
        return buildBlockCheck({ tasks: [], blockersById: new Map(), edges: [], cards: [], projectsById, now });
      }

      const openTask = and(
        eq(issues.companyId, companyId),
        isNull(issues.hiddenAt),
        notInArray(issues.status, CLOSED_STATUSES),
        scoped ? inArray(issues.projectId, [...projectsById.keys()]) : undefined,
      );

      const [blocked, titled, oldAsks] = await Promise.all([
        db
          .select(taskColumns)
          .from(issues)
          .where(and(openTask, eq(issues.status, "blocked")))
          .orderBy(issues.updatedAt)
          .limit(BLOCK_CHECK_LIMIT + 1),
        db
          .select(taskColumns)
          .from(issues)
          .where(and(openTask, sql`${issues.title} ~* ${TITLE_CONDITION_SQL}`))
          .orderBy(issues.updatedAt)
          .limit(BLOCK_CHECK_LIMIT + 1),
        db
          .select({ task: taskColumns, card: cardColumns })
          .from(issueThreadInteractions)
          .innerJoin(issues, eq(issues.id, issueThreadInteractions.issueId))
          .where(
            and(
              openTask,
              eq(issueThreadInteractions.companyId, companyId),
              eq(issueThreadInteractions.status, "pending"),
              isNull(issueThreadInteractions.addresseeAgentId),
              lt(issueThreadInteractions.createdAt, new Date(now.getTime() - BLOCK_CHECK_HUMAN_ASK_AGE_MS)),
            ),
          )
          .orderBy(issueThreadInteractions.createdAt)
          .limit(BLOCK_CHECK_LIMIT + 1),
      ]);
      const truncated = [blocked, titled, oldAsks].some((rows) => rows.length > BLOCK_CHECK_LIMIT);
      const tasks = [
        ...blocked.slice(0, BLOCK_CHECK_LIMIT),
        ...titled.slice(0, BLOCK_CHECK_LIMIT),
        ...oldAsks.slice(0, BLOCK_CHECK_LIMIT).map((row) => row.task),
      ] as BlockCheckTaskRow[];
      const cards = new Map<string, BlockCheckCardRow>(
        oldAsks.slice(0, BLOCK_CHECK_LIMIT).map((row) => [row.card.id, row.card]),
      );

      const blockedIds = [...new Set(blocked.slice(0, BLOCK_CHECK_LIMIT).map((row) => row.id))];
      let edges: { blockerId: string; blockedId: string }[] = [];
      const blockersById = new Map<string, BlockCheckBlockerRow>();
      if (blockedIds.length > 0) {
        const [edgeRows, blockedCards] = await Promise.all([
          db
            .select({ blockerId: issueRelations.issueId, blockedId: issueRelations.relatedIssueId })
            .from(issueRelations)
            .where(
              and(
                eq(issueRelations.companyId, companyId),
                eq(issueRelations.type, "blocks"),
                inArray(issueRelations.relatedIssueId, blockedIds),
              ),
            ),
          db
            .select(cardColumns)
            .from(issueThreadInteractions)
            .where(
              and(
                eq(issueThreadInteractions.companyId, companyId),
                inArray(issueThreadInteractions.issueId, blockedIds),
              ),
            ),
        ]);
        edges = edgeRows;
        for (const card of blockedCards) cards.set(card.id, card);
        const blockerIds = [...new Set(edgeRows.map((edge) => edge.blockerId))];
        if (blockerIds.length > 0) {
          const blockerRows = await db
            .select({ id: issues.id, status: issues.status, hiddenAt: issues.hiddenAt })
            .from(issues)
            .where(and(eq(issues.companyId, companyId), inArray(issues.id, blockerIds)));
          for (const row of blockerRows) blockersById.set(row.id, row);
        }
      }

      return buildBlockCheck({ tasks, blockersById, edges, cards: [...cards.values()], projectsById, now, truncated });
    },
  };
}
