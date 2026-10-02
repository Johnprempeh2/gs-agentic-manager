import { and, desc, eq, notInArray } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { issues } from "@greatstone/db";
import type { NeedsMe } from "@greatstone/shared";
import type { AttentionServiceOptions } from "./attention.js";
import { decisionsFeedService } from "./decisions-feed.js";
import { executionIssueCondition } from "./issue-visibility.js";

const CLOSED_ISSUE_STATUSES = ["done", "cancelled"];

/**
 * One "needs me" list for the board user (GRE-355): the Decisions feed plus
 * open tasks assigned to the user. Created-by or commented-on alone does not
 * count; that is what made Inbox "Mine" disagree with Decisions.
 */
export function needsMeService(db: Db, serviceOptions: AttentionServiceOptions = {}) {
  const feeds = decisionsFeedService(db, serviceOptions);

  return {
    build: async (companyId: string, options: { userId: string }): Promise<NeedsMe> => {
      const [feed, assigned] = await Promise.all([
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
      ]);

      // A task with a decision card is counted once, as the card.
      const cardTaskIds = new Set(feed.cards.map((card) => card.task?.id).filter(Boolean));
      const assignedTasks = assigned
        .filter((task) => !cardTaskIds.has(task.id))
        .map((task) => ({ ...task, updatedAt: task.updatedAt.toISOString() }));

      return {
        companyId,
        generatedAt: feed.generatedAt,
        count: feed.count + assignedTasks.length,
        decisionCount: feed.count,
        assignedTaskCount: assignedTasks.length,
        decisions: feed.cards,
        assignedTasks,
      };
    },
  };
}
