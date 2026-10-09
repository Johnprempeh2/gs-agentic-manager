import { usePipelineAccess } from "@/hooks/usePipelineAccess";
import { timeAgo } from "@/lib/timeAgo";
import {
  PIPELINE_ACCESS_LEVEL_HINTS,
  PipelineAccessLevelSelect,
  pipelineAccessChangeText,
} from "./PipelineAccessLevelSelect";

/**
 * "Pipelines" on the agent page (GRE-1073): one level for all pipelines, or a
 * level per pipeline. Uses the same API and data as the pipeline view and
 * the overview.
 */
export function AgentPipelinesAccessSection({
  companyId,
  agentId,
  agentName,
}: {
  companyId: string;
  agentId: string;
  agentName: string;
}) {
  const { query, matrix, setLevel } = usePipelineAccess(companyId);
  const canEdit = matrix?.canManage === true;
  const row = matrix?.agents.find((agent) => agent.agentId === agentId) ?? null;
  const pipelines = (matrix?.pipelines ?? []).filter((pipeline) => !pipeline.archivedAt);
  const busy = setLevel.isPending;
  const allLevel = row?.allPipelinesLevel ?? null;

  return (
    <div data-testid="agent-pipelines-access">
      <h3 className="mb-1 text-sm font-medium">Pipelines</h3>
      <p className="mb-3 text-xs text-muted-foreground">
        What this agent may do on client pipelines.
        {!canEdit && matrix ? " Only owners who manage permissions can change it." : null}
      </p>
      <div className="space-y-4 rounded-lg border border-border p-4 text-sm">
        {query.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading pipeline access…</p>
        ) : query.error ? (
          <p className="text-xs text-destructive">
            Could not load pipeline access. {query.error instanceof Error ? query.error.message : ""}
          </p>
        ) : !row ? (
          <p className="text-xs text-muted-foreground">This agent has no pipeline access record.</p>
        ) : (
          <>
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div>
                <div>All pipelines</div>
                <div className="text-xs text-muted-foreground">
                  {allLevel ? PIPELINE_ACCESS_LEVEL_HINTS[allLevel] : "Levels differ by pipeline. Pick one to set them all."}
                </div>
              </div>
              <PipelineAccessLevelSelect
                label={`${agentName} on all pipelines`}
                value={allLevel}
                mixedLabel="Per pipeline"
                canEdit={canEdit}
                disabled={busy}
                onChange={(level) => setLevel.mutate({ agentId, level })}
              />
            </div>

            {pipelines.length === 0 ? (
              <p className="text-xs text-muted-foreground">No pipelines yet.</p>
            ) : (
              <ul className="divide-y divide-border border-t border-border" aria-label="Level per pipeline">
                {pipelines.map((pipeline) => (
                  <li key={pipeline.id} className="flex items-center justify-between gap-4 py-2">
                    <span className="min-w-0 truncate">{pipeline.name}</span>
                    <PipelineAccessLevelSelect
                      label={`${agentName} on ${pipeline.name}`}
                      value={row.levels[pipeline.id] ?? "view"}
                      canEdit={canEdit}
                      disabled={busy}
                      onChange={(level) => setLevel.mutate({ agentId, pipelineId: pipeline.id, level })}
                    />
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">{pipelineAccessChangeText(row.lastChange, timeAgo)}</p>
          </>
        )}
      </div>
    </div>
  );
}
