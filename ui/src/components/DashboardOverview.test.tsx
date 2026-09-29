// @vitest-environment jsdom

import { act as reactAct } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { Agent, Issue } from "@greatstone/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DashboardOverview,
  deriveDashboardAgentRows,
  selectDashboardOpenTasks,
} from "./DashboardOverview";

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
    );
    expect(rows.map((row) => [row.agent.id, row.currentTask?.id ?? null])).toEqual([
      ["b", "i2"],
      ["a", null],
    ]);
  });
});

describe("selectDashboardOpenTasks", () => {
  it("keeps open statuses only, newest activity first, capped at the limit", () => {
    const tasks = selectDashboardOpenTasks(
      [
        issue({ id: "old", updatedAt: new Date("2026-09-01T00:00:00Z") }),
        issue({ id: "done", status: "done", updatedAt: new Date("2026-09-09T00:00:00Z") }),
        issue({ id: "new", status: "blocked", lastActivityAt: new Date("2026-09-05T00:00:00Z") }),
        issue({ id: "mid", status: "in_review", updatedAt: new Date("2026-09-03T00:00:00Z") }),
      ],
      2,
    );
    expect(tasks.map((task) => task.id)).toEqual(["new", "mid"]);
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
  });

  it("lists each agent with its current task or 'No current task'", () => {
    act(() => {
      root.render(
        <DashboardOverview
          agents={[
            agent({ id: "a", name: "Ada", status: "running" }),
            agent({ id: "b", name: "Bo", status: "paused" }),
          ]}
          openIssues={[issue({ id: "i1", identifier: "GRE-7", title: "Fix popup", assigneeAgentId: "a" })]}
        />,
      );
    });

    const rows = container.querySelectorAll('[data-testid="dashboard-agent-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Ada");
    expect(rows[0]!.textContent).toContain("GRE-7");
    expect(rows[0]!.textContent).toContain("Fix popup");
    expect(rows[0]!.querySelector('a[href="/issues/GRE-7"]')).not.toBeNull();
    expect(rows[1]!.textContent).toContain("Bo");
    expect(rows[1]!.textContent).toContain("No current task");
    expect(container.querySelector('a[href="/issues"]')?.textContent).toBe("View all tasks");
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
