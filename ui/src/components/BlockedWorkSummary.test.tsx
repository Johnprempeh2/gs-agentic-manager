// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BlockedWorkOverview } from "@greatstone/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockBlockedWorkApi = vi.hoisted(() => ({ overview: vi.fn() }));

vi.mock("../api/blockedWork", () => ({ blockedWorkApi: mockBlockedWorkApi }));

vi.mock("@/lib/router", () => ({
  Link: ({ children, className, to }: { children: React.ReactNode; className?: string; to: string }) => (
    <a className={className} href={to}>
      {children}
    </a>
  ),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { BlockedWorkSummary } from "./BlockedWorkSummary";

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

function overview(overrides: Partial<BlockedWorkOverview> = {}): BlockedWorkOverview {
  const ref = (id: string, identifier: string, title: string, status: "blocked" | "in_progress" = "blocked") => ({
    id,
    identifier,
    title,
    status,
  });
  return {
    generatedAt: new Date().toISOString(),
    totalBlocked: 3,
    oldestWaitingSince: daysAgo(9),
    rootCauses: [
      {
        issue: ref("root", "GRE-1463", "Docker on the host", "in_progress"),
        owner: { type: "agent", agentId: "mason", userId: null },
        action: null,
        heldIssueIds: ["a", "b"],
        oldestWaitingSince: daysAgo(9),
      },
    ],
    items: [
      { issue: ref("a", "GRE-1", "Booking module"), waitingSince: daysAgo(9), owner: { type: "agent", agentId: "mason", userId: null }, rootIssueIds: ["root"], tidyReason: null },
      { issue: ref("b", "GRE-2", "Calendar sync"), waitingSince: daysAgo(2), owner: { type: "nobody", agentId: null, userId: null }, rootIssueIds: ["root"], tidyReason: null },
      { issue: ref("c", "GRE-5", "Can resume"), waitingSince: daysAgo(1), owner: { type: "agent", agentId: "ridge", userId: null }, rootIssueIds: ["c"], tidyReason: "waiting_on_finished_work" },
    ],
    truncated: false,
    ...overrides,
  };
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("BlockedWorkSummary", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    mockBlockedWorkApi.overview.mockReset();
  });

  function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={client}>
          <BlockedWorkSummary
            companyId="company-1"
            agentNameById={new Map([["mason", "Mason"], ["ridge", "Ridge"]])}
            currentUserId="user-1"
          />
        </QueryClientProvider>,
      );
    });
  }

  it("says how much is blocked, what holds it up and who must act", async () => {
    mockBlockedWorkApi.overview.mockResolvedValue(overview());
    render();
    await flush();

    expect(container.querySelector("[data-testid=blocked-work-headline]")?.textContent).toBe(
      "3 tasks are blocked. 1 task is holding up 2 tasks.",
    );
    expect(container.textContent).toContain("The longest has waited 9 days.");
    const rootRow = container.querySelector("[data-testid=blocked-work-root]")!;
    expect(rootRow.textContent).toContain("GRE-1463");
    expect(rootRow.textContent).toContain("Holding up 2 tasks");
    expect(rootRow.textContent).toContain("Mason needs to act");
    expect(rootRow.querySelector("a")?.getAttribute("href")).toBe("/issues/GRE-1463");

    const toggle = rootRow.querySelector("button")!;
    flushSync(() => toggle.click());
    expect(rootRow.textContent).toContain("Booking module");
    expect(rootRow.textContent).toContain("Calendar sync");

    const tidy = container.querySelector("[data-testid=blocked-work-tidy]")!;
    expect(tidy.textContent).toContain("Can resume");
    expect(tidy.textContent).toContain("Its blockers are done · Ridge");
    expect(container.textContent).not.toMatch(/[–—]/);
  });

  it("shows nothing when no work is blocked", async () => {
    mockBlockedWorkApi.overview.mockResolvedValue(overview({ totalBlocked: 0, rootCauses: [], items: [], oldestWaitingSince: null }));
    render();
    await flush();
    expect(container.querySelector("[data-testid=blocked-work-summary]")).toBeNull();
  });

  it("says when the summary cannot load", async () => {
    mockBlockedWorkApi.overview.mockRejectedValue(new Error("Server unavailable"));
    render();
    await flush();
    expect(container.querySelector("[data-testid=blocked-work-error]")?.textContent).toContain("Server unavailable");
  });
});
