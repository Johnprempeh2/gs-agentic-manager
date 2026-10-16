import { describe, expect, it } from "vitest";
import { buildHoldReconciliation } from "./recoveryHolds";

describe("buildHoldReconciliation", () => {
  it("maps each plain answer to the recorded outcome", () => {
    expect(buildHoldReconciliation({ runId: "r1", choice: "not_sure" })).toMatchObject({
      runId: "r1",
      providerStopped: true,
      actionOutcome: "mixed",
    });
    expect(buildHoldReconciliation({ runId: "r1", choice: "it_finished" }).actionOutcome).toBe("completed");
    expect(buildHoldReconciliation({ runId: "r1", choice: "it_did_not_happen" }).actionOutcome).toBe("not_performed");
  });

  it("always sends enough evidence and carries the board's notes", () => {
    const decision = buildHoldReconciliation({
      runId: "r1",
      choice: "not_sure",
      note: " The email may have gone ",
      workspaceNote: "Checked the branch is clean and matches GitHub.",
    });
    expect(decision.outcomeEvidence.length).toBeGreaterThanOrEqual(20);
    expect(decision.outcomeEvidence).toContain("Note from the board: The email may have gone");
    expect(decision.workspaceRepairEvidence).toBe("Checked the branch is clean and matches GitHub.");
    expect(buildHoldReconciliation({ runId: "r1", choice: "it_finished", workspaceNote: "  " })).not.toHaveProperty(
      "workspaceRepairEvidence",
    );
  });
});
