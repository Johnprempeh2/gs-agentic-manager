import { describe, expect, it } from "vitest";
import {
  describeTaskStopReason,
  formatTaskStopReason,
  hasPlainRunErrorWording,
  type TaskStopReasonInput,
} from "./task-stop-reason";

const agentNames = new Map([
  ["agent-mica", { name: "Mica" }],
  ["agent-ridge", { name: "Ridge" }],
]);

function reason(overrides: {
  issue?: Partial<TaskStopReasonInput["issue"]>;
  input?: Partial<Omit<TaskStopReasonInput, "issue">>;
}): string | null {
  const result = describeTaskStopReason({
    issue: {
      status: "in_progress",
      assigneeAgentId: "agent-mica",
      assigneeUserId: null,
      ...overrides.issue,
    },
    hasLiveRuns: false,
    currentUserId: "user-john",
    agentNames,
    userLabels: new Map([["user-ana", "Ana"]]),
    formatTime: (date) => date.toISOString().slice(11, 16),
    ...overrides.input,
  });
  return result ? formatTaskStopReason(result) : null;
}

// Every run error code seen on the platform between 25 Sep and 2 Oct 2026.
const CODES_SEEN_LAST_7_DAYS = [
  "cancelled",
  "issue_reassigned",
  "configuration_incomplete",
  "issue_dependencies_blocked",
  "setup_failed",
  "run_silent_timeout",
  "server_shutdown_interrupted",
  "claude_auth_required",
  "acpx_turn_failed",
  "issue_terminal_status",
  "workspace_validation_failed",
  "issue_assignee_changed",
  "process_lost",
  "low_trust_requires_sandbox_environment",
  "operator_interrupted",
  "adapter_failed",
  "queued_comment_discarded",
];

describe("run error code wording", () => {
  it.each(CODES_SEEN_LAST_7_DAYS)("has a plain sentence for %s", (code) => {
    expect(hasPlainRunErrorWording(code)).toBe(true);
    const text = reason({ input: { lastRun: { status: "failed", errorCode: code } } });
    expect(text).not.toBeNull();
    // "cancelled" is also a plain word; only snake_case codes are raw.
    if (code.includes("_")) expect(text).not.toContain(code);
    expect(text).not.toContain("unknown error");
  });

  it.each([
    ["claude_auth_required", "Claude is signed out · You to act · Waiting for you to reconnect Claude"],
    ["process_lost", "The agent stopped without warning · Mica to act · Mica will pick it up again"],
    ["setup_failed", "The run could not start · Mica to act · Waiting for Mica to try again"],
    [
      "configuration_incomplete",
      "The agent has no working AI connection · You to act · Waiting for you to finish the agent's connection settings",
    ],
  ])("words %s in full", (code, expected) => {
    expect(reason({ input: { lastRun: { status: "failed", errorCode: code } } })).toBe(expected);
  });

  it("covers code families by prefix", () => {
    expect(hasPlainRunErrorWording("workspace_git_scan_timeout")).toBe(true);
    expect(hasPlainRunErrorWording("low_trust_boundary_mismatch")).toBe(true);
  });

  it("falls back to the unknown sentence and the task owner", () => {
    expect(hasPlainRunErrorWording("something_new")).toBe(false);
    expect(reason({ input: { lastRun: { status: "failed", errorCode: "something_new" } } })).toBe(
      "The run stopped with an unknown error · Mica to act · Waiting for Mica to look at it",
    );
    expect(reason({ input: { lastRun: { status: "failed", errorCode: null } } })).toContain("unknown error");
  });
});

describe("describeTaskStopReason", () => {
  it("says nothing while a run is live, after success, or once the task is closed", () => {
    expect(reason({ input: { hasLiveRuns: true, lastRun: { status: "failed", errorCode: "process_lost" } } })).toBeNull();
    expect(reason({ input: { lastRun: { status: "succeeded" } } })).toBeNull();
    expect(reason({ issue: { status: "done" }, input: { lastRun: { status: "failed" } } })).toBeNull();
  });

  it("ignores ordinary cancels such as a reassignment", () => {
    expect(reason({ input: { lastRun: { status: "cancelled", errorCode: "issue_reassigned" } } })).toBeNull();
    expect(reason({ input: { lastRun: { status: "cancelled", errorCode: "run_silent_timeout" } } })).toContain(
      "went quiet",
    );
  });

  it("names the agent and time of a planned retry", () => {
    expect(
      reason({
        issue: {
          scheduledRetry: {
            runId: "run-9",
            status: "scheduled_retry",
            agentId: "agent-ridge",
            agentName: "Ridge",
            retryOfRunId: "run-8",
            scheduledRetryAt: "2026-10-02T11:40:00Z",
            scheduledRetryAttempt: 1,
            scheduledRetryReason: null,
          },
        },
        input: { lastRun: { status: "failed", errorCode: "setup_failed" } },
      }),
    ).toBe("The run could not start · Ridge to act · Ridge will try again at 11:40");
  });

  it("names the agent running a repair", () => {
    const text = reason({
      issue: {
        activeRecoveryAction: { status: "active", ownerAgentId: "agent-ridge", ownerUserId: null } as never,
      },
      input: { lastRun: { status: "failed", errorCode: "workspace_validation_failed" } },
    });
    expect(text).toBe("The task's code folder failed its safety check · Ridge to act · Ridge is repairing it");
  });

  it("names the blocking task and its owner", () => {
    const text = reason({
      issue: {
        status: "blocked",
        blockedBy: [
          {
            id: "i-306",
            identifier: "GRE-306",
            title: "Fix login",
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: "agent-ridge",
            assigneeUserId: null,
          },
        ],
      },
      input: { lastRun: { status: "cancelled", errorCode: "issue_dependencies_blocked" } },
    });
    expect(text).toBe("Waiting for GRE-306 · Ridge to act · Starts again when Ridge finishes GRE-306");
  });

  it("says when a blocking task has no owner", () => {
    const text = reason({
      issue: {
        status: "blocked",
        blockedBy: [
          {
            id: "i-1",
            identifier: "GRE-1",
            title: "x",
            status: "todo",
            priority: "low",
            assigneeAgentId: null,
            assigneeUserId: null,
          },
          {
            id: "i-2",
            identifier: "GRE-2",
            title: "y",
            status: "done",
            priority: "low",
            assigneeAgentId: null,
            assigneeUserId: null,
          },
        ],
      },
    });
    expect(text).toBe("Waiting for GRE-1 · nobody assigned to act · GRE-1 needs an owner before this can start");
  });

  it("uses the unblock owner and action on a blocked task", () => {
    expect(
      reason({
        issue: { status: "blocked", unblockDescriptor: { owner: "board", action: "Approve the budget" } },
      }),
    ).toBe("Marked blocked · You to act · Approve the budget");
    expect(
      reason({
        issue: { status: "blocked", unblockDescriptor: { owner: { agentId: "agent-ridge" }, action: "Fix the CI" } },
        input: { lastRun: { status: "failed", errorCode: "claude_auth_required" } },
      }),
    ).toBe("Claude is signed out · Ridge to act · Fix the CI");
  });

  it("asks the owner when a task is blocked with no reason", () => {
    expect(reason({ issue: { status: "blocked" } })).toBe(
      "Marked blocked with no reason given · Mica to act · Waiting for Mica to say what is needed",
    );
  });
});
