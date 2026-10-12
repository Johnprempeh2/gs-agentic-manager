// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentChat } from "./AgentChat";

const setBreadcrumbs = vi.hoisted(() => vi.fn());
const chatEnabled = vi.hoisted(() => ({ enabled: false, loaded: true }));
const mockAgentChatsApi = vi.hoisted(() => ({ get: vi.fn(), ensure: vi.fn() }));

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: vi.fn(async () => [{ id: "agent-1", companyId: "company-1", name: "Everest", urlKey: "everest" }]),
  },
}));
vi.mock("@/api/auth", () => ({
  authApi: { getSession: vi.fn(async () => ({ user: { id: "user-1" } })) },
}));
vi.mock("@/api/agentChats", () => ({ agentChatsApi: mockAgentChatsApi }));
vi.mock("@/hooks/useAgentChatEnabled", () => ({ useAgentChatEnabled: () => chatEnabled }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs }) }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/lib/router", () => ({
  useParams: () => ({ agentRef: "everest" }),
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
}));
vi.mock("./IssueDetail", () => ({ TaskDetailSurface: () => <div data-testid="chat-surface" /> }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("AgentChat with Agent Chat turned off", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setBreadcrumbs.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AgentChat />
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  it("keeps the normal header so a phone gets a title and a back arrow", async () => {
    await render();

    expect(setBreadcrumbs).toHaveBeenLastCalledWith([
      { label: "Agents", href: "/agents" },
      { label: "Everest" },
    ]);
  });

  it("links to Experimental settings", async () => {
    await render();

    const link = container.querySelector("a");
    expect(link?.textContent).toBe("Experimental settings");
    expect(link?.getAttribute("href")).toBe("/company/settings/instance/experimental");
    expect(mockAgentChatsApi.get).not.toHaveBeenCalled();
  });
});
