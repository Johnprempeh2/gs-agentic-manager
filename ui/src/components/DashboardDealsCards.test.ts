import { describe, expect, it } from "vitest";
import type { PipelineCaseChildRow } from "../api/pipelines";
import { summariseDevtoolsDeals } from "./DashboardDealsCards";

const row = (kind: string, fields: Record<string, unknown>) =>
  ({ case: { id: Math.random().toString(), fields }, stage: { kind } }) as unknown as PipelineCaseChildRow;

describe("summariseDevtoolsDeals", () => {
  it("adds up open deals, flags missing next steps and counts this month's wins", () => {
    const summary = summariseDevtoolsDeals(
      [
        row("working", { dealStatus: "Open", dealValue: 10000, dealCurrency: "GBP", probability: 50, nextActivityDate: "2026-10-25" }),
        row("working", { dealStatus: "Open", dealValue: 2000, dealCurrency: "GBP" }),
        row("done", { dealStatus: "Won", dealValue: 3000, dealCurrency: "GBP", wonOn: "2026-10-05" }),
        row("done", { dealStatus: "Won", dealValue: 9000, dealCurrency: "GBP", wonOn: "2026-09-05" }),
        row("cancelled", { dealStatus: "Lost", dealValue: 4000, dealCurrency: "GBP" }),
      ],
      new Date("2026-10-17T12:00:00Z"),
    );
    expect(summary).toEqual({
      openCount: 2,
      openValue: "12,000 GBP",
      weightedValue: "5,000 GBP",
      needingNextStep: 1,
      wonThisMonth: { count: 1, totals: [{ currency: "GBP", total: 3000 }] },
    });
  });
});
