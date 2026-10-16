import { describe, expect, it } from "vitest";
import type { IssueBlockedInboxAttention, IssueRecoveryAction, IssueRelationIssueSummary } from "@greatstone/shared";
import { explainWhyBlocked, formatWhyBlocked, type WhyBlocked, type WhyBlockedInput } from "./why-blocked";

const NOW = new Date("2026-10-22T09:00:00.000Z");

const agents = new Map([
  ["agent-grace", { name: "Grace", status: "active" }],
  ["agent-ridge", { name: "Ridge", status: "active" }],
  ["agent-mica", { name: "Mica", status: "paused", pauseReason: "budget" }],
]);

function explain(
  issue: Partial<WhyBlockedInput["issue"]> = {},
  extra: Partial<Omit<WhyBlockedInput, "issue">> = {},
): WhyBlocked | null {
  return explainWhyBlocked({
    issue: {
      id: "issue-1",
      identifier: "GRE-1",
      status: "blocked",
      assigneeAgentId: "agent-ridge",
      assigneeUserId: null,
      ...issue,
    },
    currentUserId: "user-john",
    agents,
    userLabels: new Map([["user-ben", "Ben"]]),
    now: NOW,
    ...extra,
  });
}

function blocker(overrides: Partial<IssueRelationIssueSummary> = {}): IssueRelationIssueSummary {
  return {
    id: "issue-12",
    identifier: "GRE-12",
    title: "Calibrate lidar",
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: "agent-grace",
    assigneeUserId: null,
    ...overrides,
  };
}

