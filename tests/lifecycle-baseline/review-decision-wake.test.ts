import { describe, expect, it } from "vitest";
import { renderPaperclipWakePrompt } from "../../packages/adapter-utils/src/server-utils.js";

// GRE-1781 (found on GRE-1777): the reviewer wake never named the call that
// records a decision, so an agent reviewer posted "Approved:" comments, the
// stage stayed pending, and the tree stranded in blocked. The wake also showed
// the previous stage's "approved" as if it were this stage's decision.
function reviewWake(input: {
  wakeRole: "reviewer" | "approver";
  lastDecisionOutcome: string | null;
}) {
  return renderPaperclipWakePrompt({
    reason:
      input.wakeRole === "approver"
        ? "execution_approval_requested"
        : "execution_review_requested",
    issue: {
      id: "issue-1777",
      identifier: "GRE-1777",
      title: "Upload deliverables",
      status: "in_review",
    },
    executionStage: {
      wakeRole: input.wakeRole,
      stageId: "stage-flint",
      stageType: input.wakeRole === "approver" ? "approval" : "review",
      currentParticipant: { type: "agent", agentId: "flint" },
      returnAssignee: { type: "agent", agentId: "harbor" },
      lastDecisionOutcome: input.lastDecisionOutcome,
      allowedActions: ["approve", "request_changes"],
    },
    fallbackFetchNeeded: false,
  });
}

describe("GRE-1781: reviewer wake says how to record a decision", () => {
  for (const wakeRole of ["reviewer", "approver"] as const) {
    it(`gives the ${wakeRole} the decision PATCH for approve and request changes`, () => {
      const prompt = reviewWake({ wakeRole, lastDecisionOutcome: null });
      expect(prompt).toContain(
        '`PATCH /api/issues/issue-1777` with `{"status": "done", "comment": ',
      );
      expect(prompt).toContain(
        '`PATCH /api/issues/issue-1777` with `{"status": "in_progress", "comment": ',
      );
      expect(prompt).toContain("A comment alone does not record a decision");
      expect(prompt).toContain("earlier comments do not count");
      expect(prompt).toContain("same PATCH request");
    });
  }

  it("does not show an earlier stage's approval as this stage's decision", () => {
    const prompt = reviewWake({ wakeRole: "reviewer", lastDecisionOutcome: "approved" });
    expect(prompt).not.toContain("last decision outcome: approved");
    expect(prompt).toContain("- decision on this stage: none recorded yet");
  });

  it("labels a changes-requested outcome as this stage's earlier round", () => {
    const prompt = reviewWake({
      wakeRole: "reviewer",
      lastDecisionOutcome: "changes_requested",
    });
    expect(prompt).toContain(
      "- last decision on this stage: changes_requested (an earlier round; this round has no decision yet)",
    );
  });
});
