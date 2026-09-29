import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { routines } from "@greatstone/db";
import { getCompanyLeadAgentId } from "./goals.js";
import { routineService } from "./routines.js";

/**
 * Marks the routine this module creates, so a second call finds it instead of
 * creating a copy. Routines made through the API keep the default "manual".
 */
export const GOAL_CHECK_IN_ROUTINE_ORIGIN_KIND = "goal_check_in";

/**
 * The goal check-in routine template: once a day it wakes the company's lead
 * agent with an issue that tells it to check in on every goal.
 */
export const GOAL_CHECK_IN_ROUTINE_TEMPLATE = {
  title: "Goal check-in",
  cronExpression: "0 9 * * *",
  timezone: "UTC",
  triggerLabel: "Daily",
  description: [
    "Check in on every goal you own or lead.",
    "",
    "1. Read the goals: `GET /api/companies/{companyId}/goals`. Each goal has its `progress`, `blockers` and `latestCheckIn`.",
    "2. For each goal that is not done or cancelled:",
    "   - Read its progress and blockers.",
    "   - Post one check-in: `POST /api/goals/{goalId}/check-ins` with `{ \"body\", \"progressPercent\", \"blockers\" }`. The body is a short recap: what moved since the last check-in, what is next, and what is in the way.",
    "   - To close the gap or clear a blocker, create an issue with that `goalId` and assign it, or reassign a stuck one.",
    "3. If a goal is owned by another agent, do not post its check-in. Ask that agent for it: create an issue with the `goalId`, assign it to the owner, and ask for a check-in today.",
    "4. When every goal has a check-in or a request for one, close this issue with a one-line summary.",
  ].join("\n"),
} as const;

export type EnsureGoalCheckInRoutineResult =
  | { status: "created"; routineId: string }
  | { status: "exists"; routineId: string }
  | { status: "skipped"; reason: "not_lead_agent" };

/**
 * Create the daily goal check-in routine for an agent, if it is the company's
 * lead agent and does not have one yet. Safe to call more than once.
 */
export async function ensureGoalCheckInRoutine(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<EnsureGoalCheckInRoutineResult> {
  const leadAgentId = await getCompanyLeadAgentId(db, companyId);
  if (leadAgentId !== agentId) return { status: "skipped", reason: "not_lead_agent" };

  const existing = await db
    .select({ id: routines.id })
    .from(routines)
    .where(
      and(
        eq(routines.companyId, companyId),
        eq(routines.originKind, GOAL_CHECK_IN_ROUTINE_ORIGIN_KIND),
        ne(routines.status, "archived"),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (existing) return { status: "exists", routineId: existing.id };

  const svc = routineService(db);
  const template = GOAL_CHECK_IN_ROUTINE_TEMPLATE;
  const routine = await svc.create(
    companyId,
    {
      title: template.title,
      description: template.description.replaceAll("{companyId}", companyId),
      assigneeAgentId: agentId,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      variables: [],
    },
    { agentId: null, userId: null },
  );
  await db
    .update(routines)
    .set({ originKind: GOAL_CHECK_IN_ROUTINE_ORIGIN_KIND })
    .where(eq(routines.id, routine.id));
  await svc.createTrigger(
    routine.id,
    {
      kind: "schedule",
      label: template.triggerLabel,
      enabled: true,
      cronExpression: template.cronExpression,
      timezone: template.timezone,
    },
    { agentId: null, userId: null },
  );
  return { status: "created", routineId: routine.id };
}
