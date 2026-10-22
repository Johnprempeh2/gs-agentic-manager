import { describe, expect, it } from "vitest";
import { resolveHeartbeatRunResponse } from "../../server/src/services/heartbeat-run-summary.js";

// GRE-1897 (register row 138): agents post "I will check now" first, then do the
// work and end with the answer in their final message. The server reused the
// opening comment as the run's reply, so the answer was never posted and the
// task read as stopped. GRE-677 run cd89d50c sat 9.3 hours this way.
describe("GRE-1897: an opening acknowledgement does not hide the final report", () => {
  const run = {
    runStartedAt: new Date("2026-10-07T21:10:18Z"),
    runFinishedAt: new Date("2026-10-07T21:13:16Z"),
  };
  const acknowledgement = {
    id: "ack",
    body: "Thanks John. I will check the TST queue, inbox and test tickets now, then record the table.",
    createdAt: new Date("2026-10-07T21:10:32Z"),
  };
  const report = "The inbox is connected, but the TST support queue still isn't set up. Back to blocked on John.";

  it("posts the final report when the only comment was an early acknowledgement", () => {
    const resolved = resolveHeartbeatRunResponse({
      ...run,
      resultJson: { summary: report },
      existingComment: acknowledgement,
    });
    expect(resolved.text).toBe(report);
    expect(resolved.decision.commentAction).toBe("create");
  });

  it("still reuses a closing comment instead of posting twice", () => {
    const resolved = resolveHeartbeatRunResponse({
      ...run,
      resultJson: { summary: report },
      existingComment: { ...acknowledgement, body: report, createdAt: new Date("2026-10-07T21:13:10Z") },
    });
    expect(resolved.decision.commentAction).toBe("reuse");
  });
});
