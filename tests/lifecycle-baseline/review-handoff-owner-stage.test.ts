import { describe, expect, it } from "vitest";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
} from "../../server/src/services/issue-execution-policy.js";

// GRE-1903 (found on GRE-1899): Keystone owned the work and was also the only
// reviewer of stage 2. Mikey's stage 1 approval found nobody to hand stage 2
// to, the PATCH failed with a 422, and the issue stranded in review.
const owner = "00000000-0000-4000-8000-000000000001"; // Keystone
const firstReviewer = "00000000-0000-4000-8000-000000000002"; // Mikey

function approveStageOne(stageTwoType: "review" | "approval") {
  const policy = normalizeIssueExecutionPolicy({
    stages: [
      { type: "review", participants: [{ type: "agent", agentId: firstReviewer }] },
      { type: stageTwoType, participants: [{ type: "agent", agentId: owner }] },
    ],
  })!;
  const run = () =>
    applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: firstReviewer,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: policy.stages[0].id,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: firstReviewer },
          returnAssignee: { type: "agent", agentId: owner },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: firstReviewer },
      commentBody: "Approved",
    });
  return { policy, run };
}

describe("GRE-1903: approval past a stage only the work owner can review", () => {
  it("records the approval and skips the owner's stage with a note", () => {
    const { policy, run } = approveStageOne("review");
    const result = run();
    expect(result.decision).toMatchObject({ stageId: policy.stages[0].id, outcome: "approved" });
    expect(result.patch.executionState).toMatchObject({
      status: "completed",
      completedStageIds: [policy.stages[0].id, policy.stages[1].id],
    });
    expect(result.skippedStageNote).toContain("stage 2 (review)");
  });

  it("names the stage and the reason when it cannot skip", () => {
    const { run } = approveStageOne("approval");
    expect(run).toThrow(
      "No eligible participant for stage 2 (approval): its only participant is the work owner",
    );
  });
});
