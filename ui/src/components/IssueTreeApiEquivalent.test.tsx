// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { IssueCostSummary } from "@greatstone/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IssueTreeApiEquivalent } from "./IssueTreeApiEquivalent";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const baseSummary: IssueCostSummary = {
  issueId: "issue-1",
  issueCount: 3,
  includeDescendants: true,
  costCents: 0,
  inputTokens: 236_000,
  cachedInputTokens: 2_090_000,
  outputTokens: 31_000,
  runCount: 5,
  runtimeMs: 60_000,
  apiEquivalentCents: 1_234.4,
  unpricedTokens: 1_500,
  byModel: [
    {
      provider: "anthropic",
      model: "claude-opus-5-5",
      inputTokens: 200_000,
      cachedInputTokens: 2_000_000,
      outputTokens: 30_000,
      costCents: 0,
      apiEquivalentCents: 1_000,
    },
    {
      provider: "anthropic",
      model: "claude-sonnet-5",
      inputTokens: 34_500,
      cachedInputTokens: 90_000,
      outputTokens: 500,
      costCents: 0,
      apiEquivalentCents: 234.4,
    },
    {
      provider: "anthropic",
      model: "claude-unknown",
      inputTokens: 1_500,
      cachedInputTokens: 0,
      outputTokens: 0,
      costCents: 0,
      apiEquivalentCents: null,
    },
  ],
};

describe("IssueTreeApiEquivalent", () => {
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

  it("shows the tree total labelled API-equivalent and the per-model split", () => {
    act(() => root.render(<IssueTreeApiEquivalent summary={baseSummary} />));
    const text = container.textContent ?? "";
    expect(text).toContain("API-equivalent $12.34");
    expect(text).toContain("claude-opus-5-5 $10.00");
    expect(text).toContain("claude-sonnet-5 $2.34");
    expect(text).toContain("claude-unknown unpriced");
    expect(text).toContain("on unpriced models not included");
    expect(container.querySelector("[title]")?.getAttribute("title")).toContain("Not a bill");
  });

  it("renders nothing when the tree has no token usage", () => {
    act(() => root.render(<IssueTreeApiEquivalent summary={{ ...baseSummary, apiEquivalentCents: 0, unpricedTokens: 0, byModel: [] }} />));
    expect(container.textContent).toBe("");
  });
});