function recovery(overrides: Partial<IssueRecoveryAction> = {}): IssueRecoveryAction {
  return {
    id: "rec-1",
    companyId: "co-1",
    sourceIssueId: "issue-1",
    recoveryIssueId: null,
    kind: "stranded_assigned_issue",
    status: "active",
    ownerType: "agent",
    ownerAgentId: "agent-ridge",
    ownerUserId: null,
    previousOwnerAgentId: null,
    returnOwnerAgentId: null,
    cause: "stranded",
    fingerprint: "f",
    evidence: {},
    nextAction: "repair",
    wakePolicy: null,
    monitorPolicy: null,
    attemptCount: 0,
    maxAttempts: null,
    timeoutAt: null,
    lastAttemptAt: null,
    outcome: null,
    resolutionNote: null,
    resolvedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function attention(overrides: Partial<IssueBlockedInboxAttention>): IssueBlockedInboxAttention {
  return {
    kind: "blocked",
    state: "needs_attention",
    reason: "blocked_chain_stalled",
    severity: "high",
    stoppedSinceAt: null,
    owner: { type: "unknown", agentId: null, userId: null, label: null },
    action: { label: "Inspect blocker chain", detail: null },
    sourceIssue: null,
    leafIssue: null,
    recoveryIssue: null,
    approvalId: null,
    interactionId: null,
    sampleIssueIdentifier: null,
    redaction: { externalDetailsRedacted: false, secretFieldsOmitted: true },
    ...overrides,
  };
}

const leaf = {
  id: "issue-40",
  identifier: "GRE-40",
  title: "Order parts",
  status: "todo" as const,
  priority: "medium" as const,
  assigneeAgentId: null,
  assigneeUserId: null,
};

/** Nothing internal may leak into what the reader sees. */
function expectPlain(result: WhyBlocked | null) {
  expect(result).not.toBeNull();
  const text = formatWhyBlocked(result!);
  expect(text).not.toMatch(/[a-z]+_[a-z_]+/); // enum or code names
  expect(text).not.toMatch(/[{}[\]]/); // JSON
  expect(text).not.toMatch(/agent-|user-|issue-\d|rec-1|[0-9a-f]{8}-[0-9a-f]{4}/); // raw ids
  expect(text).not.toMatch(/[\u2013\u2014]/); // en or em dashes
  return result!;
}

describe("explainWhyBlocked", () => {
  it("returns null for tasks that are not blocked and not flagged", () => {
    expect(explain({ status: "in_progress" })).toBeNull();
    expect(explain({ status: "done", blockedBy: [blocker()] })).toBeNull();
  });

  it("names the person and task it waits on", () => {
    const result = expectPlain(explain({ blockedBy: [blocker()] }));
    expect(result.source).toBe("blocker");
    expect(result.headline).toBe("Waiting on Grace to finish 'Calibrate lidar' (GRE-12).");
    expect(result.whoCanUnblock).toBe("Grace");
    expect(result.nextStep).toBe("Nothing to do now. This task starts again when GRE-12 is done.");
    expect(result.link).toEqual({ label: "Open GRE-12", href: "/issues/GRE-12" });
  });

  it("says when there are more blocking tasks", () => {
    const result = expectPlain(
      explain({ blockedBy: [blocker(), blocker({ id: "issue-13", identifier: "GRE-13" }), blocker({ id: "issue-14", identifier: "GRE-14" })] }),
    );
    expect(result.detail).toBe("It is also waiting on 2 other tasks.");
  });

  it("says when the blocking task belongs to the reader", () => {
    const result = expectPlain(explain({ blockedBy: [blocker({ assigneeAgentId: null, assigneeUserId: "user-john" })] }));
    expect(result.headline).toBe("Waiting on you to finish 'Calibrate lidar' (GRE-12).");
    expect(result.whoCanUnblock).toBe("You");
  });

  it("flags a blocking task nobody owns", () => {
    const result = expectPlain(explain({ blockedBy: [blocker({ assigneeAgentId: null })] }));
    expect(result.source).toBe("blocker_unowned");
    expect(result.headline).toBe("Waiting on 'Calibrate lidar' (GRE-12), which nobody owns yet.");
    expect(result.nextStep).toBe("Give GRE-12 an owner so it can start.");
  });

  it("flags a parked blocking task", () => {
    const result = expectPlain(explain({ blockedBy: [blocker({ status: "backlog" })] }));
    expect(result.source).toBe("blocker_parked");
    expect(result.nextStep).toBe("Move GRE-12 out of the backlog so Grace can start it.");
  });

  it("flags a blocking task whose owner is paused", () => {
    const result = expectPlain(explain({ blockedBy: [blocker({ assigneeAgentId: "agent-mica" })] }));
    expect(result.source).toBe("blocker_owner_paused");
    expect(result.headline).toBe("Waiting on Mica to finish 'Calibrate lidar' (GRE-12), but Mica is paused.");
  });

  it("follows a chain to the task that needs someone", () => {
    const result = expectPlain(
      explain({
        blockedBy: [blocker({ status: "blocked", terminalBlockers: [blocker({ id: "issue-40", identifier: "GRE-40", title: "Order parts", assigneeAgentId: null })] })],
      }),
    );
    expect(result.headline).toBe("Waiting on 'Calibrate lidar' (GRE-12), which is held up further down.");
    expect(result.detail).toBe("Waiting on 'Order parts' (GRE-40), which nobody owns yet.");
    expect(result.link?.href).toBe("/issues/GRE-40");
  });

  it("says when everything it waited on is finished", () => {
    const result = expectPlain(explain({ blockedBy: [blocker({ status: "done" })] }));
    expect(result.source).toBe("blockers_finished");
    expect(result.nextStep).toBe("Move it back to To do so the work can start again.");
  });

  it("says when what it waited on was cancelled", () => {
    const result = expectPlain(explain({ blockedBy: [blocker({ status: "cancelled" })] }));
    expect(result.source).toBe("blocker_cancelled");
    expect(result.headline).toBe("It was waiting on 'Calibrate lidar' (GRE-12), which was cancelled.");
  });

  it("explains a wait on a client, with the date passed", () => {
    const result = expectPlain(
      explain({
        unblockDescriptor: { owner: "board", action: "Chase the client for the signed order", waitingOn: "client", expectedBy: "2026-10-20" },
      }),
    );
    expect(result.source).toBe("waiting");
    expect(result.headline).toBe("Waiting on a client until 20 Oct. Date passed 2 days ago.");
    expect(result.datePassed).toBe(true);
    expect(result.whoCanUnblock).toBe("You");
    expect(result.nextStep).toBe("Chase the client for the signed order.");
  });

  it("explains a wait before the date", () => {
    const result = expectPlain(
      explain({ unblockDescriptor: { owner: { agentId: "agent-grace" }, action: "", waitingOn: "outside", expectedBy: "2026-11-02" } }),
    );
    expect(result.headline).toBe("Waiting on someone outside the company until 2 Nov.");
    expect(result.datePassed).toBeUndefined();
    expect(result.whoCanUnblock).toBe("Grace");
    expect(result.nextStep).toBe("Waiting for Grace to act.");
  });

  it("counts the questions waiting for the reader", () => {
    const question = { id: "q", prompt: "?", selectionMode: "single", options: [] };
    const result = expectPlain(
      explain(
        {},
        {
          interactions: [
            { id: "int-1", kind: "ask_user_questions", status: "pending", addresseeAgentId: null, addresseeUserId: null, payload: { questions: [question, question] } },
            { id: "int-0", kind: "ask_user_questions", status: "answered", addresseeAgentId: null, addresseeUserId: null, payload: { questions: [question] } },
          ],
        },
      ),
    );
    expect(result.source).toBe("questions");
    expect(result.headline).toBe("Waiting for you to answer 2 questions.");
    expect(result.whoCanUnblock).toBe("You");
    expect(result.link).toEqual({ label: "Open the request", href: "#interaction-int-1" });
  });

  it("words a confirmation request for someone else", () => {
    const result = expectPlain(
      explain({}, { interactions: [{ id: "int-2", kind: "request_confirmation", status: "pending", addresseeAgentId: null, addresseeUserId: "user-ben" }] }),
    );
    expect(result.headline).toBe("Waiting for Ben to confirm a request.");
    expect(result.whoCanUnblock).toBe("Ben");
  });

  it("points at a pending approval", () => {
    const result = expectPlain(explain({}, { approvals: [{ id: "appr-1", status: "pending" }, { id: "appr-0", status: "approved" }] }));
    expect(result.source).toBe("approval");
    expect(result.headline).toBe("Waiting for you to approve a request.");
    expect(result.link).toEqual({ label: "Open the approval", href: "/approvals/appr-1" });
  });

  it("explains a pause hold placed on a parent task", () => {
    const result = expectPlain(
      explain({}, { pauseHold: { isRoot: false, reason: "Waiting for the board meeting", rootIssue: { id: "issue-3", identifier: "GRE-3", title: "Launch plan" } } }),
    );
    expect(result.source).toBe("pause_hold");
    expect(result.headline).toBe("Paused by a hold on 'Launch plan' (GRE-3).");
    expect(result.detail).toBe("Reason given: Waiting for the board meeting");
    expect(result.link?.href).toBe("/issues/GRE-3");
  });

  it("explains a pause hold on this task", () => {
    const result = expectPlain(explain({}, { pauseHold: { isRoot: true, reason: null } }));
    expect(result.headline).toBe("Paused by a hold: someone paused this task.");
    expect(result.link).toBeNull();
  });

  it("explains an agent that hit its budget", () => {
    const result = expectPlain(explain({ assigneeAgentId: "agent-mica" }));
    expect(result.source).toBe("agent_paused");
    expect(result.headline).toBe("Paused by a hold: Mica hit its budget limit.");
    expect(result.nextStep).toBe("Raise Mica's budget or clear the hold.");
    expect(result.link?.href).toBe("/agents/agent-mica");
  });

  it("explains a run on hold until someone says what happened", () => {
    const result = expectPlain(explain({ activeRecoveryAction: recovery({ cause: "uncertain_external_action" }) }));
    expect(result.source).toBe("run_on_hold");
    expect(result.whoCanUnblock).toBe("You");
  });

  it("explains a repair an agent is making", () => {
    const result = expectPlain(explain({ activeRecoveryAction: recovery() }));
    expect(result.source).toBe("repair");
    expect(result.headline).toBe("Ridge is repairing it. It stopped moving with nobody working on it.");
    expect(result.whoCanUnblock).toBe("Ridge");
  });

  it("explains a repair that needs the board", () => {
    const result = expectPlain(explain({ activeRecoveryAction: recovery({ ownerType: "board", ownerAgentId: null, kind: "workspace_validation" }) }));
    expect(result.headline).toBe("Needs your decision to carry on. The task's code folder failed its safety check.");
  });

  it("explains a stopped run in plain words", () => {
    const result = expectPlain(explain({}, { lastRun: { status: "failed", errorCode: "claude_auth_required" } }));
    expect(result.source).toBe("run_stopped");
    expect(result.headline).toBe("Claude is signed out.");
    expect(result.whoCanUnblock).toBe("You");
    expect(result.nextStep).toBe("Waiting for you to reconnect Claude.");
  });

  it("falls back to a plain sentence when nothing says why", () => {
    const result = expectPlain(explain());
    expect(result.source).toBe("no_reason");
    expect(result.headline).toBe("Marked blocked, but nobody has said why.");
    expect(result.whoCanUnblock).toBe("Ridge");
    expect(result.nextStep).toBe("Ask Ridge what they need, or move it back to To do.");
  });

  it("falls back for an unowned task", () => {
    const result = expectPlain(explain({ assigneeAgentId: null }));
    expect(result.whoCanUnblock).toBe("You");
    expect(result.nextStep).toBe("Give it an owner, or move it back to To do.");
  });

  it("puts what the reader can act on first", () => {
    const result = explain(
      { blockedBy: [blocker()], unblockDescriptor: { owner: "board", action: "x" } },
      { approvals: [{ id: "appr-1", status: "pending" }] },
    );
    expect(result?.source).toBe("approval");
  });

  describe("from the server's reading on list rows", () => {
    it.each([
      [attention({ reason: "pending_board_decision", interactionId: "int-9" }), "questions", "Waiting for you to answer a question on this task."],
      [attention({ reason: "pending_board_decision", approvalId: "appr-9" }), "approval", "Waiting for you to approve a request."],
      [
        attention({ reason: "missing_successful_run_disposition", owner: { type: "agent", agentId: "agent-ridge", userId: null, label: null } }),
        "missing_next_step",
        "Ridge finished a run but did not say what happens next.",
      ],
      [attention({ reason: "blocked_by_unassigned_issue", leafIssue: leaf }), "blocker_unowned", "Waiting on 'Order parts' (GRE-40), which nobody owns yet."],
      [
        attention({ reason: "blocked_by_assigned_backlog_issue", leafIssue: { ...leaf, assigneeAgentId: "agent-grace" } }),
        "blocker_parked",
        "Waiting on 'Order parts' (GRE-40), which is parked and will not start on its own.",
      ],
      [
        attention({ reason: "blocked_by_uninvokable_assignee", leafIssue: { ...leaf, assigneeAgentId: "agent-grace" } }),
        "blocker_owner_paused",
        "Waiting on Grace to finish 'Order parts' (GRE-40), but Grace is paused or cannot run.",
      ],
      [attention({ reason: "blocked_by_cancelled_issue", leafIssue: leaf }), "blocker_cancelled", "It is waiting on 'Order parts' (GRE-40), which was cancelled."],
      [attention({ reason: "blocked_chain_stalled", sampleIssueIdentifier: "GRE-40" }), "chain_stalled", "A task further down the chain has stalled: GRE-40."],
      [attention({ reason: "in_review_without_action_path" }), "review_path", "Waiting for a review, but nobody is set to review it."],
      [attention({ reason: "invalid_review_participant" }), "review_path", "The reviewer set on this task cannot review it."],
      [
        attention({ reason: "open_recovery_issue", sourceIssue: { ...leaf, id: "issue-77", identifier: "GRE-77", title: "Ship release" } }),
        "repair",
        "This task repairs 'Ship release' (GRE-77), which got stuck.",
      ],
      [attention({ reason: "external_owner_action" }), "outside_wait", "Waiting on someone outside the company."],
      [attention({ reason: "blocked_without_action_path" }), "no_reason", "Marked blocked, but nobody has said why."],
    ] as const)("%#: %s", (flag, source, headline) => {
      const result = expectPlain(explain({ blockedInboxAttention: flag }));
      expect(result.source).toBe(source);
      expect(result.headline).toBe(headline);
    });

    it("explains a flagged task that is in review, not blocked", () => {
      const result = explain({ status: "in_review", blockedInboxAttention: attention({ reason: "in_review_without_action_path" }) });
      expect(result?.source).toBe("review_path");
    });

    it("links a question to the task thread", () => {
      const result = explain({ blockedInboxAttention: attention({ reason: "pending_board_decision", interactionId: "int-9" }) });
      expect(result?.link?.href).toBe("/issues/GRE-1#interaction-int-9");
    });
  });
});
