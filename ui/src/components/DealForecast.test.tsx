// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { DealForecast, OwnerScorecard } from "./DealForecast";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("DealForecast", () => {
  it("shows each month's value and weighted value, and hides when there are no deals", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <DealForecast
          buckets={[
            { key: "overdue", label: "Overdue", count: 1, totals: [{ currency: "GBP", total: 1000 }], weighted: [{ currency: "GBP", total: 500 }] },
            { key: "2026-10", label: "Oct 2026", count: 0, totals: [], weighted: [] },
          ]}
        />,
      ),
    );
    expect(container.querySelector("[data-testid='forecast-overdue']")?.textContent).toBe("Overdue1,000 GBP1 deal · 500 GBP weighted");
    expect(container.querySelector("[data-testid='forecast-2026-10']")?.textContent).toBe("Oct 202600 deals");
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector("[data-testid='forecast-overdue']")).toBeNull();

    await act(async () => root.render(<DealForecast buckets={[{ key: "2026-10", label: "Oct 2026", count: 0, totals: [], weighted: [] }]} />));
    expect(container.textContent).toBe("");
    root.unmount();
  });

  it("lists deals by owner only when more than one owner has deals", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const row = (owner: string, overdue: number) => ({
      owner, open: 2, openTotals: [{ currency: "GBP", total: 2000 }], weighted: [], overdueNextSteps: overdue, won: 1, lost: 1, winRate: 50,
    });
    await act(async () => root.render(<OwnerScorecard rows={[row("Ann", 1)]} />));
    expect(container.textContent).toBe("");
    await act(async () => root.render(<OwnerScorecard rows={[row("Ann", 1), row("Ben", 0)]} />));
    const rows = [...container.querySelectorAll("[data-testid='owner-scorecard-row']")].map((tr) => tr.textContent);
    expect(rows).toEqual(["Ann22,000 GBP150% (1 of 2)", "Ben22,000 GBP050% (1 of 2)"]);
    root.unmount();
  });
});

