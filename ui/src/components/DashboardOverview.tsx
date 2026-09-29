import { useState, type ReactNode } from "react";
import type { Agent, Issue } from "@greatstone/shared";
import { Check, ListCollapse } from "lucide-react";
import { Link } from "@/lib/router";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentIdentity } from "./AgentIdentity";
import { AgentStatusCapsule } from "./StatusBadge";
import { KanbanBoard, type KanbanOwnerContext } from "./KanbanBoard";
import { StatusIcon } from "./StatusIcon";
import { agentUrl, cn } from "../lib/utils";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";

/** Statuses the dashboard board shows, in lane order. */
export const DASHBOARD_OPEN_TASK_STATUSES = ["todo", "in_progress", "in_review", "blocked"] as const;

export const DASHBOARD_BOARD_PAGE_SIZE_OPTIONS = [5, 10, 20] as const;
export type DashboardBoardPageSize = (typeof DASHBOARD_BOARD_PAGE_SIZE_OPTIONS)[number];
export const DASHBOARD_BOARD_DEFAULT_PAGE_SIZE: DashboardBoardPageSize = 5;
export const DASHBOARD_BOARD_PAGE_SIZE_KEY = "gsam:dashboard:board-page-size";

export function loadDashboardBoardPageSize(): DashboardBoardPageSize {
  try {
    const raw = Number(localStorage.getItem(DASHBOARD_BOARD_PAGE_SIZE_KEY));
    return (DASHBOARD_BOARD_PAGE_SIZE_OPTIONS as readonly number[]).includes(raw)
      ? (raw as DashboardBoardPageSize)
      : DASHBOARD_BOARD_DEFAULT_PAGE_SIZE;
  } catch {
    return DASHBOARD_BOARD_DEFAULT_PAGE_SIZE;
  }
}

export function saveDashboardBoardPageSize(pageSize: DashboardBoardPageSize) {
  try {
    localStorage.setItem(DASHBOARD_BOARD_PAGE_SIZE_KEY, String(pageSize));
  } catch {
    // Ignore localStorage failures.
  }
}

export interface DashboardAgentRow {
  agent: Agent;
  currentTask: Issue | null;
}

// Running agents first so "what is happening now" reads top-down; errors next
// because they need a person.
const AGENT_STATUS_ORDER: Record<string, number> = {
  running: 0,
  error: 1,
  active: 2,
  idle: 2,
  pending_approval: 3,
  paused: 4,
};

function activityTime(issue: Issue): number {
  return new Date(issue.lastActivityAt ?? issue.updatedAt).getTime();
}

function byNewestActivity(a: Issue, b: Issue): number {
  return activityTime(b) - activityTime(a);
}

/**
 * Pair every non-terminated agent with the task it works on now: its
 * in-progress assignment, preferring one a run holds, then the newest.
 */
export function deriveDashboardAgentRows(
  agents: Agent[] | undefined,
  openIssues: Issue[] | undefined,
): DashboardAgentRow[] {
  if (!agents) return [];
  const inProgressByAgent = new Map<string, Issue[]>();
  for (const issue of openIssues ?? []) {
    if (issue.status !== "in_progress" || !issue.assigneeAgentId) continue;
    const list = inProgressByAgent.get(issue.assigneeAgentId) ?? [];
    list.push(issue);
    inProgressByAgent.set(issue.assigneeAgentId, list);
  }
  return agents
    .filter((agent) => agent.status !== "terminated")
    .map((agent) => {
      const candidates = [...(inProgressByAgent.get(agent.id) ?? [])].sort((a, b) => {
        const aHeld = a.executionRunId || a.checkoutRunId ? 0 : 1;
        const bHeld = b.executionRunId || b.checkoutRunId ? 0 : 1;
        return aHeld - bHeld || byNewestActivity(a, b);
      });
      return { agent, currentTask: candidates[0] ?? null };
    })
    .sort(
      (a, b) =>
        (AGENT_STATUS_ORDER[a.agent.status] ?? 5) - (AGENT_STATUS_ORDER[b.agent.status] ?? 5)
        || a.agent.name.localeCompare(b.agent.name),
    );
}

