import { describe, expect, it } from "vitest";
import { launchDaysLeft, trainState, trainTag } from "../services/website/release-train.js";

describe("trainState", () => {
  it.each([
    [null, null, "none"],
    ["cancelled", null, "none"],
    ["todo", null, "cut"],
    ["in_progress", null, "cut"],
    ["blocked", null, "checking"],
    ["in_review", null, "checking"],
    ["in_progress", "pending", "waiting_for_approval"],
    ["in_progress", "accepted", "approved"],
    ["done", "accepted", "live"],
    ["in_progress", "rejected", "rejected"],
    // "No website train this week": the issue closes with no card.
    ["done", null, "none"],
    ["done", "rejected", "none"],
  ])("issue %s with card %s is %s", (issue, card, state) => {
    expect(trainState(issue, card)).toBe(state);
  });
});

describe("trainTag", () => {
  it("takes the newest tag named", () => {
    expect(trainTag(["Weekly website release train", null, "Tagged web-rc-2026-10-26", "Re-cut as web-rc-2026-10-27"])).toBe("web-rc-2026-10-27");
  });

  it("is null before the tag is cut", () => {
    expect(trainTag(["Weekly website release train", "No tag yet"])).toBeNull();
  });
});

describe("launchDaysLeft", () => {
  it("counts London calendar days to the target", () => {
    expect(launchDaysLeft("2026-11-03", new Date("2026-10-25T12:00:00Z"))).toBe(9);
    // 23:30 UTC on 25 Oct is still 25 Oct in London (GMT from that morning).
    expect(launchDaysLeft("2026-11-03", new Date("2026-10-25T23:30:00Z"))).toBe(9);
    // 23:30 UTC on 24 Oct is already 25 Oct in London (BST).
    expect(launchDaysLeft("2026-11-03", new Date("2026-10-24T23:30:00Z"))).toBe(9);
  });

  it("is 0 on the day and negative after", () => {
    expect(launchDaysLeft("2026-11-03", new Date("2026-11-03T08:00:00Z"))).toBe(0);
    expect(launchDaysLeft("2026-11-03", new Date("2026-11-05T08:00:00Z"))).toBe(-2);
  });

  it("is null with no date", () => {
    expect(launchDaysLeft(null)).toBeNull();
  });
});
