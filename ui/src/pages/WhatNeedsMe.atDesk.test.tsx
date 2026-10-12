// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionCard } from "@greatstone/shared";
import { atDeskCard, fixtureFeed, questionCard } from "../fixtures/decisionsFeedFixtures";

const state = vi.hoisted(() => ({ isPhone: false, feed: null as unknown, view: "list" as "list" | "focus" }));

vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: undefined, isLoading: false }) }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }) }));
vi.mock("../hooks/useInboxBadge", () => ({ useInboxDismissals: () => ({ restore: () => {} }) }));
vi.mock("../hooks/useIsPhone", () => ({ useIsPhone: () => state.isPhone }));
vi.mock("../hooks/useDecisionsFeed", () => ({
  useDecisionsFeed: () => ({ data: state.feed, isLoading: false, error: null, refetch: () => {} }),
  useNeedsMe: () => ({ data: undefined }),
}));
vi.mock("../lib/focus-prefs", () => ({
  loadDecisionsView: () => state.view,
  loadFocusPrefs: () => ({ autoRead: false }),
  saveDecisionsView: () => {},
  saveFocusPrefs: () => {},
}));
vi.mock("../components/decisions-feed/TabledList", () => ({ TabledList: () => null, useTabledIssues: () => ({ data: [] }) }));
vi.mock("../components/DecisionQueueRail", () => ({ DecisionQueueRail: () => null }));
vi.mock("../components/decisions-feed/DecisionNotificationsCard", () => ({ DecisionNotificationsCard: () => null }));
vi.mock("../components/decisions-feed/DecisionFeedCard", () => ({
  DecisionFeedCard: ({ card }: { card: DecisionCard }) => <article data-card={card.id} />,
}));
vi.mock("../components/decisions-focus/DecisionsFocusView", () => ({
  DecisionsFocusView: ({ cards }: { cards: DecisionCard[] }) => (
    <div data-focus>{cards.map((card) => <article key={card.id} data-card={card.id} />)}</div>
  ),
}));

import { WhatNeedsMe } from "./WhatNeedsMe";

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => root.render(<WhatNeedsMe />));
}

/** Card ids in page order; the desk group is marked `desk`. */
function order() {
  return [...container.querySelectorAll("[data-card], [data-at-desk-group]")]
    .filter((node) => node.hasAttribute("data-at-desk-group") || !node.closest("[data-at-desk-group]"))
    .map((node) => (node.hasAttribute("data-at-desk-group") ? "desk" : node.getAttribute("data-card")));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.feed = fixtureFeed([questionCard(), atDeskCard()]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Decisions: at your desk (GRE-450)", () => {
  it.each(["list", "focus"] as const)("%s on a laptop: the desk group comes first and open; the header counts phone cards", (view) => {
    state.isPhone = false;
    state.view = view;
    render();
    expect(order()).toEqual(["desk", "task:issue-44"]);
    expect(container.querySelector("[aria-label='1 waiting']")).not.toBeNull();
  });

  it.each(["list", "focus"] as const)("%s on a phone: phone cards first, the desk group folded last", (view) => {
    state.isPhone = true;
    state.view = view;
    render();
    expect(order()).toEqual(["task:issue-44", "desk"]);
    // Folded: the desk card is not rendered until the group is opened.
    expect(container.querySelector("[data-card='task:issue-407']")).toBeNull();
  });

  it("on a laptop with only desk cards, shows the group instead of 'all caught up'", () => {
    state.isPhone = false;
    state.view = "list";
    state.feed = fixtureFeed([atDeskCard()]);
    render();
    expect(container.textContent).not.toContain("You're all caught up");
    expect(container.querySelector("[data-card='task:issue-407']")).not.toBeNull();
  });
});
