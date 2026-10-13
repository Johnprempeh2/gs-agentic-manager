import { describe, expect, it } from "vitest";
import { isClientPortalVisible, stageCompleteness } from "./client-journey.js";

// Stage completeness: what the toolkit expects at a stage against what is filed.

describe("stageCompleteness", () => {
  const expected = [
    { key: "north-star", title: "North Star summary", kind: "report" as const },
    { key: "gita", title: "GITA report" },
    { key: "journey-maps", title: "Journey maps", kind: "deck" as const },
  ];

  it("marks each expected deliverable met or missing", () => {
    const result = stageCompleteness(expected, [
      { id: "a", key: "north-star", title: "Anything" },
      { id: "b", key: "something-else", title: "  journey   MAPS " },
    ]);
    expect(result).toEqual([
      { key: "north-star", title: "North Star summary", kind: "report", deliverableId: "a" },
      { key: "gita", title: "GITA report", kind: null, deliverableId: null },
      { key: "journey-maps", title: "Journey maps", kind: "deck", deliverableId: "b" },
    ]);
  });

  it("lets one filed deliverable meet one entry, key matches first", () => {
    const result = stageCompleteness(
      [{ key: "summary", title: "Deck" }, { key: "deck", title: "Deck" }],
      [{ id: "only", key: "deck", title: "Deck" }],
    );
    expect(result.map((entry) => entry.deliverableId)).toEqual([null, "only"]);
  });

  it("is empty when the stage expects nothing", () => {
    expect(stageCompleteness([], [{ id: "a", key: "x", title: "X" }])).toEqual([]);
  });
});

describe("portal confidentiality and NDA gate", () => {
  const base = { clientFacing: true, status: "final" as const, stageState: "done" as const };

  it("never shows internal items", () => {
    expect(isClientPortalVisible({ ...base, confidentiality: "internal", ndaAccepted: true })).toBe(false);
  });

  it("shows client items only once the NDA is accepted", () => {
    expect(isClientPortalVisible({ ...base, confidentiality: "client", ndaAccepted: false })).toBe(false);
    expect(isClientPortalVisible({ ...base, confidentiality: "client", ndaAccepted: true })).toBe(true);
  });

  it("shows public items without an NDA", () => {
    expect(isClientPortalVisible({ ...base, confidentiality: "public", ndaAccepted: false })).toBe(true);
  });
});
