import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { activityLog, agents, companies, heartbeatRuns, issueComments, issueRelations, issues } from "@greatstone/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { getCompanyLeadAgentId } from "./goals.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { issueService } from "./issues.js";

// Tidy desk: an hourly check flags open work that looks finished. It never
// changes a status. The lead agent (Everest) gets one task a day listing the
// flagged work and closes what it can confirm; owners close or clear the rest
// from the Desk.

export const LOOKS_FINISHED_ORIGIN_KIND = "looks_finished_review";
export const LOOKS_FINISHED_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const CANDIDATE_STATUSES = ["blocked", "in_progress", "in_review", "todo"] as const;
const CLOSED = new Set(["done", "cancelled"]);
/**
 * A dependent wakes when its last blocker closes; give that wake time to leave
 * a trace before "nothing has happened since" counts.
 * ponytail: fixed grace, make it per company if one hour proves wrong.
 */
const BLOCKER_CLOSE_GRACE_MS = 60 * 60 * 1000;

type Candidate = {
  id: string;
  identifier: string | null;
  title: string;
  createdAt: Date;
  looksFinishedAt: Date | null;
  looksFinishedDismissedAt: Date | null;
};

function maxDate(...values: Array<Date | string | null | undefined>): Date | null {
  let best: Date | null = null;
  for (const value of values) {
    if (!value) continue;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) continue;
    if (!best || date > best) best = date;
  }
  return best;
}

/**
 * Last work on each task: a comment, a status change, a run, or a document
 * edit. Other writes (assignment, flags, reads) do not count.
 */
export async function lastWorkActivityMap(db: Db, companyId: string, issueIds: string[]) {
  const result = new Map<string, Date>();
  if (issueIds.length === 0) return result;
  const runIssueId = sql<string>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
  const [commentRows, logRows, runRows] = await Promise.all([
    db
      .select({ issueId: issueComments.issueId, at: sql<Date>`max(${issueComments.createdAt})` })
      .from(issueComments)
      .where(and(eq(issueComments.companyId, companyId), inArray(issueComments.issueId, issueIds)))
      .groupBy(issueComments.issueId),
    db
      .select({ issueId: activityLog.entityId, at: sql<Date>`max(${activityLog.createdAt})` })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "issue"),
        inArray(activityLog.entityId, issueIds),
        or(
          sql`(${activityLog.action} = 'issue.updated' and ${activityLog.details} -> '_previous' ? 'status')`,
          sql`${activityLog.action} like 'issue.document_%'`,
        ),
      ))
      .groupBy(activityLog.entityId),
    db
      .select({ issueId: runIssueId, at: sql<Date>`max(${heartbeatRuns.createdAt})` })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), inArray(runIssueId, issueIds)))
      .groupBy(runIssueId),
  ]);
  for (const row of [...commentRows, ...logRows, ...runRows]) {
    if (!row.issueId) continue;
    const at = maxDate(result.get(row.issueId), row.at);
    if (at) result.set(row.issueId, at);
  }
  return result;
}

function label(issue: { identifier: string | null; title: string }) {
  return issue.identifier ?? issue.title;
}

/**
 * Open tasks that look finished, with the reasons, one sentence each:
 * (a) every sub-task is done or cancelled (and there is at least one), or
 * (b) every task blocking it is closed and nothing has happened on it since.
 * A merged pull request in the live release is not a rule yet: which release
 * holds a merge is known only on the host that runs releases, not here.
 */
