import { describe, expect, it } from "vitest";
import type { AgentWorkDigest } from "@greatstone/shared";
import { digestText } from "./digest-text";

describe("digestText", () => {
  it("puts the headline first, then each agent with its lines", () => {
    const agents = [
      { agentId: "a", agentName: "Ridge", items: [{ label: "Finished GRE-12: Faster board" }, { label: "Started GRE-13: Pricing" }] },
      { agentId: "b", agentName: "Quiet", items: [] },
    ] as unknown as AgentWorkDigest["agents"];
    expect(digestText({ agents }, "In the last 24 hours: 1 task finished, 1 started.").split("\n")).toEqual([
      "In the last 24 hours: 1 task finished, 1 started.",
      "",
      "Ridge",
      "• Finished GRE-12: Faster board",
      "• Started GRE-13: Pricing",
    ]);
  });
});
