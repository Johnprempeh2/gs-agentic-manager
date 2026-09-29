import { useEffect, useState } from "react";
import { useLocation } from "@/lib/router";
import {
  onboardingStepForCompany,
  shouldRouteAgentlessCompanyToOnboarding,
} from "../lib/onboarding-route";
import { claimOnboardingOffer } from "../lib/onboarding-auto-open";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dashboardApi } from "../api/dashboard";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { BrandStoneIcon } from "../components/BrandMark";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { MetricCard } from "../components/MetricCard";
import { EmptyState } from "../components/EmptyState";
import { DASHBOARD_OPEN_TASK_STATUSES, DashboardOverview } from "../components/DashboardOverview";
import { DashboardDecisionsBox } from "../components/DashboardDecisionsBox";
import { usePublishSharedQueryData, useSharedPollingQuery } from "../hooks/useSharedPolling";
import { useLiveAgents } from "../hooks/useLiveAgents";
import { cn, formatCents } from "../lib/utils";
import { SHOW_TASK_PRIORITY_UI } from "../lib/ui-flags";
import { Bot, ChevronRight, CircleDot, DollarSign, ShieldCheck, LayoutDashboard, PauseCircle } from "lucide-react";
import { ChartCard, RunActivityChart, PriorityChart, IssueStatusChart, SuccessRateChart } from "../components/ActivityCharts";
import { PageSkeleton } from "../components/PageSkeleton";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { InlineBanner } from "../components/InlineBanner";
import type { Agent } from "@greatstone/shared";
import { PluginSlotOutlet } from "@/plugins/slots";
import { SmokeLabDashboardCard } from "../components/SmokeLabDashboardCard";
import { DashboardCostCard } from "../components/DashboardCostCard";

export const DASHBOARD_MORE_OPEN_KEY = "gsam:dashboard:more-open";

function loadDashboardMoreOpen(): boolean {
  try {
    return localStorage.getItem(DASHBOARD_MORE_OPEN_KEY) === "true";
  } catch {
    return false;
  }
}

function saveDashboardMoreOpen(open: boolean) {
  try {
    localStorage.setItem(DASHBOARD_MORE_OPEN_KEY, String(open));
  } catch {
    // Ignore localStorage failures.
  }
}

