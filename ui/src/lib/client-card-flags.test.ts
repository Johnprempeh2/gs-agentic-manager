import { describe, expect, it } from "vitest";
import { getClientCardFlags, isClientCard, readLastContactDate } from "./client-card-flags";

const now = new Date("2026-10-09T12:00:00Z");

describe("client card flags", () => {
  it("flags no contact after 14 days and not before", () => {
    expect(getClientCardFlags({ fields: { lastContact: "2026-09-20" } }, now).noContactDays).toBe(19);
    expect(getClientCardFlags({ fields: { lastContact: "2026-09-25T12:00:00Z" } }, now).noContactDays).toBe(14);
    expect(getClientCardFlags({ fields: { lastContact: "2026-09-26T12:00:00Z" } }, now).noContactDays).toBeNull();
    expect(getClientCardFlags({ fields: { lastContact: "2026-10-08" } }, now).noContactDays).toBeNull();
  });

  it("flags a stage with no move for 30 days and not before", () => {
    const fields = { last_contact: "2026-10-08" };
    expect(getClientCardFlags({ fields, stageEnteredAt: "2026-08-01T00:00:00Z" }, now).stuckStageDays).toBe(69);
    expect(getClientCardFlags({ fields, stageEnteredAt: "2026-09-09T12:00:00Z" }, now).stuckStageDays).toBe(30);
    expect(getClientCardFlags({ fields, stageEnteredAt: "2026-09-20T00:00:00Z" }, now).stuckStageDays).toBeNull();
  });

  it("only flags client cards that are still in the journey", () => {
    const old = "2026-01-01";
    expect(getClientCardFlags({ fields: { channel: "blog" }, stageEnteredAt: old }, now)).toEqual({
      noContactDays: null,
      stuckStageDays: null,
    });
    expect(getClientCardFlags({ fields: { lastContact: old }, stageEnteredAt: old, terminalKind: "cancelled" }, now)).toEqual({
      noContactDays: null,
      stuckStageDays: null,
    });
  });

  it("ignores empty or unreadable last-contact values", () => {
    expect(isClientCard({ lastContact: "" })).toBe(true);
    expect(readLastContactDate({ lastContact: "" })).toBeNull();
    expect(readLastContactDate({ lastContact: "soon" })).toBeNull();
    expect(getClientCardFlags({ fields: { lastContact: "not a date" } }, now).noContactDays).toBeNull();
  });

  it("reads the usual spellings of the last-contact field", () => {
    for (const key of ["lastContact", "last_contact", "lastContactAt", "last_contact_date", "Last contact"]) {
      expect(readLastContactDate({ [key]: "2026-09-01" })?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    }
  });
});
