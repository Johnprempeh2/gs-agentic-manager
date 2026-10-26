import { describe, expect, it, vi } from "vitest";
import { waitForCorrectionSafePoint } from "./correction-safe-point.js";

describe("correction safe-point wait", () => {
  it("waits until the protected operation ends", async () => {
    let time = 0;
    const protectedState = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
    const result = await waitForCorrectionSafePoint({
      isProtected: protectedState,
      now: () => time,
      sleep: async (ms) => { time += ms; },
    });
    expect(result).toBe("safe");
    expect(time).toBe(2_000);
    expect(protectedState).toHaveBeenCalledTimes(3);
  });

  it("stops waiting after two minutes", async () => {
    let time = 0;
    const result = await waitForCorrectionSafePoint({
      isProtected: () => true,
      now: () => time,
      sleep: async (ms) => { time += ms; },
    });
    expect(result).toBe("timed_out");
    expect(time).toBe(120_000);
  });
});
