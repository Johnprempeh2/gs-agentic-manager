import type { ReactNode } from "react";
import type { Agent, Issue } from "@greatstone/shared";
import { Link } from "@/lib/router";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentIdentity } from "./AgentIdentity";
import { AgentAvatar } from "./AgentAvatar";
import { AgentStatusBadge } from "./StatusBadge";
import { IssueRow } from "./IssueRow";
import { PriorityIcon } from "./PriorityIcon";
import { TaskOwnerLabel } from "./TaskOwnerLabel";
import { StatusIcon } from "./StatusIcon";
import { agentUrl, cn } from "../lib/utils";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { SHOW_TASK_PRIORITY_UI } from "../lib/ui-flags";
import { timeAgo } from "../lib/timeAgo";
import type { LiveAgent } from "../hooks/useLiveAgents";

/** Statuses the dashboard counts as "open work happening now". */
export const DASHBOARD_OPEN_TASK_STATUSES = ["in_progress", "in_review", "blocked"] as const;
export const DASHBOARD_OPEN_TASK_LIMIT = 10;

export interface DashboardAgentRow {
  agent: Agent;
  currentTask: Issue | null;
  /** True when the agent has a running run (see `selectLiveAgents`). */
  live: boolean;
  /** The task its running run works on, even when that task is not in the open list. */
  liveIssueId: string | null;
}

/**
 * The status the row shows. Liveness comes from running runs only, so the
 * dashboard and the sidebar "N live" count agree even while `agent.status` lags.
 */
export function dashboardAgentRowStatus(row: Pick<DashboardAgentRow, "agent" | "live">): string {
  if (row.live) return "running";
  return row.agent.status === "running" ? "idle" : row.agent.status;
}

/** An agent with an error or awaiting approval stays on the dashboard even when idle. */
export function dashboardAgentNeedsAttention(row: Pick<DashboardAgentRow, "agent" | "live">): boolean {
  const status = dashboardAgentRowStatus(row);
  return status === "error" || status === "pending_approval";
}

/** Agents folded into the "N idle agents" line: no task, not running, nothing wrong. */
export function idleAgentCount(rows: Array<Pick<DashboardAgentRow, "agent" | "live" | "currentTask">>): number {
  return rows.filter((row) => !row.currentTask && !row.live && !dashboardAgentNeedsAttention(row)).length;
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
 * Pair every non-terminated agent with the task it works on now: the task of
 * its running run when it is live, else its in-progress assignment,
 * preferring one a run holds, then the newest.
 */
export function deriveDashboardAgentRows(
  agents: Agent[] | undefined,
  openIssues: Issue[] | undefined,
  liveAgents: LiveAgent[] = [],
): DashboardAgentRow[] {
  if (!agents) return [];
  const liveByAgent = new Map(liveAgents.map((live) => [live.agentId, live]));
  const issueById = new Map((openIssues ?? []).map((issue) => [issue.id, issue]));
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
      const live = liveByAgent.get(agent.id);
      const liveIssueId = live?.issueId ?? null;
      const liveTask = liveIssueId ? issueById.get(liveIssueId) ?? null : null;
      return { agent, currentTask: liveTask ?? candidates[0] ?? null, live: Boolean(live), liveIssueId };
    })
    .sort(
      (a, b) =>
        (AGENT_STATUS_ORDER[dashboardAgentRowStatus(a)] ?? 5) - (AGENT_STATUS_ORDER[dashboardAgentRowStatus(b)] ?? 5)
        || a.agent.name.localeCompare(b.agent.name),
    );
}

/** Open tasks (in progress, in review, blocked), newest activity first. */
export function selectDashboardOpenTasks(
  issues: Issue[] | undefined,
  limit = DASHBOARD_OPEN_TASK_LIMIT,
): Issue[] {
  const open = new Set<string>(DASHBOARD_OPEN_TASK_STATUSES);
  return (issues ?? [])
    .filter((issue) => open.has(issue.status))
    .sort(byNewestActivity)
    .slice(0, limit);
}

