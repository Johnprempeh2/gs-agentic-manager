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
const mockSidebar = vi.hoisted(() => ({ isMobile: false }));
const overviewProps = vi.hoisted(() => ({ last: null as null | { openTaskLimit?: number } }));

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
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => mockSidebar }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../hooks/useSharedPolling", () => ({
  useSharedPollingQuery: () => null,
  usePublishSharedQueryData: () => undefined,
}));
vi.mock("../hooks/useLiveAgents", () => ({
  useLiveAgents: () => ({ liveAgents: [], runs: [], isLoading: false }),
}));

// Children with their own data or canvas needs are stubbed; this test is about
// which blocks the page lays out, not how each one draws.
vi.mock("../components/DashboardHero", () => ({ DashboardHero: () => <div data-testid="hero" /> }));
vi.mock("../components/DashboardDecisionsBox", () => ({
  DashboardDecisionsBox: () => <div data-testid="dashboard-decisions" />,
}));
vi.mock("../components/AgentWorkDigest", () => ({
  DashboardDigestCard: () => <div data-testid="dashboard-digest" />,
}));
vi.mock("../components/DashboardOverview", () => ({
  DASHBOARD_OPEN_TASK_STATUSES: ["in_progress", "in_review", "blocked"],
  DashboardOverview: (props: { openTaskLimit?: number }) => {
    overviewProps.last = props;
    return <div data-testid="dashboard-overview" />;
  },
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
  chartWindowLabel: () => "Last 14 days",
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
    mockSidebar.isMobile = false;
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
    // "Since you were last here" sits right under decisions, one tap from home (GRE-357).
    const digest = container.querySelector('[data-testid="dashboard-digest"]')!;
    expect(decisions.compareDocumentPosition(digest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(digest.compareDocumentPosition(overview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Desktop has no phone shortcuts or toggle, and lists the full open-task count.
    expect(container.querySelector('[data-testid="dashboard-phone-shortcuts"]')).toBeNull();
    expect(container.querySelector('[data-testid="dashboard-phone-details-toggle"]')).toBeNull();
    expect(overviewProps.last?.openTaskLimit).toBeUndefined();
  });

  it("on phone, gives Agents and Audit one tap and folds runs, numbers and activity (GRE-364)", async () => {
    mockSidebar.isMobile = true;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Dashboard />
        </QueryClientProvider>,
      );
    });
    await flush();

    const shortcuts = container.querySelector('[data-testid="dashboard-phone-shortcuts"]')!;
    const hrefs = Array.from(shortcuts.querySelectorAll("a")).map((a) => [a.textContent, a.getAttribute("href")]);
    expect(hrefs).toEqual([
      ["Agents", "/agents"],
      ["Audit", "/activity"],
    ]);
    expect(overviewProps.last?.openTaskLimit).toBe(5);

    // Decisions and the overview stay; the rest waits behind the toggle.
    expect(container.querySelector('[data-testid="dashboard-decisions"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="dashboard-overview"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="active-agents"]')).toBeNull();
    expect(container.querySelector('[data-testid="chart"]')).toBeNull();
    expect(container.textContent).not.toContain("Agents Enabled");
    expect(container.textContent).not.toContain("Recent Activity");

    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="dashboard-phone-details-toggle"]')!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    act(() => toggle.click());

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-testid="active-agents"]')).not.toBeNull();
    expect(container.textContent).toContain("Agents Enabled");
    expect(container.textContent).toContain("Recent Activity");
    expect(container.querySelectorAll('[data-testid="chart"]').length).toBeGreaterThan(0);
  });
});

describe("isOwnerActivity", () => {
  it("keeps finished, blocked and cancelled tasks and drops other task updates", async () => {
    const { isOwnerActivity } = await import("./Dashboard");
    expect(isOwnerActivity({ action: "issue.updated", details: { status: "done" } })).toBe(true);
    expect(isOwnerActivity({ action: "issue.updated", details: { status: "in_review" } })).toBe(false);
    expect(isOwnerActivity({ action: "issue.updated", details: null })).toBe(false);
    expect(isOwnerActivity({ action: "instance.live_released", details: null })).toBe(true);
  });
});
