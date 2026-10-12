import { describe, expect, it } from "vitest";
import { formatAgentHours, hourlyRateInputValue, parseHourlyRateInput } from "./minimum-wage";

describe("minimum wage helpers", () => {
  it("shows agent hours with one decimal", () => {
    expect(formatAgentHours(90 * 60 * 1000)).toBe("1.5 h");
    expect(formatAgentHours(0)).toBe("0.0 h");
    expect(formatAgentHours(1_234 * 60 * 60 * 1000)).toBe("1,234.0 h");
  });

  it("reads a typed rate as cents", () => {
    expect(parseHourlyRateInput("12.5")).toBe(1_250);
    expect(parseHourlyRateInput(" 7 ")).toBe(700);
    expect(parseHourlyRateInput("1,000.25")).toBe(100_025);
  });

  it("clears the rate when the box is empty", () => {
    expect(parseHourlyRateInput("")).toBeNull();
    expect(parseHourlyRateInput("   ")).toBeNull();
  });

  it("rejects amounts that are not a plain non-negative number", () => {
    expect(parseHourlyRateInput("-3")).toBe("invalid");
    expect(parseHourlyRateInput("abc")).toBe("invalid");
    expect(parseHourlyRateInput("1.234")).toBe("invalid");
    expect(parseHourlyRateInput("99999999999")).toBe("invalid");
  });

  it("fills the input from the saved rate", () => {
    expect(hourlyRateInputValue(1_250)).toBe("12.50");
    expect(hourlyRateInputValue(null)).toBe("");
  });
});
