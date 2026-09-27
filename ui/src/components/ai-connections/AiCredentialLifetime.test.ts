import { describe, expect, it } from "vitest";
import { describeAiCredentialLifetime } from "./model";

describe("describeAiCredentialLifetime (GRE-15)", () => {
  const now = new Date("2026-09-27T12:09:00.000Z");
  it("says an imported Claude login is short-lived, when it expires, and how to get a year-long token", () => {
    const lifetime = describeAiCredentialLifetime({ source: "imported_login", expiresAt: "2026-09-27T18:50:00.000Z" }, now);
    expect(lifetime?.tone).toBe("muted");
    expect(lifetime?.text).toContain("Short-lived token");
    expect(lifetime?.text).toContain(new Date("2026-09-27T18:50:00.000Z").toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }));
    expect(lifetime?.text).toContain("claude setup-token gives a token that lasts about a year");
  });
  it("raises the tone within the warning hour and once expired", () => {
    expect(describeAiCredentialLifetime({ source: "imported_login", expiresAt: "2026-09-27T12:50:00.000Z" }, now)?.tone).toBe("warning");
    const expired = describeAiCredentialLifetime({ source: "imported_login", expiresAt: "2026-09-27T12:00:00.000Z" }, now);
    expect(expired?.tone).toBe("danger");
    expect(expired?.text).toContain("expired");
  });
  it("stays quiet for API keys and describes setup-token as long-lived", () => {
    expect(describeAiCredentialLifetime({ source: "pasted", expiresAt: null }, now)).toBeNull();
    expect(describeAiCredentialLifetime(undefined, now)).toBeNull();
    expect(describeAiCredentialLifetime({ source: "setup_token", expiresAt: null }, now)?.text).toContain("about a year");
  });
});
