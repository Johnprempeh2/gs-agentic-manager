import { describe, expect, it } from "vitest";
import {
  classifyIssueGraphLiveness,
  type IssueGraphLivenessInput,
  type IssueLivenessIssueInput,
} from "./issue-graph-liveness.js";

// GRE-72: GRE-37 sat `blocked` for hours waiting for a release. Its assignee
// had cleared every blocker and named itself as the unblock owner, so the one
// unblock wake went straight back to the agent that had just parked it. No
// blocker, monitor, interaction or human owner remained to wake it.
const companyId = "company-1";
const now = new Date("2026-09-28T06:00:00.000Z");
const managerId = "agent-everest";
const assigneeId = "agent-summit";

const agents: IssueGraphLivenessInput["agents"] = [
  { id: managerId, companyId, name: "Everest", role: "cos", status: "idle", reportsTo: null },
  { id: assigneeId, companyId, name: "Summit", role: "qa", status: "idle", reportsTo: managerId },
];

function gre37(overrides: Partial<IssueLivenessIssueInput> = {}): IssueLivenessIssueInput {
  return {
    id: "issue-37",
    companyId,
    identifier: "GRE-37",
    title: "Measure time lost to platform faults",
    status: "blocked",
    assigneeAgentId: assigneeId,
    assigneeUserId: null,
    unblockDescriptor: {
      owner: { agentId: assigneeId },
      action: "Take the after number once the fix is released to live.",
    },
    ...overrides,
  };
}

function classify(issue: IssueLivenessIssueInput, extra: Partial<IssueGraphLivenessInput> = {}) {
  return classifyIssueGraphLiveness({ issues: [issue], relations: [], agents, now, ...extra });
}

describe("GRE-72 blocked issue with no action path", () => {
  it("flags a GRE-37-shaped issue and names the assignee's manager as owner", () => {
    const [finding, ...rest] = classify(gre37());
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({
      issueId: "issue-37",
      state: "blocked_without_action_path",
      recoveryIssueId: "issue-37",
      recommendedOwnerAgentId: managerId,
    });
    // The agent that parked the issue is not its own way out.
    expect(finding!.recommendedOwnerCandidateAgentIds).not.toContain(assigneeId);
  });

  it("flags the same shape when no unblock descriptor was set", () => {
    expect(classify(gre37({ unblockDescriptor: null }))[0]?.state).toBe("blocked_without_action_path");
  });

  it("flags a dependent whose only blocker is a GRE-37-shaped issue", () => {
    const dependent: IssueLivenessIssueInput = {
      id: "issue-dependent",
      companyId,
      identifier: "GRE-99",
      title: "Waits on GRE-37",
      status: "blocked",
      assigneeAgentId: managerId,
    };
    const findings = classifyIssueGraphLiveness({
      issues: [gre37(), dependent],
      relations: [{ companyId, blockerIssueId: "issue-37", blockedIssueId: "issue-dependent" }],
      agents,
      now,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      issueId: "issue-dependent",
      state: "blocked_without_action_path",
      recoveryIssueId: "issue-37",
      recommendedOwnerAgentId: managerId,
    });
  });

  it.each([
    ["a board-owned unblock descriptor", gre37({ unblockDescriptor: { owner: "board", action: "Release it." } }), {}],
    ["a user-owned unblock descriptor", gre37({ unblockDescriptor: { owner: { userId: "john" }, action: "Release it." } }), {}],
    ["a human assignee", gre37({ assigneeUserId: "john" }), {}],
    [
      "a scheduled monitor",
      gre37({ monitorNextCheckAt: "2026-09-29T06:45:00.000Z" }),
      {},
    ],
    ["a pending interaction", gre37(), { pendingInteractions: [{ companyId, issueId: "issue-37", status: "pending" }] }],
    ["a pending approval", gre37(), { pendingApprovals: [{ companyId, issueId: "issue-37", status: "pending" }] }],
    // The recovery path parks exhausted work as `blocked` with no blocker; its
    // open recovery action already has an owner and is on the board.
    ["an open recovery action", gre37({ unblockDescriptor: null }), { openRecoveryIssues: [{ companyId, issueId: "issue-37", status: "escalated" }] }],
    ["a queued wake", gre37(), { queuedWakeRequests: [{ companyId, issueId: "issue-37", status: "queued" }] }],
  ] as const)("does not flag an issue with %s", (_label, issue, extra) => {
    expect(classify(issue, extra as Partial<IssueGraphLivenessInput>)).toEqual([]);
  });

  it("does not flag a blocked issue that waits on a live blocker", () => {
    const blocker: IssueLivenessIssueInput = {
      id: "issue-blocker",
      companyId,
      identifier: "GRE-34",
      title: "Fix",
      status: "in_progress",
      assigneeAgentId: managerId,
    };
    expect(classifyIssueGraphLiveness({
      issues: [gre37({ unblockDescriptor: null }), blocker],
      relations: [{ companyId, blockerIssueId: "issue-blocker", blockedIssueId: "issue-37" }],
      agents,
      now,
    })).toEqual([]);
  });
});
