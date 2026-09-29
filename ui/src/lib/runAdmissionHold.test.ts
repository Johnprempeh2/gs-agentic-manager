import { describe, expect, it } from "vitest";
import { runAdmissionWaitMessage } from "./runAdmissionHold";

describe("runAdmissionWaitMessage (GRE-198)", () => {
  it("returns the hold line for a queued run held by admission", () => {
    expect(
      runAdmissionWaitMessage({
        status: "queued",
        currentStatusMessage: "Waiting: low memory (1.6 GB free, floor 2 GB)",
      }),
    ).toBe("Waiting: low memory (1.6 GB free, floor 2 GB)");
  });

  it("returns the low-disk hold line (GRE-207)", () => {
    expect(
      runAdmissionWaitMessage({
        status: "queued",
        currentStatusMessage: "Waiting: low disk (12 GB free, floor 20 GB)",
      }),
    ).toBe("Waiting: low disk (12 GB free, floor 20 GB)");
  });

  it("ignores running runs and queued runs without a hold line", () => {
    expect(
      runAdmissionWaitMessage({
        status: "running",
        currentStatusMessage: "Waiting: low memory (1.6 GB free, floor 2 GB)",
      }),
    ).toBeNull();
    expect(runAdmissionWaitMessage({ status: "queued" })).toBeNull();
    expect(
      runAdmissionWaitMessage({ status: "queued", currentStatusMessage: "Editing files" }),
    ).toBeNull();
  });
});
