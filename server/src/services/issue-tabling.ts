import { and, asc, desc, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { heartbeatRuns, issues } from "@greatstone/db";
import { ISSUE_STATUSES, type IssueStatus } from "@greatstone/shared";
import { notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";

// "Not now" (GRE-262). Tabling parks a whole task: it moves to backlog,
// remembers the status it came from, gets no agent wakes, and leaves the
// Decisions feed. It comes back to that status on its return date or at once
// when a board user brings it back.

type IssueRow = typeof issues.$inferSelect;

export type BringBackReason = "manual" | "return_date";

export type TableIssueResult = {
  issue: IssueRow;
  /** Queued or running runs on the task; the caller cancels them. */
  activeRunIds: string[];
  wasAlreadyTabled: boolean;
};

export type BringBackResult = {
  issue: IssueRow;
  restoredStatus: IssueStatus;
  tabledAt: Date;
  tabledUntil: Date | null;
};

const TABLED_STATUS: IssueStatus = "backlog";
const UNTABLEABLE_STATUSES = new Set<string>(["done", "cancelled"]);
const MAX_RETURN_HORIZON_MS = 5 * 366 * 24 * 60 * 60 * 1_000;

function restorableStatus(value: string | null): IssueStatus {
  if (value && (ISSUE_STATUSES as readonly string[]).includes(value) && !UNTABLEABLE_STATUSES.has(value)) {
    return value as IssueStatus;
  }
  return "todo";
}

export function isIssueTabled(issue: { tabledAt?: Date | null } | null | undefined) {
  return Boolean(issue?.tabledAt);
}

/** True when the issue is tabled. Wake paths call this before creating work. */
export async function isIssueTabledById(db: Db, issueId: string) {
  const row = await db
    .select({ tabledAt: issues.tabledAt })
    .from(issues)
    .where(eq(issues.id, issueId))
    .then((rows) => rows[0] ?? null);
  return isIssueTabled(row);
}

/** Ids of the company's tabled tasks. */
export async function tabledIssueIdSet(db: Db, companyId: string) {
  const rows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), isNotNull(issues.tabledAt)));
  return new Set(rows.map((row) => row.id));
}

export function issueTablingService(db: Db, options: { now?: () => Date } = {}) {
  const now = () => options.now?.() ?? new Date();

  async function activeRunIdsForIssue(issue: IssueRow) {
    const issueIdFromContext = sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
    const rows = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, issue.companyId),
        inArray(heartbeatRuns.status, ["queued", "running"]),
        issue.executionRunId
          ? or(eq(heartbeatRuns.id, issue.executionRunId), eq(issueIdFromContext, issue.id))
          : eq(issueIdFromContext, issue.id),
      ));
    return [...new Set(rows.map((row) => row.id))];
  }

  async function table(
    issueId: string,
    input: { until: Date | null; userId: string },
  ): Promise<TableIssueResult> {
    const at = now();
    if (input.until) {
      if (input.until.getTime() <= at.getTime()) throw unprocessable("returnAt must be in the future");
      if (input.until.getTime() > at.getTime() + MAX_RETURN_HORIZON_MS) {
        throw unprocessable("returnAt must be within five years");
      }
    }
    const result = await db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(issues)
        .where(eq(issues.id, issueId))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Issue not found");
      if (UNTABLEABLE_STATUSES.has(existing.status)) {
        throw unprocessable(`A ${existing.status} task cannot be tabled`);
      }
      const wasAlreadyTabled = Boolean(existing.tabledAt);
      const [updated] = await tx
        .update(issues)
        .set(wasAlreadyTabled
          // Tabling again only moves the return date; the status to restore
          // is still the one from before the first "Not now".
          ? { tabledUntil: input.until, tabledByUserId: input.userId, updatedAt: at }
          : {
            status: TABLED_STATUS,
            tabledAt: at,
            tabledUntil: input.until,
            tabledByUserId: input.userId,
            tabledFromStatus: existing.status,
            // Parked work holds no execution lock; bring-back starts clean.
            checkoutRunId: null,
            executionLockedAt: null,
            updatedAt: at,
          })
        .where(eq(issues.id, issueId))
        .returning();
      return { issue: updated!, wasAlreadyTabled, previous: existing };
    });
    const activeRunIds = await activeRunIdsForIssue(result.previous);
    return { issue: result.issue, activeRunIds, wasAlreadyTabled: result.wasAlreadyTabled };
  }

  /**
   * Returns the task to the status it had before it was tabled. The update is
   * guarded on tabled_at, so a manual bring-back racing the return-date sweep
   * restores it exactly once; the loser gets null.
   */
  async function bringBack(issueId: string): Promise<BringBackResult | null> {
    const at = now();
    return db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(issues)
        .where(eq(issues.id, issueId))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Issue not found");
      if (!existing.tabledAt) return null;
      const restoredStatus = restorableStatus(existing.tabledFromStatus);
      const [updated] = await tx
        .update(issues)
        .set({
          status: restoredStatus,
          tabledAt: null,
          tabledUntil: null,
          tabledByUserId: null,
          tabledFromStatus: null,
          updatedAt: at,
        })
        .where(and(eq(issues.id, issueId), isNotNull(issues.tabledAt)))
        .returning();
      if (!updated) return null;
      return {
        issue: updated,
        restoredStatus,
        tabledAt: existing.tabledAt,
        tabledUntil: existing.tabledUntil,
      };
    });
  }

  async function listTabled(companyId: string) {
    return db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), isNotNull(issues.tabledAt)))
      .orderBy(asc(sql`${issues.tabledUntil} is null`), asc(issues.tabledUntil), desc(issues.tabledAt));
  }

  /** Ids of tabled tasks whose return date has passed (all companies). */
  async function listDueForReturn(limit = 100) {
    const rows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(isNotNull(issues.tabledAt), isNotNull(issues.tabledUntil), lte(issues.tabledUntil, now())))
      .orderBy(asc(issues.tabledUntil))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  return { table, bringBack, listTabled, listDueForReturn };
}

