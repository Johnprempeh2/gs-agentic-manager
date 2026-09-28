import type { ReactNode } from "react";
import type { Agent, Issue } from "@greatstone/shared";
import { Link } from "@/lib/router";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentIdentity } from "./AgentIdentity";
import { AgentStatusBadge } from "./StatusBadge";
import { IssueRow } from "./IssueRow";
import { PriorityIcon } from "./PriorityIcon";
import { StatusIcon } from "./StatusIcon";
import { agentUrl, cn } from "../lib/utils";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { SHOW_TASK_PRIORITY_UI } from "../lib/ui-flags";
import { timeAgo } from "../lib/timeAgo";

/** Statuses the dashboard counts as "open work happening now". */
export const DASHBOARD_OPEN_TASK_STATUSES = ["in_progress", "in_review", "blocked"] as const;
export const DASHBOARD_OPEN_TASK_LIMIT = 10;

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
  agentsLoading?: boolean;
  issuesLoading?: boolean;
  agentsError?: Error | null;
  issuesError?: Error | null;
}

export function DashboardOverview({
  agents,
  openIssues,
  agentsLoading = false,
  issuesLoading = false,
  agentsError = null,
  issuesError = null,
}: DashboardOverviewProps) {
  const agentRows = deriveDashboardAgentRows(agents, openIssues);
  const openTasks = selectDashboardOpenTasks(openIssues);
  const agentById = new Map((agents ?? []).map((agent) => [agent.id, agent]));

  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="dashboard-overview">
      <section className="min-w-0" aria-label="Agents">
        <SectionHeader
          title="Agents"
          action={(
            <Link to="/agents" className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
              View all agents
            </Link>
          )}
        />
        {agentsLoading && !agents ? (
          <ListSkeleton label="Loading agents" />
        ) : agentsError && !agents ? (
          <MessageCard tone="error">Could not load agents: {agentsError.message}</MessageCard>
        ) : agentRows.length === 0 ? (
          <MessageCard>No agents yet.</MessageCard>
        ) : (
          <Card className="block divide-y divide-border overflow-hidden py-0">
            {agentRows.map(({ agent, currentTask }) => (
              <div
                key={agent.id}
                data-testid="dashboard-agent-row"
                className="flex min-w-0 flex-col gap-1.5 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-3"
              >
                <div className="flex min-w-0 items-center gap-2 sm:w-48 sm:shrink-0">
                  <Link
                    to={agentUrl(agent)}
                    className="min-w-0 flex-1 rounded-sm text-inherit no-underline hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <AgentIdentity agent={agent} size="sm" className="max-w-full" />
                  </Link>
                  <AgentStatusBadge status={agent.status} />
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
                ) : (
                  <span className="min-w-0 flex-1 text-sm text-muted-foreground">No current task</span>
                )}
              </div>
            ))}
          </Card>
        )}
      </section>

      <section className="min-w-0" aria-label="Open tasks">
        <SectionHeader
          title="Open tasks"
          action={(
            <Link to="/issues" className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
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
