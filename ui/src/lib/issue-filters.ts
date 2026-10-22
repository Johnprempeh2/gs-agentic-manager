import { ISSUE_WORK_FILTERS, isStrategicWorkGoalKind } from "@greatstone/shared";
import type { ExternalObjectSummary, Issue, IssueWorkFilter } from "@greatstone/shared";

export type IssueFilterWorkspaceLookup = {
  mode?: string | null;
  projectWorkspaceId?: string | null;
};

export type IssueFilterWorkspaceContext = {
  executionWorkspaceById?: ReadonlyMap<string, IssueFilterWorkspaceLookup>;
  defaultProjectWorkspaceIdByProjectId?: ReadonlyMap<string, string>;
  externalObjectSummaryByIssueId?: ReadonlyMap<string, ExternalObjectSummary>;
  externalObjectSummariesReady?: boolean;
};

export type IssueFilterState = {
  statuses: string[];
  priorities: string[];
  assignees: string[];
  creators: string[];
  labels: string[];
  /** Team ids (GRE-437); optional so older saved views still load. */
  teams?: string[];
  projects: string[];
  workspaces: string[];
  liveOnly?: boolean;
  /** Strategic or day-to-day work (GRE-1144); unset shows all work. */
  work?: IssueWorkFilter | null;
  /** Due date filter; unset shows every task. */
  due?: IssueDueFilter | null;
  /**
   * External object status filter. Values are special tokens that map to
   * properties of the issue's external-object summary (rather than to a
   * single category) so the filter UI can describe intent rather than every
   * possible permutation.
   *
   *   - `failed`         — any external object with `statusCategory in (failed, blocked)`
   *   - `waiting`        — any external object with `statusCategory in (waiting)`
   *   - `running`        — any external object with `statusCategory in (running)`
   *   - `auth_required`  — any external object with `liveness == auth_required`
   *   - `unreachable`    — any external object with `liveness == unreachable`
   *   - `stale`          — any external object with `liveness == stale`
   *   - `none`           — issues with zero external objects
   */
  externalObjectStatuses: string[];
  hideRoutineExecutions: boolean;
};

export const defaultIssueFilterState: IssueFilterState = {
  statuses: [],
  priorities: [],
  assignees: [],
  creators: [],
  labels: [],
  teams: [],
  projects: [],
  workspaces: [],
  liveOnly: false,
  work: null,
  due: null,
  externalObjectStatuses: [],
  hideRoutineExecutions: false,
};

export const externalObjectFilterOrder = [
  "failed",
  "waiting",
  "running",
  "auth_required",
  "unreachable",
  "stale",
  "none",
];

const EXTERNAL_OBJECT_FILTER_LABELS: Record<string, string> = {
  failed: "Any failed",
  waiting: "Any waiting",
  running: "Any running",
  auth_required: "Auth required",
  unreachable: "Unreachable",
  stale: "Stale",
  none: "No linked work",
};

export function externalObjectFilterLabel(value: string): string {
  return EXTERNAL_OBJECT_FILTER_LABELS[value] ?? issueFilterLabel(value);
}

export const issueStatusOrder = ["in_progress", "todo", "backlog", "in_review", "blocked", "done", "cancelled"];
export const issuePriorityOrder = ["critical", "high", "medium", "low"];

export const issueQuickFilterPresets = [
  { label: "All", statuses: [] as string[] },
  // Live work plus finished results; the newest-updated sort puts recent results near the top.
  { label: "Recent", statuses: ["todo", "in_progress", "in_review", "blocked", "done"] },
  { label: "Active", statuses: ["todo", "in_progress", "in_review", "blocked"] },
  { label: "Blocked", statuses: ["blocked"] },
  { label: "Backlog", statuses: ["backlog"] },
  { label: "Done", statuses: ["done", "cancelled"] },
];

export function issueFilterLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function issueFilterArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

function normalizeIssueFilterValueArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function normalizeIssueFilterState(value: unknown): IssueFilterState {
  if (!value || typeof value !== "object") return { ...defaultIssueFilterState };
  const candidate = value as Partial<Record<keyof IssueFilterState, unknown>>;
  return {
    statuses: normalizeIssueFilterValueArray(candidate.statuses),
    priorities: normalizeIssueFilterValueArray(candidate.priorities),
    assignees: normalizeIssueFilterValueArray(candidate.assignees),
    creators: normalizeIssueFilterValueArray(candidate.creators),
    labels: normalizeIssueFilterValueArray(candidate.labels),
    teams: normalizeIssueFilterValueArray(candidate.teams),
    projects: normalizeIssueFilterValueArray(candidate.projects),
    workspaces: normalizeIssueFilterValueArray(candidate.workspaces),
    liveOnly: candidate.liveOnly === true,
    work: normalizeIssueWorkFilter(candidate.work),
    due: normalizeIssueDueFilter(candidate.due),
    externalObjectStatuses: normalizeIssueFilterValueArray(candidate.externalObjectStatuses),
    hideRoutineExecutions: candidate.hideRoutineExecutions === true,
  };
}

export function normalizeIssueWorkFilter(value: unknown): IssueWorkFilter | null {
  return typeof value === "string" && (ISSUE_WORK_FILTERS as readonly string[]).includes(value)
    ? (value as IssueWorkFilter)
    : null;
}

export const issueWorkFilterOptions: ReadonlyArray<{ value: IssueWorkFilter | null; label: string }> = [
  { value: null, label: "All work" },
  { value: "strategic", label: "Strategic" },
  { value: "day_to_day", label: "Day-to-day" },
];

export const ISSUE_DUE_FILTERS = ["overdue", "next_7_days", "no_due_date"] as const;
export type IssueDueFilter = (typeof ISSUE_DUE_FILTERS)[number];

export const issueDueFilterOptions: ReadonlyArray<{ value: IssueDueFilter | null; label: string }> = [
  { value: null, label: "Any date" },
  { value: "overdue", label: "Past due" },
  { value: "next_7_days", label: "Due in the next 7 days" },
  { value: "no_due_date", label: "No due date" },
];

export function normalizeIssueDueFilter(value: unknown): IssueDueFilter | null {
  return typeof value === "string" && (ISSUE_DUE_FILTERS as readonly string[]).includes(value)
    ? (value as IssueDueFilter)
    : null;
}

/** YYYY-MM-DD in the viewer's own time zone. */
export function localDateKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDaysToKey(key: string, days: number): string {
  const [year, month, day] = key.split("-").map(Number);
  return localDateKey(new Date(year!, month! - 1, day! + days));
}

/** Past due and due soon only count open work; a finished task is never late. */
export function issueMatchesDueFilter(
  issue: Pick<Issue, "dueDate" | "status">,
  due: IssueDueFilter,
  today: string,
): boolean {
  const dueDate = issue.dueDate ? issue.dueDate.slice(0, 10) : null;
  if (due === "no_due_date") return dueDate === null;
  if (!dueDate || issue.status === "done" || issue.status === "cancelled") return false;
  if (due === "overdue") return dueDate < today;
  return dueDate >= today && dueDate <= addDaysToKey(today, 6);
}

export function issueMatchesWorkFilter(issue: Pick<Issue, "goalKind">, work: IssueWorkFilter): boolean {
  return isStrategicWorkGoalKind(issue.goalKind) === (work === "strategic");
}

export function toggleIssueFilterValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((existing) => existing !== value) : [...values, value];
}

export function searchIssueFilterOptions<T>(
  options: readonly T[] | undefined,
  search: string,
  getSearchText: (option: T) => string,
): T[] {
  const normalizedSearch = search.trim().toLocaleLowerCase();
  if (!normalizedSearch) return [...(options ?? [])];
  return (options ?? []).filter((option) =>
    getSearchText(option).toLocaleLowerCase().includes(normalizedSearch),
  );
}

