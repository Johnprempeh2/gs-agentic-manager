// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentAccessAgentSummary, AgentAccessItem } from "@greatstone/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockToolsApi = vi.hoisted(() => ({
  listAgentAccess: vi.fn(),
}));

vi.mock("../../api/tools", () => ({ toolsApi: mockToolsApi }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }),
}));
// Render the company-aware Link as a plain anchor so we don't need a Router.
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: unknown }) =>
    createElement("a", { href: to, ...rest }, children as never),
}));

import { AgentAccess, companyAccessHeadline, sortAgentsForAccess } from "./AgentAccess";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function item(overrides: Partial<AgentAccessItem> & Pick<AgentAccessItem, "id" | "label" | "state">): AgentAccessItem {
  return { kind: "connection", connectionId: overrides.id, reason: null, lastUsedAt: null, expiresAt: null, ...overrides };
}

function agent(agentId: string, name: string, items: AgentAccessItem[]): AgentAccessAgentSummary {
  return { agentId, name, items, counts: { missing: 0, failing: 0, expiring: 0 } };
}

const AGENTS = [
  agent("agent-ok", "Atlas", [item({ id: "notion", label: "Notion", state: "ok" })]),
  agent("agent-one", "Bard", [item({ id: "drive", label: "Google Drive", state: "expiring", reason: "Expires in 3 days" })]),
  agent("agent-two", "Cleo", [
    item({ id: "github", label: "GitHub", state: "failing", reason: "Needs to be reconnected" }),
    item({ id: "key", kind: "secret", connectionId: null, label: "API key", state: "missing" }),
    item({ id: "slack", kind: "channel", label: "Slack", state: "ok" }),
  ]),
  agent("agent-none", "Dot", []),
];

describe("AgentAccess", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockToolsApi.listAgentAccess.mockReset();
  });

  afterEach(async () => {
    await act(() => root?.unmount());
    root = null;
    container.remove();
  });

  async function renderPage() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(() => {
      root = createRoot(container);
      root.render(createElement(QueryClientProvider, { client }, createElement(AgentAccess)));
    });
    await flushReact();
  }

  it("sums up the company and orders agents by how much needs fixing", () => {
    expect(companyAccessHeadline(AGENTS)).toBe("2 agents need attention");
    expect(companyAccessHeadline([AGENTS[0]!])).toBe("Every agent has what it needs");
    expect(sortAgentsForAccess(AGENTS).map((a) => a.name)).toEqual(["Cleo", "Bard", "Atlas", "Dot"]);
  });

  it("lists each agent with what needs attention and folds working agents away", async () => {
    mockToolsApi.listAgentAccess.mockResolvedValue({ generatedAt: "2026-10-16T17:00:00.000Z", agents: AGENTS });

    await renderPage();

    expect(mockToolsApi.listAgentAccess).toHaveBeenCalledWith("company-1");
    expect(container.querySelector("[data-testid='company-access-headline']")?.textContent).toBe(
      "2 agents need attention",
    );
    const cards = [...container.querySelectorAll("[data-testid='company-access-agent']")];
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual(["Cleo", "Bard"]);
    expect(cards[0]!.textContent).toContain("2 things need attention");
    expect(cards[0]!.textContent).toContain("Needs to be reconnected");
    expect(cards[0]!.textContent).not.toContain("Slack");
    expect(container.textContent).not.toContain("Dot");

    const toggle = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Everything working (1)"));
    expect(toggle).toBeTruthy();
    expect(container.textContent).not.toContain("Atlas");
    await act(() => toggle!.click());
    expect(container.textContent).toContain("Atlas");
    expect(container.textContent).toContain("1 thing working");
  });
});
