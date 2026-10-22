// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, IssueFollowWithRollup, RecentlyOpenedIssue } from "@greatstone/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToastInput } from "../context/ToastContext";
import type { IssuesCustomGrouping } from "../components/IssuesList";
import { Desk } from "./Desk";

const ME = "user-john";

const issuesListMock = vi.fn<(companyId: string, filters?: Record<string, unknown>) => Promise<Issue[]>>();
const issuesUpdateMock = vi.fn<(id: string, data: Record<string, unknown>) => Promise<Issue>>();
const addCommentMock = vi.fn<(id: string, body: string, ...rest: unknown[]) => Promise<unknown>>();
const pushToastMock = vi.fn<(input: ToastInput) => string | null>();
const listCommentsMock = vi.fn<(id: string, filters?: Record<string, unknown>) => Promise<unknown[]>>();
const markReadMock = vi.fn<(id: string) => Promise<unknown>>();
const dismissLooksFinishedMock = vi.fn<(id: string) => Promise<unknown>>();
let boardAccess: Record<string, unknown> = { source: "session", memberships: [] };
let follows: IssueFollowWithRollup[] = [];
let recent: RecentlyOpenedIssue[] = [];

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname: "/my-tasks", search: "", hash: "" }),
  useActiveCompanyPrefix: () => null,
}));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: pushToastMock }),
  useOptionalToastActions: () => ({ pushToast: pushToastMock }),
}));
vi.mock("../api/auth", () => ({ authApi: { getSession: async () => ({ user: { id: ME } }) } }));
// Decisions now live in Needs me: the feed and the one count.
let decisionCards: Array<{ id: string; task: { id: string } | null; decision: string; severity: string; atDesk?: { command: string | null } | null }> = [];
vi.mock("../api/decisionsFeed", () => ({
  decisionsFeedApi: {
    get: async () => ({ companyId: "company-1", count: decisionCards.length, cards: decisionCards, assignableAgents: [] }),
    needsMe: async () => ({
      companyId: "company-1", count: decisionCards.length, decisionCount: decisionCards.filter((card) => !card.atDesk).length, assignedTaskCount: 0,
      decisions: decisionCards, assignedTasks: [], overdueWaits: [], expiredCards: [],
    }),
  },
}));
// The card has its own tests; here it only has to appear, in feed order.
vi.mock("../components/decisions-feed/DecisionFeedCard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../components/decisions-feed/DecisionFeedCard")>()),
  DecisionFeedCard: ({ card }: { card: { id: string; decision: string } }) => (
    <article data-decision-card={card.id}>{card.decision}</article>
  ),
}));
vi.mock("../api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("../api/access", () => ({ accessApi: { getCurrentBoardAccess: async () => boardAccess } }));
vi.mock("../api/agents", () => ({
  agentsApi: {
    list: async () => [
      { id: "agent-mica", name: "Mica", role: "engineer", status: "idle", reportsTo: "agent-everest", icon: null },
      { id: "agent-everest", name: "Everest", role: "ceo", status: "idle", reportsTo: null, icon: null },
      { id: "agent-ridge", name: "Ridge", role: "engineer", status: "active", reportsTo: "agent-everest", icon: null },
    ],
  },
}));
vi.mock("../api/issues", () => ({
  issuesApi: {
    list: (companyId: string, filters?: Record<string, unknown>) => issuesListMock(companyId, filters),
    get: vi.fn(),
    update: (id: string, data: Record<string, unknown>) => issuesUpdateMock(id, data),
    addComment: (id: string, body: string, ...rest: unknown[]) => addCommentMock(id, body, ...rest),
    listComments: (id: string, filters?: Record<string, unknown>) => listCommentsMock(id, filters),
    markRead: (id: string) => markReadMock(id),
    dismissLooksFinished: (id: string) => dismissLooksFinishedMock(id),
    listFollows: async () => follows,
    listRecentlyOpened: async () => recent,
    follow: vi.fn(),
    unfollow: vi.fn(),
  },
}));
vi.mock("../hooks/useStandardMarkdownMentionOptions", () => ({ useStandardMarkdownMentionOptions: () => [] }));

// The real thread is covered elsewhere; this stub shows the comments and sends a reply.
vi.mock("../components/IssueChatThread", () => ({
  IssueChatThread: (props: {
    comments: { id: string; body: string }[];
    onAdd: (body: string, ...rest: unknown[]) => Promise<void>;
  }) => (
    <div data-thread>
      {props.comments.map((comment) => (
        <p key={comment.id} data-comment>{comment.body}</p>
      ))}
      <button type="button" data-send onClick={() => void props.onAdd("Looks good, go ahead")}>
        Send
      </button>
    </div>
  ),
}));

// The real list is covered elsewhere; this stub shows the groups and the page's row slots.
vi.mock("../components/IssuesList", () => ({
  IssuesList: (props: {
    issues: Issue[];
    customGrouping: IssuesCustomGrouping;
    renderRowLeading: (issue: Issue) => ReactNode;
    renderRowActions: (issue: Issue) => ReactNode;
    renderRowFooter: (issue: Issue) => ReactNode;
  }) => (
    <div>
      {props.customGrouping.groups.map((group) => {
        const rows = props.issues.filter((issue) => props.customGrouping.groupKeyForIssue(issue) === group.key);
        if (rows.length === 0) return null;
        return (
          <section key={group.key} data-group={group.key} aria-label={group.label}>
            {rows.map((issue) => (
              <div key={issue.id} data-row={issue.id}>
                {props.renderRowLeading(issue)}
                <span>{issue.title}</span>
                {props.renderRowActions(issue)}
                {props.renderRowFooter(issue)}
              </div>
            ))}
          </section>
        );
      })}
    </div>
  ),
}));

function makeIssue(id: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id,
    companyId: "company-1",
    title: `Task ${id}`,
    identifier: `GRE-${id}`,
    status: "todo",
    assigneeAgentId: null,
    assigneeUserId: ME,
    createdByAgentId: null,
    createdByUserId: ME,
    blocks: [],
    completedAt: null,
    myLastCommentAt: null,
    lastExternalCommentAt: null,
    myLastReadAt: null,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    ...overrides,
  } as Issue;
}