export function resolveIssueFilterWorkspaceId(
  issue: Pick<Issue, "executionWorkspaceId" | "projectId" | "projectWorkspaceId">,
  context: IssueFilterWorkspaceContext = {},
): string | null {
  const defaultProjectWorkspaceId = issue.projectId
    ? context.defaultProjectWorkspaceIdByProjectId?.get(issue.projectId) ?? null
    : null;

  if (issue.executionWorkspaceId) {
    const executionWorkspace = context.executionWorkspaceById?.get(issue.executionWorkspaceId) ?? null;
    const linkedProjectWorkspaceId =
      executionWorkspace?.projectWorkspaceId ?? issue.projectWorkspaceId ?? null;
    const isDefaultSharedExecutionWorkspace =
      executionWorkspace?.mode === "shared_workspace"
      && linkedProjectWorkspaceId != null
      && linkedProjectWorkspaceId === defaultProjectWorkspaceId;
    if (isDefaultSharedExecutionWorkspace) return null;
    return issue.executionWorkspaceId;
  }

  if (issue.projectWorkspaceId) {
    if (issue.projectWorkspaceId === defaultProjectWorkspaceId) return null;
    return issue.projectWorkspaceId;
  }

  return null;
}

export function shouldIncludeIssueFilterWorkspaceOption(
  workspace: { id: string; mode?: string | null; projectWorkspaceId?: string | null },
  defaultProjectWorkspaceIds: ReadonlySet<string>,
): boolean {
  if (defaultProjectWorkspaceIds.has(workspace.id)) return false;
  return !(workspace.mode === "shared_workspace"
    && workspace.projectWorkspaceId != null
    && defaultProjectWorkspaceIds.has(workspace.projectWorkspaceId));
}

function summaryRecordCount(record: Record<string, number> | undefined, key: string): number {
  return record?.[key] ?? 0;
}

function issueMatchesExternalObjectStatusFilter(
  summary: ExternalObjectSummary | null | undefined,
  value: string,
): boolean {
  const total = summary?.total ?? 0;
  switch (value) {
    case "failed":
      return summaryRecordCount(summary?.byStatusCategory, "failed") > 0
        || summaryRecordCount(summary?.byStatusCategory, "blocked") > 0;
    case "waiting":
      return summaryRecordCount(summary?.byStatusCategory, "waiting") > 0;
    case "running":
      return summaryRecordCount(summary?.byStatusCategory, "running") > 0;
    case "auth_required":
      return (summary?.authRequiredCount ?? 0) > 0
        || summaryRecordCount(summary?.byLiveness, "auth_required") > 0;
    case "unreachable":
      return (summary?.unreachableCount ?? 0) > 0
        || summaryRecordCount(summary?.byLiveness, "unreachable") > 0;
    case "stale":
      return (summary?.staleCount ?? 0) > 0
        || summaryRecordCount(summary?.byLiveness, "stale") > 0;
    case "none":
      return total === 0;
    default:
      return false;
  }
}

