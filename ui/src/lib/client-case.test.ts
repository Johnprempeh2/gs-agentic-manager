import { describe, expect, it } from "vitest";
import { CLIENT_RECORD_FIELD_KEYS, averageDaysInStage, dealNextStepLabel, dealWinRate, dealsClosedThisMonth, forecastByCloseMonth, formatDealTotals, isDevtoolsCaseType, readCardSummary, readClientRecord, readDevtoolsDeal, sumDealValues, weightedDealValues } from "./client-case";

describe("readClientRecord", () => {
  it("shows the deal owner from a Pipedrive or HubSpot import as the owner", () => {
    expect(readClientRecord({ dealOwner: "Ben Asante" }).owner).toBe("Ben Asante");
    expect(readCardSummary({ dealOwner: "Ben Asante" }).owner).toBe("Ben Asante");
    expect(CLIENT_RECORD_FIELD_KEYS.has("dealOwner")).toBe(true);
  });

  it("prefers an owner set in GSAM over the imported deal owner", () => {
    expect(readClientRecord({ ownerPerson: "John", dealOwner: "Ben Asante" }).owner).toBe("John");
  });
});

describe("DevTools clients", () => {
  it("treats Pipedrive pipelines and the leads inbox as DevTools clients", () => {
    expect(isDevtoolsCaseType("pipedrive-12")).toBe(true);
    expect(isDevtoolsCaseType("pipedrive-leads")).toBe(true);
    expect(isDevtoolsCaseType("client")).toBe(false);
    expect(isDevtoolsCaseType(null)).toBe(false);
  });

  it("reads a deal and falls back to lead fields", () => {
    expect(readDevtoolsDeal({ dealStatus: "Lost", lostOn: "2026-09-01", lostReason: "Budget", dealValue: "900" })).toMatchObject({
      status: "Lost",
      closedOn: "2026-09-01",
      lostReason: "Budget",
      value: 900,
    });
    expect(readDevtoolsDeal({ leadValue: 300, leadCurrency: "EUR", leadOwner: "Ben" })).toMatchObject({
      value: 300,
      currency: "EUR",
      owner: "Ben",
      status: null,
    });
  });
});

describe("deal value totals", () => {
  it("sums deal and lead values per currency, largest first, and skips cases with none", () => {
    const totals = sumDealValues([
      { fields: { dealValue: 1000, dealCurrency: "GBP" } },
      { fields: { dealValue: "2500.4", dealCurrency: "GBP" } },
      { fields: { leadValue: 9000, leadCurrency: "USD" } },
      { fields: { title: "No value" } },
      { fields: null },
    ]);
    expect(totals).toEqual([
      { currency: "USD", total: 9000 },
      { currency: "GBP", total: 3500.4 },
    ]);
    expect(formatDealTotals(totals)).toBe("9,000 USD + 3,500 GBP");
    expect(formatDealTotals(sumDealValues([{ fields: {} }]))).toBe("");
  });
});

describe("dealsClosedThisMonth", () => {
  it("counts deals won or lost this calendar month with their values", () => {
    const now = new Date("2026-10-16T18:00:00Z");
    const cases = [
      { fields: { dealStatus: "Won", wonOn: "2026-10-02", dealValue: 9000, dealCurrency: "USD" } },
      { fields: { dealStatus: "won", wonOn: "2026-10-15T09:00:00Z", dealValue: 1000, dealCurrency: "USD" } },
      { fields: { dealStatus: "Won", wonOn: "2026-09-30", dealValue: 5000, dealCurrency: "USD" } },
      { fields: { dealStatus: "Lost", lostOn: "2026-10-10", dealValue: 2000, dealCurrency: "GBP" } },
      { fields: { dealStatus: "Open", dealValue: 7000, dealCurrency: "USD" } },
    ];
    expect(dealsClosedThisMonth(cases, "won", now)).toEqual({ count: 2, totals: [{ currency: "USD", total: 10000 }] });
    expect(dealsClosedThisMonth(cases, "lost", now)).toEqual({ count: 1, totals: [{ currency: "GBP", total: 2000 }] });
  });
});

