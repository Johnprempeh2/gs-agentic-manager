const GOAL_LEVEL_LABELS: Record<string, string> = {
  company: "Organisation",
  team: "Team",
  agent: "Agent",
  task: "Task",
};

/** The word people see for a goal level, e.g. "Organisation" for `company`. */
export function goalLevelLabel(level: string): string {
  return GOAL_LEVEL_LABELS[level] ?? level.charAt(0).toUpperCase() + level.slice(1);
}