export function applyIssueFilters(
  issues: Issue[],
  state: IssueFilterState,
  currentUserId?: string | null,
  enableRoutineVisibilityFilter = false,
  liveIssueIds?: ReadonlySet<string>,
  workspaceContext: IssueFilterWorkspaceContext = {},
): Issue[] {
  let result = issues;
  if (state.liveOnly) {
    result = result.filter((issue) => liveIssueIds?.has(issue.id) === true);
  }
  if (enableRoutineVisibilityFilter && state.hideRoutineExecutions) {
    result = result.filter((issue) => issue.originKind !== "routine_execution");
  }
  const work = state.work ?? null;
  if (work) result = result.filter((issue) => issueMatchesWorkFilter(issue, work));
  const due = state.due ?? null;
  if (due) {
    const today = localDateKey(new Date());
    result = result.filter((issue) => issueMatchesDueFilter(issue, due, today));
  }
  if (state.statuses.length > 0) result = result.filter((issue) => state.statuses.includes(issue.status));
  if (state.priorities.length > 0) result = result.filter((issue) => state.priorities.includes(issue.priority));
  if (state.assignees.length > 0) {
    result = result.filter((issue) => {
      for (const assignee of state.assignees) {
        if (assignee === "__unassigned" && !issue.assigneeAgentId && !issue.assigneeUserId) return true;
        if (assignee === "__me" && currentUserId && issue.assigneeUserId === currentUserId) return true;
        if (issue.assigneeAgentId === assignee) return true;
      }
      return false;
    });
  }
  if (state.creators.length > 0) {
    result = result.filter((issue) => {
      for (const creator of state.creators) {
        if (creator.startsWith("agent:") && issue.createdByAgentId === creator.slice("agent:".length)) return true;
        if (creator.startsWith("user:") && issue.createdByUserId === creator.slice("user:".length)) return true;
      }
      return false;
    });
  }
  if (state.labels.length > 0) {
    result = result.filter((issue) => (issue.labelIds ?? []).some((id) => state.labels.includes(id)));
  }
  const teams = state.teams ?? [];
  if (teams.length > 0) {
    result = result.filter((issue) => issue.teamId != null && teams.includes(issue.teamId));
  }
  if (state.projects.length > 0) {
    result = result.filter((issue) => issue.projectId != null && state.projects.includes(issue.projectId));
  }
  if (state.workspaces.length > 0) {
    result = result.filter((issue) => {
      const workspaceId = resolveIssueFilterWorkspaceId(issue, workspaceContext);
      return workspaceId != null && state.workspaces.includes(workspaceId);
    });
  }
  if (state.externalObjectStatuses.length > 0) {
    const summaries = workspaceContext.externalObjectSummaryByIssueId;
    if (!summaries || workspaceContext.externalObjectSummariesReady !== true) return [];
    result = result.filter((issue) => {
      const summary = summaries.get(issue.id) ?? null;
      return state.externalObjectStatuses.some((status) =>
        issueMatchesExternalObjectStatusFilter(summary, status),
      );
    });
  }
  return result;
}

export function countActiveIssueFilters(
  state: IssueFilterState,
  enableRoutineVisibilityFilter = false,
): number {
  let count = 0;
  if (state.statuses.length > 0) count += 1;
  if (state.priorities.length > 0) count += 1;
  if (state.assignees.length > 0) count += 1;
  if (state.creators.length > 0) count += 1;
  if (state.labels.length > 0) count += 1;
  if ((state.teams ?? []).length > 0) count += 1;
  if (state.projects.length > 0) count += 1;
  if (state.workspaces.length > 0) count += 1;
  if (state.liveOnly) count += 1;
  if (state.work) count += 1;
  if (state.due) count += 1;
  if (state.externalObjectStatuses.length > 0) count += 1;
  if (enableRoutineVisibilityFilter && state.hideRoutineExecutions) count += 1;
  return count;
}

export type ActiveIssueFilter = {
  key: string;
  /** What the filter is, for example "Responsible". */
  name: string;
  /** What it is set to, for example "Me" or "Ada +2". */
  value: string;
  /** The patch that turns this one filter off. */
  clear: Partial<IssueFilterState>;
};

export type ActiveIssueFilterNames = {
  agents?: ReadonlyArray<{ id: string; name: string }>;
  creators?: ReadonlyArray<{ id: string; label: string }>;
  labels?: ReadonlyArray<{ id: string; name: string }>;
  teams?: ReadonlyArray<{ id: string; name: string }>;
  projects?: ReadonlyArray<{ id: string; name: string }>;
  workspaces?: ReadonlyArray<{ id: string; name: string }>;
};

