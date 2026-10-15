import { describe, expect, it } from "vitest";
import { blockedWorkOwnerLabel, formatWaitingFor, pluralTasks } from "./blockedWork";

const NOW = new Date("2026-10-16T08:00:00.000Z").getTime();

describe("formatWaitingFor", () => {
  it("reads in plain words", () => {
    expect(formatWaitingFor(null, NOW)).toBeNull();
    expect(formatWaitingFor("2026-10-16T07:58:00.000Z", NOW)).toBe("a few minutes");
    expect(formatWaitingFor("2026-10-16T07:20:00.000Z", NOW)).toBe("40 minutes");
    expect(formatWaitingFor("2026-10-16T07:00:00.000Z", NOW)).toBe("1 hour");
    expect(formatWaitingFor("2026-10-15T20:00:00.000Z", NOW)).toBe("12 hours");
    expect(formatWaitingFor("2026-10-15T08:00:00.000Z", NOW)).toBe("1 day");
    expect(formatWaitingFor("2026-10-07T08:00:00.000Z", NOW)).toBe("9 days");
  });
});

describe("blockedWorkOwnerLabel", () => {
  const names = {
    agentNameById: new Map([["a1", "Mason"]]),
    userLabelById: new Map([["u2", "Ben"]]),
    currentUserId: "u1",
  };

  it("names who must act", () => {
    expect(blockedWorkOwnerLabel({ type: "agent", agentId: "a1", userId: null }, names)).toBe("Mason");
    expect(blockedWorkOwnerLabel({ type: "board", agentId: null, userId: null }, names)).toBe("You (the board)");
    expect(blockedWorkOwnerLabel({ type: "user", agentId: null, userId: "u1" }, names)).toBe("You");
    expect(blockedWorkOwnerLabel({ type: "user", agentId: null, userId: "u2" }, names)).toBe("Ben");
    expect(blockedWorkOwnerLabel({ type: "nobody", agentId: null, userId: null }, names)).toBe("Nobody yet");
  });

  it("counts tasks", () => {
    expect(pluralTasks(1)).toBe("1 task");
    expect(pluralTasks(9)).toBe("9 tasks");
  });
});
