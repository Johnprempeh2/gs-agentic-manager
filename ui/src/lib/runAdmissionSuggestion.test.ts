import { describe, expect, it } from "vitest";
import {
  describeRunCapSuggestion,
  formatGb,
  parseWholeNumber,
  runsFreeRamCanHold,
  suggestRunCap,
} from "./runAdmissionSuggestion";

const GB = 1024 * 1024 * 1024;

describe("run cap suggestion (GRE-114)", () => {
  it("divides total RAM minus the floor by about 500 MB per run", () => {
    // 16384 MB - 2048 MB = 14336 MB, / 500 = 28.67
    expect(suggestRunCap(16 * GB, 2048)).toBe(28);
    // Floor off: 16384 / 500 = 32.77
    expect(suggestRunCap(16 * GB, 0)).toBe(32);
    expect(suggestRunCap(8 * GB, 2048)).toBe(12);
  });

  it("never suggests less than 1 or more than 1000 runs", () => {
    expect(suggestRunCap(2 * GB, 4096)).toBe(1);
    expect(suggestRunCap(1024 * GB, 0)).toBe(1000);
  });

  it("shows the math in one line", () => {
    expect(describeRunCapSuggestion(16 * GB, 2048)).toBe(
      "16 GB machine minus 2 GB floor, about 500 MB per run: suggested 28 runs",
    );
    expect(describeRunCapSuggestion(16 * GB, 0)).toBe(
      "16 GB machine, about 500 MB per run: suggested 32 runs",
    );
    expect(describeRunCapSuggestion(2 * GB, 2048)).toBe(
      "2 GB machine minus 2 GB floor, about 500 MB per run: suggested 1 run",
    );
  });

  it("counts runs the free RAM can still hold above the floor", () => {
    expect(runsFreeRamCanHold(5 * GB, 2048)).toBe(6);
    expect(runsFreeRamCanHold(1 * GB, 2048)).toBe(0);
  });

  it("formats GB with at most one decimal", () => {
    expect(formatGb(16 * GB)).toBe("16 GB");
    expect(formatGb(5.25 * GB)).toBe("5.3 GB");
  });

  it("parses only whole numbers inside the range", () => {
    expect(parseWholeNumber("6", 1, 1000)).toBe(6);
    expect(parseWholeNumber(" 12 ", 1, 1000)).toBe(12);
    expect(parseWholeNumber("0", 1, 1000)).toBeNull();
    expect(parseWholeNumber("1001", 1, 1000)).toBeNull();
    expect(parseWholeNumber("2.5", 1, 1000)).toBeNull();
    expect(parseWholeNumber("", 0, 10)).toBeNull();
  });
});