/**
 * Split agent rows into the ones worth a row of their own (running, holding a
 * task, or in error) and the resting rest, which the strip folds into one line.
 */
export function splitDashboardAgentRows(rows: DashboardAgentRow[]): {
  working: DashboardAgentRow[];
  resting: DashboardAgentRow[];
} {
  const working: DashboardAgentRow[] = [];
  const resting: DashboardAgentRow[] = [];
  for (const row of rows) {
    const busy = row.agent.status === "running" || row.agent.status === "error" || row.currentTask !== null;
    (busy ? working : resting).push(row);
  }
  return { working, resting };
}

/** Open tasks for the board (to do, in progress, in review, blocked), newest activity first. */
export function selectDashboardBoardTasks(issues: Issue[] | undefined): Issue[] {
  const open = new Set<string>(DASHBOARD_OPEN_TASK_STATUSES);
  return (issues ?? []).filter((issue) => open.has(issue.status)).sort(byNewestActivity);
}

function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {action ? <div className="flex items-center gap-3">{action}</div> : null}
    </div>
  );
}

function SectionLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
      {children}
    </Link>
  );
}

function ListSkeleton({ label }: { label: string }) {
  return (
    <Card className="block space-y-3 p-4" aria-busy="true" aria-label={label}>
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton key={index} className="h-6 w-full" />
      ))}
    </Card>
  );
}

function MessageCard({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "error" }) {
  return (
    <Card className="block p-4">
      <p className={cn("text-sm", tone === "error" ? "text-destructive" : "text-muted-foreground")}>{children}</p>
    </Card>
  );
}

