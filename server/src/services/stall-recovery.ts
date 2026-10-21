import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { activityLog, companies, issues } from "@greatstone/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { attentionService } from "./attention.js";
import { STALL_ROUTED_ACTION } from "./decisions-feed.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { issueService } from "./issues.js";
import { findLeadAgentId } from "./looks-finished.js";
import { isReleaseTask } from "./release-task.js";

// Decisions: a stall on the agent side (a blocker with no live next step,
// owned by an agent or by nobody, and no ask of a person) goes to the lead
// agent first, as one recovery task. A person sees it only if the lead asks
// them, or if it is still stuck STALL_ESCALATION_MS after it was routed here.

export const STALL_RECOVERY_ORIGIN_KIND = "decision_stall_recovery";
const CLOSED = ["done", "cancelled"];

type Stall = { id: string; identifier: string | null; title: string; holdsUp: number };

export function stallRecoveryDescription(stalls: Stall[]) {
  return [
    "These tasks are stuck with no live next step, and other work waits on them. Nothing on them asks a person yet, so they come to you first.",
    "",
    "For each one, get it moving: reassign it, give its owner an instruction, or cancel it if it is no longer needed.",
    "If only a person can move it, ask them on that task with a question (`ask_user_questions` or `request_confirmation`, with a `recommendation`), not only in a comment. A question reaches their Decisions as a card they can answer.",
    "Then leave a one-line comment on the task saying what you did or what is needed. If the task is still stuck after 24 hours, the person sees that comment as your summary.",
    "",
    ...stalls.map((stall) => `- ${`${stall.identifier ?? ""} ${stall.title}`.trim()} (holds up ${stall.holdsUp} ${stall.holdsUp === 1 ? "task" : "tasks"})`),
    "",
    "Close this task when every listed task is moving or has gone to a person.",
  ].join("\n");
}

export function stallRecoveryService(db: Db, deps: { heartbeat?: IssueAssignmentWakeupDeps } = {}) {
  /** The same stalls the Decisions gate holds back: stalled blockers with no person on them. */
  async function stallsOf(companyId: string): Promise<Stall[]> {
    const feed = await attentionService(db).list(companyId, { all: true, allowUnscopedAll: true });
    const holdsUp = new Map<string, number>();
    for (const item of feed.items) {
      if (item.sourceKind !== "blocker_attention" || !item.dedupKey.startsWith("blocker:")) continue;
      const count = (item.detail as { blockedTaskCount?: unknown } | null)?.blockedTaskCount;
      holdsUp.set(item.subject.id, typeof count === "number" ? count : 0);
    }
    if (holdsUp.size === 0) return [];
    const rows = await db
      .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.id, [...holdsUp.keys()]), isNull(issues.assigneeUserId)));
    return rows
      .filter((row) => !isReleaseTask(row.title))
      .map((row) => ({ ...row, holdsUp: holdsUp.get(row.id) ?? 0 }))
      .sort((left, right) => (left.identifier ?? left.id).localeCompare(right.identifier ?? right.id));
  }

  /** Hands new stalls to the lead: one open recovery task, a wake per batch. */
  async function routeCompany(companyId: string) {
    const stalls = await stallsOf(companyId);
    if (stalls.length === 0) return { routed: 0 };
    const [open] = await db
      .select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, STALL_RECOVERY_ORIGIN_KIND),
        notInArray(issues.status, CLOSED),
      ))
      .limit(1);
    // A stall already handed to the open recovery task is not handed again.
    const routedRows = open
      ? await db
        .select({ issueId: activityLog.entityId })
        .from(activityLog)
        .where(and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, STALL_ROUTED_ACTION),
          inArray(activityLog.entityId, stalls.map((stall) => stall.id)),
          sql`${activityLog.details} ->> 'recoveryIssueId' = ${open.id}`,
        ))
      : [];
    const routed = new Set(routedRows.map((row) => row.issueId));
    const fresh = stalls.filter((stall) => !routed.has(stall.id));
    if (fresh.length === 0) return { routed: 0 };
    const leadAgentId = await findLeadAgentId(db, companyId);
    if (!leadAgentId) return { routed: 0 };

    const svc = issueService(db);
    let recovery: { id: string; assigneeAgentId: string | null; status: string };
    if (open) {
      await svc.addComment(open.id, `More stuck work for you:\n\n${stallRecoveryDescription(fresh).split("\n").filter((line) => line.startsWith("- ")).join("\n")}`, {}, { authorType: "system" });
      recovery = open;
    } else {
      const created = await svc.create(companyId, {
        title: `Stuck work to recover (${fresh.length})`,
        description: stallRecoveryDescription(fresh),
        status: "todo",
        priority: "high",
        assigneeAgentId: leadAgentId,
        originKind: STALL_RECOVERY_ORIGIN_KIND,
        originId: companyId,
      });
      recovery = created;
    }
    for (const stall of fresh) {
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "decisions_stall_router",
        action: STALL_ROUTED_ACTION,
        entityType: "issue",
        entityId: stall.id,
        issueId: stall.id,
        agentId: leadAgentId,
        details: { recoveryIssueId: recovery.id, identifier: stall.identifier },
      });
    }
    if (deps.heartbeat) {
      await queueIssueAssignmentWakeup({
        heartbeat: deps.heartbeat,
        issue: recovery,
        reason: "decision_stall_recovery",
        mutation: open ? "comment" : "create",
        contextSource: "decisions_stall_router",
        requestedByActorType: "system",
      });
    }
    return { routed: fresh.length };
  }

  async function sweep() {
    const companyRows = await db.select({ id: companies.id }).from(companies);
    let routed = 0;
    for (const { id } of companyRows) {
      try {
        routed += (await routeCompany(id)).routed;
      } catch (err) {
        logger.error({ err, companyId: id }, "stall recovery routing failed for a company");
      }
    }
    return { routed };
  }

  return { stallsOf, routeCompany, sweep };
}