/** First name, then "+N" for the rest, so a chip stays one short line. */
function summarizeFilterValues(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names[0]} +${names.length - 1}`;
}

function namesById(
  ids: string[],
  options: ReadonlyArray<{ id: string; name?: string; label?: string }> | undefined,
  fallback: (id: string) => string,
): string[] {
  const byId = new Map((options ?? []).map((option) => [option.id, option.name ?? option.label ?? option.id]));
  return ids.map((id) => byId.get(id) ?? fallback(id));
}

/**
 * Each active filter in words, in the same order and with the same rules as
 * countActiveIssueFilters, so the chips and the count always agree.
 */
export function describeActiveIssueFilters(
  state: IssueFilterState,
  names: ActiveIssueFilterNames = {},
  enableRoutineVisibilityFilter = false,
): ActiveIssueFilter[] {
  const filters: ActiveIssueFilter[] = [];
  const shortId = (id: string) => id.slice(0, 8);
  if (state.statuses.length > 0) {
    const preset = issueQuickFilterPresets.find(
      (candidate) => candidate.statuses.length > 0 && issueFilterArraysEqual(candidate.statuses, state.statuses),
    );
    filters.push({
      key: "statuses",
      name: "Status",
      value: preset?.label ?? summarizeFilterValues(state.statuses.map(issueFilterLabel)),
      clear: { statuses: [] },
    });
  }
  if (state.priorities.length > 0) {
    filters.push({
      key: "priorities",
      name: "Priority",
      value: summarizeFilterValues(state.priorities.map(issueFilterLabel)),
      clear: { priorities: [] },
    });
  }
  if (state.assignees.length > 0) {
    const agentNames = new Map((names.agents ?? []).map((agent) => [agent.id, agent.name]));
    filters.push({
      key: "assignees",
      name: "Responsible",
      value: summarizeFilterValues(state.assignees.map((id) =>
        id === "__unassigned" ? "No one" : id === "__me" ? "Me" : agentNames.get(id) ?? shortId(id))),
      clear: { assignees: [] },
    });
  }
  if (state.creators.length > 0) {
    filters.push({
      key: "creators",
      name: "Created by",
      value: summarizeFilterValues(namesById(state.creators, names.creators, (id) => shortId(id.replace(/^(agent|user):/, "")))),
      clear: { creators: [] },
    });
  }
  if (state.labels.length > 0) {
    filters.push({
      key: "labels",
      name: "Label",
      value: summarizeFilterValues(namesById(state.labels, names.labels, shortId)),
      clear: { labels: [] },
    });
  }
  const teams = state.teams ?? [];
  if (teams.length > 0) {
    filters.push({
      key: "teams",
      name: "Team",
      value: summarizeFilterValues(namesById(teams, names.teams, shortId)),
      clear: { teams: [] },
    });
  }
  if (state.projects.length > 0) {
    filters.push({
      key: "projects",
      name: "Project",
      value: summarizeFilterValues(namesById(state.projects, names.projects, shortId)),
      clear: { projects: [] },
    });
  }
  if (state.workspaces.length > 0) {
    filters.push({
      key: "workspaces",
      name: "Workspace",
      value: summarizeFilterValues(namesById(state.workspaces, names.workspaces, shortId)),
      clear: { workspaces: [] },
    });
  }
  if (state.liveOnly) {
    filters.push({ key: "liveOnly", name: "Only", value: "Working now", clear: { liveOnly: false } });
  }
  if (state.work) {
    const option = issueWorkFilterOptions.find((candidate) => candidate.value === state.work);
    filters.push({ key: "work", name: "Work", value: option?.label ?? issueFilterLabel(state.work), clear: { work: null } });
  }
  if (state.due) {
    const option = issueDueFilterOptions.find((candidate) => candidate.value === state.due);
    filters.push({ key: "due", name: "Due", value: option?.label ?? issueFilterLabel(state.due), clear: { due: null } });
  }
  if (state.externalObjectStatuses.length > 0) {
    filters.push({
      key: "externalObjectStatuses",
      name: "Linked work",
      value: summarizeFilterValues(state.externalObjectStatuses.map(externalObjectFilterLabel)),
      clear: { externalObjectStatuses: [] },
    });
  }
  if (enableRoutineVisibilityFilter && state.hideRoutineExecutions) {
    filters.push({ key: "hideRoutineExecutions", name: "Hide", value: "Routine tasks", clear: { hideRoutineExecutions: false } });
  }
  return filters;
}
