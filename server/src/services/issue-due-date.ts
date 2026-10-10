import { and, eq, inArray } from "drizzle-orm";
import { goals, type Db } from "@greatstone/db";
import { findPlanObjective, type StrategyBoardGoal } from "@greatstone/shared";
import { unprocessable } from "../errors.js";

/**
 * Due dates on plan actions (GRE-1188). Only a task whose goal is a plan
 * objective, or sits under one, may carry a due date, so tasks that are not
 * on the plan never change.
 */

type GoalReader = Pick<Db, "select">;

/** Deep enough for vision → value → CSF → objective → initiative → KPI, with room to spare. */
const MAX_GOAL_DEPTH = 16;

/** The objective a goal belongs to (itself or its nearest objective ancestor), or null. */
export async function findPlanObjectiveId(db: GoalReader, companyId: string, goalId: string | null): Promise<string | null> {
  if (!goalId) return null;
  const byId = new Map<string, StrategyBoardGoal>();
  let nextIds = [goalId];
  for (let depth = 0; depth < MAX_GOAL_DEPTH && nextIds.length > 0; depth += 1) {
    const rows = await db
      .select({
        id: goals.id,
        parentId: goals.parentId,
        kind: goals.kind,
        status: goals.status,
        title: goals.title,
        unit: goals.unit,
        targetValue: goals.targetValue,
        targetDate: goals.targetDate,
        ownerUserId: goals.ownerUserId,
        ownerAgentId: goals.ownerAgentId,
      })
      .from(goals)
      .where(and(eq(goals.companyId, companyId), inArray(goals.id, nextIds)));
    nextIds = [];
    for (const row of rows) {
      byId.set(row.id, row);
      if (row.kind === "objective") return findPlanObjective(goalId, byId)?.id ?? null;
      if (row.parentId && !byId.has(row.parentId)) nextIds.push(row.parentId);
    }
  }
  return null;
}

export const DUE_DATE_OFF_PLAN_MESSAGE =
  "A due date can only be set on a task linked to a plan objective. Link the task to an objective, or to an initiative or KPI under one, first.";

export async function assertDueDateOnPlan(db: GoalReader, companyId: string, goalId: string | null) {
  if (!(await findPlanObjectiveId(db, companyId, goalId))) {
    throw unprocessable(DUE_DATE_OFF_PLAN_MESSAGE, { code: "due_date_needs_plan_objective" });
  }
}

/**
 * The due date after an update, or undefined to leave it as it is. Setting a
 * date checks the task is on the plan. Moving a dated task off the plan
 * clears its date, so an off-plan task never keeps one.
 */
export async function resolveNextDueDate(
  db: GoalReader,
  companyId: string,
  input: { currentDueDate: string | null; currentGoalId: string | null; dueDate: string | null | undefined; goalId: string | null },
): Promise<string | null | undefined> {
  if (input.dueDate === null) return null;
  if (input.dueDate !== undefined) {
    await assertDueDateOnPlan(db, companyId, input.goalId);
    return input.dueDate;
  }
  if (input.currentDueDate && input.goalId !== input.currentGoalId) {
    return (await findPlanObjectiveId(db, companyId, input.goalId)) ? undefined : null;
  }
  return undefined;
}
