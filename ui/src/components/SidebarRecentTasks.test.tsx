// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarRecentTasks } from "./SidebarRecentTasks";
import { queryKeys } from "@/lib/queryKeys";

const mockAuthApi = vi.hoisted(() => ({ getSession: vi.fn() }));
const mockAgentsApi = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({
  get: vi.fn(),
  listRecentlyOpened: vi.fn(),
  update: vi.fn(),
  archiveFromInbox: vi.fn(),
  getTreeControlState: vi.fn(),
  createTreeHold: vi.fn(),
  releaseTreeHold: vi.fn(),
}));

vi.mock("@/api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("@/api/auth", () => ({ authApi: mockAuthApi }));
vi.mock("@/api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("@/lib/router", () => ({
  NavLink: ({ children, to, className, ...props }: {
    children: ReactNode;
    to: string;
    className?: string | ((state: { isActive: boolean }) => string);
  }) => (
    <a
      href={to}
      className={typeof className === "function" ? className({ isActive: false }) : className}
      {...props}
    >
      {children}
    </a>
  ),
}));
vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({
    collapsed: false,
    peeking: false,
    isMobile: false,
    setSidebarOpen: vi.fn(),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type RecentTask = { id: string; title: string; identifier: string | null; status?: string };

/** What the server returns for GET /companies/:id/recent-issues, newest first. */
function serveRecent(tasks: RecentTask[]) {
  mockIssuesApi.listRecentlyOpened.mockResolvedValue(tasks.map((task, index) => ({
    issueId: task.id,
    viewedAt: new Date(1000 - index),
    issue: {
      id: task.id,
      identifier: task.identifier,
      title: task.title,
      status: task.status ?? "todo",
      priority: "medium",
      originKind: "manual",
      updatedAt: new Date(1),
    },
  })));
}

describe("SidebarRecentTasks", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    Object.values(mockAgentsApi).forEach((mock) => mock.mockReset());
    Object.values(mockIssuesApi).forEach((mock) => mock.mockReset());
    mockIssuesApi.listRecentlyOpened.mockResolvedValue([]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", name: "Board", email: "board@example.test", image: null },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  async function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <SidebarRecentTasks companyId="company-1" liveIssueIds={new Set(["issue-1"])} />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      for (let index = 0; index < 5; index += 1) {
        await Promise.resolve();
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    });
    return queryClient;
  }

  async function openActions(taskTitle: string) {
    const actions = container.querySelector<HTMLButtonElement>(
      `button[aria-label="More actions for ${taskTitle}"]`,
    );
    await act(async () => {
      actions?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await Promise.resolve();
    });
  }

  function menuItem(label: string) {
    return Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((item) => item.textContent?.trim() === label);
  }

  function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("hides the section when there are no recent tasks", async () => {
    await render();
    expect(container.textContent).not.toContain("Recent");
    expect(container.textContent).not.toContain("Open or create a task");
  });

  it("lists the tasks opened last, newest first, with live state and no status icon", async () => {
    serveRecent([
      { id: "issue-1", title: "Opened just now", identifier: "PAP-1" },
      { id: "issue-2", title: "Opened earlier", identifier: "PAP-2" },
    ]);

    await render();

    expect(mockIssuesApi.listRecentlyOpened).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("Recent");
    const order = Array.from(container.querySelectorAll("a")).map((link) => link.getAttribute("href"));
    expect(order).toEqual(["/issues/PAP-1", "/issues/PAP-2"]);
    const link = container.querySelector('a[href="/issues/PAP-1"]');
    expect(link?.textContent).toContain("Opened just now");
    expect(link?.textContent).toContain("1 live");
    expect(link?.querySelector('[data-slot="sidebar-nav-icon"]')).toBeNull();
    expect(link?.firstElementChild?.textContent).toBe("Opened just now");
    const actions = container.querySelector<HTMLButtonElement>(
      'button[aria-label="More actions for Opened just now"]',
    );
    expect(actions).not.toBeNull();
    expect(actions?.className).toContain("opacity-0");
  });

  it("opens the compact task actions menu from the ellipsis button", async () => {
    serveRecent([{ id: "issue-1", title: "Menu task", identifier: "PAP-1" }]);
    mockIssuesApi.get.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      title: "Menu task",
      identifier: "PAP-1",
      status: "todo",
      hiddenAt: null,
      updatedAt: new Date(1),
    });

    await render();
    await openActions("Menu task");

    const menu = document.body.querySelector('[data-slot="dropdown-menu-content"]');
    expect(menu?.textContent).toContain("Rename");
    expect(menu?.textContent).toContain("Archive");
    expect(menu?.textContent).toContain("Pause/Restart");
  });

  it("archives a task from the inbox without hiding or removing the recent task", async () => {
    const issue = {
      id: "issue-1",
      companyId: "company-1",
      title: "Archive me",
      identifier: "PAP-1",
      status: "todo" as const,
      hiddenAt: null,
      updatedAt: new Date(1),
    };
    serveRecent([issue]);
    mockIssuesApi.get.mockResolvedValue(issue);
    mockIssuesApi.archiveFromInbox.mockResolvedValue({
      id: issue.id,
      archivedAt: new Date(2),
    });

    await render();
    await openActions("Archive me");
    await act(async () => {
      menuItem("Archive")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(mockIssuesApi.archiveFromInbox).toHaveBeenCalledWith("issue-1");
    expect(mockIssuesApi.update).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Recent");
    expect(container.querySelector('a[href="/issues/PAP-1"]')?.textContent).toContain(
      "Archive me",
    );
  });

  it("refreshes task activity after a rename", async () => {
    const issue = {
      id: "issue-1",
      companyId: "company-1",
      title: "Old title",
      identifier: "PAP-1",
      status: "todo" as const,
      hiddenAt: null,
      updatedAt: new Date(1),
    };
    const renamedIssue = { ...issue, title: "New title", updatedAt: new Date(2) };
    serveRecent([issue]);
    mockIssuesApi.get.mockResolvedValue(issue);
    mockIssuesApi.update.mockResolvedValue(renamedIssue);

    const queryClient = await render();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    await openActions("Old title");
    await act(async () => {
      menuItem("Rename")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Task name"]');
    expect(input).not.toBeNull();
    await act(async () => {
      setInputValue(input!, "New title");
      await Promise.resolve();
    });
    await act(async () => {
      input?.closest("form")?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(mockIssuesApi.update).toHaveBeenCalledWith("issue-1", { title: "New title" });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.issues.activity("issue-1"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.recentIssues("company-1"),
    });
  });

  it("pauses a running task or restarts its active pause hold", async () => {
    const issue = {
      id: "issue-1",
      companyId: "company-1",
      title: "Toggle work",
      identifier: "PAP-1",
      status: "in_progress" as const,
      assigneeAgentId: "agent-1",
      hiddenAt: null,
      updatedAt: new Date(1),
    };
    serveRecent([issue]);
    mockIssuesApi.get.mockResolvedValue(issue);
    mockIssuesApi.getTreeControlState
      .mockResolvedValueOnce({ activePauseHold: null })
      .mockResolvedValueOnce({
        activePauseHold: {
          holdId: "hold-1",
          rootIssueId: "issue-1",
          issueId: "issue-1",
          isRoot: true,
          mode: "pause",
          reason: null,
          releasePolicy: { strategy: "manual" },
        },
      });
    mockIssuesApi.createTreeHold.mockResolvedValue({ hold: {}, preview: {} });
    mockIssuesApi.releaseTreeHold.mockResolvedValue({});
    mockAgentsApi.wakeup.mockResolvedValue({ id: "run-1" });

    await render();
    await openActions("Toggle work");
    await act(async () => {
      menuItem("Pause/Restart")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(mockIssuesApi.createTreeHold).toHaveBeenCalledWith("issue-1", {
      mode: "pause",
      reason: "Paused from Recent Tasks.",
      releasePolicy: { strategy: "manual" },
    });

    await openActions("Toggle work");
    await act(async () => {
      menuItem("Pause/Restart")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(mockIssuesApi.releaseTreeHold).toHaveBeenCalledWith("issue-1", "hold-1", {
      reason: "Restarted from Recent Tasks.",
    });
    expect(mockAgentsApi.wakeup).toHaveBeenCalledWith(
      "agent-1",
      {
        source: "assignment",
        triggerDetail: "manual",
        reason: "recent_task_restart",
        payload: { issueId: "issue-1" },
      },
      "company-1",
    );
  });

  it("retries only the wake after a remount when restart releases the hold before wakeup fails", async () => {
    const issue = {
      id: "issue-1",
      companyId: "company-1",
      title: "Retry restart",
      identifier: "PAP-1",
      status: "in_progress" as const,
      assigneeAgentId: "agent-1",
      hiddenAt: null,
      updatedAt: new Date(1),
    };
    serveRecent([issue]);
    mockIssuesApi.get.mockResolvedValue(issue);
    mockIssuesApi.getTreeControlState
      .mockResolvedValueOnce({
        activePauseHold: {
          holdId: "hold-1",
          rootIssueId: "issue-1",
          issueId: "issue-1",
          isRoot: true,
          mode: "pause",
          reason: null,
          releasePolicy: { strategy: "manual" },
        },
      })
      .mockResolvedValueOnce({ activePauseHold: null });
    mockIssuesApi.releaseTreeHold.mockResolvedValue({});
    mockAgentsApi.wakeup
      .mockRejectedValueOnce(new Error("Wake failed"))
      .mockResolvedValueOnce({ id: "run-1" });

    await render();
    await openActions("Retry restart");
    await act(async () => {
      menuItem("Pause/Restart")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    await act(async () => root.unmount());
    root = createRoot(container);
    await render();

    await openActions("Retry restart");
    await act(async () => {
      menuItem("Pause/Restart")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(mockIssuesApi.releaseTreeHold).toHaveBeenCalledTimes(1);
    expect(mockIssuesApi.createTreeHold).not.toHaveBeenCalled();
    expect(mockAgentsApi.wakeup).toHaveBeenCalledTimes(2);
    expect(mockAgentsApi.wakeup).toHaveBeenLastCalledWith(
      "agent-1",
      {
        source: "assignment",
        triggerDetail: "manual",
        reason: "recent_task_restart_retry",
        payload: { issueId: "issue-1" },
      },
      "company-1",
    );
  });

  it("preserves pending restart wake retries from before the snapshot storage migration", async () => {
    const issue = {
      id: "issue-1", companyId: "company-1", title: "Retry after upgrade", identifier: "PAP-1",
      status: "in_progress" as const, assigneeAgentId: "agent-1", hiddenAt: null, updatedAt: new Date(1),
    };
    serveRecent([issue]);
    window.localStorage.setItem("paperclip.recentTasks:company-1:user-1:restart-wake-retry", JSON.stringify([issue.id]));
    mockIssuesApi.get.mockResolvedValue(issue);
    mockIssuesApi.getTreeControlState.mockResolvedValue({ activePauseHold: null });
    mockAgentsApi.wakeup.mockResolvedValue({ id: "run-1" });

    await render();
    await openActions("Retry after upgrade");
    await act(async () => {
      menuItem("Pause/Restart")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(mockIssuesApi.createTreeHold).not.toHaveBeenCalled();
    expect(mockIssuesApi.releaseTreeHold).not.toHaveBeenCalled();
    expect(mockAgentsApi.wakeup).toHaveBeenCalledWith("agent-1", expect.objectContaining({
      reason: "recent_task_restart_retry",
    }), "company-1");
    expect(window.localStorage.getItem("paperclip.recentTasks:company-1:user-1:restart-wake-retry")).toBeNull();
  });
});