function greetingFor(hour: number) {
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** A one-line page header: organization name with the greeting and date beside it. */
function DashboardHeader({ companyName, now = new Date() }: { companyName: string; now?: Date }) {
  const dateLabel = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(now);
  return (
    <header className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
      <h1 className="min-w-0 truncate text-xl font-bold">{companyName}</h1>
      <p className="text-sm text-muted-foreground">
        {greetingFor(now.getHours())} · {dateLabel}
      </p>
    </header>
  );
}

export type PausedAgentBanner =
  | { kind: "imported"; pausedImportedAgentIds: string[] }
  | { kind: "all-paused" }
  | null;

/**
 * Which paused-agents banner the dashboard should show. Import-paused agents
 * get the specific banner with a bulk resume (they were parked by the import
 * safety default and stay parked until someone acts); otherwise a company
 * whose agents are ALL paused gets a generic explanation, because from the
 * outside it is indistinguishable from a broken company.
 */
export function derivePausedAgentBanner(agents: Agent[] | undefined): PausedAgentBanner {
  if (!agents || agents.length === 0) return null;
  const importedPaused = agents.filter(
    (agent) => agent.status === "paused" && agent.pauseReason === "import",
  );
  if (importedPaused.length > 0) {
    return { kind: "imported", pausedImportedAgentIds: importedPaused.map((agent) => agent.id) };
  }
  if (agents.every((agent) => agent.status === "paused")) return { kind: "all-paused" };
  return null;
}

export function Dashboard() {
  const { selectedCompanyId, companies } = useCompany();
  const { openOnboarding } = useDialogActions();
  const location = useLocation();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [moreOpen, setMoreOpen] = useState(() => loadDashboardMoreOpen());

  // `isFetching` is read alongside the data: a cached list is served while its
  // refetch runs, and an empty one from before the first hire must not pass
  // for the company's current state — see `shouldRouteAgentlessCompanyToOnboarding`.
  const { data: agents, isFetching: agentsRefreshing, isLoading: agentsLoading, error: agentsError } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Bulk resume for agents parked by a company import. Sequential on purpose
  // (mirrors the import page's activation checklist); a per-agent failure is
  // tolerated so one bad agent never blocks the rest, and the refetch below
  // re-renders the banner with whatever remains paused.
  const queryClient = useQueryClient();
  const resumeImportedAgents = useMutation({
    mutationFn: async () => {
      const targets = derivePausedAgentBanner(agents);
      if (!targets || targets.kind !== "imported") return;
      for (const agentId of targets.pausedImportedAgentIds) {
        try {
          await agentsApi.resume(agentId, selectedCompanyId ?? undefined);
        } catch {
          // Leave the agent paused; the banner re-renders with the remainder.
        }
      }
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId!) }),
      ]);
    },
  });

  // A company with no agent cannot do anything — no runs, no tasks, nothing
  // to show. The banner below already says so and offers a link; this takes
  // the customer there instead of asking them to notice.
  //
  // It also closes the gap a Cloud-provisioned stack falls into. Cloud creates
  // the company before the tenant boots, so the companyless redirect never
  // fires and a seeded customer lands here, on an empty dashboard, straight
  // out of signup.
  //
  // Opened as the dialog rather than navigated to: the wizard is already
  // mounted globally, so there is no route to race and no redirect to loop.
  // Placed with the other hooks — the early returns below mean anything
  // further down would be called conditionally.
  //
  // The company and the step are both passed. Opening with empty options would
  // start the wizard at the front door with no company, and the new-company
  // path there would create a *second* company instead of giving this one an
  // agent.
  const shouldOpenOnboarding = shouldRouteAgentlessCompanyToOnboarding({
    pathname: location.pathname,
    agentsLoaded: agents !== undefined,
    agentsRefreshing,
    agentCount: agents?.length ?? 0,
  });
  // Auto-open once per company. Every input to the effect sits behind a query,
  // so a refetch re-runs it, and the customer can also navigate away and come
  // back — both would otherwise call `openOnboarding` again and reopen a
  // wizard that was deliberately closed. `claimOnboardingOffer` holds the
  // companies already offered; see it for why that outlives this component.
  useEffect(() => {
    if (!shouldOpenOnboarding || !selectedCompanyId) return;
    if (!claimOnboardingOffer(selectedCompanyId)) return;
    openOnboarding({
      companyId: selectedCompanyId,
      initialStep: onboardingStepForCompany(),
    });
    // No mission lookup to wait on any more: the step this opens is the same
    // whatever the goals say, so waiting only delayed the open.
  }, [shouldOpenOnboarding, selectedCompanyId, openOnboarding]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Dashboard" }]);
  }, [setBreadcrumbs]);

  const dashboardQueryKey = queryKeys.dashboard(selectedCompanyId!);
  const sharedDashboard = useSharedPollingQuery({
    companyId: selectedCompanyId,
    resourceKey: "dashboard",
    queryKey: dashboardQueryKey,
    enabled: !!selectedCompanyId,
  });
  const { data, isLoading, error, dataUpdatedAt: dashboardUpdatedAt } = useQuery({
    queryKey: dashboardQueryKey,
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  usePublishSharedQueryData(sharedDashboard, data, dashboardUpdatedAt);

  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Open work for the overview, fetched by status so a long history of done
  // tasks cannot push it past the list's default page.
  const {
    data: openIssues,
    isLoading: openIssuesLoading,
    error: openIssuesError,
  } = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "dashboard-open"] as const,
    queryFn: () => issuesApi.list(selectedCompanyId!, { status: DASHBOARD_OPEN_TASK_STATUSES.join(",") }),
    enabled: !!selectedCompanyId,
  });

  // Same source as the sidebar "N live" count, so the two always agree (GRE-257).
  const { liveAgents } = useLiveAgents(selectedCompanyId);

  if (!selectedCompanyId) {
    if (companies.length === 0) {
      return (
        <EmptyState
          icon={BrandStoneIcon}
          message="Welcome to GS Agentic Manager. Set up your first organization and agent to get started."
          action="Get Started"
          onAction={openOnboarding}
        />
      );
    }
    return (
      <EmptyState icon={LayoutDashboard} message="Create or select an organization to view the dashboard." />
    );
  }

  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  // Same rule as the auto-offer above: a list still being refreshed may be the
  // empty one cached before the first hire, and the banner's "Create one here"
  // opens the same agent step the offer does.
  const hasNoAgents = agents !== undefined && !agentsRefreshing && agents.length === 0;
  const pausedBanner = derivePausedAgentBanner(agents);
  const pausedImportedCount =
    pausedBanner?.kind === "imported" ? pausedBanner.pausedImportedAgentIds.length : 0;

  const selectedCompany = companies.find((company) => company.id === selectedCompanyId);

  return (
    <div className="space-y-6">
      {selectedCompany ? <DashboardHeader companyName={selectedCompany.name} /> : null}
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {pausedBanner?.kind === "imported" ? (
        <InlineBanner
          tone="warning"
          icon={PauseCircle}
          title={`${pausedImportedCount} imported agent${pausedImportedCount === 1 ? " is" : "s are"} paused and will not run.`}
          actions={
            <Button
              size="sm"
              onClick={() => resumeImportedAgents.mutate()}
              disabled={resumeImportedAgents.isPending}
              data-testid="dashboard-resume-imported-agents"
            >
              {resumeImportedAgents.isPending ? "Resuming…" : "Resume all"}
            </Button>
          }
        >
          Agents from an organization import arrive paused as a safety default. Resume them so assigned tasks can start.
        </InlineBanner>
      ) : pausedBanner?.kind === "all-paused" ? (
        <InlineBanner
          tone="warning"
          icon={PauseCircle}
          title="All agents in this organization are paused — nothing will run."
          actions={
            <Button variant="ghost" size="sm" asChild>
              <Link to="/agents">Review agents</Link>
            </Button>
          }
        >
          Resume at least one agent to let assigned tasks start.
        </InlineBanner>
      ) : null}

      {hasNoAgents && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-500/25 dark:bg-amber-950/60">
          <div className="flex items-center gap-2.5">
            <Bot className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <p className="text-sm text-amber-900 dark:text-amber-100">
              You have no agents.
            </p>
          </div>
          <button
            onClick={() => openOnboarding({ initialStep: 3, companyId: selectedCompanyId! })}
            className="text-sm font-medium text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100 underline underline-offset-2 shrink-0"
          >
            Create one here
          </button>
        </div>
      )}

      {data && data.budgets.activeIncidents > 0 ? (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-red-500/20 bg-(image:--gradient-extract-1) px-4 py-3">
          <div className="flex items-start gap-2.5">
            <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-700 dark:text-red-300" />
            <div>
              <p className="text-sm font-medium text-red-950 dark:text-red-50">
                {data.budgets.activeIncidents} active budget incident{data.budgets.activeIncidents === 1 ? "" : "s"}
              </p>
              <p className="text-xs text-red-900/70 dark:text-red-100/70">
                {data.budgets.pausedAgents} agents paused · {data.budgets.pausedProjects} projects paused · {data.budgets.pendingApprovals} pending budget approvals
              </p>
            </div>
          </div>
          <Link to="/costs" className="text-sm underline underline-offset-2 text-red-900 dark:text-red-100">
            Open budgets
          </Link>
        </div>
      ) : null}

      <DashboardDecisionsBox companyId={selectedCompanyId!} />

      <DashboardOverview
        agents={agents}
        openIssues={openIssues}
        liveAgents={liveAgents}
        agentsLoading={agentsLoading}
        issuesLoading={openIssuesLoading}
        agentsError={agentsError}
        issuesError={openIssuesError}
      />

      {data && (
        <Collapsible
          open={moreOpen}
          onOpenChange={(open) => {
            setMoreOpen(open);
            saveDashboardMoreOpen(open);
          }}
        >
          <CollapsibleTrigger className="group flex items-center gap-1.5 rounded-sm text-sm font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRight className="h-4 w-4 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
            Numbers and charts
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3 space-y-6">
            <div className="gs-stagger grid grid-cols-2 xl:grid-cols-4 gap-2 sm:gap-3">
              <MetricCard
                icon={Bot}
                value={data.agents.active + data.agents.running + data.agents.paused + data.agents.error}
                label="Agents Enabled"
                to="/agents"
                description={
                  <span>
                    {data.agents.running} running{", "}
                    {data.agents.paused} paused{", "}
                    {data.agents.error} errors
                  </span>
                }
              />
              <MetricCard
                icon={CircleDot}
                value={data.tasks.inProgress}
                label="Tasks In Progress"
                to="/issues"
                description={
                  <span>
                    {data.tasks.open} open{", "}
                    {data.tasks.blocked} blocked
                  </span>
                }
              />
              <MetricCard
                icon={DollarSign}
                value={formatCents(data.costs.monthSpendCents)}
                label="Month Spend"
                to="/costs"
                description={
                  <span>
                    {data.costs.monthBudgetCents > 0
                      ? `${data.costs.monthUtilizationPercent}% of ${formatCents(data.costs.monthBudgetCents)} budget`
                      : "Unlimited budget"}
                  </span>
                }
              />
              <MetricCard
                icon={ShieldCheck}
                value={data.pendingApprovals + data.budgets.pendingApprovals}
                label="Pending Approvals"
                to="/approvals"
                description={
                  <span>
                    {data.budgets.pendingApprovals > 0
                      ? `${data.budgets.pendingApprovals} budget overrides awaiting board review`
                      : "Awaiting board review"}
                  </span>
                }
              />
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3 xl:grid-cols-4">
              <DashboardCostCard companyId={selectedCompanyId!} />
            </div>

            <SmokeLabDashboardCard companyId={selectedCompanyId!} />

            <div className={cn("gs-stagger grid grid-cols-2 gap-4", SHOW_TASK_PRIORITY_UI ? "lg:grid-cols-4" : "lg:grid-cols-3")}>
              <ChartCard title="Run Activity" subtitle="Last 14 days">
                <RunActivityChart activity={data.runActivity} />
              </ChartCard>
              {/* PAP-411: "Tasks by Priority" chart hidden behind SHOW_TASK_PRIORITY_UI. */}
              {SHOW_TASK_PRIORITY_UI && (
                <ChartCard title="Tasks by Priority" subtitle="Last 14 days">
                  <PriorityChart issues={issues ?? []} />
                </ChartCard>
              )}
              <ChartCard title="Tasks by Status" subtitle="Last 14 days">
                <IssueStatusChart issues={issues ?? []} />
              </ChartCard>
              <ChartCard title="Success Rate" subtitle="Last 14 days">
                <SuccessRateChart activity={data.runActivity} />
              </ChartCard>
            </div>

            <PluginSlotOutlet
              slotTypes={["dashboardWidget"]}
              context={{ companyId: selectedCompanyId }}
              className="grid gap-4 md:grid-cols-2"
              // design-allow(card-pattern): class-string prop consumed by the plugin outlet; a component can't be passed here (C5a Run 3)
              itemClassName="rounded-lg border bg-card p-4 shadow-sm"
            />

            <p className="text-xs text-muted-foreground">
              <Link to="/activity" className="underline-offset-2 hover:text-foreground hover:underline">
                See all recent activity
              </Link>
            </p>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
