import { describe, expect, it } from "vitest";
import { agentWorkHours, minimumWageEquivalentCents } from "./agent-hours.js";

describe("agent hours", () => {
  it("turns run time into hours", () => {
    expect(agentWorkHours(90 * 60 * 1000)).toBe(1.5);
  });

  it("counts negative or broken durations as no time", () => {
    expect(agentWorkHours(-5_000)).toBe(0);
    expect(agentWorkHours(Number.NaN)).toBe(0);
  });

  it("values the hours at the company rate", () => {
    // 2.5 hours at 1,000 cents an hour = 2,500 cents
    expect(minimumWageEquivalentCents(2.5 * 60 * 60 * 1000, 1_000)).toBe(2_500);
  });

  it("rounds to whole cents", () => {
    // 20 minutes at 1,000 cents an hour = 333.33 cents
    expect(minimumWageEquivalentCents(20 * 60 * 1000, 1_000)).toBe(333);
  });

  it("returns null when no rate is set", () => {
    expect(minimumWageEquivalentCents(60 * 60 * 1000, null)).toBeNull();
    expect(minimumWageEquivalentCents(60 * 60 * 1000, undefined)).toBeNull();
  });

  it("is zero when the agents did no work", () => {
    expect(minimumWageEquivalentCents(0, 1_000)).toBe(0);
  });
});