export async function detectLooksFinished(db: Db, companyId: string, now: Date = new Date()) {
  const candidates: Candidate[] = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      createdAt: issues.createdAt,
      looksFinishedAt: issues.looksFinishedAt,
      looksFinishedDismissedAt: issues.looksFinishedDismissedAt,
    })
    .from(issues)
    .where(and(
      eq(issues.companyId, companyId),
      inArray(issues.status, [...CANDIDATE_STATUSES]),
      isNull(issues.hiddenAt),
      isNull(issues.tabledAt),
    ));
  const reasons = new Map<string, string[]>();
  if (candidates.length === 0) return { candidates, reasons };
  const ids = candidates.map((issue) => issue.id);
  const add = (id: string, reason: string) => reasons.set(id, [...(reasons.get(id) ?? []), reason]);

  const [children, blockers, activity] = await Promise.all([
    db
      .select({ parentId: issues.parentId, status: issues.status })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.parentId, ids), isNull(issues.hiddenAt))),
    db
      .select({
        blockedId: issueRelations.relatedIssueId,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        completedAt: issues.completedAt,
        cancelledAt: issues.cancelledAt,
        updatedAt: issues.updatedAt,
      })
      .from(issueRelations)
      .innerJoin(issues, eq(issueRelations.issueId, issues.id))
      .where(and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.type, "blocks"),
        inArray(issueRelations.relatedIssueId, ids),
        isNull(issues.hiddenAt),
      )),
    lastWorkActivityMap(db, companyId, ids),
  ]);

  const childStatuses = new Map<string, string[]>();
  for (const child of children) {
    if (!child.parentId) continue;
    childStatuses.set(child.parentId, [...(childStatuses.get(child.parentId) ?? []), child.status]);
  }
  for (const [id, statuses] of childStatuses) {
    if (statuses.every((status) => CLOSED.has(status))) {
      add(id, `All ${statuses.length} sub-task${statuses.length === 1 ? " is" : "s are"} done or cancelled.`);
    }
  }

  const blockersById = new Map<string, typeof blockers>();
  for (const row of blockers) blockersById.set(row.blockedId, [...(blockersById.get(row.blockedId) ?? []), row]);
  for (const [id, rows] of blockersById) {
    if (!rows.every((row) => CLOSED.has(row.status))) continue;
    const lastClosedAt = maxDate(...rows.map((row) => row.completedAt ?? row.cancelledAt ?? row.updatedAt));
    if (!lastClosedAt || now.getTime() - lastClosedAt.getTime() < BLOCKER_CLOSE_GRACE_MS) continue;
    const lastWork = activity.get(id);
    if (lastWork && lastWork > lastClosedAt) continue;
    add(id, `Every task blocking it is closed (${rows.map(label).join(", ")}) and nothing has happened on it since.`);
  }

  // "Not finished" holds until new work happens on the task.
  for (const issue of candidates) {
    if (!reasons.has(issue.id) || !issue.looksFinishedDismissedAt) continue;
    const lastWork = activity.get(issue.id);
    if (!lastWork || lastWork <= issue.looksFinishedDismissedAt) reasons.delete(issue.id);
  }
  return { candidates, reasons };
}

