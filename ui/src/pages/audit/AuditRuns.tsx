import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { HeartbeatRun, RoutineRunSummary } from "@greatstone/shared";
import { Activity, CircleDotDashed } from "lucide-react";
import { agentsApi } from "@/api/agents";
import { heartbeatsApi } from "@/api/heartbeats";
import { issuesApi } from "@/api/issues";
import { routinesApi } from "@/api/routines";
import { EmptyState } from "@/components/EmptyState";
import { StatusBadge, sentenceCaseStatus } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useSearchParams } from "@/lib/router";
import { relativeTime } from "@/lib/utils";

const ALL = "__all";
const RUN_LIMIT = 200;
/** Tasks looked up to name what each run worked on; older rows fall back to the run kind. */
const RUN_TASK_LOOKUP_LIMIT = 40;

function runIssueId(run: HeartbeatRun): string | null {
  const snapshot = run.contextSnapshot as { issueId?: unknown } | null | undefined;
  return typeof snapshot?.issueId === "string" ? snapshot.issueId : null;
}

function runSummary(run: HeartbeatRun) {
  const result = run.resultJson as { summary?: unknown; result?: unknown } | null;
  const value = result?.summary ?? result?.result ?? run.error;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function runDuration(run: HeartbeatRun) {
  const start = run.startedAt ? new Date(run.startedAt).getTime() : null;
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : null;
  if (start == null || end == null || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

const SOURCE_LABELS: Record<string, string> = {
  timer: "Scheduled",
  assignment: "Task assigned",
  on_demand: "Started by hand",
  automation: "Automation",
};

function readableSource(source: string) {
  return SOURCE_LABELS[source] ?? source.replaceAll("_", " ");
}

function routineRunTitle(run: RoutineRunSummary) {
  return run.linkedIssue?.title ?? run.trigger?.label ?? "Routine run";
}

function RoutineScopedRuns({
  runs,
  isLoading,
  error,
  onRetry,
}: {
  runs: RoutineRunSummary[];
  isLoading: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  if (isLoading) {
    return (
      <div className="border-y border-border py-14 text-center text-sm text-muted-foreground">
        Loading routine runs…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 border-y border-border py-14 text-center">
        <p className="text-sm text-muted-foreground">{error.message}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>
      </div>
    );
  }

  if (runs.length === 0) {
    return <EmptyState icon={Activity} message="No routine runs yet." />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Routine runs</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Executions created by this routine, newest first.
        </p>
      </div>
      <ul className="divide-y divide-border border-y border-border" aria-label="Routine runs">
        {runs.map((run) => {
          const content = (
            <>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{routineRunTitle(run)}</span>
                  <StatusBadge status={run.status} />
                </div>
                <p className="mt-1 truncate text-sm text-muted-foreground">
                  {run.trigger?.label ?? readableSource(run.source)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground sm:justify-end">
                <span className="capitalize">{readableSource(run.source)}</span>
                <time dateTime={new Date(run.triggeredAt).toISOString()}>
                  {relativeTime(run.triggeredAt)}
                </time>
              </div>
            </>
          );
          const rowClassName = "flex flex-col gap-2 px-1 py-3 text-inherit no-underline transition-colors hover:bg-muted/50 sm:flex-row sm:items-start sm:justify-between sm:px-3";
          return (
            <li key={run.id}>
              {run.linkedIssue ? (
                <Link to={`/issues/${run.linkedIssue.identifier ?? run.linkedIssue.id}`} className={rowClassName}>
                  {content}
                </Link>
              ) : (
                <div className={rowClassName}>{content}</div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">Showing the {RUN_LIMIT} most recent routine runs.</p>
    </div>
  );
}

export function AuditRuns({ companyId, routineId }: { companyId: string; routineId?: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const agentId = searchParams.get("agentId") ?? ALL;
  const status = searchParams.get("runStatus") ?? ALL;
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !routineId,
  });
  const runs = useQuery({
    queryKey: queryKeys.audit.runs(companyId, agentId === ALL ? null : agentId),
    queryFn: () =>
      heartbeatsApi.list(companyId, agentId === ALL ? undefined : agentId, RUN_LIMIT, {
        summary: true,
      }),
    refetchInterval: 15_000,
    enabled: !routineId,
  });
  const routineRuns = useQuery({
    queryKey: [...queryKeys.routines.runs(routineId ?? ""), "audit"],
    queryFn: () => routinesApi.listRuns(routineId!, RUN_LIMIT),
    enabled: Boolean(routineId),
    refetchInterval: 15_000,
  });
  const agentById = useMemo(
    () => new Map((agents.data ?? []).map((agent) => [agent.id, agent])),
    [agents.data],
  );
  const statuses = useMemo(
    () => Array.from(new Set((runs.data ?? []).map((run) => run.status))).sort(),
    [runs.data],
  );
  const visibleRuns = useMemo(
    () => (runs.data ?? []).filter((run) => status === ALL || run.status === status),
    [runs.data, status],
  );

  const runIssueIds = useMemo(() => {
    const ids: string[] = [];
    for (const run of visibleRuns) {
      const issueId = runIssueId(run);
      if (issueId && !ids.includes(issueId)) ids.push(issueId);
      if (ids.length >= RUN_TASK_LOOKUP_LIMIT) break;
    }
    return ids;
  }, [visibleRuns]);
  const runIssueQueries = useQueries({
    queries: runIssueIds.map((issueId) => ({
      queryKey: queryKeys.issues.detail(issueId),
      queryFn: () => issuesApi.get(issueId),
      staleTime: 60_000,
    })),
  });
  const issueById = new Map(
    runIssueQueries.flatMap((query) => (query.data ? [[query.data.id, query.data] as const] : [])),
  );

  const updateFilter = (key: "agentId" | "runStatus", value: string) => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === ALL) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );
  };

  const clearFilters = () => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("agentId");
        next.delete("runStatus");
        return next;
      },
      { replace: true },
    );
  };

  if (routineId) {
    return (
      <RoutineScopedRuns
        runs={routineRuns.data ?? []}
        isLoading={routineRuns.isLoading}
        error={routineRuns.error instanceof Error ? routineRuns.error : null}
        onRetry={() => void routineRuns.refetch()}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Runs</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Recent work by your agents across the organisation. Open a run to see what the agent
          did, what it produced and which task it was for.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 border-y border-border py-3">
        <label className="grid gap-1 text-(length:--text-micro) font-medium text-muted-foreground">
          <span>Agent</span>
          <Select value={agentId} onValueChange={(value) => updateFilter("agentId", value)}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="All agents" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All agents</SelectItem>
              {(agents.data ?? []).map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="grid gap-1 text-(length:--text-micro) font-medium text-muted-foreground">
          <span>Status</span>
          <Select value={status} onValueChange={(value) => updateFilter("runStatus", value)}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All statuses</SelectItem>
              {statuses.map((value) => (
                <SelectItem key={value} value={value}>
                  {sentenceCaseStatus(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        {agentId !== ALL || status !== ALL ? (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        ) : null}
      </div>

      {runs.isLoading ? (
        <div className="border-y border-border py-14 text-center text-sm text-muted-foreground">
          Loading runs…
        </div>
      ) : runs.error ? (
        <div className="flex flex-col items-center gap-3 border-y border-border py-14 text-center">
          <p className="text-sm text-muted-foreground">
            {runs.error instanceof Error ? runs.error.message : "Failed to load runs."}
          </p>
          <Button variant="outline" size="sm" onClick={() => runs.refetch()}>
            Try again
          </Button>
        </div>
      ) : visibleRuns.length === 0 ? (
        <EmptyState
          icon={agentId !== ALL || status !== ALL ? CircleDotDashed : Activity}
          message={agentId !== ALL || status !== ALL ? "No runs match these filters." : "No runs yet."}
        />
      ) : (
        <ul className="divide-y divide-border border-y border-border" aria-label="Recent runs">
          {visibleRuns.map((run) => {
            const agent = agentById.get(run.agentId);
            const summary = runSummary(run);
            const duration = runDuration(run);
            const issueId = runIssueId(run);
            const issue = issueId ? issueById.get(issueId) : undefined;
            return (
              <li key={run.id}>
                <Link
                  to={`/agents/${run.agentId}/runs/${run.id}`}
                  className="flex flex-col gap-2 px-1 py-3 text-inherit no-underline transition-colors hover:bg-muted/50 sm:flex-row sm:items-start sm:justify-between sm:px-3"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">
                        {agent?.name ?? "Unknown agent"}
                      </span>
                      <StatusBadge status={run.status} />
                    </div>
                    {issue ? (
                      <p className="mt-1 truncate text-sm text-foreground" title={`Run ${run.id.slice(0, 8)}`}>
                        Worked on {issue.identifier ? `${issue.identifier} ` : ""}{issue.title}
                      </p>
                    ) : null}
                    {summary || !issue ? (
                      <p className="mt-1 truncate text-sm text-muted-foreground" title={issue ? undefined : `Run ${run.id.slice(0, 8)}`}>
                        {summary ?? `${readableSource(run.invocationSource)} run`}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground sm:justify-end">
                    <span className="capitalize">{readableSource(run.invocationSource)}</span>
                    {duration ? <span>{duration}</span> : null}
                    <time dateTime={new Date(run.createdAt).toISOString()}>
                      {relativeTime(run.createdAt)}
                    </time>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">Showing the {RUN_LIMIT} most recent runs.</p>
    </div>
  );
}
