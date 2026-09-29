// @vitest-environment jsdom

import { act as reactAct } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { AttentionFeed, AttentionItem } from "@greatstone/shared";
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

function item(overrides: Partial<AttentionItem> & { title?: string }): AttentionItem {
  const { title = "Approve hire", ...rest } = overrides;
  return {
    id: "att-1",
    sourceKind: "approval",
    subject: { kind: "approval", id: "sub-1", companyId: "c", title, identifier: "GRE-9", status: null, href: null },
    rank: 1,
    severity: "medium",
    ...rest,
  } as unknown as AttentionItem;
}

function feed(items: AttentionItem[], totalCount = items.length): AttentionFeed {
  return { items, totalCount, deskBadgeCount: 0 } as unknown as AttentionFeed;
}

describe("selectDashboardDecisions", () => {
  it("previews the best-ranked item and counts the whole feed", () => {
    const result = selectDashboardDecisions(
      feed(
        [
          item({ id: "c", rank: 3 }),
          item({ id: "a", rank: 1 }),
          item({ id: "d", rank: 4 }),
          item({ id: "b", rank: 2 }),
        ],
        9,
      ),
    );
    expect(result.count).toBe(9);
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

  it("shows the count, the top title without its task key, and a button to the decisions page", () => {
    act(() => {
      root.render(
        <DashboardDecisionsBoxView
          feed={feed([
            item({ id: "b", rank: 2, title: "Approve hire" }),
            item({ id: "a", rank: 1, title: "Pick a name", sourceKind: "decision", subject: { kind: "decision", id: "dec-1", companyId: "c", title: "Pick a name", identifier: null, status: null, href: null } }),
          ], 5)}
        />,
      );
    });

    expect(container.querySelector('[data-testid="dashboard-decisions-count"]')?.textContent).toBe("5");
    expect(container.textContent).toContain("Pick a name");
    expect(container.textContent).not.toContain("Approve hire");
    expect(container.textContent).toContain("and 4 more");
    expect(container.textContent).not.toContain("GRE-9");
    expect(container.querySelector('a[href="/decisions?decisionId=dec-1"]')).not.toBeNull();
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
