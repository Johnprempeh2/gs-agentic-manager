import { describe, expect, it } from "vitest";
import { runApiEquivalent, runApiEquivalentLabel, visibleRunCostUsd } from "./utils";

const codexTokens = { provider: "openai", model: "gpt-6-sol", inputTokens: 793, cachedInputTokens: 43_776, outputTokens: 78 };
const codexUsd = (793 * 2 + 43_776 * 0.2 + 78 * 10) / 1_000_000;

describe("run API-equivalent cost", () => {
  it("prices a past Codex run that was stored unpriced, as an estimate", () => {
    const usage = { ...codexTokens, billingType: "subscription_included", costStatus: "unpriced" };
    const value = runApiEquivalent(usage, null, "2026-10-22");
    expect(value?.estimated).toBe(true);
    expect(value?.usd).toBeCloseTo(codexUsd, 12);
  });

  it("reads the estimate stored at run end and never counts it as billed", () => {
    const usage = { ...codexTokens, billingType: "metered_api", costStatus: "estimated", costUsd: 0.5 };
    expect(visibleRunCostUsd(usage)).toBe(0);
    expect(runApiEquivalent(usage)).toEqual({ usd: 0.5, estimated: true });
  });

  it("shows Claude's reported subscription cost as API-equivalent, not estimated", () => {
    const usage = {
      provider: "anthropic",
      model: "claude-opus-5-5",
      billingType: "subscription_included",
      costStatus: "reported",
      costUsd: 0.5687894,
      cacheAdjustedCostUsd: 0.51,
    };
    expect(runApiEquivalent(usage)).toEqual({ usd: 0.51, estimated: false });
  });

  it("leaves an unpublished model unpriced and a billed run to its billed cost", () => {
    expect(runApiEquivalent({ ...codexTokens, model: "gpt-9-mystery", billingType: "subscription_included" })).toBeNull();
    expect(runApiEquivalent({ ...codexTokens, billingType: "metered_api", costStatus: "reported", costUsd: 1 })).toBeNull();
  });

  it("labels each kind plainly", () => {
    expect(runApiEquivalentLabel(true)).toBe("Estimated, API-equivalent");
    expect(runApiEquivalentLabel(false)).toBe("API-equivalent; billed through your subscription");
  });
});
