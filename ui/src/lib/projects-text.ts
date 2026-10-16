import type { Project, ProjectStatus } from "@greatstone/shared";
import { parseCalendarDate, targetDateLabel } from "./goal-journey";
import { sheetToCsv, type Sheet } from "./spreadsheet-export";
import { formatCalendarDay } from "./utils";

/**
 * "Copy as an update" and "Download as spreadsheet" on Projects: every live
 * project with its status, task count, target date and lead, ready to paste
 * into an email or open in Excel.
 */

export interface ProjectsTextLookups {
  agentName: (id: string) => string | null | undefined;
}

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  backlog: "Backlog",
  planned: "Planned",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

const STATUS_ORDER: readonly ProjectStatus[] = ["in_progress", "planned", "backlog", "completed"];

/** Live projects only (not cancelled or archived), busiest first, then soonest target date. */
export function projectsForUpdate(projects: readonly Project[]): Project[] {
  const rank = (project: Project) => STATUS_ORDER.indexOf(project.status);
  const target = (project: Project) => parseCalendarDate(project.targetDate)?.getTime() ?? Number.POSITIVE_INFINITY;
  return projects
    .filter((project) => project.status !== "cancelled" && !project.archivedAt)
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        target(a) - target(b) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
}

/** "6 Oct, 10 days late" or "20 Oct, 4 days to go"; completed projects show the date only. */
export function projectTargetLabel(project: Pick<Project, "targetDate" | "status">, now: Date = new Date()): string | null {
  return targetDateLabel(project.targetDate, project.status === "completed", now)?.replace(/^Target /, "") ?? null;
}

function taskCount(project: Project): string | null {
  const count = project.taskCount ?? 0;
  return count > 0 ? `${count} ${count === 1 ? "task" : "tasks"}` : null;
}

function projectLine(project: Project, lookups: ProjectsTextLookups, now: Date): string {
  const lead = project.leadAgentId ? lookups.agentName(project.leadAgentId) : null;
  const target = projectTargetLabel(project, now);
  const parts = [
    PROJECT_STATUS_LABEL[project.status],
    taskCount(project),
    target ? `due ${target}` : null,
    lead ? `led by ${lead}` : null,
  ].filter(Boolean);
  return `${project.name}: ${parts.join(", ")}`;
}

/**
 *   Projects update, 16 Oct
 *   3 projects: 2 in progress, 1 planned.
 *
 *   • Website relaunch: In progress, 12 tasks, due 6 Oct, 10 days late, led by Ridge
 */
export function projectsUpdateText(projects: readonly Project[], lookups: ProjectsTextLookups, today: string): string {
  const header = `Projects update, ${formatCalendarDay(today)}`;
  const now = parseCalendarDate(today) ?? new Date();
  const live = projectsForUpdate(projects);
  if (live.length === 0) return `${header}\n\nNo projects are open.`;
  const counts = STATUS_ORDER.map((status) => [status, live.filter((p) => p.status === status).length] as const)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${PROJECT_STATUS_LABEL[status].toLowerCase()}`);
  const summary = `${live.length} ${live.length === 1 ? "project" : "projects"}: ${counts.join(", ")}.`;
  return [header, summary, "", ...live.map((project) => `• ${projectLine(project, lookups, now)}`)].join("\n");
}

export function projectsSheet(projects: readonly Project[], lookups: ProjectsTextLookups): Sheet {
  return {
    name: "Projects",
    headers: ["Project", "Status", "Tasks", "Target date", "Lead", "Description"],
    rows: projectsForUpdate(projects).map((project) => [
      project.name,
      PROJECT_STATUS_LABEL[project.status],
      project.taskCount ?? 0,
      project.targetDate ?? "",
      (project.leadAgentId ? lookups.agentName(project.leadAgentId) : null) ?? "",
      project.description ?? "",
    ]),
  };
}

export function projectsToCsv(projects: readonly Project[], lookups: ProjectsTextLookups): string {
  return sheetToCsv(projectsSheet(projects, lookups));
}
