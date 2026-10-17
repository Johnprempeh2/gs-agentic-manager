import { useQuery } from "@tanstack/react-query";
import { activityApi } from "../api/activity";
import { AGENT_STATUS_ACTIONS, agentStatusHistory } from "../lib/agent-status-history";
import { formatDateTime, relativeTime } from "../lib/utils";

/**
 * "Status history" on the agent page: when the agent was added, paused,
 * resumed or removed, and by whom, so a quiet agent can be explained at a glance.
 */
export function AgentStatusHistory({ companyId, agentId }: { companyId: string; agentId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["activity", companyId, "agent-status-history", agentId],
    queryFn: () =>
      activityApi.list(companyId, {
        entityType: "agent",
        entityId: agentId,
        action: Object.keys(AGENT_STATUS_ACTIONS),
        limit: 20,
      }),
  });
  const rows = agentStatusHistory(data ?? []);
  return (
    <section className="space-y-3" aria-labelledby="agent-status-history-heading">
      <h3 id="agent-status-history-heading" className="text-sm font-medium">Status history</h3>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading</p>
      ) : error ? (
        <p className="text-sm text-destructive">Could not load the status history.</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No pauses, resumes or changes yet.</p>
      ) : (
        <ol className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {rows.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span>
                <span className="font-medium">{row.label}</span>{" "}
                <span className="text-muted-foreground">{row.by}</span>
              </span>
              <time className="shrink-0 text-xs text-muted-foreground" dateTime={row.at.toISOString()} title={formatDateTime(row.at)}>
                {relativeTime(row.at)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