function BoardPageSizePicker({
  value,
  onChange,
}: {
  value: DashboardBoardPageSize;
  onChange: (value: DashboardBoardPageSize) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2"
          title="Tasks shown per column"
          aria-label={`Tasks shown per column: ${value}`}
        >
          <ListCollapse className="h-3.5 w-3.5" />
          <span className="min-w-4 text-xs tabular-nums">{value}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-40 p-0">
        <div className="space-y-0.5 p-2">
          {DASHBOARD_BOARD_PAGE_SIZE_OPTIONS.map((pageSize) => (
            <button
              key={pageSize}
              type="button"
              className={cn(
                "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm",
                value === pageSize ? "bg-accent/50 text-foreground" : "text-muted-foreground hover:bg-accent/50",
              )}
              onClick={() => onChange(pageSize)}
            >
              <span>{pageSize} per column</span>
              {value === pageSize && <Check className="h-3.5 w-3.5" />}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export interface DashboardTaskBoardProps {
  agents: Agent[] | undefined;
  openIssues: Issue[] | undefined;
  ownerContext?: KanbanOwnerContext;
  loading?: boolean;
  error?: Error | null;
}

/**
 * The open work as a read-only board: one lane per open status, titles only
 * (task keys stay on the task page), with the per-lane count the user picked.
 */
export function DashboardTaskBoard({ agents, openIssues, ownerContext, loading = false, error = null }: DashboardTaskBoardProps) {
  const [pageSize, setPageSize] = useState<DashboardBoardPageSize>(() => loadDashboardBoardPageSize());
  const tasks = selectDashboardBoardTasks(openIssues);

  return (
    <section className="min-w-0" aria-label="Tasks" data-testid="dashboard-task-board">
      <SectionHeader
        title="Tasks"
        action={(
          <>
            <BoardPageSizePicker
              value={pageSize}
              onChange={(next) => {
                setPageSize(next);
                saveDashboardBoardPageSize(next);
              }}
            />
            <SectionLink to="/issues">View all tasks</SectionLink>
          </>
        )}
      />
      {loading && !openIssues ? (
        <ListSkeleton label="Loading tasks" />
      ) : error && !openIssues ? (
        <MessageCard tone="error">Could not load tasks: {error.message}</MessageCard>
      ) : tasks.length === 0 ? (
        <MessageCard>No open tasks. Nothing is to do, in progress, in review or blocked.</MessageCard>
      ) : (
        <KanbanBoard
          issues={tasks}
          agents={agents}
          ownerContext={ownerContext}
          statuses={DASHBOARD_OPEN_TASK_STATUSES}
          showIdentifiers={false}
          fillWidth
          compactCards
          initialVisibleCount={pageSize}
          revealIncrement={pageSize}
        />
      )}
    </section>
  );
}

export interface DashboardAgentStripProps {
  agents: Agent[] | undefined;
  openIssues: Issue[] | undefined;
  loading?: boolean;
  error?: Error | null;
}

/**
 * Who is working on what. Busy agents get a compact card with their current
 * task; idle and paused agents share a single line so they take no room.
 */
export function DashboardAgentStrip({ agents, openIssues, loading = false, error = null }: DashboardAgentStripProps) {
  const { working, resting } = splitDashboardAgentRows(deriveDashboardAgentRows(agents, openIssues));
  const pausedCount = resting.filter(({ agent }) => agent.status === "paused").length;
  const restingSummary = [
    `${resting.length - pausedCount} idle`,
    pausedCount > 0 ? `${pausedCount} paused` : null,
  ].filter(Boolean).join(" · ");

  return (
    <section className="min-w-0" aria-label="Agents" data-testid="dashboard-agent-strip">
      <SectionHeader title="Agents" action={<SectionLink to="/agents">View all agents</SectionLink>} />
      {loading && !agents ? (
        <ListSkeleton label="Loading agents" />
      ) : error && !agents ? (
        <MessageCard tone="error">Could not load agents: {error.message}</MessageCard>
      ) : working.length === 0 && resting.length === 0 ? (
        <MessageCard>No agents yet.</MessageCard>
      ) : (
        <Card className="block space-y-3 p-3">
          {working.length > 0 ? (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {working.map(({ agent, currentTask }) => (
                <div
                  key={agent.id}
                  data-testid="dashboard-agent-row"
                  className="flex min-w-0 flex-col gap-1 rounded-lg border border-border/60 bg-background/60 px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <AgentStatusCapsule status={agent.status} />
                    <Link
                      to={agentUrl(agent)}
                      className="min-w-0 flex-1 rounded-sm text-inherit no-underline hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <AgentIdentity agent={agent} size="sm" className="max-w-full font-medium" />
                    </Link>
                  </div>
                  {currentTask ? (
                    <Link
                      to={createIssueDetailPath(currentTask.identifier ?? currentTask.id)}
                      className="flex min-w-0 items-center gap-2 rounded-sm text-sm text-inherit no-underline hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      title={currentTask.title}
                    >
                      <StatusIcon status={currentTask.status} blockerAttention={currentTask.blockerAttention} />
                      <span className="min-w-0 truncate">{currentTask.title}</span>
                    </Link>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      {agent.status === "error" ? "Needs a look" : "No current task"}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No agent is working right now.</p>
          )}
          {resting.length > 0 ? (
            <div
              data-testid="dashboard-resting-agents"
              className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground"
            >
              <span className="shrink-0 font-medium">{restingSummary}</span>
              {resting.map(({ agent }) => (
                <Link
                  key={agent.id}
                  to={agentUrl(agent)}
                  className="inline-flex min-w-0 items-center gap-1.5 rounded-sm text-inherit no-underline hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <AgentStatusCapsule status={agent.status} />
                  <AgentIdentity agent={agent} size="xs" className="max-w-32" />
                </Link>
              ))}
            </div>
          ) : null}
        </Card>
      )}
    </section>
  );
}

export interface DashboardOverviewProps {
  agents: Agent[] | undefined;
  openIssues: Issue[] | undefined;
  agentsLoading?: boolean;
  issuesLoading?: boolean;
  agentsError?: Error | null;
  issuesError?: Error | null;
  ownerContext?: KanbanOwnerContext;
}

/** The task board with the agent strip under it, as the dashboard stacks them. */
export function DashboardOverview({
  agents,
  openIssues,
  agentsLoading = false,
  issuesLoading = false,
  agentsError = null,
  issuesError = null,
  ownerContext,
}: DashboardOverviewProps) {
  return (
    <div className="space-y-6" data-testid="dashboard-overview">
      <DashboardTaskBoard agents={agents} openIssues={openIssues} ownerContext={ownerContext} loading={issuesLoading} error={issuesError} />
      <DashboardAgentStrip agents={agents} openIssues={openIssues} loading={agentsLoading} error={agentsError} />
    </div>
  );
}
