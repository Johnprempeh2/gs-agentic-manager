import { and, desc, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { issueComments, issueRelations, issues } from "@greatstone/db";
import { unprocessable } from "../errors.js";
import type { issueService } from "./issues.js";

// A cancelled blocker never counts as resolved, so every open task it blocks
// stays `blocked` for ever unless the blocker link is moved or removed when the
// blocker closes. This module does that move inside the closing transaction.

type IssueService = ReturnType<typeof issueService>;
type Tx = Parameters<IssueService["update"]>[2];

const CLOSED_STATUSES = ["done", "cancelled"];

export type BlockerHandoff =
  | { kind: "move"; toIssueId: string; reason: "duplicate" | "moved" }
  | { kind: "remove" };

export type OpenBlockedDependent = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
};

export type HandedOffDependent = OpenBlockedDependent & { returnedToTodo: boolean };

export type BlockerHandoffResult = {
  target: { id: string; identifier: string | null } | null;
  dependents: HandedOffDependent[];
};

export async function listOpenBlockedDependents(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  blockerIssueId: string,
): Promise<OpenBlockedDependent[]> {
  return dbOrTx
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
    })
    .from(issueRelations)
    .innerJoin(issues, eq(issueRelations.relatedIssueId, issues.id))
    .where(
      and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.type, "blocks"),
        eq(issueRelations.issueId, blockerIssueId),
        notInArray(issues.status, CLOSED_STATUSES),
      ),
    )
    .orderBy(issues.id);
}

const DUPLICATE_OF_PATTERN = /(?:^|[^\w-])(not\s+(?:a\s+)?)?duplicate\s+of\s+\[?([A-Z][A-Z0-9]*-\d+)\b/i;

/** Reads "Duplicate of ABC-12" from a closing comment. Returns the kept task id. */
export async function resolveDuplicateOfFromComment(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  closingIssueId: string,
  body: string | null | undefined,
): Promise<string | null> {
  if (!body) return null;
  const match = DUPLICATE_OF_PATTERN.exec(body);
  if (!match || match[1]) return null;
  const identifier = match[2]!.toUpperCase();
  const row = await dbOrTx
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.identifier, identifier)))
    .then((rows) => rows[0] ?? null);
  if (!row || row.id === closingIssueId) return null;
  return row.id;
}

async function blocksTransitively(
  tx: Pick<Db, "select">,
  companyId: string,
  fromIssueId: string,
  toIssueId: string,
) {
  const rows = await tx
    .select({ from: issueRelations.issueId, to: issueRelations.relatedIssueId })
    .from(issueRelations)
    .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks")));
  const adjacency = new Map<string, string[]>();
  for (const row of rows) {
    adjacency.set(row.from, [...(adjacency.get(row.from) ?? []), row.to]);
  }
  const queue = [fromIssueId];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === toIssueId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    queue.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

function label(issue: { identifier: string | null; id: string }) {
  return issue.identifier ?? issue.id;
}

function handoffCommentBody(input: {
  closed: { id: string; identifier: string | null };
  target: { id: string; identifier: string | null } | null;
  handoff: BlockerHandoff;
  dependentIsTarget: boolean;
  returnedToTodo: boolean;
}) {
  const closed = label(input.closed);
  let body: string;
  if (input.handoff.kind === "remove") {
    body = `${closed} was closed without a replacement, so it was removed from this task's blockers.`;
  } else if (input.dependentIsTarget) {
    body = `${closed} was closed as a duplicate of this task, so it no longer blocks it.`;
  } else if (input.handoff.reason === "duplicate") {
    body = `${closed} was closed as a duplicate of ${label(input.target!)}. This task now waits on ${label(input.target!)} instead.`;
  } else {
    body = `${closed} was closed. This task now waits on ${label(input.target!)} instead.`;
  }
  if (input.returnedToTodo) body += " No open blockers are left, so it is back in todo.";
  return body;
}

/**
 * Returns `blocked` dependents to `todo` when every blocker is done and no other
 * reason (an unblock owner) keeps them blocked. Locks the rows first, so two
 * callers racing on the same dependent move it once. Returns the moved ids with
 * the time each one entered `blocked` (the dependency wake key needs it).
 */
async function returnReadyDependentsToTodo(
  svc: IssueService,
  tx: Tx,
  companyId: string,
  dependentIds: string[],
  actor: { agentId?: string | null; userId?: string | null },
) {
  const returned = new Map<string, { blockedTransitionAt: Date | null }>();
  if (dependentIds.length === 0) return returned;
  const rows = await (tx as Db)
    .select({
      id: issues.id,
      status: issues.status,
      unblockDescriptor: issues.unblockDescriptor,
      conversationAgentId: issues.conversationAgentId,
      blockedTransitionAt: issues.blockedTransitionAt,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, [...dependentIds].sort())))
    .orderBy(issues.id)
    .for("update");
  const candidates = rows.filter(
    (row) => row.status === "blocked" && !row.unblockDescriptor && !row.conversationAgentId,
  );
  if (candidates.length === 0) return returned;
  const readiness = await svc.listDependencyReadiness(
    companyId,
    candidates.map((row) => row.id),
    tx,
  );
  for (const candidate of candidates) {
    const state = readiness.get(candidate.id);
    if (state && !state.isDependencyReady) continue;
    await svc.update(
      candidate.id,
      {
        status: "todo",
        actorAgentId: actor.agentId ?? null,
        actorUserId: actor.userId ?? null,
      },
      tx,
    );
    returned.set(candidate.id, { blockedTransitionAt: candidate.blockedTransitionAt });
  }
  return returned;
}

