import { describe, expect, it } from "vitest";
import { describeAiCredentialLifetime } from "./model";

describe("describeAiCredentialLifetime (GRE-15)", () => {
  const now = new Date("2026-09-27T12:09:00.000Z");
  it("says an imported Claude login is short-lived, when it expires, and how to get a year-long token", () => {
    const lifetime = describeAiCredentialLifetime({ source: "imported_login", expiresAt: "2026-09-27T18:50:00.000Z" }, now);
    expect(lifetime?.tone).toBe("muted");
    expect(lifetime?.text).toContain("Short-lived token");
    expect(lifetime?.text).toContain(new Date("2026-09-27T18:50:00.000Z").toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }));
    expect(lifetime?.text).toContain("run claude setup-token");
    expect(lifetime?.text).toContain("Paste a long-lived token");
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
  it("gives a pasted setup-token's expiry date (GRE-244)", () => {
    const lifetime = describeAiCredentialLifetime({ source: "setup_token", expiresAt: "2027-09-29T12:00:00.000Z" }, now);
    expect(lifetime?.tone).toBe("muted");
    expect(lifetime?.text).toContain(new Date("2027-09-29T12:00:00.000Z").toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }));
    expect(describeAiCredentialLifetime({ source: "setup_token", expiresAt: "2026-09-27T12:00:00.000Z" }, now)?.tone).toBe("danger");
  });
  it("warns that a Claude subscription saved without a credential record has an unknown expiry (GRE-43)", () => {
    const lifetime = describeAiCredentialLifetime(undefined, now, { provider: "anthropic", method: "subscription" });
    expect(lifetime?.tone).toBe("warning");
    expect(lifetime?.text).toContain("expiry unknown");
    expect(lifetime?.text).toContain("Reconnect");
    expect(lifetime?.text).toContain("claude setup-token");
    expect(describeAiCredentialLifetime(undefined, now, { provider: "anthropic", method: "api_key" })).toBeNull();
    expect(describeAiCredentialLifetime(undefined, now, { provider: "openai", method: "subscription" })).toBeNull();
  });
});
