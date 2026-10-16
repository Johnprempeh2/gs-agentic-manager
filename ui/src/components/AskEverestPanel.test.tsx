// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskEverestPanel, findLeadReply } from "./AskEverestPanel";
import { openAskEverest } from "../lib/ask-everest-events";
import type { IssueComment } from "@greatstone/shared";

const mocks = vi.hoisted(() => ({
  agentsList: vi.fn(),
  needsMe: vi.fn(),
  scorecard: vi.fn(),
  issuesList: vi.fn(),
  addComment: vi.fn(),
  listComments: vi.fn(),
  ensureChat: vi.fn(),
  experimental: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../api/agents", () => ({ agentsApi: { list: mocks.agentsList } }));
vi.mock("../api/decisionsFeed", () => ({ decisionsFeedApi: { needsMe: mocks.needsMe } }));
vi.mock("../api/teamScorecard", () => ({ teamScorecardApi: { get: mocks.scorecard } }));
vi.mock("../api/issues", () => ({
  issuesApi: { list: mocks.issuesList, addComment: mocks.addComment, listComments: mocks.listComments },
}));
vi.mock("../api/agentChats", () => ({ agentChatsApi: { ensure: mocks.ensureChat } }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: mocks.experimental } }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, onClick }: { to: string; children: ReactNode; onClick?: () => void }) =>
    createElement("a", { href: to, onClick }, children),
}));
vi.mock("./AgentAvatar", () => ({ AgentAvatar: () => null }));
vi.mock("./MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => createElement("div", null, children) }));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? createElement("div", null, children) : null),
  SheetContent: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  SheetTitle: ({ children }: { children: ReactNode }) => createElement("h2", null, children),
  SheetDescription: ({ children }: { children: ReactNode }) => createElement("p", null, children),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(callback);
}

async function waitFor(assertion: () => void, attempts = 60) {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

const agents = [
  { id: "everest", name: "Everest", role: "ceo", status: "idle", reportsTo: null, urlKey: "everest" },
  { id: "mason", name: "Mason", role: "engineer", status: "idle", reportsTo: "everest", urlKey: "mason" },
];

describe("AskEverestPanel", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.agentsList.mockResolvedValue(agents);
    mocks.experimental.mockResolvedValue({ enableAgentChat: true });
    mocks.needsMe.mockResolvedValue({
      count: 1,
      decisionCount: 1,
      assignedTaskCount: 0,
      decisions: [{ id: "task:i1", title: "Approve the Indago fee", reason: "Fixed fee or day rate", task: { id: "i1", identifier: "GRE-9" } }],
      assignedTasks: [],
      overdueWaits: [],
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(createElement(QueryClientProvider, { client }, createElement(AskEverestPanel)));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("answers a decision question from Needs you", async () => {
    act(() => openAskEverest("What do I need to decide?"));
    await waitFor(() => {
      expect(container.textContent).toContain("1 thing needs you: 1 decision.");
      expect(container.textContent).toContain("Approve the Indago fee");
    });
    expect(mocks.needsMe).toHaveBeenCalledWith("company-1");
  });

  it("shows suggestions before a question is asked", async () => {
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", metaKey: true, bubbles: true }));
    });
    await waitFor(() => {
      expect(container.textContent).toContain("What is stuck?");
      expect(container.textContent).toContain("What did Mason do today?");
    });
  });

  it("passes the question to Everest and shows the reply", async () => {
    mocks.ensureChat.mockResolvedValue({ id: "chat-1" });
    mocks.addComment.mockResolvedValue({ id: "c1", createdAt: "2026-10-16T09:00:00Z" });
    mocks.listComments.mockResolvedValue([
      { id: "c2", authorAgentId: "everest", body: "Two Indago tasks are waiting on your fee decision.", createdAt: "2026-10-16T09:01:00Z" },
    ]);
    act(() => openAskEverest("What do I need to decide?"));
    await waitFor(() => expect(container.querySelector('[data-testid="ask-everest-live"]')).not.toBeNull());
    act(() => {
      (container.querySelector('[data-testid="ask-everest-live"]') as HTMLButtonElement).click();
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Two Indago tasks are waiting on your fee decision.");
    });
    expect(mocks.ensureChat).toHaveBeenCalledWith("company-1", "everest");
    expect(mocks.addComment).toHaveBeenCalledWith("chat-1", "What do I need to decide?", true, undefined, undefined, expect.any(String));
  });
});

describe("findLeadReply", () => {
  it("takes the lead's first reply after the question", () => {
    const comments = [
      { id: "old", authorAgentId: "everest", body: "old", createdAt: "2026-10-16T08:00:00Z" },
      { id: "late", authorAgentId: "everest", body: "second", createdAt: "2026-10-16T09:05:00Z" },
      { id: "first", authorAgentId: "everest", body: "first", createdAt: "2026-10-16T09:02:00Z" },
      { id: "other", authorAgentId: "mason", body: "not the lead", createdAt: "2026-10-16T09:01:00Z" },
    ] as unknown as IssueComment[];
    expect(findLeadReply(comments, "everest", "2026-10-16T09:00:00Z")?.id).toBe("first");
  });
});
