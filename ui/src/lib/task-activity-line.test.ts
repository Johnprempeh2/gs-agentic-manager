import { describe, expect, it } from "vitest";
import {
  describeTaskActivity,
  formatTaskActivityLine,
  type TaskActivityLineInput,
} from "./task-activity-line";

const agentNames = new Map([
  ["agent-mica", { name: "Mica" }],
  ["agent-keystone", { name: "Keystone" }],
]);

function line(overrides: {
  issue?: Partial<TaskActivityLineInput["issue"]>;
  input?: Partial<Omit<TaskActivityLineInput, "issue">>;
}): string | null {
  const result = describeTaskActivity({
    issue: {
      status: "in_progress",
      assigneeAgentId: "agent-mica",
      assigneeUserId: null,
      ...overrides.issue,
    },
    hasLiveRuns: false,
    waitingOnMonitor: false,
    currentUserId: "user-john",
    agentNames,
    userLabels: new Map([["user-ana", "Ana"]]),
    ...overrides.input,
  });
  return result ? formatTaskActivityLine(result) : null;
}

describe("describeTaskActivity", () => {
  it("says who is working while a run is live", () => {
    expect(line({ input: { hasLiveRuns: true } })).toBe("Mica is working on it");
  });

  it("uses the run phase in plain words, never the raw code", () => {
    const text = line({
      issue: {
        activeRun: {
          id: "run-123",
          status: "running",
          agentId: "agent-mica",
          invocationSource: "assignment",
          triggerDetail: null,
          startedAt: null,
          finishedAt: null,
          createdAt: "2026-10-02T00:00:00Z",
          execution: { phase: "finishing" } as never,
        },
      },
      input: { hasLiveRuns: true },
    });
    expect(text).toBe("Mica is finishing up");
    expect(text).not.toContain("run-123");
  });

  // The server moves the assignee to the reviewer while a stage is open.
  const reviewStage: Partial<TaskActivityLineInput["issue"]> & {
    executionState: NonNullable<TaskActivityLineInput["issue"]["executionState"]>;
  } = {
    status: "in_review",
    assigneeAgentId: "agent-keystone",
    executionState: {
      status: "pending",
      currentStageId: "s1",
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: "agent-keystone" },
      returnAssignee: { type: "agent", agentId: "agent-mica" },
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    },
  };

  it("names the author and the reviewer of a pending review stage", () => {
    expect(line({ issue: reviewStage })).toBe("Mica handed it over · waiting for Keystone's review");
  });

  it("says the reviewer is reviewing while their run is live", () => {
    expect(line({ issue: reviewStage, input: { hasLiveRuns: true } })).toBe("Keystone is reviewing it");
  });

  it("says 'your approval' when the viewer must approve", () => {
    expect(
      line({
        issue: {
          ...reviewStage,
          executionState: {
            ...reviewStage.executionState,
            currentStageType: "approval",
            currentParticipant: { type: "user", userId: "user-john" },
          },
        },
      }),
    ).toBe("Mica handed it over · waiting for your approval");
  });

  it("says 'your answer' when a pending question is for the viewer", () => {
    expect(
      line({
        input: { interactions: [{ status: "pending", addresseeAgentId: null, addresseeUserId: "user-john" }] },
      }),
    ).toBe("Mica is on it · waiting for your answer");
  });

  it("ignores answered questions", () => {
    expect(
      line({
        input: { interactions: [{ status: "answered", addresseeAgentId: null, addresseeUserId: "user-john" }] },
      }),
    ).toBe("Mica is on it; not running right now");
  });

  it("names the open blocker and counts the rest", () => {
    const blocker = (identifier: string, status: "todo" | "done") =>
      ({ id: identifier, identifier, title: "", status, priority: "medium", assigneeAgentId: null, assigneeUserId: null }) as const;
    expect(
      line({
        issue: {
          status: "blocked",
          blockedBy: [blocker("GRE-1", "done"), blocker("GRE-306", "todo"), blocker("GRE-307", "todo")],
        },
      }),
    ).toBe("Mica is stopped · waiting for GRE-306 and 1 more");
  });

  it("names the unblock owner when there is no blocker task", () => {
    expect(
      line({
        issue: { status: "blocked", unblockDescriptor: { owner: { userId: "user-ana" }, action: "Answer the question" } },
      }),
    ).toBe("Mica is stopped · waiting for Ana");
  });

  it("names the monitor's service", () => {
    expect(line({ input: { waitingOnMonitor: true, monitorServiceName: "GitHub CI" } })).toBe(
      "Mica is on it · waiting for GitHub CI",
    );
  });

  it("speaks to the viewer when the task is theirs", () => {
    expect(line({ issue: { assigneeAgentId: null, assigneeUserId: "user-john", status: "todo" } })).toBe(
      "You will pick it up next",
    );
    expect(line({ issue: { assigneeAgentId: null, assigneeUserId: "user-john" }, input: { hasLiveRuns: true } })).toBe(
      "You are working on it",
    );
  });

  it("says when nobody is assigned", () => {
    expect(line({ issue: { assigneeAgentId: null, status: "todo" } })).toBe("Nobody is assigned");
  });

  it("shows nothing for finished or cancelled tasks", () => {
    expect(line({ issue: { status: "done" } })).toBeNull();
    expect(line({ issue: { status: "cancelled" } })).toBeNull();
  });
});
