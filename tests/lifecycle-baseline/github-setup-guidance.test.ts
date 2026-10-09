import { describe, expect, it } from "vitest";
import { describeGitAuthFailure } from "../../server/src/services/git-credentials.js";

describe("GRE-1119: missing git credentials have a setup path", () => {
  it("explains the token-only limit and names both supported setup paths", () => {
    const guidance = describeGitAuthFailure({
      error: "fatal: could not read Username: terminal prompts disabled",
      used: null,
    });
    expect(guidance).toContain("cannot supply git credentials");
    expect(guidance).toContain("Agents cannot push with a GitHub personal access token");
    expect(guidance).toContain("Add account, then Use this connection as an agent tool");
    expect(guidance).toContain("Settings → Secrets");
  });
});