function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-2">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {action}
    </div>
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

export interface DashboardOverviewProps {
  agents: Agent[] | undefined;
  openIssues: Issue[] | undefined;
  /** From `useLiveAgents`, the same source as the sidebar "N live" count. */
  liveAgents?: LiveAgent[];
  agentsLoading?: boolean;
  issuesLoading?: boolean;
  agentsError?: Error | null;
  issuesError?: Error | null;
  /** The viewer, so task rows can say "Your task" and name other people. */
  currentUserId?: string | null;
  userLabels?: ReadonlyMap<string, string> | null;
}

export function DashboardOverview({
  agents,
  openIssues,
  liveAgents = [],
  agentsLoading = false,
  issuesLoading = false,
  agentsError = null,
  issuesError = null,
  currentUserId = null,
  userLabels = null,
}: DashboardOverviewProps) {
  const agentRows = deriveDashboardAgentRows(agents, openIssues, liveAgents);
  const liveCount = agentRows.filter((row) => row.live).length;
  const openTasks = selectDashboardOpenTasks(openIssues);
  const agentById = new Map((agents ?? []).map((agent) => [agent.id, agent]));

  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="dashboard-overview">
      <section className="min-w-0" aria-label="Agents">
        <SectionHeader
          title="Agents"
          action={(
            <span className="flex items-baseline gap-3">
              {liveCount > 0 ? (
                <span className="text-xs font-medium tabular-nums text-foreground" data-testid="dashboard-live-count">
                  {liveCount} live
                </span>
              ) : null}
              <Link to="/agents" className="-my-3.5 inline-flex min-h-11 items-center text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                View all agents
              </Link>
            </span>
          )}
        />
        {agentsLoading && !agents ? (
          <ListSkeleton label="Loading agents" />
        ) : agentsError && !agents ? (
          <MessageCard tone="error">Could not load agents: {agentsError.message}</MessageCard>
        ) : agentRows.length === 0 ? (
          <MessageCard>No agents yet.</MessageCard>
        ) : (
          <>
          {/* Phone: the whole team as a swipeable strip of faces (a lime ring
              is working now, red needs you), then only the agents on a task. */}
          <div
            className="-mx-4 mb-3 flex snap-x gap-3 overflow-x-auto px-4 pb-1 sm:hidden"
            role="list"
            aria-label="Team"
            data-testid="dashboard-agent-strip"
          >
            {agentRows.map((row) => {
              const status = dashboardAgentRowStatus(row);
              return (
                <Link
                  key={row.agent.id}
                  to={agentUrl(row.agent)}
                  role="listitem"
                  className="flex w-16 shrink-0 snap-start flex-col items-center gap-1 rounded-md text-center text-inherit no-underline active:scale-95 transition-transform duration-(--motion-press)"
                  aria-label={`${row.agent.name}, ${status}`}
                >
                  <span
                    className={cn(
                      "rounded-full p-0.5 ring-2",
                      row.live ? "ring-primary" : status === "error" ? "ring-destructive" : "ring-border",
                    )}
                  >
                    <AgentAvatar agent={row.agent} size={48} />
                  </span>
                  <span className="w-full truncate text-xs text-muted-foreground">{row.agent.name}</span>
                </Link>
              );
            })}
          </div>
          {agentRows.some((row) => row.currentTask || row.live) ? null : (
            <p className="text-sm text-muted-foreground sm:hidden">Nobody is on a task right now.</p>
          )}
          <Card
            className={cn(
              "block divide-y divide-border overflow-hidden py-0",
              !agentRows.some((row) => row.currentTask || row.live) && "max-sm:hidden",
            )}
          >
            {agentRows.map((row) => {
              const { agent, currentTask, live, liveIssueId } = row;
              return (
              <div
                key={agent.id}
                data-testid="dashboard-agent-row"
                data-live={live ? "true" : undefined}
                className={cn(
                  "flex min-w-0 flex-col gap-1.5 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-3",
                  // Idle agents with nothing to do fold into the count below:
                  // ten "No current task" rows buried what was moving.
                  !currentTask && !live && !dashboardAgentNeedsAttention(row) && "hidden",
                )}
              >
                <div className="flex min-w-0 items-center gap-2 sm:w-48 sm:shrink-0">
                  <Link
                    to={agentUrl(agent)}
                    className="min-w-0 flex-1 rounded-sm text-inherit no-underline hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <AgentIdentity agent={agent} size="sm" className="max-w-full" />
                  </Link>
                  <AgentStatusBadge status={dashboardAgentRowStatus(row)} />
                </div>
                {currentTask ? (
                  <Link
                    to={createIssueDetailPath(currentTask.identifier ?? currentTask.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-sm text-inherit no-underline hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title={currentTask.title}
                  >
                    <StatusIcon status={currentTask.status} blockerAttention={currentTask.blockerAttention} />
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {currentTask.identifier ?? currentTask.id.slice(0, 8)}
                    </span>
                    <span className="min-w-0 truncate">{currentTask.title}</span>
                  </Link>
                ) : live && liveIssueId ? (
                  <Link
                    to={createIssueDetailPath(liveIssueId)}
                    className="min-w-0 flex-1 truncate rounded-sm text-sm text-inherit no-underline hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Open current task
                  </Link>
                ) : (
                  <span className="min-w-0 flex-1 text-sm text-muted-foreground">
                    {live ? "Running without a task" : "No current task"}
                  </span>
                )}
              </div>
              );
            })}
            {idleAgentCount(agentRows) > 0 ? (
              <Link
                to="/agents"
                className="flex min-h-11 items-center px-4 py-2.5 text-sm text-muted-foreground no-underline hover:text-foreground hover:underline max-sm:hidden"
                data-testid="dashboard-idle-agents"
              >
                {idleAgentCount(agentRows)} idle {idleAgentCount(agentRows) === 1 ? "agent" : "agents"}
              </Link>
            ) : null}
          </Card>
          </>
        )}
      </section>

      <section className="min-w-0" aria-label="Open tasks">
        <SectionHeader
          title="Open tasks"
          action={(
            <Link to="/issues" className="-my-3.5 inline-flex min-h-11 items-center text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
              View all tasks
            </Link>
          )}
        />
        {issuesLoading && !openIssues ? (
          <ListSkeleton label="Loading open tasks" />
        ) : issuesError && !openIssues ? (
          <MessageCard tone="error">Could not load tasks: {issuesError.message}</MessageCard>
        ) : openTasks.length === 0 ? (
          <MessageCard>No open tasks. Nothing is in progress, in review or blocked.</MessageCard>
        ) : (
          <Card className="@container block overflow-hidden p-1">
            {openTasks.map((issue) => {
              const assignee = issue.assigneeAgentId ? agentById.get(issue.assigneeAgentId) : undefined;
              return (
                <IssueRow
                  key={issue.id}
                  issue={issue}
                  presentation="task"
                  ownerLabel={<TaskOwnerLabel issue={issue} currentUserId={currentUserId} userLabels={userLabels} />}
                  metadata={(
                    <span className="flex items-center gap-2">
                      {SHOW_TASK_PRIORITY_UI ? <PriorityIcon priority={issue.priority} /> : null}
                      {assignee ? <AgentIdentity agent={assignee} size="xs" className="max-w-32" /> : null}
                    </span>
                  )}
                  mobileTitleMeta={timeAgo(issue.lastActivityAt ?? issue.updatedAt)}
                  trailingMeta={timeAgo(issue.lastActivityAt ?? issue.updatedAt)}
                />
              );
            })}
          </Card>
        )}
      </section>
    </div>
  );
}
