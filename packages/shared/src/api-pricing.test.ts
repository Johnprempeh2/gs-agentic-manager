import { describe, expect, it } from "vitest";
import {
  API_PRICE_TABLE_CHECKED_AT,
  computeApiEquivalentCents,
  normalizeModelForPricing,
  resolveApiPrice,
} from "./api-pricing.js";

describe("api pricing", () => {
  it("records the date the price table was checked", () => {
    expect(API_PRICE_TABLE_CHECKED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("prices Anthropic input, cache reads and output separately", () => {
    // 1M input at $5, 2M cache reads at $0.50, 100k output at $25
    // = 5 + 1 + 2.5 = $8.50
    const cents = computeApiEquivalentCents({
      provider: "anthropic",
      model: "claude-opus-4-6",
      inputTokens: 1_000_000,
      cachedInputTokens: 2_000_000,
      outputTokens: 100_000,
    });
    expect(cents).toBeCloseTo(850, 6);
  });

  it("does not double count OpenAI cached tokens, which sit inside input", () => {
    // 1M input of which 800k cached: 200k at $1.25 + 800k at $0.125 + 50k output at $10
    // = 0.25 + 0.10 + 0.50 = $0.85
    const cents = computeApiEquivalentCents({
      provider: "openai",
      model: "gpt-5",
      inputTokens: 1_000_000,
      cachedInputTokens: 800_000,
      outputTokens: 50_000,
    });
    expect(cents).toBeCloseTo(85, 6);
  });

  it("returns null for an unknown model instead of guessing", () => {
    expect(
      computeApiEquivalentCents({
        provider: "openai",
        model: "gpt-5.6-terra",
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 10,
      }),
    ).toBeNull();
    expect(resolveApiPrice("anthropic", "opus")).toBeNull();
    expect(resolveApiPrice("mystery", "claude-opus-4-6")).toBeNull();
  });

  it("normalizes snapshot dates, cloud prefixes and context tags", () => {
    expect(normalizeModelForPricing("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
    expect(normalizeModelForPricing("us.anthropic.claude-opus-4-6")).toBe("claude-opus-4-6");
    expect(normalizeModelForPricing("claude-opus-4-6[1m]")).toBe("claude-opus-4-6");
    expect(normalizeModelForPricing("claude-opus-4-5@20251101")).toBe("claude-opus-4-5");
    expect(resolveApiPrice("Anthropic", "Claude-Haiku-4-5-20251001")?.outputPerMTok).toBe(5);
  });

  it("returns zero for zero tokens on a known model", () => {
    expect(
      computeApiEquivalentCents({
        provider: "anthropic",
        model: "claude-haiku-4-5",
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe(0);
  });
});
