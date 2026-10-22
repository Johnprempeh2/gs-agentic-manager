// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { ExternalObjectSummary, Issue } from "@greatstone/shared";
import {
  applyIssueFilters,
  countActiveIssueFilters,
  defaultIssueFilterState,
  describeActiveIssueFilters,
  issueMatchesDueFilter,
  normalizeIssueFilterState,
  resolveIssueFilterWorkspaceId,
  searchIssueFilterOptions,
  shouldIncludeIssueFilterWorkspaceOption,
} from "./issue-filters";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: overrides.id ?? "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Issue",
    description: null,
    status: "todo",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    responsibleUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier: "PAP-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    labels: [],
    labelIds: [],
    createdAt: new Date("2026-04-15T00:00:00.000Z"),
    updatedAt: new Date("2026-04-15T00:00:00.000Z"),
    ...overrides,
    workMode: overrides.workMode ?? "standard",
  };
}

function makeExternalObjectSummary(overrides: Partial<ExternalObjectSummary> = {}): ExternalObjectSummary {
  return {
    total: 1,
    byStatusCategory: {},
    byLiveness: { fresh: 1 },
    highestSeverity: "neutral",
    staleCount: 0,
    authRequiredCount: 0,
    unreachableCount: 0,
    objects: [],
    ...overrides,
  };
}

