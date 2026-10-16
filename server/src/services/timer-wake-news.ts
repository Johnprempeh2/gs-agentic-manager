import { and, desc, eq, gt, isNull, ne, or } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { heartbeatRuns, issueComments, issues } from "@greatstone/db";

/**
 * A quiet agent still gets one timer run a day, so work that changes outside
 * GS Agentic Manager (a reply in a mailbox, a deploy finishing) is never missed for long.
 */
export const TIMER_WAKE_DAILY_CHECK_IN_MS = 24 * 60 * 60 * 1000;

export type TimerWakeNews =
  | { hasNews: true; reason: "first_run" | "daily_check_in" | "task_changed" | "new_comment"; since: Date | null }
  | { hasNews: false; reason: "nothing_changed"; since: Date };

type TimerWakeAgent = { id: string; companyId: string };

/**
 * Reads whether anything that concerns the agent changed since its last run ended:
 * a task assigned to it or made by it changed, or someone else commented on its tasks.
 * The timer skips the run when nothing did.
 */
export async function readTimerWakeNews(
  db: Pick<Db, "select">,
  agent: TimerWakeAgent,
  now: Date = new Date(),
): Promise<TimerWakeNews> {
  const [lastRun] = await db
    .select({
      createdAt: heartbeatRuns.createdAt,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
    })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id)))
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(1);
  if (!lastRun) return { hasNews: true, reason: "first_run", since: null };

  // Changes the run made itself land before it finishes, so count from the end of the run.
  const since = lastRun.finishedAt ?? lastRun.startedAt ?? lastRun.createdAt;
  if (now.getTime() - since.getTime() >= TIMER_WAKE_DAILY_CHECK_IN_MS) {
    return { hasNews: true, reason: "daily_check_in", since };
  }

  const [changedTask] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, agent.companyId),
        isNull(issues.hiddenAt),
        or(eq(issues.assigneeAgentId, agent.id), eq(issues.createdByAgentId, agent.id)),
        gt(issues.updatedAt, since),
      ),
    )
    .limit(1);
  if (changedTask) return { hasNews: true, reason: "task_changed", since };

  const [newComment] = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .innerJoin(issues, eq(issues.id, issueComments.issueId))
    .where(
      and(
        eq(issueComments.companyId, agent.companyId),
        eq(issues.assigneeAgentId, agent.id),
        gt(issueComments.createdAt, since),
        or(isNull(issueComments.authorAgentId), ne(issueComments.authorAgentId, agent.id)),
      ),
    )
    .limit(1);
  if (newComment) return { hasNews: true, reason: "new_comment", since };

  return { hasNews: false, reason: "nothing_changed", since };
}
