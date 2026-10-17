import { describe, expect, it } from "vitest";
import { formatCents } from "./utils";
import { agentMonthLine, monthPace, monthPaceLine } from "./spend-pace";

describe("monthPace", () => {
  it("projects the month from the days so far", () => {
    // 10 Oct: $100 over 10 days, 31 days in October.
    expect(monthPace(10_000, 0, new Date(2026, 9, 10, 12))).toEqual({ projectedCents: 31_000, overBudgetOn: null });
  });

  it("names the day the budget runs out", () => {
    const pace = monthPace(10_000, 20_000, new Date(2026, 9, 10, 12));
    expect(pace?.overBudgetOn).toEqual(new Date(2026, 9, 20));
    expect(monthPaceLine(pace)).toBe("On pace to pass the budget around 20 Oct");
  });

  it("stays quiet in the first two days and with no spend", () => {
    expect(monthPace(10_000, 0, new Date(2026, 9, 2))).toBeNull();
    expect(monthPace(0, 1000, new Date(2026, 9, 20))).toBeNull();
  });

  it("does not warn once the budget is already spent", () => {
    expect(monthPace(30_000, 20_000, new Date(2026, 9, 10))?.overBudgetOn).toBeNull();
    expect(monthPaceLine(monthPace(10_000, 50_000, new Date(2026, 9, 10)))).toBe(
      `On pace for ${formatCents(31_000)} by month end`,
    );
  });
});

describe("agentMonthLine", () => {
  it("says what the agent spent and where it is heading", () => {
    const now = new Date(2026, 9, 10, 12);
    expect(agentMonthLine({ spentMonthlyCents: 0, budgetMonthlyCents: 1000 }, now)).toBeNull();
    expect(agentMonthLine({ spentMonthlyCents: 1000, budgetMonthlyCents: 0 }, now)).toBe("$10.00 spent. On pace for $31.00 by month end");
    expect(agentMonthLine({ spentMonthlyCents: 1000, budgetMonthlyCents: 2000 }, now)).toBe(
      "$10.00 spent. On pace to pass the budget around 20 Oct",
    );
    expect(agentMonthLine({ spentMonthlyCents: 1000 }, new Date(2026, 9, 2))).toBe("$10.00 spent");
  });
});
