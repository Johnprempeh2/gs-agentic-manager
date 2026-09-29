// @vitest-environment jsdom

import { act as reactAct } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { Agent, Issue } from "@greatstone/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_BOARD_PAGE_SIZE_KEY,
  DashboardOverview,
  deriveDashboardAgentRows,
  loadDashboardBoardPageSize,
  selectDashboardBoardTasks,
  splitDashboardAgentRows,
} from "./DashboardOverview";
import { selectLiveAgents } from "../hooks/useLiveAgents";
import type { LiveRunForIssue } from "../api/heartbeats";

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    disableIssueQuicklook: _disableIssueQuicklook,
    issuePrefetch: _issuePrefetch,
    to,
    ...props
  }: React.ComponentProps<"a"> & { to: string; disableIssueQuicklook?: boolean; issuePrefetch?: Issue | null }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  if (typeof reactAct === "function") {
    reactAct(callback);
    return;
  }
  flushSync(callback);
}

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    name: "Agent",
    urlKey: null,
    status: "idle",
    icon: null,
    ...overrides,
  } as unknown as Agent;
}

function issue(overrides: Partial<Issue>): Issue {
  return {
    id: "issue-1",
    identifier: "GRE-1",
    title: "Task",
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: null,
    checkoutRunId: null,
    executionRunId: null,
    labels: [],
    labelIds: [],
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    lastActivityAt: null,
    ...overrides,
  } as unknown as Issue;
}

function run(overrides: Partial<LiveRunForIssue>): LiveRunForIssue {
  return {
    id: "run-1",
    status: "running",
    invocationSource: "assignment",
    triggerDetail: null,
    startedAt: "2026-09-29T08:00:00Z",
    finishedAt: null,
    createdAt: "2026-09-29T08:00:00Z",
    agentId: "agent-1",
    agentName: "Agent",
    adapterType: "claude_local",
    issueId: null,
    ...overrides,
  } as LiveRunForIssue;
}

describe("selectLiveAgents", () => {
  it("counts each agent with a running run once and ignores queued runs", () => {
    const live = selectLiveAgents([
      run({ id: "r1", agentId: "a", issueId: "old", createdAt: "2026-09-29T08:00:00Z" }),
      run({ id: "r2", agentId: "a", issueId: "new", createdAt: "2026-09-29T09:00:00Z" }),
      run({ id: "r3", agentId: "b" }),
      run({ id: "r4", agentId: "c", status: "queued" }),
    ]);
    expect(live.map((agent) => [agent.agentId, agent.runs.length, agent.issueId])).toEqual([
      ["a", 2, "new"],
      ["b", 1, null],
    ]);
    expect(selectLiveAgents(undefined)).toEqual([]);
  });
});

describe("deriveDashboardAgentRows", () => {
  it("drops terminated agents and pairs each agent with its in-progress task", () => {
    const rows = deriveDashboardAgentRows(
      [
        agent({ id: "a", name: "Ada", status: "idle" }),
        agent({ id: "b", name: "Bo", status: "running" }),
        agent({ id: "c", name: "Cy", status: "terminated" }),
      ],
      [
        issue({ id: "i1", assigneeAgentId: "b", updatedAt: new Date("2026-09-02T00:00:00Z") }),
        issue({ id: "i2", assigneeAgentId: "b", executionRunId: "run-1" }),
        issue({ id: "i3", assigneeAgentId: "a", status: "in_review" }),
      ],
      selectLiveAgents([run({ agentId: "b" })]),
    );
    expect(rows.map((row) => [row.agent.id, row.currentTask?.id ?? null])).toEqual([
      ["b", "i2"],
      ["a", null],
    ]);
  });
});

describe("splitDashboardAgentRows", () => {
  it("keeps running, erroring and task-holding agents apart from resting ones", () => {
    const rows = deriveDashboardAgentRows(
      [
        agent({ id: "run", name: "Run", status: "running" }),
        agent({ id: "err", name: "Err", status: "error" }),
        agent({ id: "busy", name: "Busy", status: "idle" }),
        agent({ id: "idle", name: "Idle", status: "idle" }),
        agent({ id: "paused", name: "Paused", status: "paused" }),
      ],
      [issue({ id: "i1", assigneeAgentId: "busy" })],
      selectLiveAgents([run({ agentId: "run" })]),
    );
    const { working, resting } = splitDashboardAgentRows(rows);
    expect(working.map((row) => row.agent.id).sort()).toEqual(["busy", "err", "run"]);
    expect(resting.map((row) => row.agent.id)).toEqual(["idle", "paused"]);
  });
});

