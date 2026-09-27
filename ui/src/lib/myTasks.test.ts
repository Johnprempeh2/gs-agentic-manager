import { describe, expect, it } from "vitest";
import type { Issue, IssueRelationIssueSummary } from "@greatstone/shared";
import { selectMyTasks } from "./myTasks";

const ME = "user-john";

function makeIssue(id: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id,
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: `Issue ${id}`,
    description: null,
    status: "todo",
    workMode: "standard",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: ME,
    responsibleUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier: `GRE-${id}`,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    ...overrides,
  };
}

function blockedSummary(id: string, status: IssueRelationIssueSummary["status"] = "blocked"): IssueRelationIssueSummary {
  return {
    id,
    identifier: `GRE-${id}`,
    title: `Agent issue ${id}`,
    status,
    priority: "medium",
    assigneeAgentId: "agent-ridge",
    assigneeUserId: null,
  };
}

function pendingReviewOn(userId: string): Issue["executionState"] {
  return {
    status: "pending",
    currentStageId: "stage-1",
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: { type: "user", userId },
    returnAssignee: { type: "agent", agentId: "agent-ridge" },
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
  };
}

describe("selectMyTasks", () => {
  it("puts an issue that blocks open agent work under blocking, with the blocked issue listed", () => {
    const result = selectMyTasks(
      [makeIssue("1", { blocks: [blockedSummary("10")] })],
      ME,
    );

    expect(result.blocking).toHaveLength(1);
    expect(result.blocking[0]?.issue.id).toBe("1");
    expect(result.blocking[0]?.blockedIssues.map((issue) => issue.id)).toEqual(["10"]);
    expect(result.blocking[0]?.waitingOnReview).toBe(false);
    expect(result.assigned).toEqual([]);
  });

  it("treats an issue whose blocked issues are all closed as plain assigned work", () => {
    const result = selectMyTasks(
      [makeIssue("1", { blocks: [blockedSummary("10", "done"), blockedSummary("11", "cancelled")] })],
      ME,
    );

    expect(result.blocking).toEqual([]);
    expect(result.assigned).toEqual([{ status: "todo", issues: [expect.objectContaining({ id: "1" })] }]);
  });

  it("puts a review stage waiting on the user under blocking even with no blocks relation", () => {
    const result = selectMyTasks(
      [
        makeIssue("1", { status: "in_review", executionState: pendingReviewOn(ME) }),
        makeIssue("2", { status: "in_review", executionState: pendingReviewOn("someone-else") }),
      ],
      ME,
    );

    expect(result.blocking.map((entry) => [entry.issue.id, entry.waitingOnReview])).toEqual([["1", true]]);
    expect(result.assigned).toEqual([{ status: "in_review", issues: [expect.objectContaining({ id: "2" })] }]);
  });

  it("groups other assigned issues by status in page order and drops done/cancelled", () => {
    const result = selectMyTasks(
      [
        makeIssue("backlog", { status: "backlog" }),
        makeIssue("done", { status: "done", blocks: [blockedSummary("10")] }),
        makeIssue("todo", { status: "todo" }),
        makeIssue("cancelled", { status: "cancelled", executionState: pendingReviewOn(ME) }),
        makeIssue("blocked", { status: "blocked" }),
        makeIssue("doing", { status: "in_progress" }),
      ],
      ME,
    );

    expect(result.blocking).toEqual([]);
    expect(result.assigned.map((group) => [group.status, group.issues.map((issue) => issue.id)])).toEqual([
      ["in_progress", ["doing"]],
      ["todo", ["todo"]],
      ["blocked", ["blocked"]],
      ["backlog", ["backlog"]],
    ]);
  });

  it("ignores issues assigned to someone else and orders blocking by how much it blocks", () => {
    const result = selectMyTasks(
      [
        makeIssue("other", { assigneeUserId: "user-other", blocks: [blockedSummary("10")] }),
        makeIssue("one", { blocks: [blockedSummary("11")] }),
        makeIssue("two", { blocks: [blockedSummary("12"), blockedSummary("13", "todo")] }),
      ],
      ME,
    );

    expect(result.blocking.map((entry) => entry.issue.id)).toEqual(["two", "one"]);
  });

  it("returns empty sections without a signed-in user", () => {
    expect(selectMyTasks([makeIssue("1", { blocks: [blockedSummary("10")] })], null)).toEqual({
      blocking: [],
      assigned: [],
    });
  });
});
