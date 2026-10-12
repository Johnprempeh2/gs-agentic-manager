// @vitest-environment jsdom

import { act as reactAct } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { DecisionCard, DecisionsFeed } from "@greatstone/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardDecisionsBoxView, selectDashboardDecisions } from "./DashboardDecisionsBox";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: React.ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  if (typeof reactAct === "function") {
    reactAct(callback);
    return;
  }
  flushSync(callback);
}

function card(id: string, title: string): DecisionCard {
  return { id, title, kind: "blocked", kinds: ["blocked"], task: null, reason: "", waiting: null } as unknown as DecisionCard;
}

// The one Decisions feed (GRE-263): already ordered, with the one count.
function feed(cards: DecisionCard[], count = cards.length): DecisionsFeed {
  return { cards, count, countsByKind: {} } as unknown as DecisionsFeed;
}

describe("selectDashboardDecisions", () => {
  it("previews the first card and uses the feed's one count", () => {
    const result = selectDashboardDecisions(feed([card("a", "A"), card("b", "B"), card("c", "C")], 7));
    expect(result.count).toBe(7);
    expect(result.preview.map((entry) => entry.id)).toEqual(["a"]);
  });
});

describe("DashboardDecisionsBoxView", () => {
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

  it("shows the one count, the top card, and a button to the decisions page", () => {
    act(() => {
      root.render(
        <DashboardDecisionsBoxView
          feed={feed([card("task:1", "Pick a name"), card("task:2", "Approve hire")], 5)}
        />,
      );
    });

    expect(container.querySelector('[data-testid="dashboard-decisions-count"]')?.textContent).toBe("5");
    expect(container.textContent).toContain("Pick a name");
    expect(container.textContent).not.toContain("Approve hire");
    expect(container.textContent).toContain("and 4 more");
    expect(container.querySelector('a[title="Pick a name"]')?.getAttribute("href")).toBe("/decisions");
    const button = Array.from(container.querySelectorAll("a")).find((link) => link.textContent?.includes("Open decisions"));
    expect(button?.getAttribute("href")).toBe("/decisions");
  });

  it("says so in one line when nothing is waiting", () => {
    act(() => {
      root.render(<DashboardDecisionsBoxView feed={feed([], 0)} />);
    });

    expect(container.textContent).toContain("Nothing is waiting for you.");
    expect(container.querySelector('[data-testid="dashboard-decisions-count"]')?.textContent).toBe("0");
  });
});
