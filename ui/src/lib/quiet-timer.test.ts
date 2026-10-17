import { describe, expect, it } from "vitest";
import { agentsRunningEmptyTimers, withEmptyTimerSkip } from "./quiet-timer";

const agent = (id: string, status: string, heartbeat: Record<string, unknown> | undefined) =>
  ({ id, name: id, status, runtimeConfig: heartbeat ? { heartbeat, aiConnection: { id: "c" } } : {} }) as never;

describe("agentsRunningEmptyTimers", () => {
  it("lists agents on a timer that do not skip empty runs", () => {
    const list = [
      agent("a", "idle", { enabled: true, intervalSec: 300 }),
      agent("b", "idle", { enabled: true, skipTimerWhenNothingChanged: true }),
      agent("c", "idle", { enabled: false }),
      agent("d", "terminated", { enabled: true }),
      agent("e", "paused", undefined),
    ];
    expect(agentsRunningEmptyTimers(list).map((item: { id: string }) => item.id)).toEqual(["a"]);
  });
});

describe("withEmptyTimerSkip", () => {
  it("turns the skip on and keeps every other setting", () => {
    expect(withEmptyTimerSkip(agent("a", "idle", { enabled: true, intervalSec: 300 }))).toEqual({
      heartbeat: { enabled: true, intervalSec: 300, skipTimerWhenNothingChanged: true },
      aiConnection: { id: "c" },
    });
  });
});
