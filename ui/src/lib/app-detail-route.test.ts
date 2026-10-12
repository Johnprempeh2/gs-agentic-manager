import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RESERVED_APP_SUBPATHS, getAppDetailConnectionId } from "./app-detail-route";

describe("getAppDetailConnectionId", () => {
  it("returns the connection id for an app detail path", () => {
    expect(getAppDetailConnectionId(["apps", "conn-123", "permissions"])).toBe("conn-123");
  });

  it("does not treat the mailboxes page as a connection (GRE-1435)", () => {
    expect(getAppDetailConnectionId(["apps", "mailboxes"])).toBeNull();
  });

  it("returns null outside an app detail path", () => {
    expect(getAppDetailConnectionId(["apps"])).toBeNull();
    expect(getAppDetailConnectionId(["issues", "conn-123"])).toBeNull();
    expect(getAppDetailConnectionId(["apps", "Gateways"])).toBeNull();
  });

  it("reserves every fixed /apps/<segment> route declared in App.tsx", () => {
    const appSource = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    const fixedSegments = new Set(
      [...appSource.matchAll(/path="apps\/([^/":]+)/g)].map((match) => match[1]!.toLowerCase()),
    );
    expect(fixedSegments.size).toBeGreaterThan(0);
    for (const segment of fixedSegments) {
      expect(RESERVED_APP_SUBPATHS.has(segment), `"${segment}" must be reserved`).toBe(true);
    }
  });
});
