import { afterEach, describe, expect, it, vi } from "vitest";
import { AFTER_PAINT_MAX_WAIT_MS, scheduleAfterPaint } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("scheduleAfterPaint (GRE-5821)", () => {
  it("waits for the browser to go idle, with a deadline, and can be cancelled", () => {
    const callbacks = new Map<number, () => void>();
    const requestIdleCallback = vi.fn((callback: () => void, _options?: { timeout: number }) => {
      callbacks.set(callbacks.size + 1, callback);
      return callbacks.size;
    });
    const cancelIdleCallback = vi.fn((id: number) => callbacks.delete(id));
    vi.stubGlobal("window", { requestIdleCallback, cancelIdleCallback });
    const task = vi.fn();

    const cancel = scheduleAfterPaint(task);
    expect(task).not.toHaveBeenCalled();
    expect(requestIdleCallback).toHaveBeenCalledWith(task, { timeout: AFTER_PAINT_MAX_WAIT_MS });

    cancel();
    expect(cancelIdleCallback).toHaveBeenCalledWith(1);
    expect(callbacks.size).toBe(0);
  });

  it("falls back to the next task where idle callbacks are missing", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    });
    const task = vi.fn();
    scheduleAfterPaint(task);
    expect(task).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(task).toHaveBeenCalledTimes(1);

    const cancelled = vi.fn();
    scheduleAfterPaint(cancelled)();
    vi.runAllTimers();
    expect(cancelled).not.toHaveBeenCalled();
  });
});