describe("weightedDealValues", () => {
  it("weights each deal by its probability and skips deals without one", () => {
    expect(
      weightedDealValues([
        { fields: { dealValue: 10000, dealCurrency: "GBP", probability: 50 } },
        { fields: { dealValue: 2000, dealCurrency: "GBP", probability: "25" } },
        { fields: { dealValue: 4000, dealCurrency: "USD", probability: 100 } },
        { fields: { dealValue: 9000, dealCurrency: "USD" } },
        { fields: { dealValue: 1000, dealCurrency: "USD", probability: 150 } },
      ]),
    ).toEqual([
      { currency: "GBP", total: 5500 },
      { currency: "USD", total: 5000 },
    ]);
  });
});

describe("forecastByCloseMonth", () => {
  it("groups open deals by expected close month, with overdue, later and no date", () => {
    const deal = (value: number, expectedCloseDate?: string, extra: Record<string, unknown> = {}) => ({
      fields: { dealStatus: "Open", dealValue: value, dealCurrency: "GBP", probability: 50, ...(expectedCloseDate ? { expectedCloseDate } : {}), ...extra },
    });
    const buckets = forecastByCloseMonth(
      [
        deal(1000, "2026-09-30"),
        deal(2000, "2026-10-20"),
        deal(3000, "2026-10-28"),
        deal(4000, "2026-12-01"),
        deal(5000, "2027-03-01"),
        deal(6000),
        deal(7000, "2026-10-01", { dealStatus: "Won" }),
        { fields: { dealStatus: "Open", expectedCloseDate: "2026-10-05" } },
      ],
      new Date("2026-10-17T12:00:00Z"),
    );
    expect(buckets.map((bucket) => [bucket.label, bucket.count, bucket.totals[0]?.total ?? 0, bucket.weighted[0]?.total ?? 0])).toEqual([
      ["Overdue", 1, 1000, 500],
      ["Oct 2026", 2, 5000, 2500],
      ["Nov 2026", 0, 0, 0],
      ["Dec 2026", 1, 4000, 2000],
      ["Later", 1, 5000, 2500],
      ["No close date", 1, 6000, 3000],
    ]);
  });
});

describe("dealWinRate and averageDaysInStage", () => {
  const now = new Date("2026-10-17T12:00:00Z");
  it("counts deals won and lost in the last 90 days", () => {
    expect(
      dealWinRate(
        [
          { fields: { dealStatus: "Won", wonOn: "2026-10-01" } },
          { fields: { dealStatus: "Won", wonOn: "2026-05-01" } },
          { fields: { dealStatus: "Lost", lostOn: "2026-09-20" } },
          { fields: { dealStatus: "Lost", lostOn: "2026-08-20" } },
          { fields: { dealStatus: "Open" } },
        ],
        now,
      ),
    ).toEqual({ won: 1, lost: 2, percent: 33 });
    expect(dealWinRate([{ fields: { dealStatus: "Open" } }], now)).toBeNull();
  });

  it("averages the days in stage", () => {
    expect(averageDaysInStage([{ stageEnteredAt: "2026-10-07T12:00:00Z" }, { stageEnteredAt: "2026-10-14T12:00:00Z" }, {}], now)).toBe(7);
    expect(averageDaysInStage([{}], now)).toBeNull();
  });
});

describe("dealNextStepLabel", () => {
  it("shows the next step date and subject for a card", () => {
    const day = (value: string) => `day ${value}`;
    expect(dealNextStepLabel({ nextActivityDate: "2026-10-20", nextActivitySubject: "Demo call" }, day)).toBe("day 2026-10-20 · Demo call");
    expect(dealNextStepLabel({ nextActivityDate: "2026-10-20T09:00:00Z" }, day)).toBe("day 2026-10-20");
    expect(dealNextStepLabel({ nextActivitySubject: "Demo" }, day)).toBeNull();
  });
});