let openIssues: Issue[] = [];
let doneIssues: Issue[] = [];
let touchedIssues: Issue[] = [];

let container: HTMLDivElement;
let root: Root;

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Desk />
      </QueryClientProvider>,
    );
  });
  await flush();
}

function groupOf(issueId: string) {
  return container.querySelector(`[data-row="${issueId}"]`)?.closest("section")?.getAttribute("data-group") ?? null;
}

function click(element: Element | null | undefined) {
  if (!element) throw new Error("element not found");
  flushSync(() => {
    (element as HTMLElement).click();
  });
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  window.localStorage.clear();
  decisionCards = [];
  follows = [];
  recent = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  openIssues = [];
  doneIssues = [];
  touchedIssues = [];
  issuesListMock.mockReset().mockImplementation(async (_companyId, filters) => {
    if (filters?.status === "done") return doneIssues;
    if (filters?.assigneeUserId === "me") return openIssues;
    return touchedIssues;
  });
  // A tiny server: lists follow the writes, as the refetch after each one would.
  issuesUpdateMock.mockReset().mockImplementation(async (id, data) => {
    const current = [...openIssues, ...doneIssues, ...touchedIssues].find((issue) => issue.id === id)!;
    const next = { ...current, ...data, completedAt: data.status === "done" ? new Date() : current.completedAt } as Issue;
    openIssues = openIssues.filter((issue) => issue.id !== id);
    doneIssues = doneIssues.filter((issue) => issue.id !== id);
    touchedIssues = touchedIssues.filter((issue) => issue.id !== id);
    if (next.status === "done") doneIssues.push(next);
    else if (next.assigneeUserId === ME) openIssues.push(next);
    else touchedIssues.push({ ...next, myLastCommentAt: new Date() });
    return next;
  });
  addCommentMock.mockReset().mockImplementation(async (id) => {
    openIssues = openIssues.map((issue) => (issue.id === id ? { ...issue, myLastCommentAt: new Date() } : issue));
    return { id: "comment-1" };
  });
  pushToastMock.mockReset().mockReturnValue("toast-1");
  listCommentsMock.mockReset().mockImplementation(async (id) => [
    { id: `${id}-c2`, body: `Second on ${id}` },
    { id: `${id}-c1`, body: `First on ${id}` },
  ]);
  markReadMock.mockReset().mockImplementation(async (id) => {
    openIssues = openIssues.map((issue) => (issue.id === id ? { ...issue, myLastReadAt: new Date() } : issue));
    return { id };
  });
  boardAccess = { source: "session", memberships: [] };
  dismissLooksFinishedMock.mockReset().mockImplementation(async (id) => {
    openIssues = openIssues.map((issue) => (issue.id === id ? { ...issue, looksFinishedAt: null, looksFinishedReasons: null } : issue));
    return { id };
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("MyTasks rows (GRE-619)", () => {
  it("shows the three groups: Needs you, Waiting on an agent, Done today", async () => {
    const now = new Date();
    openIssues = [makeIssue("1"), makeIssue("2", { myLastCommentAt: now })];
    touchedIssues = [makeIssue("3", { assigneeUserId: null, assigneeAgentId: "agent-ridge", myLastCommentAt: now })];
    doneIssues = [
      makeIssue("4", { status: "done", completedAt: now }),
      makeIssue("5", { status: "done", completedAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000) }),
    ];
    await renderPage();

    expect(groupOf("1")).toBe("needs_you");
    expect(groupOf("2")).toBe("waiting");
    expect(groupOf("3")).toBe("waiting");
    expect(groupOf("4")).toBe("done_today");
    expect(container.querySelector('[data-row="5"]')).toBeNull();
    expect(container.querySelector('[data-row="2"] [data-ask-state="waiting"]')?.textContent).toBe("Waiting for answer");
  });

  it("ticking closes the task, and Undo puts back the old status", async () => {
    openIssues = [makeIssue("1", { status: "in_progress" })];
    await renderPage();

    const tick = container.querySelector('[data-my-tasks-tick="1"]');
    expect(tick?.getAttribute("aria-label")).toBe("Mark GRE-1: Task 1 done");
    click(tick);
    await flush();

    expect(issuesUpdateMock).toHaveBeenCalledWith("1", { status: "done" });
    expect(groupOf("1")).toBe("done_today");
    const toast = pushToastMock.mock.calls[0]![0];
    expect(toast.ttlMs).toBe(5000);
    expect(toast.action?.label).toBe("Undo");

    issuesUpdateMock.mockClear();
    flushSync(() => toast.action!.onClick!());
    await flush();
    expect(issuesUpdateMock).toHaveBeenCalledWith("1", { status: "in_progress" });
  });

  it("hands a task to an agent with Everest first, the instruction as a comment", async () => {
    openIssues = [makeIssue("1", { status: "backlog" })];
    await renderPage();

    click(container.querySelector('[aria-label="Hand GRE-1: Task 1 to an agent"]'));
    await flush();
    const options = [...document.querySelectorAll('[role="radio"]')];
    expect(options.map((option) => option.textContent)).toEqual(["Everest", "Mica", "Ridge"]);
    expect(options[0]!.getAttribute("aria-checked")).toBe("true");

    click(options[2]);
    typeInto(document.querySelector('input[aria-label="Instruction for the agent (optional)"]')!, "Please fix the login page");
    click([...document.querySelectorAll("button")].find((button) => button.textContent === "Hand to Ridge"));
    await flush();

    expect(issuesUpdateMock).toHaveBeenCalledWith("1", {
      assigneeAgentId: "agent-ridge",
      assigneeUserId: null,
      status: "todo",
      comment: "Please fix the login page",
    });
  });

  it("Ask mentions the agent that made the task and the row waits for the answer", async () => {
    openIssues = [makeIssue("1", { createdByAgentId: "agent-mica" })];
    await renderPage();

    const askButton = container.querySelector('[data-my-tasks-ask="1"]');
    click(askButton);
    expect(askButton?.getAttribute("aria-expanded")).toBe("true");
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Question for Mica"]')!;
    expect(document.activeElement).toBe(input);
    typeInto(input, "Is this still needed?");
    flushSync(() => {
      input.form!.requestSubmit();
    });
    await flush();

    expect(addCommentMock).toHaveBeenCalledTimes(1);
    const [issueId, body] = addCommentMock.mock.calls[0]!;
    expect(issueId).toBe("1");
    expect(body).toBe("[@Mica](agent://agent-mica) Is this still needed?");
    expect(groupOf("1")).toBe("waiting");
    expect(container.querySelector('[data-row="1"] [data-ask-state="waiting"]')).not.toBeNull();
  });

  it("asks the assignee agent with a plain comment, and shows Answer ready after a reply", async () => {
    const asked = new Date(Date.now() - 60_000);
    openIssues = [
      makeIssue("1", {
        assigneeAgentId: "agent-ridge",
        myLastCommentAt: asked,
        lastExternalCommentAt: new Date(),
        myLastReadAt: asked,
      }),
    ];
    await renderPage();
    expect(groupOf("1")).toBe("needs_you");
    expect(container.querySelector('[data-row="1"] [data-ask-state="answered"]')?.textContent).toBe("Answer ready");

    click(container.querySelector('[data-my-tasks-ask="1"]'));
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Question for Ridge"]')!;
    typeInto(input, "And the tests?");
    flushSync(() => {
      input.form!.requestSubmit();
    });
    await flush();
    expect(addCommentMock.mock.calls[0]![1]).toBe("And the tests?");
  });
});

describe("MyTasks Discuss panel (GRE-620)", () => {
  const panel = () => document.querySelector<HTMLElement>("[data-my-tasks-discuss-panel]");
  const comments = () => [...document.querySelectorAll("[data-comment]")].map((node) => node.textContent);

  it("opens the thread next to the list, oldest first, and moves focus in", async () => {
    openIssues = [makeIssue("1"), makeIssue("2")];
    await renderPage();

    const discuss = container.querySelector('[data-my-tasks-discuss="1"]');
    click(discuss);
    await flush();

    expect(panel()?.getAttribute("data-my-tasks-discuss-panel")).toBe("1");
    expect(panel()?.querySelector("section")?.getAttribute("aria-label")).toBe("Discuss GRE-1: Task 1");
    expect(discuss?.getAttribute("aria-expanded")).toBe("true");
    expect(listCommentsMock).toHaveBeenCalledWith("1", { order: "desc", limit: 50 });
    expect(comments()).toEqual(["First on 1", "Second on 1"]);
    expect(document.activeElement?.hasAttribute("data-my-tasks-discuss-close")).toBe(true);
    // The list stays on screen beside the panel.
    expect(container.querySelector('[data-row="2"]')).not.toBeNull();
    // Row actions go icon only so the titles keep their room.
    expect(container.querySelector('[data-my-tasks-ask="2"]')?.textContent).toBe("");
    expect(container.querySelector('[data-my-tasks-ask="2"]')?.getAttribute("aria-label")).toBe("Ask about GRE-2: Task 2");
    expect(panel()?.querySelector('a[href="/issues/GRE-1"]')?.textContent).toContain("Open task");
  });

  it("closes with the close button and with Escape, and focus goes back to the row", async () => {
    openIssues = [makeIssue("1")];
    await renderPage();

    click(container.querySelector('[data-my-tasks-discuss="1"]'));
    await flush();
    click(document.querySelector("[data-my-tasks-discuss-close]"));
    await flush();
    expect(panel()).toBeNull();
    expect(document.activeElement?.getAttribute("data-my-tasks-discuss")).toBe("1");
    expect(container.querySelector('[data-my-tasks-ask="1"]')?.textContent).toBe("Ask");

    click(container.querySelector('[data-my-tasks-discuss="1"]'));
    await flush();
    flushSync(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(panel()).toBeNull();
    expect(document.activeElement?.getAttribute("data-my-tasks-discuss")).toBe("1");
  });

  it("switches to another row's thread", async () => {
    openIssues = [makeIssue("1"), makeIssue("2")];
    await renderPage();

    click(container.querySelector('[data-my-tasks-discuss="1"]'));
    await flush();
    click(container.querySelector('[data-my-tasks-discuss="2"]'));
    await flush();

    expect(panel()?.getAttribute("data-my-tasks-discuss-panel")).toBe("2");
    expect(comments()).toEqual(["First on 2", "Second on 2"]);
    expect(container.querySelector('[data-my-tasks-discuss="1"]')?.getAttribute("aria-expanded")).toBe("false");
  });

  it("a reply posts a plain comment and the row waits for the answer", async () => {
    openIssues = [makeIssue("1", { assigneeAgentId: "agent-ridge" })];
    await renderPage();

    click(container.querySelector('[data-my-tasks-discuss="1"]'));
    await flush();
    listCommentsMock.mockClear();
    click(document.querySelector("[data-send]"));
    await flush();

    expect(addCommentMock).toHaveBeenCalledTimes(1);
    expect(addCommentMock.mock.calls[0]![0]).toBe("1");
    expect(addCommentMock.mock.calls[0]![1]).toBe("Looks good, go ahead");
    expect(container.querySelector('[data-row="1"] [data-ask-state="waiting"]')).not.toBeNull();
    // The thread refetches so the reply shows.
    expect(listCommentsMock).toHaveBeenCalledWith("1", { order: "desc", limit: 50 });
  });

  it("below 900px the panel is a full-width dialog that Escape closes", async () => {
    // Focus going back to the icon-only Discuss button opens its tooltip, which measures itself.
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(width < 56.25rem)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    openIssues = [makeIssue("1")];
    await renderPage();

    click(container.querySelector('[data-my-tasks-discuss="1"]'));
    await flush();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("data-my-tasks-discuss-panel")).toBe("1");
    expect(dialog?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(document.activeElement?.hasAttribute("data-my-tasks-discuss-close")).toBe(true);

    flushSync(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement?.getAttribute("data-my-tasks-discuss")).toBe("1");
  });

  it("opening a row with an answer ready marks it read", async () => {
    const asked = new Date(Date.now() - 60_000);
    openIssues = [
      makeIssue("1", { assigneeAgentId: "agent-ridge", myLastCommentAt: asked, lastExternalCommentAt: new Date(), myLastReadAt: asked }),
    ];
    await renderPage();
    expect(container.querySelector('[data-row="1"] [data-ask-state="answered"]')).not.toBeNull();

    click(container.querySelector('[data-my-tasks-discuss="1"]'));
    await flush();
    expect(markReadMock).toHaveBeenCalledWith("1");
    expect(container.querySelector('[data-row="1"] [data-ask-state="answered"]')).toBeNull();
  });
});

function summary(id: string, overrides: Partial<RecentlyOpenedIssue["issue"]> = {}): RecentlyOpenedIssue["issue"] {
  return {
    id,
    identifier: `GRE-${id}`,
    title: `Task ${id}`,
    status: "in_progress",
    priority: "medium",
    originKind: "manual",
    updatedAt: new Date("2026-10-20T00:00:00.000Z"),
    ...overrides,
  };
}

function section(id: string) {
  return container.querySelector(`[data-desk-section="${id}"]`);
}

describe("Desk sections", () => {
  it("shows Pinned on top with its rollup, then Needs me and Recently opened", async () => {
    openIssues = [makeIssue("1")];
    follows = [{
      issueId: "p1",
      followedAt: new Date("2026-10-20T00:00:00.000Z"),
      issue: summary("p1", { title: "Indago portal" }),
      counts: { total: 5, done: 2, inProgress: 1, waitingOnYou: 1, blocked: 1 },
      latestUpdates: [{
        kind: "comment",
        issueId: "c1",
        issueIdentifier: "GRE-c1",
        issueTitle: "DNS",
        summary: "DNS is still pending at the registrar",
        at: new Date(),
      }],
    }];
    recent = [{ issueId: "r1", viewedAt: new Date(), issue: summary("r1", { title: "Opened lately" }) }];
    await renderPage();

    const headings = [...container.querySelectorAll("h2")].map((heading) => heading.textContent);
    expect(headings).toEqual(["Pinned", "Decisions", "Your tasks", "Recently opened"]);
    expect(section("desk-tasks")?.querySelector('[data-row="1"]')).not.toBeNull();
    const pinned = section("desk-pinned");
    expect(pinned?.textContent).toContain("Indago portal");
    expect(pinned?.textContent).toContain("2 of 5 done");
    expect(pinned?.textContent).toContain("1 waiting on you");
    expect(pinned?.textContent).toContain("1 blocked");
    expect(pinned?.textContent).toContain("DNS is still pending at the registrar");
    expect(pinned?.querySelector('[aria-label="Unpin GRE-p1"]')).not.toBeNull();
    expect(pinned?.querySelector('[data-desk-follow-tree="p1"]')?.getAttribute("href")).toBe("/issues/GRE-p1/tree");
    expect(section("desk-recent")?.textContent).toContain("Opened lately");
  });

  it("shows decision cards in Decisions, in feed order, with the one count, and the plain rows in Your tasks below", async () => {
    openIssues = [makeIssue("1"), makeIssue("7", { title: "Pick the launch month" })];
    decisionCards = [
      { id: "task:7", task: { id: "7" }, decision: "Which month should we launch?", severity: "high" },
      { id: "item:budget", task: null, decision: "Raise the budget or leave the work paused.", severity: "medium" },
    ];
    await renderPage();

    const needsMe = section("desk-needs-me")!;
    expect([...needsMe.querySelectorAll("[data-decision-card]")].map((card) => card.getAttribute("data-decision-card")))
      .toEqual(["task:7", "item:budget"]);
    expect(needsMe.querySelector("[data-desk-section-count]")?.textContent).toBe("2");
    // The section lists exactly its number: cards, no task rows.
    expect(needsMe.querySelectorAll("[data-row]")).toHaveLength(0);
    const tasks = section("desk-tasks")!;
    // A task with a card is that card, not a second row.
    expect(tasks.querySelector('[data-row="7"]')).toBeNull();
    const row = tasks.querySelector('[data-row="1"]')!;
    expect(needsMe.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect([...needsMe.querySelectorAll("a")].find((a) => a.textContent === "Focus and history")?.getAttribute("href")).toBe("/decisions/focus");
    expect(container.textContent).not.toContain("Nothing needs you right now.");
  });

  it("keeps At your desk cards in their own labelled group, outside the one count (GRE-450)", async () => {
    decisionCards = [
      { id: "task:7", task: { id: "7" }, decision: "Which month should we launch?", severity: "high" },
      { id: "task:8", task: { id: "8" }, decision: "Restart WSL on the host.", severity: "high", atDesk: { command: "wsl --shutdown" } },
    ];
    await renderPage();

    const needsMe = section("desk-needs-me")!;
    expect(needsMe.querySelector("[data-desk-section-count]")?.textContent).toBe("1");
    expect(needsMe.querySelector("[data-desk-decisions]")?.textContent).not.toContain("Restart WSL");
    const desk = needsMe.querySelector("[data-at-desk-group]")!;
    expect(desk.textContent).toContain("At your desk");
    expect(desk.textContent).toContain("not in the Decisions count");
    expect(desk.textContent).toContain("Restart WSL on the host.");
  });

  it("shows a pinned task only in Pinned, and leaves finished pins out", async () => {
    openIssues = [makeIssue("1"), makeIssue("2")];
    const rollup = { total: 1, done: 0, inProgress: 1, waitingOnYou: 0, blocked: 0 };
    follows = [
      { issueId: "1", followedAt: new Date(), issue: summary("1", { title: "Pinned and mine" }), counts: rollup, latestUpdates: [] },
      { issueId: "d", followedAt: new Date(), issue: summary("d", { title: "Pinned but done", status: "done" }), counts: rollup, latestUpdates: [] },
    ];
    recent = [{ issueId: "1", viewedAt: new Date(), issue: summary("1", { title: "Pinned and mine" }) }];
    await renderPage();

    expect(section("desk-pinned")?.querySelector('[data-desk-follow="1"]')).not.toBeNull();
    expect(section("desk-pinned")?.querySelector('[data-desk-follow="d"]')).toBeNull();
    expect(container.querySelector('[data-row="1"]')).toBeNull();
    expect(container.querySelector('[data-row="2"]')).not.toBeNull();
    expect(section("desk-recent")?.textContent).not.toContain("Pinned and mine");
  });

  it("keeps a pinned task's actions on its card, so pinning never hides them", async () => {
    openIssues = [makeIssue("1")];
    const rollup = { total: 1, done: 0, inProgress: 1, waitingOnYou: 0, blocked: 0 };
    follows = [{ issueId: "1", followedAt: new Date(), issue: summary("1"), counts: rollup, latestUpdates: [] }];
    await renderPage();

    const actions = section("desk-pinned")?.querySelector('[data-desk-pinned-actions="1"]');
    expect(actions?.querySelector('[aria-label="Hand GRE-1: Task 1 to an agent"]')).not.toBeNull();
  });

  it("leaves Pinned out until something is pinned", async () => {
    await renderPage();
    expect(section("desk-pinned")).toBeNull();
    expect(section("desk-recent")?.textContent).toContain("Tasks you open show up here");
  });

  it("hides routine tasks until Show routine tasks is on", async () => {
    openIssues = [
      makeIssue("1", { title: "Sign off the Q3 pack" }),
      makeIssue("2", { title: "Loose ends", originKind: "routine_execution" }),
      makeIssue("3", { title: "Daily digest", originKind: "agent_daily_digest" }),
    ];
    recent = [{ issueId: "r2", viewedAt: new Date(), issue: summary("r2", { title: "Daily release candidate", originKind: "routine_execution" }) }];
    await renderPage();

    expect(container.querySelector('[data-row="1"]')).not.toBeNull();
    expect(container.querySelector('[data-row="2"]')).toBeNull();
    expect(container.querySelector('[data-row="3"]')).toBeNull();
    expect(section("desk-recent")?.textContent).not.toContain("Daily release candidate");
    expect(container.querySelector("[data-desk-routine-hidden]")?.textContent).toBe("2 hidden");

    const toggle = container.querySelector<HTMLButtonElement>("[data-desk-routine-toggle]");
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    click(toggle);
    await flush();

    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector('[data-row="2"]')).not.toBeNull();
    expect(container.querySelector('[data-row="3"]')).not.toBeNull();
    expect(section("desk-recent")?.textContent).toContain("Daily release candidate");
    expect(window.localStorage.getItem("paperclip:desk-show-routine")).toBe("true");
  });
});

describe("Tidy desk", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const flagged = (id: string, overrides: Partial<Issue> = {}) =>
    makeIssue(id, {
      status: "blocked",
      looksFinishedAt: new Date(),
      looksFinishedReasons: ["Every task blocking it is closed (GRE-9) and nothing has happened on it since."],
      ...overrides,
    });

  it("asks the server to leave parked work out of every Desk list", async () => {
    await renderPage();
    const calls = issuesListMock.mock.calls.map(([, filters]) => filters);
    expect(calls.length).toBe(3);
    for (const filters of calls) expect(filters?.excludeParked).toBe(true);
  });

  it("moves flagged tasks into Looks finished with the reasons, Close and Not finished", async () => {
    openIssues = [makeIssue("1"), flagged("2")];
    await renderPage();

    expect(groupOf("1")).toBe("needs_you");
    expect(groupOf("2")).toBe("looks_finished");
    expect(container.querySelector('[data-desk-finished-reasons="2"]')?.textContent).toContain("Every task blocking it is closed");

    click(container.querySelector('[data-desk-close-finished="2"]'));
    await flush();
    expect(issuesUpdateMock).toHaveBeenCalledWith("2", { status: "done" });
    expect(groupOf("2")).toBe("done_today");
  });

  it("Not finished clears the flag and the task goes back to live work", async () => {
    openIssues = [flagged("2")];
    await renderPage();

    click(container.querySelector('[data-desk-not-finished="2"]'));
    await flush();
    expect(dismissLooksFinishedMock).toHaveBeenCalledWith("2");
    expect(groupOf("2")).toBe("needs_you");
  });

  it("a task closed from Looks finished can be reopened in one click", async () => {
    doneIssues = [makeIssue("3", { status: "done", completedAt: new Date(), looksFinishedAt: new Date() })];
    await renderPage();

    expect(groupOf("3")).toBe("done_today");
    click(container.querySelector('[data-desk-reopen="3"]'));
    await flush();
    expect(issuesUpdateMock).toHaveBeenCalledWith("3", { status: "todo" });
  });

  it("only people who may override reviews see Close on a task in someone else's review", async () => {
    // Assigned to me, but the review waits on someone else (no decision of mine).
    openIssues = [flagged("4", { status: "in_review" })];
    await renderPage();
    expect(groupOf("4")).toBe("looks_finished");
    expect(container.querySelector('[data-desk-close-finished="4"]')).toBeNull();
    expect(container.querySelector('[data-desk-not-finished="4"]')).not.toBeNull();

    flushSync(() => root.unmount());
    root = createRoot(container);
    // Owners and reviews:override holders close through the review override.
    boardAccess = {
      source: "session",
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "member" }],
      reviewOverrideCompanyIds: ["company-1"],
    };
    await renderPage();
    click(container.querySelector('[data-desk-close-finished="4"]'));
    await flush();
    expect(issuesUpdateMock).toHaveBeenCalledWith("4", expect.objectContaining({ status: "done", reviewOverride: true }));
  });

  it("puts tasks with no work for a week in a collapsed Gone quiet group at the bottom", async () => {
    const now = Date.now();
    openIssues = [
      makeIssue("5", { title: "Live work", lastActivityAt: new Date(now - DAY) }),
      makeIssue("6", { title: "When a client is near", lastActivityAt: new Date(now - 9 * DAY) }),
      // A recent run is work too.
      makeIssue("7", {
        title: "Ran yesterday",
        lastActivityAt: new Date(now - 9 * DAY),
        latestRun: { status: "succeeded", errorCode: null, finishedAt: new Date(now - DAY) },
      }),
    ];
    await renderPage();

    expect(groupOf("5")).toBe("needs_you");
    expect(groupOf("7")).toBe("needs_you");
    expect(container.querySelector('[data-row="6"]')).toBeNull();
    const quiet = container.querySelector<HTMLDetailsElement>("[data-desk-gone-quiet]");
    expect(quiet?.open).toBe(false);
    expect(quiet?.querySelector("summary")?.textContent).toContain("Gone quiet (1)");
    expect(quiet?.textContent).toContain("When a client is near");
  });
});
