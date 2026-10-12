// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIXTURE_COMPANY_ID,
  approvalCard,
  atDeskCard,
  fixtureAgents,
  fixtureFeed,
  questionCard,
} from "../../fixtures/decisionsFeedFixtures";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), copy: vi.fn() }));

vi.mock("../../api/client", () => ({ api: { get: api.get, post: api.post, patch: api.patch } }));
vi.mock("../../lib/clipboard", () => ({ copyTextToClipboard: api.copy }));
vi.mock("../../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("../AttentionInteractionResolver", () => ({
  AttentionInteractionResolver: ({ interactionId }: { interactionId: string }) => (
    <div data-testid="inline-question">{interactionId}</div>
  ),
}));
vi.mock("../MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock("../DecisionResolver", () => ({ DecisionResolver: () => <div /> }));

import { AtDeskGroup, splitAtDeskCards } from "./AtDeskGroup";
import { selectDashboardDecisions } from "../DashboardDecisionsBox";

let container: HTMLDivElement;
let root: Root;

function render(node: ReactNode) {
  act(() => {
    root.render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
  });
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll("button")].find(
    (entry) => entry.getAttribute("aria-label") === label || entry.textContent?.trim() === label,
  );
  if (!match) throw new Error(`No button "${label}"`);
  return match as HTMLButtonElement;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function group(defaultOpen: boolean) {
  return (
    <AtDeskGroup
      cards={[atDeskCard()]}
      defaultOpen={defaultOpen}
      companyId={FIXTURE_COMPANY_ID}
      assignableAgents={fixtureAgents}
    />
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.post.mockReset().mockResolvedValue({});
  api.copy.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("At your desk (GRE-450)", () => {
  it("splits desk cards from phone cards and keeps feed order", () => {
    const desk = atDeskCard();
    const question = questionCard();
    const approval = approvalCard();
    expect(splitAtDeskCards([question, desk, approval])).toEqual({ phone: [question, approval], desk: [desk] });
  });

  it("leaves desk cards out of the dashboard count", () => {
    const feed = fixtureFeed([questionCard(), atDeskCard()]);
    expect(feed.count).toBe(1);
    expect(selectDashboardDecisions(feed)).toMatchObject({ count: 1, preview: [{ id: "task:issue-44" }] });
  });

  it("shows the command in a copy box and Done instead of a second Accept", async () => {
    render(group(true));
    expect(container.textContent).toContain("At your desk (1)");
    expect(container.querySelector("[aria-label='Command']")?.textContent).toBe("wsl --shutdown");
    // The confirmation is answered with Done, so its in-place form is not shown.
    expect(container.querySelector("[data-testid='inline-question']")).toBeNull();

    await click(button("Copy command"));
    expect(api.copy).toHaveBeenCalledWith("wsl --shutdown");
    expect(button("Copy command").textContent).toContain("Copied");

    await click(button("Done"));
    expect(api.post).toHaveBeenCalledWith("/issues/issue-407/interactions/int-wsl/accept", {});
  });

  it("folds the group on a phone until it is opened", async () => {
    render(group(false));
    expect(container.textContent).toContain("At your desk (1)");
    expect(container.querySelector("[data-at-desk-panel]")).toBeNull();
    await click([...container.querySelectorAll("button")].find((entry) => entry.textContent?.includes("At your desk"))!);
    expect(container.querySelector("[data-at-desk-panel]")).not.toBeNull();
  });
});
