import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionCheckedLabel, connectionHealthBadge } from "./connection-health";

describe("connectionHealthBadge", () => {
  it.each([
    ["ok", "Works"],
    ["healthy", "Works"],
    ["degraded", "Warning"],
    ["error", "Needs reconnect"],
    ["failed", "Needs reconnect"],
    ["missing_secret", "Needs reconnect"],
    ["unknown", "Not tested"],
    ["unchecked", "Not tested"],
  ] as const)("maps %s to %s", (healthStatus, label) => {
    expect(connectionHealthBadge({ healthStatus }).label).toBe(label);
  });

  it("asks for a reconnect when the row needs attention for another reason", () => {
    expect(connectionHealthBadge({ healthStatus: "ok" }, true)).toEqual({ status: "error", label: "Needs reconnect" });
    expect(connectionHealthBadge({ healthStatus: "degraded" }, true).label).toBe("Warning");
  });
});

describe("connectionCheckedLabel", () => {
  afterEach(() => vi.useRealTimers());

  it("says when the connection was last checked", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
    expect(connectionCheckedLabel({ healthCheckedAt: new Date("2026-10-02T11:58:00Z") })).toBe("Checked 2m ago");
    expect(connectionCheckedLabel({ healthCheckedAt: null })).toBe("Not checked yet");
  });
});
