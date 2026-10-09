import { GOAL_KINDS, type GoalKind, type GoalWithProgress } from "@greatstone/shared";

/**
 * Goals page, strategy cascade (GRE-1132): the board layers (vision, values)
 * and the strategy tree built from goals that have a kind. Each CSF is a
 * strategic area at the top of the tree, with its KPIs, objectives and work
 * under it; pillars under the vision are roots too. Plain goals stay on the
 * scoreboard.
 */

export interface CascadeRow<G> {
  goal: G;
  depth: number;
}

export interface StrategyCascade<G> {
  vision: G[];
  values: G[];
  csfs: G[];
  strategy: CascadeRow<G>[];
}

type CascadeGoal = Pick<GoalWithProgress, "id" | "kind" | "parentId" | "status" | "createdAt">;

const KIND_ORDER = new Map<GoalKind, number>(GOAL_KINDS.map((kind, index) => [kind, index]));

function byKindThenAge(a: CascadeGoal, b: CascadeGoal) {
  return (
    (KIND_ORDER.get(a.kind as GoalKind) ?? 99) - (KIND_ORDER.get(b.kind as GoalKind) ?? 99)
    || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    || a.id.localeCompare(b.id)
  );
}

export function hasStrategyGoals(goals: readonly CascadeGoal[]): boolean {
  return goals.some((goal) => goal.kind != null && goal.status !== "cancelled");
}

export function buildStrategyCascade<G extends CascadeGoal>(goals: readonly G[]): StrategyCascade<G> {
  const kinded = goals.filter((goal) => goal.kind != null && goal.status !== "cancelled").sort(byKindThenAge);
  const ofKind = (kind: GoalKind) => kinded.filter((goal) => goal.kind === kind);

  const children = new Map<string, G[]>();
  for (const goal of kinded) {
    if (!goal.parentId) continue;
    const list = children.get(goal.parentId) ?? [];
    list.push(goal);
    children.set(goal.parentId, list);
  }

  const strategy: CascadeRow<G>[] = [];
  const seen = new Set<string>();
  const walk = (goal: G, depth: number) => {
    if (seen.has(goal.id)) return;
    seen.add(goal.id);
    strategy.push({ goal, depth });
    for (const child of children.get(goal.id) ?? []) walk(child, depth + 1);
  };
  for (const csf of ofKind("csf")) walk(csf, 0);
  for (const pillar of ofKind("pillar")) walk(pillar, 0);

  return { vision: ofKind("vision"), values: ofKind("value"), csfs: ofKind("csf"), strategy };
}
