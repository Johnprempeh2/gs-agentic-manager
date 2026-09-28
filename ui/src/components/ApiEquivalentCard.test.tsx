// @vitest-environment jsdom

import { act as reactAct } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { ApiEquivalentSummary } from "@greatstone/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiEquivalentCard, apiEquivalentDifferenceLine } from "./ApiEquivalentCard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  if (typeof reactAct === "function") {
    reactAct(callback);
    return;
  }
  flushSync(callback);
}

const summary: ApiEquivalentSummary = {
  companyId: "company-1",
  from: "2026-04-01T00:00:00.000Z",
  to: "2026-05-01T00:00:00.000Z",
  priceTableCheckedAt: "2026-09-28",
  actualApiSpendCents: 300,
  subscriptionCostCents: 40_000,
  paidCents: 40_300,
  apiEquivalentCents: 1_235,
  savingCents: -39_065,
  totalTokens: 5_951_500,
  unpricedTokens: 1_500,
  unpricedModels: ["openai/gpt-5.6-terra"],
  byProvider: [
    {
      provider: "openai",
      inputTokens: 1_001_000,
      cachedInputTokens: 800_000,
      outputTokens: 50_500,
      actualApiSpendCents: 0,
      subscriptionCostCents: 20_000,
      apiEquivalentCents: 85,
      unpricedTokens: 1_500,
    },
  ],
  byModel: [
    {
      provider: "openai",
      model: "gpt-5",
      inputTokens: 1_000_000,
      cachedInputTokens: 800_000,
      outputTokens: 50_000,
      subscriptionTokens: 1_850_000,
      actualApiSpendCents: 0,
      apiEquivalentCents: 85,
    },
    {
      provider: "openai",
      model: "gpt-5.6-terra",
      inputTokens: 1_000,
      cachedInputTokens: 0,
      outputTokens: 500,
      subscriptionTokens: 1_500,
      actualApiSpendCents: 0,
      apiEquivalentCents: null,
    },
  ],
};

describe("ApiEquivalentCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows actual API spend, subscription cost and API-equivalent cost, with unknown prices marked", () => {
    act(() => root.render(<ApiEquivalentCard summary={summary} />));
    const text = container.textContent ?? "";
    expect(text).toContain("Actual API spend$3.00");
    expect(text).toContain("Subscription cost$400.00");
    expect(text).toContain("Would cost under API billing$12.35");
    expect(text).toContain("unknown");
    expect(text).toContain("openai/gpt-5.6-terra");
    expect(container.querySelector("[data-testid='api-equivalent-difference']")?.textContent).toBe(
      "Extra $390.65: we paid $403.00, API billing would have cost $12.35.",
    );
  });

  it("describes a saving when API billing would cost more than we pay", () => {
    expect(apiEquivalentDifferenceLine({ savingCents: 10_000, paidCents: 20_000, apiEquivalentCents: 30_000 })).toBe(
      "Saving $100.00: we paid $200.00, API billing would have cost $300.00.",
    );
  });
});