describe("selectDashboardBoardTasks", () => {
  it("keeps the four open statuses only, newest activity first", () => {
    const tasks = selectDashboardBoardTasks([
      issue({ id: "old", updatedAt: new Date("2026-09-01T00:00:00Z") }),
      issue({ id: "done", status: "done", updatedAt: new Date("2026-09-09T00:00:00Z") }),
      issue({ id: "backlog", status: "backlog", updatedAt: new Date("2026-09-09T00:00:00Z") }),
      issue({ id: "new", status: "blocked", lastActivityAt: new Date("2026-09-05T00:00:00Z") }),
      issue({ id: "todo", status: "todo", updatedAt: new Date("2026-09-04T00:00:00Z") }),
      issue({ id: "mid", status: "in_review", updatedAt: new Date("2026-09-03T00:00:00Z") }),
    ]);
    expect(tasks.map((task) => task.id)).toEqual(["new", "todo", "mid", "old"]);
  });
});

describe("loadDashboardBoardPageSize", () => {
  afterEach(() => localStorage.clear());

  it("defaults to 5 and only accepts the offered sizes", () => {
    expect(loadDashboardBoardPageSize()).toBe(5);
    localStorage.setItem(DASHBOARD_BOARD_PAGE_SIZE_KEY, "20");
    expect(loadDashboardBoardPageSize()).toBe(20);
    localStorage.setItem(DASHBOARD_BOARD_PAGE_SIZE_KEY, "7");
    expect(loadDashboardBoardPageSize()).toBe(5);
  });
});