describe("issue filters", () => {
  it("searches filter options case-insensitively without mutating the source", () => {
    const options = [{ name: "Alpha Agent" }, { name: "Release QA" }];
    expect(searchIssueFilterOptions(options, "  qa ", (option) => option.name)).toEqual([
      { name: "Release QA" },
    ]);
    expect(options).toHaveLength(2);
  });

  it("filters issues by creator across agents and users", () => {
    const issues = [
      makeIssue({ id: "agent-match", createdByAgentId: "agent-1" }),
      makeIssue({ id: "user-match", createdByUserId: "user-1" }),
      makeIssue({ id: "excluded", createdByAgentId: "agent-2", createdByUserId: "user-2" }),
    ];

    const filtered = applyIssueFilters(issues, {
      ...defaultIssueFilterState,
      creators: ["agent:agent-1", "user:user-1"],
    });

    expect(filtered.map((issue) => issue.id)).toEqual(["agent-match", "user-match"]);
  });

  it("filters issues by team (GRE-437) and counts it as a filter group", () => {
    const issues = [
      makeIssue({ id: "platform", teamId: "team-platform" }),
      makeIssue({ id: "release", teamId: "team-release" }),
      makeIssue({ id: "loose", teamId: null }),
    ];
    const state = { ...defaultIssueFilterState, teams: ["team-platform"] };
    expect(applyIssueFilters(issues, state).map((issue) => issue.id)).toEqual(["platform"]);
    expect(countActiveIssueFilters(state)).toBe(1);
    // Saved views from before teams existed have no `teams` key.
    const { teams: _teams, ...legacyState } = defaultIssueFilterState;
    expect(applyIssueFilters(issues, legacyState)).toHaveLength(3);
  });

  it("counts creator filters as an active filter group", () => {
    expect(countActiveIssueFilters({
      ...defaultIssueFilterState,
      creators: ["user:user-1"],
    })).toBe(1);
  });

  it("filters issues to live issue ids when live-only is enabled", () => {
    const issues = [
      makeIssue({ id: "live-issue" }),
      makeIssue({ id: "idle-issue" }),
    ];

    const filtered = applyIssueFilters(
      issues,
      { ...defaultIssueFilterState, liveOnly: true },
      null,
      false,
      new Set(["live-issue"]),
    );

    expect(filtered.map((issue) => issue.id)).toEqual(["live-issue"]);
  });

  it("counts the live-only filter as an active filter group", () => {
    expect(countActiveIssueFilters({
      ...defaultIssueFilterState,
      liveOnly: true,
    })).toBe(1);
  });

  it("does not treat default project workspaces as workspace filter matches", () => {
    const issue = makeIssue({
      id: "default-workspace-issue",
      projectId: "project-1",
      projectWorkspaceId: "workspace-default",
    });
    const workspaceContext = {
      defaultProjectWorkspaceIdByProjectId: new Map([["project-1", "workspace-default"]]),
    };

    expect(resolveIssueFilterWorkspaceId(issue, workspaceContext)).toBeNull();
    expect(applyIssueFilters(
      [issue],
      { ...defaultIssueFilterState, workspaces: ["workspace-default"] },
      null,
      false,
      undefined,
      workspaceContext,
    )).toEqual([]);
  });

  it("does not treat shared default execution workspaces as workspace filter matches", () => {
    const issue = makeIssue({
      id: "shared-default-issue",
      projectId: "project-1",
      projectWorkspaceId: "workspace-default",
      executionWorkspaceId: "execution-shared-default",
    });
    const workspaceContext = {
      executionWorkspaceById: new Map([[
        "execution-shared-default",
        { mode: "shared_workspace", projectWorkspaceId: "workspace-default" },
      ]]),
      defaultProjectWorkspaceIdByProjectId: new Map([["project-1", "workspace-default"]]),
    };

    expect(resolveIssueFilterWorkspaceId(issue, workspaceContext)).toBeNull();
    expect(shouldIncludeIssueFilterWorkspaceOption(
      { id: "execution-shared-default", mode: "shared_workspace", projectWorkspaceId: "workspace-default" },
      new Set(["workspace-default"]),
    )).toBe(false);
  });

  it("keeps non-default project and isolated execution workspaces filterable", () => {
    const featureIssue = makeIssue({
      id: "feature-issue",
      projectId: "project-1",
      projectWorkspaceId: "workspace-feature",
    });
    const executionIssue = makeIssue({
      id: "execution-issue",
      projectId: "project-1",
      projectWorkspaceId: "workspace-default",
      executionWorkspaceId: "execution-isolated",
    });
    const workspaceContext = {
      executionWorkspaceById: new Map([[
        "execution-isolated",
        { mode: "isolated_workspace", projectWorkspaceId: "workspace-default" },
      ]]),
      defaultProjectWorkspaceIdByProjectId: new Map([["project-1", "workspace-default"]]),
    };

    expect(resolveIssueFilterWorkspaceId(featureIssue, workspaceContext)).toBe("workspace-feature");
    expect(resolveIssueFilterWorkspaceId(executionIssue, workspaceContext)).toBe("execution-isolated");
    expect(shouldIncludeIssueFilterWorkspaceOption({ id: "workspace-feature" }, new Set(["workspace-default"]))).toBe(true);
    expect(shouldIncludeIssueFilterWorkspaceOption(
      { id: "execution-isolated", mode: "isolated_workspace", projectWorkspaceId: "workspace-default" },
      new Set(["workspace-default"]),
    )).toBe(true);
  });

  it.each([
    ["failed", ["failed-issue", "blocked-issue"]],
    ["auth_required", ["auth-issue"]],
    ["stale", ["stale-issue"]],
    ["none", ["none-issue"]],
  ])("filters issues by external-object status token %s", (externalObjectStatus, expectedIssueIds) => {
    const issues = [
      makeIssue({ id: "failed-issue" }),
      makeIssue({ id: "blocked-issue" }),
      makeIssue({ id: "auth-issue" }),
      makeIssue({ id: "stale-issue" }),
      makeIssue({ id: "none-issue" }),
      makeIssue({ id: "fresh-issue" }),
    ];
    const summaries = new Map<string, ExternalObjectSummary>([
      ["failed-issue", makeExternalObjectSummary({ byStatusCategory: { failed: 1 }, highestSeverity: "danger" })],
      ["blocked-issue", makeExternalObjectSummary({ byStatusCategory: { blocked: 1 }, highestSeverity: "danger" })],
      ["auth-issue", makeExternalObjectSummary({
        byLiveness: { auth_required: 1 },
        highestSeverity: "danger",
        authRequiredCount: 1,
      })],
      ["stale-issue", makeExternalObjectSummary({
        byLiveness: { stale: 1 },
        highestSeverity: "warning",
        staleCount: 1,
      })],
      ["fresh-issue", makeExternalObjectSummary({ byStatusCategory: { succeeded: 1 }, highestSeverity: "success" })],
    ]);

    const filtered = applyIssueFilters(
      issues,
      { ...defaultIssueFilterState, externalObjectStatuses: [externalObjectStatus] },
      null,
      false,
      undefined,
      {
        externalObjectSummaryByIssueId: summaries,
        externalObjectSummariesReady: true,
      },
    );

    expect(filtered.map((issue) => issue.id)).toEqual(expectedIssueIds);
  });

  it("does not apply external-object filters before summaries are ready", () => {
    const filtered = applyIssueFilters(
      [makeIssue({ id: "issue-1" })],
      { ...defaultIssueFilterState, externalObjectStatuses: ["none"] },
      null,
      false,
      undefined,
      { externalObjectSummaryByIssueId: new Map(), externalObjectSummariesReady: false },
    );

    expect(filtered).toEqual([]);
  });
});

