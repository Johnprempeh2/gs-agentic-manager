import {
  BOARD_GOAL_KINDS,
  STRATEGIC_WORK_GOAL_KINDS,
  type GoalKind,
  type GoalLevel,
} from "./constants.js";

/**
 * Tree rules for the strategy cascade. `null` means the kind sits at the top
 * (no parent). Plain goals (no kind) are not checked, so old trees keep working.
 */
export const GOAL_KIND_PARENTS: Record<GoalKind, readonly GoalKind[] | null> = {
  vision: null,
  value: null,
  csf: null,
  pillar: ["csf", "vision"],
  objective: ["pillar"],
  kpi: ["objective"],
  initiative: ["objective"],
};

/** The old `level` a new goal of this kind gets when the caller sends none. */
export const GOAL_KIND_DEFAULT_LEVEL: Record<GoalKind, GoalLevel> = {
  vision: "company",
  value: "company",
  csf: "company",
  pillar: "company",
  objective: "team",
  kpi: "task",
  initiative: "task",
};

export function isBoardGoalKind(kind: string | null | undefined): boolean {
  return kind != null && (BOARD_GOAL_KINDS as readonly string[]).includes(kind);
}

export function isStrategicWorkGoalKind(kind: string | null | undefined): boolean {
  return kind != null && (STRATEGIC_WORK_GOAL_KINDS as readonly string[]).includes(kind);
}

/**
 * Why `kind` may not sit under a parent of `parentKind`, or null when it may.
 * `hasParent` is false for a top-level goal. A plain parent (no kind) is not
 * a valid parent for a kind that needs one.
 */
export function goalKindParentError(
  kind: GoalKind | null | undefined,
  hasParent: boolean,
  parentKind: GoalKind | null | undefined,
): string | null {
  if (!kind) return null;
  const allowed = GOAL_KIND_PARENTS[kind];
  if (allowed === null) {
    return hasParent ? `A ${kind} goal sits at the top of the plan and cannot have a parent goal` : null;
  }
  if (!hasParent || !parentKind || !allowed.includes(parentKind)) {
    return `A ${kind} goal must sit under a goal of kind ${allowed.join(" or ")}`;
  }
  return null;
}

export interface StrategicPlanTemplateNode {
  key: string;
  kind: GoalKind;
  title: string;
  parentKey: string | null;
}

/**
 * The empty strategic plan: the board layers at the top, then one pillar,
 * objective, KPI and initiative to copy from. Titles are placeholders.
 */
export const STRATEGIC_PLAN_TEMPLATE: readonly StrategicPlanTemplateNode[] = [
  { key: "vision", kind: "vision", title: "Vision and purpose", parentKey: null },
  { key: "value", kind: "value", title: "Values", parentKey: null },
  { key: "csf", kind: "csf", title: "Critical success factors", parentKey: null },
  { key: "pillar", kind: "pillar", title: "Strategic pillar 1", parentKey: "vision" },
  { key: "objective", kind: "objective", title: "Objective 1.1", parentKey: "pillar" },
  { key: "kpi", kind: "kpi", title: "KPI 1.1.1", parentKey: "objective" },
  { key: "initiative", kind: "initiative", title: "Initiative 1.1.1", parentKey: "objective" },
];
