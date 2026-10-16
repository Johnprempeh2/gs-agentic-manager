// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentAccessItem, AgentAccessSummary } from "@greatstone/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockToolsApi = vi.hoisted(() => ({
  listAgentAccess: vi.fn(),
}));

vi.mock("../api/tools", () => ({ toolsApi: mockToolsApi }));

// Render the company-aware Link as a plain anchor so we don't need a Router.
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: unknown }) =>
    createElement("a", { href: to, ...rest }, children as never),
}));

import { AgentAccessTab, agentAccessHeadline } from "./AgentAccessTab";

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

const AGENT = { id: "agent-1", name: "Writer", urlKey: "writer" };

function item(overrides: Partial<AgentAccessItem> & Pick<AgentAccessItem, "id" | "label" | "state">): AgentAccessItem {
  return {
    kind: "connection",
    connectionId: overrides.id,
    reason: null,
    lastUsedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

function summary(items: AgentAccessItem[]): AgentAccessSummary {
  return {
    generatedAt: "2026-10-16T12:00:00.000Z",
    agents: [
      { agentId: "agent-1", name: "Writer", items, counts: { missing: 0, failing: 0, expiring: 0 } },
      {
        agentId: "agent-2",
        name: "Other",
        items: [item({ id: "other", label: "Other agent app", state: "failing" })],
        counts: { missing: 0, failing: 1, expiring: 0 },
      },
    ],
  };
}

describe("AgentAccessTab", () => {
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

  async function renderTab() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(() => {
      root = createRoot(container);
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(AgentAccessTab, { agent: AGENT, companyId: "company-1" }),
        ),
      );
    });
    await flushReact();
  }

  it("lists what needs attention first and folds working items away", async () => {
    mockToolsApi.listAgentAccess.mockResolvedValue(summary([
      item({ id: "conn-broken", label: "Google Drive", state: "failing", reason: "Needs to be reconnected" }),
      item({ id: "binding-1", kind: "secret", connectionId: null, label: "API key", state: "missing", reason: "The secret it needs has been deleted" }),
      item({ id: "conn-ok", label: "Notion", state: "ok" }),
      item({ id: "chan-1", kind: "channel", label: "Slack: Acme", state: "ok" }),
    ]));

    await renderTab();

    expect(mockToolsApi.listAgentAccess).toHaveBeenCalledWith("company-1");
    expect(container.querySelector("[data-testid='agent-access-headline']")?.textContent).toBe("2 things need attention");
    const rows = [...container.querySelectorAll("[data-testid='agent-access-row']")];
    expect(rows.map((row) => row.getAttribute("data-state"))).toEqual(["failing", "missing"]);
    expect(container.textContent).toContain("Needs to be reconnected");
    expect(container.textContent).toContain("The secret it needs has been deleted");
    expect(container.textContent).not.toContain("Other agent app");
    expect(container.textContent).not.toContain("Notion");

    const links = rows.map((row) => row.querySelector("a")?.getAttribute("href"));
    expect(links).toEqual(["/apps/conn-broken", "/agents/writer/secrets"]);

    const toggle = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Working (2)"));
    expect(toggle).toBeTruthy();
    await act(() => toggle!.click());
    expect(container.textContent).toContain("Notion");
    const channelLink = [...container.querySelectorAll("a")].find((link) => link.textContent === "Open channels");
    expect(channelLink?.getAttribute("href")).toBe("/agents/writer/channels");
  });

  it("says everything is working when nothing needs attention", async () => {
    mockToolsApi.listAgentAccess.mockResolvedValue(summary([item({ id: "conn-ok", label: "Notion", state: "ok" })]));

    await renderTab();

    expect(container.querySelector("[data-testid='agent-access-headline']")?.textContent).toBe(
      "Everything this agent needs is working",
    );
  });

  it("shows an empty state when the agent has nothing yet", async () => {
    mockToolsApi.listAgentAccess.mockResolvedValue(summary([]));

    await renderTab();

    expect(container.textContent).toContain("This agent has no apps, keys or channels yet.");
  });

  it("shows an error when the summary cannot be loaded", async () => {
    mockToolsApi.listAgentAccess.mockRejectedValue(new Error("boom"));

    await renderTab();

    expect(container.textContent).toContain("Could not load this view");
  });

  it("words the headline for a single item", () => {
    expect(agentAccessHeadline([item({ id: "a", label: "A", state: "expiring" })])).toBe("1 thing needs attention");
  });
});
