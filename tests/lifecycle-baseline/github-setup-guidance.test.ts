import { describe, expect, it } from "vitest";
import { describeGitAuthFailure } from "../../server/src/services/git-credentials.js";

describe("GRE-1119: missing git credentials have a setup path", () => {
  it("explains the token-only limit and names both supported setup paths", () => {
    const guidance = describeGitAuthFailure({
      error: "fatal: could not read Username: terminal prompts disabled",
      used: null,
    });
    expect(guidance).toContain("cannot supply git credentials");
    expect(guidance).toContain("Connect as me");
    expect(guidance).toContain("Share with agents");
    expect(guidance).toContain("Settings → Secrets");
  });
});
