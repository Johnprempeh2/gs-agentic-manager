import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { issues, issueThreadInteractions } from "@greatstone/db";
import type { NeedsMe, NeedsMeExpiredCard, NeedsMeOverdueWait } from "@greatstone/shared";
import type { AttentionServiceOptions } from "./attention.js";
import { viewerPrincipalUserIds } from "./board-identity.js";
import { decisionsFeedService } from "./decisions-feed.js";
import { executionIssueCondition } from "./issue-visibility.js";
import { isReleaseTask } from "./release-task.js";
import {
  humanWaitAgeMs,
  humanWaitRecheckCutoff,
  isHumanWaitOwnedBy,
  isOverdueHumanWait,
} from "./recovery/human-wait-deadline.js";

const CLOSED_ISSUE_STATUSES = ["done", "cancelled"];
/** How far back an expired question still shows in Needs you. */
const EXPIRED_CARD_LOOKBACK_MS = 48 * 60 * 60 * 1000;
const EXPIRED_CARD_LIMIT = 20;

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
      // An owner also answers for the legacy `local-board` user (board-identity.ts).
      const viewerUserIds = await viewerPrincipalUserIds(db, companyId, options.userId);
      const [feed, assigned, waits, expired] = await Promise.all([
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
            inArray(issues.assigneeUserId, viewerUserIds),
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
        // Questions agents asked people that expired unanswered on a task
        // that is still open. Agent-to-agent questions are left out.
        db
          .select({
            interactionId: issueThreadInteractions.id,
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            question: issueThreadInteractions.title,
            expiredAt: issueThreadInteractions.updatedAt,
          })
          .from(issueThreadInteractions)
          .innerJoin(issues, eq(issues.id, issueThreadInteractions.issueId))
          .where(and(
            eq(issueThreadInteractions.companyId, companyId),
            eq(issues.companyId, companyId),
            eq(issueThreadInteractions.status, "expired"),
            isNotNull(issueThreadInteractions.createdByAgentId),
            isNull(issueThreadInteractions.addresseeAgentId),
            or(
              isNull(issueThreadInteractions.addresseeUserId),
              inArray(issueThreadInteractions.addresseeUserId, viewerUserIds),
            ),
            gte(issueThreadInteractions.updatedAt, new Date(now.getTime() - EXPIRED_CARD_LOOKBACK_MS)),
            notInArray(issues.status, CLOSED_ISSUE_STATUSES),
            executionIssueCondition(),
            // A task whose agent has asked again shows the new card instead.
            sql`not exists (
              select 1 from ${issueThreadInteractions} as newer
              where newer.issue_id = ${issueThreadInteractions.issueId}
                and newer.status = 'pending'
            )`,
          ))
          .orderBy(desc(issueThreadInteractions.updatedAt))
          .limit(EXPIRED_CARD_LIMIT * 3),
      ]);

      const overdueWaits: NeedsMeOverdueWait[] = waits
        .filter((wait) => !isReleaseTask(wait.title))
        .filter((wait) => viewerUserIds.some((id) => isHumanWaitOwnedBy(wait.unblockDescriptor, id)) && isOverdueHumanWait(wait, now))
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
        // Releases run from Claude, not from here (release-task.ts).
        .filter((task) => !cardTaskIds.has(task.id) && !waitIds.has(task.id) && !isReleaseTask(task.title))
        .map((task) => ({ ...task, updatedAt: task.updatedAt.toISOString() }));
      // A wait that already has a card is that card: listed and counted once.
      const uncountedWaits = overdueWaits.filter((wait) => !cardTaskIds.has(wait.id));
      // One expired question per task, newest first, and none for a task
      // already listed above.
      const listedTaskIds = new Set<string>([
        ...cardTaskIds as Set<string>,
        ...waitIds,
        ...assignedTasks.map((task) => task.id),
      ]);
      const expiredCards: NeedsMeExpiredCard[] = [];
      for (const card of expired) {
        if (expiredCards.length >= EXPIRED_CARD_LIMIT) break;
        if (listedTaskIds.has(card.id) || isReleaseTask(card.title)) continue;
        listedTaskIds.add(card.id);
        expiredCards.push({
          interactionId: card.interactionId,
          id: card.id,
          identifier: card.identifier,
          title: card.title,
          question: card.question,
          expiredAt: card.expiredAt.toISOString(),
        });
      }

      // The one "needs you" number (22 Oct, "one count everywhere"): every
      // decision card, overdue wait and expired question. "At your desk"
      // cards stay out (GRE-450) and are shown apart, labelled as such.
      // Sidebar, phone tab, app icon, Dashboard, Desk, Needed from you,
      // Focus, push and the morning summary all show it.
      const decisionCount = feed.count + uncountedWaits.length + expiredCards.length;
      return {
        companyId,
        generatedAt: feed.generatedAt,
        count: decisionCount + assignedTasks.length,
        decisionCount,
        assignedTaskCount: assignedTasks.length,
        decisions: feed.cards,
        assignedTasks,
        overdueWaits: uncountedWaits,
        expiredCards,
      };
    },
  };
}
