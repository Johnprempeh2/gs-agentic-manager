import { useMemo } from "react";
import { ShieldCheck } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { usePipelineAccess } from "@/hooks/usePipelineAccess";
import { timeAgo } from "@/lib/timeAgo";
import {
  PipelineAccessLevelSelect,
  pipelineAccessChangeText,
} from "./PipelineAccessLevelSelect";

/**
 * "Agent access" in pipeline settings (GRE-1073): every agent's level on this
 * pipeline. Board users with users:manage_permissions can change it; others
 * see the levels only.
 */
export function PipelineAgentAccessSection({
  companyId,
  pipelineId,
  pipelineName,
}: {
  companyId: string;
  pipelineId: string;
  pipelineName: string;
}) {
  const { query, matrix, setLevel } = usePipelineAccess(companyId);
  const canEdit = matrix?.canManage === true;
  const rows = useMemo(() => matrix?.agents ?? [], [matrix]);
  const pendingAgentId = setLevel.isPending ? setLevel.variables?.agentId : null;

  return (
    <section className="space-y-3 border-t border-border pt-6" data-testid="pipeline-agent-access">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Agent access</h2>
        <p className="text-sm text-muted-foreground">
          What each agent may do on this pipeline. View sees it, Work cases also works its cases,
          Administer also edits the pipeline, its stages and moves.
        </p>
        {!canEdit && matrix ? (
          <p className="text-xs text-muted-foreground">Only owners who manage permissions can change agent access.</p>
        ) : null}
      </div>
      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading agent access…</p>
      ) : query.error ? (
        <p className="text-sm text-destructive">
          Could not load agent access. {query.error instanceof Error ? query.error.message : ""}
        </p>
      ) : rows.length === 0 ? (
        <EmptyState icon={ShieldCheck} message="No agents in this company yet." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Agent</th>
                <th className="px-3 py-2 font-medium">Level</th>
                <th className="hidden px-3 py-2 font-medium sm:table-cell">Last change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((agent) => (
                <tr key={agent.agentId} className="border-t border-border">
                  <td className="px-3 py-2">
                    <div className="font-medium">{agent.name}</div>
                    <div className="text-xs text-muted-foreground sm:hidden">
                      {pipelineAccessChangeText(agent.lastChange, timeAgo)}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <PipelineAccessLevelSelect
                      label={`${agent.name} on ${pipelineName}`}
                      value={agent.levels[pipelineId] ?? "view"}
                      canEdit={canEdit}
                      disabled={pendingAgentId === agent.agentId}
                      onChange={(level) => setLevel.mutate({ agentId: agent.agentId, pipelineId, level })}
                    />
                  </td>
                  <td className="hidden px-3 py-2 text-xs text-muted-foreground sm:table-cell">
                    {pipelineAccessChangeText(agent.lastChange, timeAgo)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
