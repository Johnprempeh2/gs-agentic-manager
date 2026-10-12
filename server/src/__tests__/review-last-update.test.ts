import { describe, expect, it } from "vitest";
import { pickReviewLastUpdate } from "../services/attention.js";

const ASSIGNEE = "agent-ridge";
const OTHER = "agent-mikey";
const HANDOFF = "Done. The billing page now shows fees, the allowance and the usage warnings. The PR is open for review.";

function row(id: string, authorAgentId: string, body: string, minute: number) {
  return { id, authorAgentId, body, createdAt: new Date(Date.UTC(2026, 9, 12, 6, minute)) };
}

describe("pickReviewLastUpdate (GRE-1421)", () => {
  it("quotes the assignee's hand-off over a newer status note and a newer note from another agent", () => {
    const rows = [
      row("c4", OTHER, "I am reviewing the decision card screenshots and the branch against the brief, then I will reply.", 4),
      row("c3", ASSIGNEE, "Starting: I am reading the review notes and will fix the three points.", 3),
      row("c2", ASSIGNEE, HANDOFF, 2),
      row("c1", ASSIGNEE, "Starting work.", 1),
    ];
    expect(pickReviewLastUpdate(rows, ASSIGNEE)).toMatchObject({ commentId: "c2", kind: "handoff", excerpt: HANDOFF });
  });

  it("falls back to the newest agent comment as the latest update when no hand-off exists", () => {
    const rows = [row("c2", OTHER, "Looks fine.", 2), row("c1", ASSIGNEE, "Starting work.", 1)];
    expect(pickReviewLastUpdate(rows, ASSIGNEE)).toMatchObject({ commentId: "c2", kind: "latest", authorAgentId: OTHER });
  });

  it("uses the newest comment when the task has no agent assignee", () => {
    const rows = [row("c2", OTHER, HANDOFF, 2), row("c1", ASSIGNEE, HANDOFF, 1)];
    expect(pickReviewLastUpdate(rows, null)).toMatchObject({ commentId: "c2", kind: "latest" });
  });

  it("returns null when there are no agent comments", () => {
    expect(pickReviewLastUpdate([], ASSIGNEE)).toBeNull();
  });
});