describe("work filter (GRE-1144)", () => {
  const issues = [
    makeIssue({ id: "objective", goalKind: "objective" }),
    makeIssue({ id: "initiative", goalKind: "initiative" }),
    makeIssue({ id: "kpi", goalKind: "kpi" }),
    makeIssue({ id: "no-goal", goalKind: null }),
    makeIssue({ id: "legacy" }),
  ];
  const ids = (list: Issue[]) => list.map((issue) => issue.id);

  it("keeps only strategic or only day-to-day work", () => {
    expect(ids(applyIssueFilters(issues, { ...defaultIssueFilterState, work: "strategic" }))).toEqual(["objective", "initiative"]);
    expect(ids(applyIssueFilters(issues, { ...defaultIssueFilterState, work: "day_to_day" }))).toEqual(["kpi", "no-goal", "legacy"]);
    expect(applyIssueFilters(issues, defaultIssueFilterState)).toHaveLength(5);
  });

  it("counts as an active filter and drops unknown saved values", () => {
    expect(countActiveIssueFilters({ ...defaultIssueFilterState, work: "strategic" })).toBe(1);
    expect(countActiveIssueFilters(defaultIssueFilterState)).toBe(0);
    expect(normalizeIssueFilterState({ work: "day_to_day" }).work).toBe("day_to_day");
    expect(normalizeIssueFilterState({ work: "urgent" }).work).toBeNull();
    expect(normalizeIssueFilterState({}).work).toBeNull();
  });
});

describe("due date filter", () => {
  const today = "2026-10-16";
  const open = (dueDate: string | null) => ({ dueDate, status: "todo" as const });

  it("finds past due open work only", () => {
    expect(issueMatchesDueFilter(open("2026-10-15"), "overdue", today)).toBe(true);
    expect(issueMatchesDueFilter(open("2026-10-16"), "overdue", today)).toBe(false);
    expect(issueMatchesDueFilter({ dueDate: "2026-10-01", status: "done" }, "overdue", today)).toBe(false);
    expect(issueMatchesDueFilter(open(null), "overdue", today)).toBe(false);
  });

  it("finds work due today and in the next six days", () => {
    expect(issueMatchesDueFilter(open("2026-10-16"), "next_7_days", today)).toBe(true);
    expect(issueMatchesDueFilter(open("2026-10-22"), "next_7_days", today)).toBe(true);
    expect(issueMatchesDueFilter(open("2026-10-23"), "next_7_days", today)).toBe(false);
    expect(issueMatchesDueFilter(open("2026-10-15"), "next_7_days", today)).toBe(false);
  });

  it("finds tasks with no due date", () => {
    expect(issueMatchesDueFilter(open(null), "no_due_date", today)).toBe(true);
    expect(issueMatchesDueFilter(open("2026-10-20"), "no_due_date", today)).toBe(false);
  });

  it("keeps a saved due filter and drops an unknown one", () => {
    expect(normalizeIssueFilterState({ due: "overdue" }).due).toBe("overdue");
    expect(normalizeIssueFilterState({ due: "someday" }).due).toBeNull();
    expect(countActiveIssueFilters({ ...defaultIssueFilterState, due: "overdue" })).toBe(1);
  });
});

describe("describeActiveIssueFilters", () => {
  it("names each active filter in words and agrees with the count", () => {
    const state = {
      ...defaultIssueFilterState,
      statuses: ["todo", "in_progress", "in_review", "blocked", "done"],
      assignees: ["__me", "agent-1", "agent-2"],
      projects: ["project-1"],
      due: "overdue" as const,
    };
    const filters = describeActiveIssueFilters(state, {
      agents: [{ id: "agent-1", name: "Ada" }],
      projects: [{ id: "project-1", name: "Rover pilot" }],
    });
    expect(filters.map((filter) => `${filter.name}: ${filter.value}`)).toEqual([
      "Status: Recent",
      "Responsible: Me +2",
      "Project: Rover pilot",
      "Due: Past due",
    ]);
    expect(filters).toHaveLength(countActiveIssueFilters(state));
  });

  it("gives a patch that turns only that filter off", () => {
    const state = { ...defaultIssueFilterState, labels: ["label-1"], liveOnly: true };
    const [labelFilter, liveFilter] = describeActiveIssueFilters(state);
    expect(labelFilter).toMatchObject({ name: "Label", value: "label-1", clear: { labels: [] } });
    expect(liveFilter?.clear).toEqual({ liveOnly: false });
  });

  it("only lists the routine filter when the page offers it", () => {
    const state = { ...defaultIssueFilterState, hideRoutineExecutions: true };
    expect(describeActiveIssueFilters(state)).toEqual([]);
    expect(describeActiveIssueFilters(state, {}, true)).toHaveLength(1);
  });
});
