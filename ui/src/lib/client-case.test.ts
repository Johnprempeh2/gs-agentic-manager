import { describe, expect, it } from "vitest";
import { CLIENT_RECORD_FIELD_KEYS, readCardSummary, readClientRecord } from "./client-case";

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
