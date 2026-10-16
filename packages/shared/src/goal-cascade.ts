import {
  BOARD_GOAL_KINDS,
  STRATEGIC_WORK_GOAL_KINDS,
  type GoalKind,
  type GoalLevel,
} from "./constants.js";

/**
 * Tree rules for the strategy cascade. `null` means the kind sits at the top
 * (no parent). Plain goals (no kind) are not checked, so old trees keep working.
 * On a one-page plan the CSF is the strategic area: objectives sit under it and
 * its KPIs sit on its row. `pillar` is optional, for clients who use that word.
 */
export const GOAL_KIND_PARENTS: Record<GoalKind, readonly GoalKind[] | null> = {
  vision: null,
  value: null,
  csf: null,
  pillar: ["csf", "vision"],
  objective: ["csf", "pillar"],
  kpi: ["csf", "pillar", "objective"],
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
  description: string | null;
  parentKey: string | null;
}

export const STRATEGIC_PLAN_TEMPLATE_NAME = "One-page strategic plan";

/**
 * The empty one-page strategic plan: vision and purpose, values and one CSF
 * at the top, then a strategic objective and a KPI under that CSF to copy
 * from. Titles and descriptions are placeholders.
 */
export const STRATEGIC_PLAN_TEMPLATE: readonly StrategicPlanTemplateNode[] = [
  {
    key: "vision",
    kind: "vision",
    title: "Vision and purpose",
    description: "Where we will be by the target year, and why we exist.",
    parentKey: null,
  },
  { key: "value", kind: "value", title: "Value 1", description: "The behaviour that shows this value.", parentKey: null },
  {
    key: "csf",
    kind: "csf",
    title: "Critical success factor 1",
    description: "One line: what we must get right in this area.",
    parentKey: null,
  },
  { key: "objective", kind: "objective", title: "Strategic objective 1.1", description: null, parentKey: "csf" },
  { key: "kpi", kind: "kpi", title: "KPI 1.1", description: null, parentKey: "csf" },
];
