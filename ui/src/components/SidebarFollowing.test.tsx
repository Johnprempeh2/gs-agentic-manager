// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarFollowing } from "./SidebarFollowing";

const mockIssuesApi = vi.hoisted(() => ({ listFollows: vi.fn() }));

vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("@/lib/router", () => ({
  NavLink: ({ children, to, className, ...props }: {
    children: ReactNode;
    to: string;
    className?: string | ((state: { isActive: boolean }) => string);
  }) => (
    <a href={to} className={typeof className === "function" ? className({ isActive: false }) : className} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ collapsed: false, peeking: false, isMobile: false, setSidebarOpen: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("SidebarFollowing", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockIssuesApi.listFollows.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <SidebarFollowing companyId="company-1" />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    for (let index = 0; index < 5; index += 1) {
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }

  it("stays out of the sidebar until something is followed", async () => {
    mockIssuesApi.listFollows.mockResolvedValue([]);
    await render();
    expect(mockIssuesApi.listFollows).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toBe("");
  });

  it("lists each followed task with its subtree progress, one click away", async () => {
    mockIssuesApi.listFollows.mockResolvedValue([
      {
        issueId: "p1",
        followedAt: new Date(),
        issue: {
          id: "p1", identifier: "GRE-1681", title: "Indago portal", status: "in_progress",
          priority: "high", originKind: "manual", updatedAt: new Date(),
        },
        counts: { total: 12, done: 8, inProgress: 2, waitingOnYou: 1, blocked: 1 },
        latestUpdates: [],
      },
    ]);
    await render();

    expect(container.textContent).toContain("Pinned");
    const link = container.querySelector('a[href="/issues/GRE-1681"]');
    expect(link?.textContent).toContain("Indago portal");
    expect(link?.querySelector("[data-sidebar-follow-progress]")?.textContent).toContain("8/12");
    expect(link?.textContent).toContain("8 of 12 done, 1 waiting on you");
  });
});
