import { describe, expect, it } from "vitest";
import type { CostByAgent, CostByProject } from "@greatstone/shared";
import { costsByAgentSheet, costsByProjectSheet, costsFileName } from "./costs-export";

const agent = (overrides: Partial<CostByAgent>): CostByAgent => ({
  agentId: "a1",
  agentName: "Ridge",
  agentStatus: "active",
  costCents: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  apiRunCount: 0,
  subscriptionRunCount: 0,
  subscriptionCachedInputTokens: 0,
  subscriptionInputTokens: 0,
  subscriptionOutputTokens: 0,
  ...overrides,
});

describe("costsByAgentSheet", () => {
  it("lists agents by spend in dollars, adding subscription runs and tokens", () => {
    const sheet = costsByAgentSheet([
      agent({ agentId: "a1", agentName: "Ridge", costCents: 1234, apiRunCount: 2, subscriptionRunCount: 3, inputTokens: 10, subscriptionInputTokens: 5 }),
      agent({ agentId: "a2", agentName: null, costCents: 99999 }),
    ]);
    expect(sheet.headers[1]).toBe("Spend ($)");
    expect(sheet.rows[0]).toEqual(["Unknown agent", 999.99, 0, 0, 0, 0]);
    expect(sheet.rows[1]).toEqual(["Ridge", 12.34, 5, 15, 0, 0]);
  });
});

describe("costsByProjectSheet", () => {
  it("names spend with no project", () => {
    const rows: CostByProject[] = [
      { projectId: null, projectName: null, costCents: 500, inputTokens: 1, cachedInputTokens: 0, outputTokens: 2 },
      { projectId: "p1", projectName: "Website", costCents: 700, inputTokens: 3, cachedInputTokens: 0, outputTokens: 4 },
    ];
    expect(costsByProjectSheet(rows).rows.map((row) => row[0])).toEqual(["Website", "No project"]);
  });
});

describe("costsFileName", () => {
  it("names the file after the organisation and range", () => {
    expect(costsFileName("GRE", "2026-10-01T00:00:00.000Z", "2026-10-16T12:00:00.000Z", "2026-10-16")).toBe(
      "gre-costs-2026-10-01-to-2026-10-16.xlsx",
    );
    expect(costsFileName(null, undefined, undefined, "2026-10-16")).toBe("costs-all-time-2026-10-16.xlsx");
  });
});
