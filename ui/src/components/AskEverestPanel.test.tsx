// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskEverestPanel, findLeadReply } from "./AskEverestPanel";
import { openAskEverest } from "../lib/ask-everest-events";
import { fireFiles } from "../fixtures/fileEvents";
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
  uploadAttachment: vi.fn(),
  search: vi.fn(async () => ({ results: [] })),
  quietClients: vi.fn(),
  closingDeals: vi.fn(),
  clientBrief: vi.fn(async () => ({ brief: null })),
  recentClientActivity: vi.fn(async () => ({ days: 1, total: 0, clientCount: 0, byKind: [], activity: [] })),
}));

vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../api/agents", () => ({ agentsApi: { list: mocks.agentsList } }));
vi.mock("../api/decisionsFeed", () => ({ decisionsFeedApi: { needsMe: mocks.needsMe } }));
vi.mock("../api/teamScorecard", () => ({ teamScorecardApi: { get: mocks.scorecard } }));
vi.mock("../api/issues", () => ({
  issuesApi: { list: mocks.issuesList, addComment: mocks.addComment, listComments: mocks.listComments, uploadAttachment: mocks.uploadAttachment },
}));
vi.mock("../api/search", () => ({ searchApi: { search: mocks.search, quietClients: mocks.quietClients, closingDeals: mocks.closingDeals, clientBrief: mocks.clientBrief, recentClientActivity: mocks.recentClientActivity } }));
vi.mock("../api/agentChats", () => ({ agentChatsApi: { ensure: mocks.ensureChat } }));
vi.mock("../api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: mocks.experimental } }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, onClick }: { to: string; children: ReactNode; onClick?: () => void }) =>
    createElement("a", { href: to, onClick }, children),
}));
const dictationState = vi.hoisted(() => ({ onFinal: null as null | ((text: string) => void) }));
vi.mock("../hooks/useDictation", () => ({
  useDictation: ({ onFinal }: { onFinal: (text: string) => void }) => {
    dictationState.onFinal = onFinal;
    return { available: true, listening: false, interim: "", start: vi.fn(), stop: vi.fn(), toggle: vi.fn() };
  },
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

function typeQuestion(text: string) {
  const input = document.querySelector('input[aria-label^="Ask"]') as HTMLInputElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setValue.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => {
    (document.querySelector('button[aria-label="Ask"]') as HTMLButtonElement).click();
  });
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
      // The headline number is the one needs-you count.
      expect(container.textContent).toContain("1 thing needs you.");
      expect(container.textContent).toContain("Approve the Indago fee");
    });
    expect(mocks.needsMe).toHaveBeenCalledWith("company-1");
  });

  it("answers when we last spoke to a client from imported notes and calls", async () => {
    mocks.search.mockResolvedValueOnce({
      results: [
        { id: "activity:a1", type: "record", title: "Kick-off meeting", href: "/GRE/organisations/o1", updatedAt: "2026-09-01T10:00:00.000Z", record: { kind: "activity", subtitle: "Meeting, Acme Ltd, 1 Sep 2026" } },
        { id: "activity:a2", type: "record", title: "Pricing call", href: "/GRE/organisations/o1", updatedAt: "2026-10-12T10:00:00.000Z", record: { kind: "activity", subtitle: "Call, Acme Ltd, 12 Oct 2026" } },
      ],
    } as never);
    act(() => openAskEverest("When did we last speak to Acme?"));
    await waitFor(() => {
      expect(container.textContent).toContain("The latest with Acme: Pricing call (Call, Acme Ltd, 12 Oct 2026).");
      expect(container.textContent).toContain("Kick-off meeting");
    });
    expect(mocks.search).toHaveBeenCalledWith("company-1", { q: "Acme", limit: 10, recordKind: ["activity"], scope: "records" });
    expect(mocks.issuesList).not.toHaveBeenCalled();
  });

  it("lists clients that have gone quiet", async () => {
    mocks.quietClients.mockResolvedValueOnce({
      days: 14,
      total: 1,
      clients: [{ caseId: "c1", title: "Heron rollout", pipelineId: "p", pipelineName: "Sales", stageName: "Proposal", organisationName: "Heron Ltd", lastTouchAt: "2026-08-29T09:00:00.000Z", lastTouchLabel: "Call: Pricing call", quietDays: 50, href: "/GRE/pipelines/p/items/c1" }],
    });
    act(() => openAskEverest("Which clients have gone quiet for 2 weeks?"));
    await waitFor(() => expect(container.textContent).toContain("1 open deal or lead had no note, call or meeting in 14 days."));
    expect(mocks.quietClients).toHaveBeenCalledWith("company-1", { days: 14, limit: 8 });
  });

  it("lists deals closing this week", async () => {
    mocks.closingDeals.mockResolvedValueOnce({
      days: 7,
      total: 1,
      overdueCount: 0,
      valueByCurrency: [{ currency: "GBP", value: 2500, count: 1 }],
      deals: [{ caseId: "c1", title: "Heron rollout", pipelineName: "Sales", stageName: "Proposal", organisationName: null, expectedCloseDate: "2026-10-22", overdue: false, value: 2500, currency: "GBP", href: "/GRE/pipelines/p/items/c1" }],
    });
    act(() => openAskEverest("Which deals are closing this week?"));
    await waitFor(() => expect(container.textContent).toContain("1 open deal or lead closing this week, worth GBP 2,500."));
    expect(mocks.closingDeals).toHaveBeenCalledWith("company-1", { days: 7, limit: 8 });
  });

  it("briefs on an organisation", async () => {
    act(() => openAskEverest("Tell me about Grebe"));
    await waitFor(() => expect(container.textContent).toContain("I could not find an organisation called Grebe."));
    expect(mocks.clientBrief).toHaveBeenCalledWith("company-1", "Grebe");
  });

  it("shows suggestions before a question is asked", async () => {
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", metaKey: true, bubbles: true }));
    });
    await waitFor(() => {
      expect(container.textContent).toContain("What is stuck?");
      expect(container.textContent).toContain("What did Mason do today?");
      expect(container.textContent).toContain("Which deals are closing this month?");
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

  it("takes files by paste and drop, and sends them to Everest with the question", async () => {
    mocks.ensureChat.mockResolvedValue({ id: "chat-1" });
    mocks.uploadAttachment.mockImplementation(async (_companyId: string, _issueId: string, file: File) => ({ id: `att-${file.name}` }));
    mocks.addComment.mockResolvedValue({ id: "c1", createdAt: "2026-10-16T09:00:00Z" });
    mocks.listComments.mockResolvedValue([]);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", metaKey: true, bubbles: true }));
    });
    await waitFor(() => expect(container.querySelector('[data-testid="ask-everest-form"]')).not.toBeNull());
    const form = container.querySelector('[data-testid="ask-everest-form"]')!;
    const screenshot = new File(["png"], "image.png", { type: "image/png" });
    const brief = new File(["pdf"], "brief.pdf", { type: "application/pdf" });
    fireFiles(form, "paste", [screenshot]);
    fireFiles(form, "drop", [brief]);
    await waitFor(() => {
      const chips = container.querySelector('[data-testid="ask-everest-files"]')!;
      expect(chips.textContent).toContain("Pasted image");
      expect(chips.textContent).toContain("brief.pdf");
    });

    act(() => {
      (container.querySelector('button[aria-label="Ask"]') as HTMLButtonElement).click();
    });
    await waitFor(() => expect(container.textContent).toContain("Please take a look at these files."));
    expect(container.querySelector('[data-testid="ask-everest-files"]')).toBeNull();
    expect(container.querySelector('[data-testid="ask-everest-question-files"]')?.textContent).toContain("brief.pdf");
    await waitFor(() => expect(container.querySelector('[data-testid="ask-everest-live"]')?.textContent).toContain("Send to Everest with the 2 files"));

    act(() => {
      (container.querySelector('[data-testid="ask-everest-live"]') as HTMLButtonElement).click();
    });
    await waitFor(() => expect(mocks.addComment).toHaveBeenCalled());
    expect(mocks.uploadAttachment).toHaveBeenCalledTimes(2);
    expect(mocks.uploadAttachment).toHaveBeenCalledWith("company-1", "chat-1", brief);
    const [, body, , , attachmentIds] = mocks.addComment.mock.calls[0]!;
    expect(body).toBe("Please take a look at these files.");
    expect(attachmentIds).toHaveLength(2);
    expect(attachmentIds).toContain("att-brief.pdf");
  });

  it("answers a follow-up from the last answer without restating it", async () => {
    mocks.issuesList.mockResolvedValue([
      { id: "i1", identifier: "GRE-1", title: "Send the Indago contract", status: "blocked", assigneeAgentId: "mason", dueDate: "2020-01-02", updatedAt: "2026-10-15T09:00:00Z" },
      { id: "i2", identifier: "GRE-2", title: "Book the venue", status: "blocked", assigneeAgentId: null, dueDate: null, updatedAt: "2026-10-15T09:00:00Z" },
    ]);
    act(() => openAskEverest("What is stuck?"));
    await waitFor(() => expect(container.textContent).toContain("2 tasks are stuck."));
    await waitFor(() => {
      const input = container.querySelector("input") as HTMLInputElement;
      expect(input.placeholder).toContain("follow-up");
    });

    typeQuestion("and which of those are overdue?");
    await waitFor(() => expect(container.textContent).toContain("1 of those 2 stuck tasks is overdue."));
    const turns = container.querySelectorAll('[data-testid="ask-everest-turn"]');
    expect(turns).toHaveLength(2);
    expect(turns[1]!.textContent).toContain("Send the Indago contract");
    expect(turns[1]!.textContent).not.toContain("Book the venue");
    expect(mocks.issuesList).toHaveBeenCalledTimes(1);

    typeQuestion("and which are with Mason?");
    await waitFor(() => expect(container.querySelectorAll('[data-testid="ask-everest-turn"]')).toHaveLength(3));
    await waitFor(() => expect(container.textContent).toContain("That task is with Mason."));
  });

  it("asks about the page it was opened from and sends that context to Everest", async () => {
    mocks.issuesList.mockResolvedValue([]);
    mocks.ensureChat.mockResolvedValue({ id: "chat-1" });
    mocks.addComment.mockResolvedValue({ id: "c1", createdAt: "2026-10-16T09:00:00Z" });
    mocks.listComments.mockResolvedValue([]);
    act(() => openAskEverest(undefined, {
      label: "Acme Ltd",
      subject: "Acme Ltd",
      summary: "The client \"Acme Ltd\". Stage: Proposal.",
      suggestions: ["What is next for Acme Ltd?"],
    }));
    await waitFor(() => expect(container.querySelector('[data-testid="ask-everest-context"]')?.textContent).toContain("Acme Ltd"));
    expect(container.querySelector('[data-testid="ask-everest-suggestions"]')?.textContent).toContain("What is next for Acme Ltd?");

    typeQuestion("What is happening?");
    await waitFor(() => expect(mocks.issuesList).toHaveBeenCalledWith("company-1", { q: "Acme Ltd", limit: 50 }));
    expect(mocks.search).toHaveBeenCalledWith("company-1", { q: "Acme Ltd", scope: "records", limit: 4 });
    await waitFor(() => expect(container.querySelector('[data-testid="ask-everest-live"]')).not.toBeNull());
    act(() => {
      (container.querySelector('[data-testid="ask-everest-live"]') as HTMLButtonElement).click();
    });
    await waitFor(() => expect(mocks.addComment).toHaveBeenCalled());
    const [, body] = mocks.addComment.mock.calls[0]!;
    expect(body).toContain("What is happening?");
    expect(body).toContain("Asked from Acme Ltd:");
    expect(body).toContain("Stage: Proposal.");
  });

  it("puts spoken words into the question box", async () => {
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", ctrlKey: true, bubbles: true }));
    });
    await waitFor(() => expect(container.querySelector('[data-testid="ask-everest-mic"]')).not.toBeNull());
    act(() => dictationState.onFinal?.("what is stuck"));
    await waitFor(() => {
      const input = container.querySelector("input") as HTMLInputElement;
      expect(input.value).toBe("what is stuck");
    });
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