/** The lead agent: the CEO role first, otherwise the top of the org chart. */
export async function findLeadAgentId(db: Db, companyId: string) {
  const ceo = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo"), ne(agents.status, "terminated")))
    .orderBy(asc(agents.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return ceo?.id ?? getCompanyLeadAgentId(db, companyId);
}

export function reviewTaskDescription(flagged: Array<{ identifier: string | null; title: string; reasons: string[] }>) {
  return [
    "The hourly check thinks these tasks are finished. It changed nothing.",
    "",
    "For each one, open it and check. If it is finished, close it (status done) with a comment saying why. If it is not, leave it open: its owner can press Not finished on their Desk.",
    "",
    ...flagged.map((issue) => `- ${issue.identifier ?? ""} ${issue.title}: ${issue.reasons.join(" ")}`.replace(/^- {2}/, "- ")),
    "",
    "Close this task when you have been through the list.",
  ].join("\n");
}

export function looksFinishedService(db: Db, deps: { heartbeat?: IssueAssignmentWakeupDeps; now?: () => Date } = {}) {
  const now = () => deps.now?.() ?? new Date();

  /** Flags and clears for one company; returns the open flagged tasks. */
  async function refreshCompany(companyId: string) {
    const at = now();
    const { candidates, reasons } = await detectLooksFinished(db, companyId, at);
    let flagged = 0;
    let cleared = 0;
    for (const issue of candidates) {
      const found = reasons.get(issue.id);
      if (found && !issue.looksFinishedAt) {
        // No updatedAt bump: a flag is not work on the task.
        await db
          .update(issues)
          .set({ looksFinishedAt: at, looksFinishedReasons: found })
          .where(and(eq(issues.id, issue.id), isNull(issues.looksFinishedAt)));
        await logActivity(db, {
          companyId,
          actorType: "system",
          actorId: "looks_finished_check",
          action: "issue.looks_finished_flagged",
          entityType: "issue",
          entityId: issue.id,
          issueId: issue.id,
          details: { reasons: found },
        });
        flagged += 1;
      } else if (found) {
        await db.update(issues).set({ looksFinishedReasons: found }).where(eq(issues.id, issue.id));
      } else if (issue.looksFinishedAt) {
        await db
          .update(issues)
          .set({ looksFinishedAt: null, looksFinishedReasons: null })
          .where(eq(issues.id, issue.id));
        cleared += 1;
      }
    }
    const open = candidates
      .filter((issue) => reasons.has(issue.id))
      .map((issue) => ({ ...issue, reasons: reasons.get(issue.id)! }));
    return { flagged, cleared, open };
  }

  /** One review task a day for the lead agent, while anything is flagged. */
  async function ensureDailyReview(
    companyId: string,
    open: Array<{ identifier: string | null; title: string; reasons: string[] }>,
  ) {
    if (open.length === 0) return null;
    const originId = `${companyId}:${now().toISOString().slice(0, 10)}`;
    const existing = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, LOOKS_FINISHED_ORIGIN_KIND),
        eq(issues.originId, originId),
      ))
      .then((rows) => rows[0] ?? null);
    if (existing) return null;
    const leadAgentId = await findLeadAgentId(db, companyId);
    if (!leadAgentId) return null;
    const created = await issueService(db).create(companyId, {
      title: `Tasks that look finished (${open.length})`,
      description: reviewTaskDescription(open),
      status: "todo",
      priority: "low",
      assigneeAgentId: leadAgentId,
      originKind: LOOKS_FINISHED_ORIGIN_KIND,
      originId,
    });
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "looks_finished_check",
      action: "issue.created",
      entityType: "issue",
      entityId: created.id,
      issueId: created.id,
      agentId: leadAgentId,
      details: { originKind: LOOKS_FINISHED_ORIGIN_KIND, flagged: open.length },
    });
    if (deps.heartbeat) {
      await queueIssueAssignmentWakeup({
        heartbeat: deps.heartbeat,
        issue: created,
        reason: "looks_finished_review",
        mutation: "create",
        contextSource: "looks_finished_check",
        requestedByActorType: "system",
      });
    }
    return created;
  }

  async function sweep() {
    const companyRows = await db.select({ id: companies.id }).from(companies);
    const totals = { flagged: 0, cleared: 0, reviews: 0 };
    for (const { id } of companyRows) {
      try {
        const result = await refreshCompany(id);
        totals.flagged += result.flagged;
        totals.cleared += result.cleared;
        if (await ensureDailyReview(id, result.open)) totals.reviews += 1;
      } catch (err) {
        logger.error({ err, companyId: id }, "looks finished check failed for a company");
      }
    }
    return totals;
  }

  /** "Not finished": clears the flag until new work happens on the task. */
  async function dismiss(issueId: string) {
    const [updated] = await db
      .update(issues)
      .set({ looksFinishedAt: null, looksFinishedReasons: null, looksFinishedDismissedAt: now() })
      .where(eq(issues.id, issueId))
      .returning();
    return updated ?? null;
  }

  return { refreshCompany, ensureDailyReview, sweep, dismiss };
}
