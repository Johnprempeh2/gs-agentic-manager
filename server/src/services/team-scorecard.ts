import { and, desc, eq, gte, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { agents, issues } from "@greatstone/db";
import type { TeamScorecard, TeamScorecardAgent, TeamScorecardTask } from "@greatstone/shared";
import { HOUSEKEEPING_ISSUE_ORIGIN_KINDS } from "./agent-work-digest.js";

/** 7 and 30 are the periods people pick; 14 and 60 let the page compare with the period before. */
export const TEAM_SCORECARD_DAY_OPTIONS = [7, 14, 30, 60] as const;
const RECENT_LIMIT = 5;
const STUCK_LIMIT = 3;

/** Work the user asked for: not hidden, and not a task the platform opened for itself. */
function userWork() {
  return and(
    isNull(issues.hiddenAt),
    or(isNull(issues.originKind), notInArray(issues.originKind, [...HOUSEKEEPING_ISSUE_ORIGIN_KINDS])),
  );
}

function task(row: { id: string; identifier: string | null; title: string }): TeamScorecardTask {
  return { id: row.id, identifier: row.identifier, title: row.title };
}

export function teamScorecardService(db: Db) {
  return {
    async build(companyId: string, opts: { days: number; now?: Date }): Promise<TeamScorecard> {
      const now = opts.now ?? new Date();
      const since = new Date(now.getTime() - opts.days * 24 * 60 * 60 * 1000);
      const today = now.toISOString().slice(0, 10);

      const [agentRows, finishedRows, openRows] = await Promise.all([
        db
          .select({ id: agents.id, name: agents.name, title: agents.title, status: agents.status })
          .from(agents)
          .where(eq(agents.companyId, companyId)),
        db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            agentId: issues.assigneeAgentId,
            completedAt: issues.completedAt,
          })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              eq(issues.status, "done"),
              isNotNull(issues.assigneeAgentId),
              gte(issues.completedAt, since),
              userWork(),
            ),
          )
          .orderBy(desc(issues.completedAt)),
        db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            agentId: issues.assigneeAgentId,
            status: issues.status,
            overdue: sql<boolean>`${issues.dueDate} is not null and ${issues.dueDate} < ${today}`,
          })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              isNotNull(issues.assigneeAgentId),
              inArray(issues.status, ["todo", "in_progress", "in_review", "blocked"]),
              userWork(),
            ),
          )
          .orderBy(issues.updatedAt),
      ]);

      const byAgent = new Map<string, TeamScorecardAgent>();
      for (const agent of agentRows) {
        byAgent.set(agent.id, {
          agentId: agent.id,
          name: agent.name,
          title: agent.title ?? null,
          status: agent.status,
          finished: 0,
          underWay: 0,
          inReview: 0,
          stuck: 0,
          overdue: 0,
          recentlyFinished: [],
          stuckTasks: [],
        });
      }

      for (const row of finishedRows) {
        const entry = byAgent.get(row.agentId!);
        if (!entry) continue;
        entry.finished += 1;
        if (entry.recentlyFinished.length < RECENT_LIMIT) entry.recentlyFinished.push(task(row));
      }
      for (const row of openRows) {
        const entry = byAgent.get(row.agentId!);
        if (!entry) continue;
        if (row.status === "in_progress") entry.underWay += 1;
        else if (row.status === "in_review") entry.inReview += 1;
        else if (row.status === "blocked") {
          entry.stuck += 1;
          if (entry.stuckTasks.length < STUCK_LIMIT) entry.stuckTasks.push(task(row));
        }
        if (row.overdue) entry.overdue += 1;
      }

      // Agents that were let go only show when they finished something in the window.
      const rows = [...byAgent.values()].filter(
        (entry) => entry.status !== "terminated" || entry.finished > 0,
      );
      rows.sort(
        (a, b) =>
          b.stuck - a.stuck ||
          b.finished - a.finished ||
          b.underWay - a.underWay ||
          a.name.localeCompare(b.name),
      );

      const totals = rows.reduce(
        (sum, entry) => ({
          finished: sum.finished + entry.finished,
          underWay: sum.underWay + entry.underWay,
          inReview: sum.inReview + entry.inReview,
          stuck: sum.stuck + entry.stuck,
          overdue: sum.overdue + entry.overdue,
        }),
        { finished: 0, underWay: 0, inReview: 0, stuck: 0, overdue: 0 },
      );
      return { since: since.toISOString(), days: opts.days, totals, agents: rows };
    },
  };
}
