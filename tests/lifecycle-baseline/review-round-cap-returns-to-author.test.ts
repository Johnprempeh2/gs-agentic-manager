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

describe("GRE-2049: the review round cap never parks an agent verdict on a human", () => {
  it("returns every agent verdict to the author, then sends the capped resubmit to the human", () => {
    let issue: Issue = {
      status: "in_review",
      assigneeAgentId: reviewer,
      assigneeUserId: null,
      responsibleUserId: john,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewer },
        returnAssignee: { type: "agent", agentId: author },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };

    for (let round = 1; round <= 3; round += 1) {
      issue = step(issue, reviewer, "in_progress", `Round ${round}: fix it`);
      expect(issue).toMatchObject({ status: "in_progress", assigneeAgentId: author, assigneeUserId: null });
      issue = step(issue, author, "in_review", `Fixed round ${round}`);
      const expected = round < 3
        ? { assigneeAgentId: reviewer, assigneeUserId: null }
        : { assigneeAgentId: null, assigneeUserId: john };
      expect(issue).toMatchObject({ status: "in_review", ...expected });
    }
  });
});
