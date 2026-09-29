import { access } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { CLAUDE_SETUP_TOKEN_LIFETIME_MS, verifyClaudeSetupToken } from "../services/claude-setup-token.js";

type Probe = NonNullable<Parameters<typeof verifyClaudeSetupToken>[2]>;
const token = "sk-ant-oat01-fixture_setup-token";
const now = new Date("2026-09-29T21:00:00.000Z");
function probeReturning(code: string) {
  return vi.fn<Probe>(async () => ({ adapterType: "claude_local", status: "pass", testedAt: now.toISOString(), checks: [{ code, level: "info", message: "fixture" }] }));
}

describe("verifyClaudeSetupToken (GRE-244)", () => {
  it("runs the hello probe with only the pasted token, then records it as a year-long setup token", async () => {
    const probe = probeReturning("claude_hello_probe_passed");
    const result = await verifyClaudeSetupToken("company-1", `  ${token}\n`, probe, now);
    expect(result).toEqual({
      credential: token,
      info: { source: "setup_token", expiresAt: new Date(now.getTime() + CLAUDE_SETUP_TOKEN_LIFETIME_MS).toISOString() },
    });
    expect(result.info.expiresAt).toBe("2027-09-29T21:00:00.000Z");
    const context = probe.mock.calls[0][0];
    const config = context.config as { engine: string; cwd: string; env: Record<string, string> };
    expect(context).toMatchObject({ companyId: "company-1", adapterType: "claude_local" });
    expect(context.executionTarget).toBeUndefined();
    expect(config.engine).toBe("cli");
    // An empty, throwaway config dir: the machine's own Claude login cannot pass the probe.
    expect(config.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CONFIG_DIR: config.cwd });
    await expect(access(config.cwd)).rejects.toThrow();
  });

  it("accepts a token whose usage window is spent: auth works", async () => {
    await expect(verifyClaudeSetupToken("company-1", token, probeReturning("claude_hello_probe_usage_limited"), now)).resolves.toMatchObject({ credential: token });
  });

  it.each([
    ["an API key", "sk-ant-api03-fixture", "API key"],
    ["text that is not a token", "hello there", "does not look like a token"],
    ["a token cut short by a line break", "sk-ant-oat01-abc\ndef", "does not look like a token"],
  ])("rejects %s before it runs the probe", async (_label, value, message) => {
    const probe = probeReturning("claude_hello_probe_passed");
    await expect(verifyClaudeSetupToken("company-1", value, probe, now)).rejects.toMatchObject({ status: 422, message: expect.stringContaining(message) });
    expect(probe).not.toHaveBeenCalled();
  });

  it.each(["claude_hello_probe_auth_required", "claude_hello_probe_failed", "claude_hello_probe_timed_out", "claude_hello_probe_skipped_unresolved_command"])(
    "rejects the token when the probe reports %s, with a fixed message that never echoes it",
    async (code) => {
      const error = await verifyClaudeSetupToken("company-1", token, probeReturning(code), now).catch((cause: unknown) => cause as { status: number; message: string });
      expect(error).toMatchObject({ status: 422, message: expect.stringContaining("Claude did not accept this token") });
      expect(error.message).toContain("Nothing was changed");
      expect(error.message).not.toContain(token);
    },
  );

  it("rejects the token when the probe itself throws, without leaking the thrown text", async () => {
    const probe = vi.fn<Probe>(async () => { throw new Error(`spawn failed for ${token}`); });
    const error = await verifyClaudeSetupToken("company-1", token, probe, now).catch((cause: unknown) => cause as Error);
    expect(error.message).toContain("Claude did not accept this token");
    expect(error.message).not.toContain(token);
  });
});
