import { describe, expect, it } from "vitest";
import { crmSyncValuesEqual, decideCrmSyncField } from "./crm-sync.js";

describe("crmSyncValuesEqual", () => {
  it("treats null, missing, blank and empty list as the same empty value", () => {
    expect(crmSyncValuesEqual(null, undefined)).toBe(true);
    expect(crmSyncValuesEqual("  ", null)).toBe(true);
    expect(crmSyncValuesEqual([], null)).toBe(true);
    expect(crmSyncValuesEqual("", "a")).toBe(false);
  });

  it("ignores surrounding spaces and compares lists in order", () => {
    expect(crmSyncValuesEqual(" Acme ", "Acme")).toBe(true);
    expect(crmSyncValuesEqual(["a", "b"], ["a", "b"])).toBe(true);
    expect(crmSyncValuesEqual(["a", "b"], ["b", "a"])).toBe(false);
    expect(crmSyncValuesEqual(5, "5")).toBe(false);
  });
});

describe("decideCrmSyncField (three-value rule)", () => {
  it("does nothing when both sides already agree, whatever the owner", () => {
    for (const owner of ["crm", "gsam", "shared"] as const) {
      expect(decideCrmSyncField({ owner, lastSynced: "old", crm: "new", gsam: "new" }))
        .toEqual({ action: "none", value: "new" });
    }
  });

  it("CRM-owned fields always take the CRM value", () => {
    expect(decideCrmSyncField({ owner: "crm", lastSynced: "a", crm: "a", gsam: "edited in gsam" }))
      .toEqual({ action: "pull_from_crm", value: "a" });
    expect(decideCrmSyncField({ owner: "crm", lastSynced: "a", crm: "b", gsam: "c" }))
      .toEqual({ action: "pull_from_crm", value: "b" });
  });

  it("GSAM-owned fields always push the GSAM value", () => {
    expect(decideCrmSyncField({ owner: "gsam", lastSynced: "a", crm: "edited in crm", gsam: "a" }))
      .toEqual({ action: "push_to_crm", value: "a" });
  });

  it("shared fields follow whichever side changed since the last sync", () => {
    expect(decideCrmSyncField({ owner: "shared", lastSynced: "a", crm: "b", gsam: "a" }))
      .toEqual({ action: "pull_from_crm", value: "b" });
    expect(decideCrmSyncField({ owner: "shared", lastSynced: "a", crm: "a", gsam: "c" }))
      .toEqual({ action: "push_to_crm", value: "c" });
  });

  it("shared fields changed on both sides to different values are a conflict", () => {
    expect(decideCrmSyncField({ owner: "shared", lastSynced: "a", crm: "b", gsam: "c" }))
      .toEqual({ action: "conflict" });
  });

  it("a shared field cleared on one side counts as a change", () => {
    expect(decideCrmSyncField({ owner: "shared", lastSynced: "a", crm: null, gsam: "a" }))
      .toEqual({ action: "pull_from_crm", value: null });
  });

  it("on first sync fills an empty side and queues two different values", () => {
    expect(decideCrmSyncField({ owner: "shared", lastSynced: undefined, crm: "b", gsam: null }))
      .toEqual({ action: "pull_from_crm", value: "b" });
    expect(decideCrmSyncField({ owner: "shared", lastSynced: undefined, crm: "", gsam: "c" }))
      .toEqual({ action: "push_to_crm", value: "c" });
    expect(decideCrmSyncField({ owner: "shared", lastSynced: undefined, crm: "b", gsam: "c" }))
      .toEqual({ action: "conflict" });
  });
});
