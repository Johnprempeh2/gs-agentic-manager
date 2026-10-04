// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue } from "@greatstone/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToastInput } from "../context/ToastContext";
import type { IssuesCustomGrouping } from "../components/IssuesList";
import { MyTasks } from "./MyTasks";

const ME = "user-john";

const issuesListMock = vi.fn<(companyId: string, filters?: Record<string, unknown>) => Promise<Issue[]>>();
const issuesUpdateMock = vi.fn<(id: string, data: Record<string, unknown>) => Promise<Issue>>();
const addCommentMock = vi.fn<(id: string, body: string, ...rest: unknown[]) => Promise<unknown>>();
const pushToastMock = vi.fn<(input: ToastInput) => string | null>();

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname: "/my-tasks", search: "", hash: "" }),
}));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: pushToastMock }) }));
vi.mock("../hooks/useStreamlinedUiEnabled", () => ({ useStreamlinedUiEnabled: () => ({ enabled: true, loaded: true }) }));
vi.mock("../api/auth", () => ({ authApi: { getSession: async () => ({ user: { id: ME } }) } }));
vi.mock("../api/attention", () => ({ attentionApi: { list: async () => ({ items: [] }) } }));
vi.mock("../api/projects", () => ({ projectsApi: { list: async () => [] } }));
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
  },
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
    isUnreadForMe: false,
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
        <MyTasks />
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
        isUnreadForMe: true,
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
