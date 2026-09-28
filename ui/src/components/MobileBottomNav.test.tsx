// @vitest-environment jsdom

import { type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileBottomNav } from "./MobileBottomNav";

const mockAttentionApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/PAP/dashboard" }),
  NavLink: ({ to, children, className, state: _state, ...props }: {
    to: string;
    children: ReactNode | ((state: { isActive: boolean }) => ReactNode);
    className?: string | ((state: { isActive: boolean }) => string);
    state?: unknown;
  }) => (
    <a
      href={to}
      className={typeof className === "function" ? className({ isActive: false }) : className}
      {...props}
    >
      {typeof children === "function" ? children({ isActive: false }) : children}
    </a>
  ),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue: vi.fn() }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../api/attention", () => ({
  attentionApi: mockAttentionApi,
}));

vi.mock("../hooks/useInboxBadge", () => ({
  useInboxBadge: () => ({ inbox: 0, failedRuns: 0 }),
}));

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("MobileBottomNav", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAttentionApi.list.mockResolvedValue({ items: [], deskBadgeCount: 3 });
  });

  afterEach(() => {
    container.remove();
    vi.clearAllMocks();
  });

  it("shows Decisions with its badge and keeps five items (GRE-66)", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MobileBottomNav visible />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const grid = container.querySelector("nav > div")!;
    expect(grid.children).toHaveLength(5);

    const decisionsLink = [...container.querySelectorAll("a")].find(
      (anchor) => anchor.textContent?.includes("Decisions"),
    );
    expect(decisionsLink?.getAttribute("href")).toBe("/decisions");
    expect(decisionsLink?.textContent).toContain("3");
    expect(mockAttentionApi.list).toHaveBeenCalledWith("company-1");

    flushSync(() => {
      root.unmount();
    });
  });
});
