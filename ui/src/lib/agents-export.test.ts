import { describe, expect, it } from "vitest";
import type { Agent, AgentTeam } from "@greatstone/shared";
import { agentsSheet } from "./agents-export";

const agent = (over: Partial<Agent>): Agent =>
  ({
    id: "a",
    name: "A",
    role: "general",
    title: null,
    status: "idle",
    reportsTo: null,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    lastHeartbeatAt: null,
    ...over,
  }) as Agent;

describe("agentsSheet", () => {
  it("lists agents by name with manager, teams and money in dollars", () => {
    const sheet = agentsSheet(
      [
        agent({ id: "r", name: "Ridge", status: "running", reportsTo: "k", budgetMonthlyCents: 5000, spentMonthlyCents: 1234, lastHeartbeatAt: new Date(2026, 9, 16, 10) }),
        agent({ id: "k", name: "Keystone", title: "Chief of staff" }),
      ],
      new Map([["r", [{ id: "t", name: "Sales" } as AgentTeam]]]),
    );
    expect(sheet.headers[0]).toBe("Agent");
    expect(sheet.rows[0][0]).toBe("Keystone");
    expect(sheet.rows[0][2]).toBe("Chief of staff");
    expect(sheet.rows[0][6]).toBe("");
    expect(sheet.rows[1]).toEqual(["Ridge", expect.any(String), "", "Working now", "Keystone", "Sales", 50, 12.34, "2026-10-16"]);
  });
});
