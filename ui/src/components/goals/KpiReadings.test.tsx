// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { GoalKpiReading, KpiStatus } from "@greatstone/shared";
import { KpiReadingsList, KpiStatusPill, kpiStatusSentence, rollupSummary } from "./KpiReadings";
import { budgetSummary } from "./KpiPlanForm";

function reading(id: string, overrides: Partial<GoalKpiReading>): GoalKpiReading {
  return {
    id,
    companyId: "c1",
    goalId: "kpi1",
    value: 100,
    readingDate: "2026-10-01",
    note: null,
    source: "owner_reported",
    recordedByAgentId: null,
    recordedByUserId: null,
    createdAt: new Date(2026, 9, 1),
    ...overrides,
  };
}

const names = {
  agents: new Map([["ag-check", { name: "Summit" }]]),
  users: new Map([["u-ben", { label: "Ben" }]]),
};

describe("KpiReadingsList", () => {
  it("shows each reading's source and who recorded it", () => {
    const html = renderToStaticMarkup(
      <KpiReadingsList
        unit="staff"
        names={names}
        readings={[
          reading("r3", { value: 128, source: "agent_verified", recordedByAgentId: "ag-check", note: "Payroll says 128" }),
          reading("r2", { value: 1500, source: "system", recordedByAgentId: "ag-check" }),
          reading("r1", { value: 152, source: "owner_reported", recordedByUserId: "u-ben" }),
        ]}
      />,
    );
    expect(html.match(/data-source="([a-z_]+)"/g)).toEqual([
      'data-source="agent_verified"',
      'data-source="system"',
      'data-source="owner_reported"',
    ]);
    expect(html).toContain("Agent verified");
    expect(html).toContain("From a system");
    expect(html).toContain("Owner reported");
    expect(html).toContain("Recorded by Summit");
    expect(html).toContain("Recorded by Ben");
    expect(html).toContain("128 staff");
    expect(html).toContain("1,500 staff");
    expect(html).toContain("Payroll says 128");
  });

  it("explains the empty state", () => {
    const html = renderToStaticMarkup(<KpiReadingsList unit={null} names={names} readings={[]} />);
    expect(html).toContain("No readings yet");
  });
});

describe("KPI status text", () => {
  const base: KpiStatus = {
    status: "amber",
    reason: "behind_plan",
    plannedValue: 150,
    gapPercent: 12,
    latestValue: 138,
    latestDate: "2026-10-01",
  };

  it("says why the KPI has its colour", () => {
    expect(kpiStatusSentence(base, null)).toBe("12% behind plan: 138 against a plan of 150 on that date.");
    expect(kpiStatusSentence({ ...base, status: "red", reason: "deadline_missed", plannedValue: 200 }, "USD")).toBe(
      "Deadline passed and the target is not met: 138 USD against 200 USD.",
    );
    expect(kpiStatusSentence({ ...base, status: null, reason: "no_reading" }, null)).toBe("No reading yet.");
    expect(kpiStatusSentence({ ...base, status: null, reason: "no_plan" }, null)).toMatch(/Set a target and a deadline/);
  });

  it("labels the pill with the colour and its meaning", () => {
    expect(renderToStaticMarkup(<KpiStatusPill status="red" />)).toContain("Red · off track");
    expect(renderToStaticMarkup(<KpiStatusPill status={null} />)).toContain("No status");
  });

  it("summarises the KPIs under a goal", () => {
    expect(rollupSummary({ status: "red", red: 1, amber: 1, green: 2, noStatus: 1 })).toBe(
      "1 red, 1 amber, 2 green, 1 no status of 5 KPIs",
    );
    expect(rollupSummary({ status: null, red: 0, amber: 0, green: 0, noStatus: 0 })).toBeNull();
  });
});

describe("budgetSummary", () => {
  it("shows spent against planned", () => {
    expect(budgetSummary({ budgetPlannedCents: 400_000, budgetSpentCents: 100_000, budgetCurrency: "USD" })).toMatch(
      /^Spent \$1,000 of \$4,000 \(25%\)$/,
    );
    expect(budgetSummary({ budgetPlannedCents: null, budgetSpentCents: null, budgetCurrency: null })).toBeNull();
    expect(budgetSummary({ budgetPlannedCents: null, budgetSpentCents: 5_000, budgetCurrency: null })).toBe(
      "Spent 50, no planned budget",
    );
  });
});