/**
 * Moves or removes the blocker links from a closing task to its open dependents.
 * Run it in the same transaction as the close so no dependent is left waiting on
 * a task that will never finish. Running it twice is a no-op the second time.
 */
export async function handOffBlockedDependents(
  svc: IssueService,
  tx: Tx,
  input: {
    companyId: string;
    closed: { id: string; identifier: string | null };
    handoff: BlockerHandoff;
    actor: { agentId?: string | null; userId?: string | null; runId?: string | null };
  },
): Promise<BlockerHandoffResult> {
  const db = tx as Db;
  const { companyId, closed, handoff } = input;
  let target: { id: string; identifier: string | null } | null = null;
  if (handoff.kind === "move") {
    if (handoff.toIssueId === closed.id) {
      throw unprocessable("A task cannot be a duplicate of itself");
    }
    const row = await db
      .select({ id: issues.id, identifier: issues.identifier, status: issues.status })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, handoff.toIssueId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw unprocessable("The kept task must belong to the same company");
    if (row.status === "cancelled") {
      throw unprocessable(
        `${label(row)} is cancelled, so it cannot take over as a blocker. Pick an open task or remove the blocker.`,
      );
    }
    target = { id: row.id, identifier: row.identifier };
  }

  const dependents = await svc.listOpenBlockedDependents(companyId, closed.id, tx);
  if (dependents.length === 0) return { target, dependents: [] };

  // Lock the dependents (and the target) in id order, like blocker sync does.
  const lockIds = [...new Set([...dependents.map((d) => d.id), ...(target ? [target.id] : [])])].sort();
  await db.execute(
    sql`SELECT ${issues.id} FROM ${issues}
        WHERE ${and(eq(issues.companyId, companyId), inArray(issues.id, lockIds))}
        ORDER BY ${issues.id}
        FOR UPDATE`,
  );

  for (const dependent of dependents) {
    await db
      .delete(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "blocks"),
          eq(issueRelations.issueId, closed.id),
          eq(issueRelations.relatedIssueId, dependent.id),
        ),
      );
    if (!target || dependent.id === target.id) continue;
    if (await blocksTransitively(db, companyId, dependent.id, target.id)) {
      throw unprocessable(
        `Moving ${label(dependent)} to wait on ${label(target)} would make a blocker loop, because ${label(dependent)} already blocks ${label(target)}. Remove the blocker instead.`,
      );
    }
    await db
      .insert(issueRelations)
      .values({
        companyId,
        issueId: target.id,
        relatedIssueId: dependent.id,
        type: "blocks",
        createdByAgentId: input.actor.agentId ?? null,
        createdByUserId: input.actor.userId ?? null,
      })
      .onConflictDoNothing();
  }

  const returned = await returnReadyDependentsToTodo(
    svc,
    tx,
    companyId,
    dependents.map((d) => d.id),
    input.actor,
  );

  const result: HandedOffDependent[] = [];
  for (const dependent of dependents) {
    const returnedToTodo = returned.has(dependent.id);
    await svc.addComment(
      dependent.id,
      handoffCommentBody({
        closed,
        target,
        handoff,
        dependentIsTarget: dependent.id === target?.id,
        returnedToTodo,
      }),
      {},
      { authorType: "system" },
      tx,
    );
    result.push({ ...dependent, returnedToTodo });
  }
  return { target, dependents: result };
}

