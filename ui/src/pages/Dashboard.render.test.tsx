// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ActivityEvent, Agent, DashboardSummary } from "@greatstone/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";

const mockDashboardApi = vi.hoisted(() => ({ summary: vi.fn() }));
const mockActivityApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn(), resume: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockProjectsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockAccessApi = vi.hoisted(() => ({ listUserDirectory: vi.fn() }));

vi.mock("../api/dashboard", () => ({ dashboardApi: mockDashboardApi }));
vi.mock("../api/activity", () => ({ activityApi: mockActivityApi }));
vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/projects", () => ({ projectsApi: mockProjectsApi }));
vi.mock("../api/access", () => ({ accessApi: mockAccessApi }));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/GRE/dashboard" }),
  Link: ({ children, to, ...props }: React.ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    companies: [{ id: "company-1", name: "Greatstone" }],
  }),
}));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openOnboarding: vi.fn() }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../hooks/useSharedPolling", () => ({
  useSharedPollingQuery: () => null,
  usePublishSharedQueryData: () => undefined,
}));

// Children with their own data or canvas needs are stubbed; this test is about
// which blocks the page lays out, not how each one draws.
vi.mock("../components/DashboardHero", () => ({ DashboardHero: () => <div data-testid="hero" /> }));
vi.mock("../components/DashboardDecisionsBox", () => ({
  DashboardDecisionsBox: () => <div data-testid="dashboard-decisions" />,
}));
vi.mock("../components/DashboardOverview", () => ({
  DASHBOARD_OPEN_TASK_STATUSES: ["in_progress", "in_review", "blocked"],
  DashboardOverview: () => <div data-testid="dashboard-overview" />,
}));
vi.mock("../components/ActiveAgentsPanel", () => ({ ActiveAgentsPanel: () => <div data-testid="active-agents" /> }));
vi.mock("../components/DashboardCostCard", () => ({ DashboardCostCard: () => null }));
vi.mock("../components/SmokeLabDashboardCard", () => ({ SmokeLabDashboardCard: () => null }));
vi.mock("@/plugins/slots", () => ({ PluginSlotOutlet: () => null }));
vi.mock("../components/ActivityCharts", () => ({
  ChartCard: ({ title, children }: { title: string; children: ReactNode }) => (
    <section data-testid="chart" aria-label={title}>
      {children}
    </section>
  ),
  RunActivityChart: () => null,
  PriorityChart: () => null,
  IssueStatusChart: () => null,
  SuccessRateChart: () => null,
}));
vi.mock("../components/ActivityRow", () => ({
  ActivityRow: ({ event }: { event: ActivityEvent }) => <div data-testid="activity-row">{event.id}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const summary: DashboardSummary = {
  companyId: "company-1",
  agents: { active: 3, running: 1, paused: 0, error: 0 },
  tasks: { open: 5, inProgress: 2, blocked: 1, done: 9 },
  costs: { monthSpendCents: 1234, monthBudgetCents: 0, monthUtilizationPercent: 0 },
  pendingApprovals: 0,
  budgets: { activeIncidents: 0, pendingApprovals: 0, pausedAgents: 0, pausedProjects: 0 },
  runActivity: [],
};

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("Dashboard layout", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockDashboardApi.summary.mockResolvedValue(summary);
    mockActivityApi.list.mockResolvedValue([
      { id: "event-1" },
      { id: "event-2" },
    ] as unknown as ActivityEvent[]);
    mockAgentsApi.list.mockResolvedValue([{ id: "agent-1", name: "Mica", status: "running" }] as unknown as Agent[]);
    mockIssuesApi.list.mockResolvedValue([]);
    mockProjectsApi.list.mockResolvedValue([]);
    mockAccessApi.listUserDirectory.mockResolvedValue({ users: [] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("shows decisions on top, then agents, metric cards, charts and recent activity, none collapsed", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Dashboard />
        </QueryClientProvider>,
      );
    });
    await flush();

    const text = container.textContent ?? "";
    for (const label of ["Agents Enabled", "Tasks In Progress", "Month Spend", "Pending Approvals"]) {
      expect(text).toContain(label);
    }

    const charts = Array.from(container.querySelectorAll('[data-testid="chart"]')).map((node) =>
      node.getAttribute("aria-label"),
    );
    expect(charts).toEqual(expect.arrayContaining(["Run Activity", "Tasks by Status", "Success Rate"]));

    expect(text).toContain("Recent Activity");
    expect(container.querySelectorAll('[data-testid="activity-row"]')).toHaveLength(2);

    expect(container.querySelector('[data-testid="dashboard-overview"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="active-agents"]')).not.toBeNull();

    // Nothing sits behind a disclosure, and the decisions item comes before the overview.
    expect(container.querySelector("[data-state='closed']")).toBeNull();
    const decisions = container.querySelector('[data-testid="dashboard-decisions"]')!;
    const overview = container.querySelector('[data-testid="dashboard-overview"]')!;
    expect(decisions.compareDocumentPosition(overview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
