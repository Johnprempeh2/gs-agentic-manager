import { describe, expect, it } from "vitest";
import { createConcurrencyLimiter } from "./concurrency-limiter.js";

describe("createConcurrencyLimiter", () => {
  it("never runs more sections than the limit and serves waiters in order", async () => {
    const limiter = createConcurrencyLimiter(2);
    let inFlight = 0;
    let maxInFlight = 0;
    const order: number[] = [];
    const releases: Array<() => void> = [];
    const runs = [0, 1, 2, 3].map((index) =>
      limiter.run(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        order.push(index);
        await new Promise<void>((resolve) => releases.push(resolve));
        inFlight -= 1;
        return index;
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual([0, 1]);
    releases.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual([0, 1, 2]);
    while (releases.length > 0 || order.length < 4) {
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2, 3]);
    expect(maxInFlight).toBe(2);
  });

  it("releases the slot when a section fails", async () => {
    const limiter = createConcurrencyLimiter(1);
    await expect(limiter.run(async () => {
      throw new Error("section failed");
    })).rejects.toThrow("section failed");
    await expect(limiter.run(async () => "next")).resolves.toBe("next");
  });

  it("rejects a limit that is not a positive integer", () => {
    expect(() => createConcurrencyLimiter(0)).toThrow();
    expect(() => createConcurrencyLimiter(1.5)).toThrow();
  });
});