export type ReleasedDependent = {
  /** The note on the dependent that quotes the blocker's closing comment. */
  commentId: string;
  /** When the dependent entered `blocked`; the dependency wake key uses it. */
  blockedTransitionAt: Date | null;
};

const CLOSING_COMMENT_QUOTE_CHARS = 2000;

function quote(body: string) {
  const trimmed = body.trim();
  const clipped =
    trimmed.length > CLOSING_COMMENT_QUOTE_CHARS
      ? `${trimmed.slice(0, CLOSING_COMMENT_QUOTE_CHARS).trimEnd()} …`
      : trimmed;
  return clipped
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** The newest done blocker of a dependent: the one whose close freed it. */
async function latestDoneBlocker(db: Db, companyId: string, dependentId: string) {
  return db
    .select({ id: issues.id, identifier: issues.identifier })
    .from(issueRelations)
    .innerJoin(issues, eq(issueRelations.issueId, issues.id))
    .where(
      and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.type, "blocks"),
        eq(issueRelations.relatedIssueId, dependentId),
        eq(issues.status, "done"),
      ),
    )
    .orderBy(desc(issues.completedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

/** The last thing a person or agent said on the blocker, usually the close. */
async function closingComment(db: Db, blockerIssueId: string) {
  return db
    .select({ body: issueComments.body, sourceTrust: issueComments.sourceTrust })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.issueId, blockerIssueId),
        isNull(issueComments.deletedAt),
        or(isNull(issueComments.authorType), ne(issueComments.authorType, "system")),
      ),
    )
    .orderBy(desc(issueComments.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

/**
 * When a blocker is done, every `blocked` task that no longer waits on anything
 * goes back to `todo` with a note that quotes the blocker's closing comment.
 * The caller wakes agent assignees once with that note (GRE-1896). A task whose
 * unblock note names another reason stays blocked.
 *
 * Pass `blocker` when one task just closed, or `dependentIds` alone (the
 * dependency backstop) to quote each dependent's newest done blocker. Running it
 * twice moves nothing the second time.
 */
export async function releaseReadyDependents(
  svc: IssueService,
  db: Db,
  input: {
    companyId: string;
    blocker?: { id: string; identifier: string | null };
    dependentIds?: string[];
    actor: { agentId?: string | null; userId?: string | null };
  },
): Promise<Map<string, ReleasedDependent>> {
  // Most closes free nothing; only open a transaction when a task is blocked.
  const dependentIds =
    input.dependentIds ??
    (input.blocker
      ? (await svc.listOpenBlockedDependents(input.companyId, input.blocker.id, db))
          .filter((d) => d.status === "blocked")
          .map((d) => d.id)
      : []);
  if (dependentIds.length === 0) return new Map();
  const run = async (tx: Tx) => {
    const returned = await returnReadyDependentsToTodo(svc, tx, input.companyId, dependentIds, input.actor);
    const released = new Map<string, ReleasedDependent>();
    for (const [id, { blockedTransitionAt }] of returned) {
      const blocker = input.blocker ?? (await latestDoneBlocker(tx as Db, input.companyId, id));
      const closing = blocker ? await closingComment(tx as Db, blocker.id) : null;
      const opening = blocker
        ? `${label(blocker)} is done and no open blockers are left, so this task is back in todo.`
        : "Every blocker is done, so this task is back in todo.";
      const body = closing?.body.trim()
        ? `${opening}\n\n${label(blocker!)}'s closing comment:\n\n${quote(closing.body)}`
        : opening;
      // The quote keeps the trust of the words it repeats.
      const comment = await svc.addComment(
        id,
        body,
        {},
        { authorType: "system", ...(closing?.sourceTrust ? { sourceTrust: closing.sourceTrust } : {}) },
        tx,
      );
      released.set(id, { commentId: comment.id, blockedTransitionAt });
    }
    return released;
  };
  // On a caller's transaction this nests as a savepoint.
  return db.transaction((tx) => run(tx as unknown as Tx));
}
