import { describe, expect, it } from "vitest";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
} from "../../server/src/services/issue-execution-policy.js";

// GRE-2049 (found on GRE-2044): Mikey, the only reviewer, asked for changes a
// third time. The round cap handed the stage to John, who had nothing to
// decide, and Slate could not pick up the fix.
const author = "00000000-0000-4000-8000-000000000001"; // Slate
const reviewer = "00000000-0000-4000-8000-000000000002"; // Mikey
const john = "john-user";
const lead = "00000000-0000-4000-8000-000000000003"; // chief of staff

const policy = normalizeIssueExecutionPolicy({
  stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewer }] }],
})!;

type Issue = Parameters<typeof applyIssueExecutionPolicyTransition>[0]["issue"];

function step(issue: Issue, actorAgentId: string, requestedStatus: string, commentBody: string): Issue {
  const result = applyIssueExecutionPolicyTransition({
    issue,
    policy,
    requestedStatus,
    requestedAssigneePatch: {},
    actor: { agentId: actorAgentId },
    commentBody,
  });
  return { ...issue, ...(result.patch.status ? {} : { status: requestedStatus }), ...result.patch } as Issue;
}

function pendingWith(participant: { type: "agent"; agentId: string } | { type: "user"; userId: string }, changesRequestedCount = 0): Issue {
  return {
    status: "in_review",
    assigneeAgentId: participant.type === "agent" ? participant.agentId : null,
    assigneeUserId: participant.type === "user" ? participant.userId : null,
    responsibleUserId: john,
    executionPolicy: policy,
    executionState: {
      status: "pending",
      currentStageId: policy.stages[0].id,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: participant,
      returnAssignee: { type: "agent", agentId: author },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      changesRequestedCount,
    },
  };
}

// GRE-2161 (found on GRE-2118): after Keystone's third change request (all
// merge conflicts) the author's resubmit handed the PR review to John, who
// was not in the stage, and nobody else could move it.
describe("GRE-2049 / GRE-2161: a review stage stays with its listed participants", () => {
  it("returns every agent verdict to the author and every resubmit to the reviewer", () => {
    let issue = pendingWith({ type: "agent", agentId: reviewer });

    for (let round = 1; round <= 4; round += 1) {
      issue = step(issue, reviewer, "in_progress", `Round ${round}: fix it`);
      expect(issue).toMatchObject({ status: "in_progress", assigneeAgentId: author, assigneeUserId: null });
      issue = step(issue, author, "in_review", `Fixed round ${round}`);
      expect(issue).toMatchObject({ status: "in_review", assigneeAgentId: reviewer, assigneeUserId: null });
    }
  });

  it("lets the reviewer or the chief of staff take back a stage left on a non-participant", () => {
    for (const actor of [reviewer, lead, author]) {
      const issue = step(pendingWith({ type: "user", userId: john }, 3), actor, "in_review", "");
      expect(issue).toMatchObject({
        status: "in_review",
        assigneeAgentId: reviewer,
        assigneeUserId: null,
        executionState: { status: "pending", currentParticipant: { type: "agent", agentId: reviewer } },
      });
    }
  });
});