describe("DashboardOverview", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("shows the board and busy agents by title only, with no task keys", () => {
    act(() => {
      root.render(
        <DashboardOverview
          agents={[agent({ id: "a", name: "Ada", status: "running" })]}
          openIssues={[
            issue({ id: "i1", identifier: "GRE-7", title: "Fix popup", assigneeAgentId: "a" }),
            issue({ id: "i2", identifier: "GRE-8", title: "Write docs", status: "todo" }),
          ]}
        />,
      );
    });

    const board = container.querySelector('[data-testid="dashboard-task-board"]')!;
    expect(board.querySelector('[data-testid="kanban-column-todo"]')?.textContent).toContain("Write docs");
    expect(board.querySelector('[data-testid="kanban-column-in_progress"]')?.textContent).toContain("Fix popup");
    const rows = container.querySelectorAll('[data-testid="dashboard-agent-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Ada");
    expect(rows[0]!.textContent).toContain("Fix popup");
    expect(rows[0]!.querySelector('a[href="/issues/GRE-7"]')).not.toBeNull();
    expect(container.textContent).not.toMatch(/GRE-\d/);
    expect(container.querySelector('a[href="/issues"]')?.textContent).toBe("View all tasks");
  });

  it("folds idle and paused agents into one line", () => {
    act(() => {
      root.render(
        <DashboardOverview
          agents={[
            agent({ id: "a", name: "Ada", status: "running" }),
            agent({ id: "b", name: "Bo", status: "idle" }),
            agent({ id: "c", name: "Cy", status: "idle" }),
            agent({ id: "d", name: "Di", status: "paused" }),
          ]}
          openIssues={[]}
          liveAgents={selectLiveAgents([run({ agentId: "a" })])}
        />,
      );
    });

    expect(container.querySelectorAll('[data-testid="dashboard-agent-row"]')).toHaveLength(1);
    const resting = container.querySelector('[data-testid="dashboard-resting-agents"]')!;
    expect(resting.textContent).toContain("2 idle · 1 paused");
    expect(resting.textContent).toContain("Bo");
    expect(resting.textContent).toContain("Di");
  });

  it("shows exactly the agents with running runs as live, with their current task (GRE-257)", () => {
    // Several running runs: two for Ada, one for Keystone (on an in-review
    // task it does not own), one for Bo on a task not in the open list, and a
    // queued run for Cy. Di's own status says running but no run is.
    const runs = [
      run({ id: "r1", agentId: "a", issueId: "i1", createdAt: "2026-09-29T08:00:00Z" }),
      run({ id: "r2", agentId: "a", issueId: "i1", createdAt: "2026-09-29T08:05:00Z" }),
      run({ id: "r3", agentId: "k", issueId: "i2" }),
      run({ id: "r4", agentId: "b", issueId: "closed" }),
      run({ id: "r5", agentId: "c", status: "queued" }),
    ];
    const liveAgents = selectLiveAgents(runs);
    act(() => {
      root.render(
        <DashboardOverview
          agents={[
            agent({ id: "a", name: "Ada", status: "running" }),
            agent({ id: "k", name: "Keystone", status: "idle" }),
            agent({ id: "b", name: "Bo", status: "idle" }),
            agent({ id: "c", name: "Cy", status: "idle" }),
            agent({ id: "d", name: "Di", status: "running" }),
          ]}
          openIssues={[
            issue({ id: "i1", identifier: "GRE-7", title: "Fix popup", assigneeAgentId: "a" }),
            issue({ id: "i2", identifier: "GRE-8", title: "Review PR", status: "in_review", assigneeAgentId: "a" }),
          ]}
          liveAgents={liveAgents}
        />,
      );
    });

    const liveRows = [...container.querySelectorAll('[data-testid="dashboard-agent-row"][data-live="true"]')];
    // The sidebar shows `liveAgents.length` as "N live"; the dashboard must match.
    expect(liveAgents).toHaveLength(3);
    expect(liveRows).toHaveLength(liveAgents.length);
    expect(container.querySelector('[data-testid="dashboard-live-count"]')?.textContent).toBe("3 live");
    const rowFor = (name: string) => liveRows.find((row) => row.textContent?.includes(name));
    expect(rowFor("Ada")?.textContent).toContain("Fix popup");
    expect(rowFor("Keystone")?.textContent).toContain("Review PR");
    expect(rowFor("Keystone")?.textContent).not.toContain("No current task");
    expect(rowFor("Bo")?.querySelector('a[href="/issues/closed"]')?.textContent).toBe("Open current task");
    const resting = container.querySelector('[data-testid="dashboard-resting-agents"]')!;
    expect(resting.textContent).toContain("Cy");
    expect(resting.textContent).toContain("Di");
  });

  it("caps each lane at the saved size and remembers a new choice", () => {
    localStorage.setItem(DASHBOARD_BOARD_PAGE_SIZE_KEY, "10");
    const todos = Array.from({ length: 12 }, (_, index) =>
      issue({ id: `t${index}`, title: `Todo ${index}`, status: "todo", updatedAt: new Date(2026, 8, 1, index) }),
    );
    act(() => {
      root.render(<DashboardOverview agents={[]} openIssues={todos} />);
    });

    const lane = () => container.querySelector('[data-testid="kanban-column-todo"]')!;
    expect(lane().textContent).toContain("Showing 10 of 12");

    const trigger = container.querySelector('button[aria-label="Tasks shown per column: 10"]') as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    act(() => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const option = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "20 per column",
    );
    expect(option).toBeTruthy();
    act(() => {
      option!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(localStorage.getItem(DASHBOARD_BOARD_PAGE_SIZE_KEY)).toBe("20");
    expect(lane().textContent).toContain("Todo 0");
    expect(lane().textContent).not.toContain("Showing");
  });

  it("shows empty states when there are no agents and no open tasks", () => {
    act(() => {
      root.render(<DashboardOverview agents={[]} openIssues={[]} />);
    });

    expect(container.textContent).toContain("No agents yet.");
    expect(container.textContent).toContain("No open tasks.");
  });

  it("shows loading and error states", () => {
    act(() => {
      root.render(
        <DashboardOverview
          agents={undefined}
          openIssues={undefined}
          agentsLoading
          issuesError={new Error("boom")}
        />,
      );
    });

    expect(container.querySelector('[aria-label="Loading agents"]')).not.toBeNull();
    expect(container.textContent).toContain("Could not load tasks: boom");
  });
});
