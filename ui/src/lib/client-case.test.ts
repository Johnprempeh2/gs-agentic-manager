import { describe, expect, it } from "vitest";
import { CLIENT_RECORD_FIELD_KEYS, isDevtoolsCaseType, readCardSummary, readClientRecord, readDevtoolsDeal } from "./client-case";

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
