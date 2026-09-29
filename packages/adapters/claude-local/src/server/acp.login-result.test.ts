import { describe, expect, it } from "vitest";
import { isLoginRequiredResult } from "@agentclientprotocol/claude-agent-acp";

// GRE-245: claude-agent-acp failed any successful turn whose final text
// contained "Please run /login" as `access` (auth_required). Three runs on
// 29 Sep (GRE-227, GRE-233, GRE-234) wrote up the Conference Room login bug,
// quoted that phrase in their summary, and were reported as Claude access
// failures although the token was valid. Our patch only treats the phrase as a
// login prompt when no real model answered the turn.
describe("claude-agent-acp isLoginRequiredResult (patched)", () => {
  it("does not treat a real model's summary that quotes the login phrase as an auth failure", () => {
    // Shape of the GRE-234 run 710ffacb final result text.
    const summary =
      "I fixed the bug and opened PR #109. **Cause:** in `server/src/routes/board-chat.ts`, " +
      'the relay never checked `is_error`. So a message like "Not logged in · Please run /login" ' +
      "showed up as a normal Assistant reply.";

    expect(isLoginRequiredResult(summary, "claude-opus-5-5")).toBe(false);
  });

  it("still treats the CLI's own login prompt as an auth failure when no real model answered", () => {
    expect(isLoginRequiredResult("Not logged in · Please run /login", null)).toBe(true);
    expect(
      isLoginRequiredResult("Session expired. Please run /login to sign in again.", null),
    ).toBe(true);
  });

  it("ignores results without the login phrase", () => {
    expect(isLoginRequiredResult("All done.", null)).toBe(false);
    expect(isLoginRequiredResult(undefined, null)).toBe(false);
  });
});
