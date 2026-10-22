import { describe, expect, it } from "vitest";
import {
  API_PRICE_TABLE,
  API_PRICE_TABLE_CHECKED_AT,
  computeApiEquivalentCents,
  forecastDatedUsage,
  normalizeModelForPricing,
  resolveApiPrice,
} from "./api-pricing.js";

describe("api pricing", () => {
  it("records the date the price table was checked", () => {
    expect(API_PRICE_TABLE_CHECKED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("every price has a source and a valid effective date range", () => {
    for (const provider of Object.values(API_PRICE_TABLE)) {
      for (const rows of Object.values(provider.models)) {
        for (const row of rows) {
          expect(row.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(row.sourceUrl).toMatch(/^https:\/\//);
          if (row.effectiveUntil) expect(row.effectiveUntil > row.effectiveFrom).toBe(true);
        }
      }
    }
  });

  it("switches Argon from the introductory price on December 1", () => {
    const usage = { provider: "google", model: "gemini-4-argon", inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 1_000_000 };
    expect(computeApiEquivalentCents(usage, "2026-11-30")).toBe(1200);
    expect(computeApiEquivalentCents(usage, "2026-12-01")).toBe(2400);
    expect(resolveApiPrice("google", "gemini-4-argon", "2026-11-30")?.effectiveUntil).toBe("2026-12-01");
  });

  it("continues to price existing Claude usage before the legacy check date", () => {
    const usage = { provider: "anthropic", model: "claude-opus-4-8", inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 };
    expect(computeApiEquivalentCents(usage, "2026-04-10")).toBe(500);
    expect(computeApiEquivalentCents(usage, "2026-09-27")).toBe(500);
  });

  it("blends a forecast across a rate change, and reports missing future prices", () => {
    const usage = [{ provider: "google", model: "gemini-4-argon", inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 }];
    expect(forecastDatedUsage(usage, new Date("2026-11-30"), new Date("2026-12-02"))).toEqual({ cents: 600, unpriced: [] });
    API_PRICE_TABLE.google.models["temporary"] = [{ inputPerMTok: 1, cachedInputPerMTok: 0, outputPerMTok: 1, effectiveFrom: "2026-11-01", effectiveUntil: "2026-12-01", sourceUrl: "https://example.com" }];
    try {
      const result = forecastDatedUsage([{ ...usage[0], model: "temporary" }], new Date("2026-11-30"), new Date("2026-12-02"));
      expect(result.cents).toBe(100);
      expect(result.unpriced).toEqual([{ provider: "google", model: "temporary", day: "2026-12-01" }]);
    } finally {
      delete API_PRICE_TABLE.google.models["temporary"];
    }
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

  it("prices the Codex models at OpenAI's published rates, cached tokens inside input", () => {
    const usage = { provider: "openai", inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000 };
    // 600k at input + 400k at cached + 100k at output
    expect(computeApiEquivalentCents({ ...usage, model: "gpt-6-astra" }, "2026-10-22")).toBeCloseTo(1140, 6);
    expect(computeApiEquivalentCents({ ...usage, model: "gpt-6-sol" }, "2026-10-22")).toBeCloseTo(228, 6);
    expect(computeApiEquivalentCents({ ...usage, model: "gpt-6-luna" }, "2026-10-22")).toBeCloseTo(11.4, 6);
    expect(computeApiEquivalentCents({ ...usage, model: "gpt-5.6-sol" }, "2026-10-22")).toBeCloseTo(456, 6);
    expect(computeApiEquivalentCents({ ...usage, model: "gpt-5.6-sol" }, "2026-08-20")).toBeCloseTo(620, 6);
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

describe("computeApiEquivalentCents with input reported as uncached", () => {
  it("prices the input at full rate when cached exceeds input (live Codex runs)", () => {
    // gpt-6-sol: input 2, cached 0.20, output 10 per million tokens.
    const cents = computeApiEquivalentCents(
      { provider: "openai", model: "gpt-6-sol", inputTokens: 793, cachedInputTokens: 43_776, outputTokens: 78 },
      "2026-10-22",
    );
    expect(cents).toBeCloseTo(((793 * 2 + 43_776 * 0.2 + 78 * 10) / 1_000_000) * 100, 8);
  });
});
