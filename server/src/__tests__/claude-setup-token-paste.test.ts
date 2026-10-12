import { describe, expect, it, vi } from "vitest";
import { createAiConnectionSchema } from "@greatstone/shared";
import { validateClaudeSetupToken } from "../routes/ai-connections.js";

// A local install could only import this Mac's short-lived Claude login; the
// server refused a pasted `claude setup-token` token outright.
const token = `sk-ant-oat01-${"a1B2_c3-".repeat(12)}`;
const base = { provider: "anthropic", method: "subscription", name: "My Claude subscription", ownership: "personal" } as const;

describe("pasting a Claude setup token", () => {
  it("joins a token the terminal wrapped across lines", async () => {
    const check = vi.fn(async () => "unknown" as const);
    const wrapped = `  ${token.slice(0, 40)}\n${token.slice(40, 70)}\r\n ${token.slice(70)}  `;
    await expect(validateClaudeSetupToken(wrapped, check)).resolves.toBe(token);
    expect(check).toHaveBeenCalledWith({ provider: "anthropic", method: "subscription" }, token);
  });

  it("accepts a token the check cannot judge, since a setup token lacks the profile scope", async () => {
    await expect(validateClaudeSetupToken(token, async () => "unknown")).resolves.toBe(token);
    await expect(validateClaudeSetupToken(token, async () => "valid")).resolves.toBe(token);
  });

  it("refuses a token Claude rejects, an API key, and text that is not a token", async () => {
    await expect(validateClaudeSetupToken(token, async () => "rejected")).rejects.toThrow("Claude refused this token");
    const check = vi.fn(async () => "valid" as const);
    await expect(validateClaudeSetupToken(`sk-ant-api03-${"x".repeat(40)}`, check)).rejects.toThrow("API key");
    await expect(validateClaudeSetupToken("Your OAuth token (valid for 1 year):", check)).rejects.toThrow("sk-ant-oat");
    expect(check).not.toHaveBeenCalled();
  });

  it("takes exactly one subscription credential, and a setup token only for Claude", () => {
    expect(createAiConnectionSchema.safeParse({ ...base, setupToken: token }).success).toBe(true);
    expect(createAiConnectionSchema.safeParse({ ...base, loginSessionId: "session" }).success).toBe(true);
    expect(createAiConnectionSchema.safeParse({ ...base }).success).toBe(false);
    expect(createAiConnectionSchema.safeParse({ ...base, setupToken: token, loginSessionId: "session" }).success).toBe(false);
    expect(createAiConnectionSchema.safeParse({ ...base, method: "api_key", apiKey: "key", setupToken: token }).success).toBe(false);
    expect(createAiConnectionSchema.safeParse({ ...base, provider: "openai", setupToken: token }).success).toBe(false);
  });
});
