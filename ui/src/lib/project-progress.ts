import { formatNumber } from "./utils";

export interface ProjectProgress {
  /** "7 of 24 done", or "3 tasks" when the list did not say how many are finished. */
  label: string;
  /** 0 to 100, or null when there is nothing to show a bar for. */
  percent: number | null;
}

export function projectProgress(project: { taskCount?: number; doneTaskCount?: number }): ProjectProgress {
  const total = Math.max(0, project.taskCount ?? 0);
  if (project.doneTaskCount === undefined || total === 0) {
    return { label: `${formatNumber(total)} ${total === 1 ? "task" : "tasks"}`, percent: null };
  }
  const done = Math.min(total, Math.max(0, project.doneTaskCount));
  return {
    label: `${formatNumber(done)} of ${formatNumber(total)} done`,
    percent: Math.round((done / total) * 100),
  };
}
