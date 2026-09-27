import { describe, expect, it } from "vitest";
import { formatStepElapsed } from "./step-elapsed";

describe("formatStepElapsed", () => {
  it.each([
    [10_000, "10s"],
    [59_999, "59s"],
    [60_000, "1m 00s"],
    [160_000, "2m 40s"],
    [3_600_000, "1h 0m"],
    [3_900_000, "1h 5m"],
  ])("formats %d ms as %s", (ms, expected) => {
    expect(formatStepElapsed(ms)).toBe(expected);
  });
});