/** Statuses where the assignee needs a fresh wake to pick the work back up. */
const WAKE_ON_RETURN_STATUSES = new Set<IssueStatus>(["todo", "in_progress"]);

/**
 * Brings a tabled task back, logs it, and wakes its assignee once. Shared by
 * the "bring back" route and the return-date sweep so both paths behave the
 * same. Returns null when the task was not tabled (already back).
 */
export async function bringBackTabledIssue(
  db: Db,
  deps: { heartbeat: IssueAssignmentWakeupDeps; now?: () => Date },
  issueId: string,
  input: {
    reason: BringBackReason;
    actorType: "user" | "system";
    actorId: string;
    agentId?: string | null;
    runId?: string | null;
    agentApiKeyId?: string | null;
  },
) {
  const result = await issueTablingService(db, { now: deps.now }).bringBack(issueId);
  if (!result) return null;
  const { issue } = result;
  await logActivity(db, {
    companyId: issue.companyId,
    actorType: input.actorType,
    actorId: input.actorId,
    agentId: input.agentId ?? null,
    runId: input.runId ?? null,
    agentApiKeyId: input.agentApiKeyId ?? null,
    action: "issue.untabled",
    entityType: "issue",
    entityId: issue.id,
    issueId: issue.id,
    details: {
      reason: input.reason,
      restoredStatus: result.restoredStatus,
      tabledAt: result.tabledAt.toISOString(),
      tabledUntil: result.tabledUntil?.toISOString() ?? null,
    },
  });
  if (WAKE_ON_RETURN_STATUSES.has(result.restoredStatus)) {
    await queueIssueAssignmentWakeup({
      heartbeat: deps.heartbeat,
      issue,
      reason: "issue_untabled",
      mutation: "untable",
      contextSource: "issue.untabled",
      requestedByActorType: input.actorType,
      requestedByActorId: input.actorId,
    });
  }
  return result;
}

/**
 * Scheduler job: brings back every tabled task whose return date has passed.
 * Safe to run twice or in parallel; bringBack is guarded on tabled_at.
 */
export async function returnDueTabledIssues(
  db: Db,
  deps: { heartbeat: IssueAssignmentWakeupDeps; now?: () => Date },
) {
  const dueIds = await issueTablingService(db, { now: deps.now }).listDueForReturn();
  let returned = 0;
  for (const issueId of dueIds) {
    try {
      const result = await bringBackTabledIssue(db, deps, issueId, {
        reason: "return_date",
        actorType: "system",
        actorId: "system",
      });
      if (result) returned += 1;
    } catch (err) {
      logger.error({ err, issueId }, "failed to bring back tabled issue on its return date");
    }
  }
  return { due: dueIds.length, returned };
}
