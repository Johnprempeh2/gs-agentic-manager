import { and, asc, desc, eq, lte, notInArray, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { issues } from "@greatstone/db";
import type { NeedsMe, NeedsMeOverdueWait } from "@greatstone/shared";
import type { AttentionServiceOptions } from "./attention.js";
import { decisionsFeedService } from "./decisions-feed.js";
import { executionIssueCondition } from "./issue-visibility.js";
import {
  humanWaitAgeMs,
  humanWaitRecheckCutoff,
  isHumanWaitOwnedBy,
  isOverdueHumanWait,
} from "./recovery/human-wait-deadline.js";

const CLOSED_ISSUE_STATUSES = ["done", "cancelled"];

/**
 * One "needs me" list for the board user (GRE-355): the Decisions feed plus
 * open tasks assigned to the user. Created-by or commented-on alone does not
 * count; that is what made Inbox "Mine" disagree with Decisions. Waits on the
 * user or the board older than 24h are listed here too, with their age
 * (GRE-500).
 */
export function needsMeService(db: Db, serviceOptions: AttentionServiceOptions = {}) {
  const feeds = decisionsFeedService(db, serviceOptions);

  return {
    build: async (companyId: string, options: { userId: string; now?: Date }): Promise<NeedsMe> => {
      const now = options.now ?? new Date();
      const [feed, assigned, waits] = await Promise.all([
        feeds.build(companyId, options),
        db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
            priority: issues.priority,
            updatedAt: issues.updatedAt,
          })
          .from(issues)
          .where(and(
            eq(issues.companyId, companyId),
            eq(issues.assigneeUserId, options.userId),
            notInArray(issues.status, CLOSED_ISSUE_STATUSES),
            executionIssueCondition(),
          ))
          .orderBy(desc(issues.updatedAt)),
        db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
            priority: issues.priority,
            updatedAt: issues.updatedAt,
            assigneeAgentId: issues.assigneeAgentId,
            unblockDescriptor: issues.unblockDescriptor,
            blockedTransitionAt: issues.blockedTransitionAt,
            blockedOwnerNotifiedAt: issues.blockedOwnerNotifiedAt,
          })
          .from(issues)
          .where(and(
            eq(issues.companyId, companyId),
            eq(issues.status, "blocked"),
            sql`${issues.unblockDescriptor} is not null`,
            lte(issues.blockedTransitionAt, humanWaitRecheckCutoff(now)),
            executionIssueCondition(),
          ))
          .orderBy(asc(issues.blockedTransitionAt)),
      ]);

      const overdueWaits: NeedsMeOverdueWait[] = waits
        .filter((wait) => isHumanWaitOwnedBy(wait.unblockDescriptor, options.userId) && isOverdueHumanWait(wait, now))
        .map((wait) => ({
          id: wait.id,
          identifier: wait.identifier,
          title: wait.title,
          status: wait.status,
          priority: wait.priority,
          updatedAt: wait.updatedAt.toISOString(),
          assigneeAgentId: wait.assigneeAgentId,
          owner: wait.unblockDescriptor?.owner === "board" ? "board" : "user",
          action: wait.unblockDescriptor?.action ?? "",
          waitingSinceAt: wait.blockedTransitionAt!.toISOString(),
          waitingForMs: humanWaitAgeMs(wait, now) ?? 0,
          recheckWokenAt: wait.blockedOwnerNotifiedAt?.toISOString() ?? null,
        }));

      // A task with a decision card is counted once, as the card. An overdue
      // wait is listed once, as the wait.
      const cardTaskIds = new Set(feed.cards.map((card) => card.task?.id).filter(Boolean));
      const waitIds = new Set(overdueWaits.map((wait) => wait.id));
      const assignedTasks = assigned
        .filter((task) => !cardTaskIds.has(task.id) && !waitIds.has(task.id))
        .map((task) => ({ ...task, updatedAt: task.updatedAt.toISOString() }));
      const uncountedWaits = overdueWaits.filter((wait) => !cardTaskIds.has(wait.id));

      return {
        companyId,
        generatedAt: feed.generatedAt,
        count: feed.count + assignedTasks.length + uncountedWaits.length,
        decisionCount: feed.count,
        assignedTaskCount: assignedTasks.length,
        decisions: feed.cards,
        assignedTasks,
        overdueWaits,
      };
    },
  };
}
