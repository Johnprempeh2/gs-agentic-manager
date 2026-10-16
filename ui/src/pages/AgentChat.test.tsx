// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentChat } from "./AgentChat";

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
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/lib/router", () => ({ useParams: () => ({ agentRef: "everest" }) }));
vi.mock("./IssueDetail", () => ({ TaskDetailSurface: () => <div data-testid="chat-surface" /> }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Agent Chat graduated out of Experimental (GRE-1621): there is no switch to check.
describe("AgentChat", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockAgentChatsApi.get.mockReset();
    mockAgentChatsApi.get.mockResolvedValue(null);
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

  it("opens the chat surface without an Experimental settings check", async () => {
    await render();

    expect(mockAgentChatsApi.get).toHaveBeenCalledWith("company-1", "agent-1");
    expect(container.querySelector('[data-testid="chat-surface"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Agent Chat is disabled");
    expect(container.querySelector("a")).toBeNull();
  });
});
