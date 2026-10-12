import { useEffect, useMemo, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import {
  PipelineAccessLevelSelect,
  pipelineAccessChangeShort,
  pipelineAccessChangeText,
} from "@/components/PipelineAccessLevelSelect";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useIsPhone } from "@/hooks/useIsPhone";
import { usePipelineAccess } from "@/hooks/usePipelineAccess";
import { Link } from "@/lib/router";
import { timeAgo } from "@/lib/timeAgo";
import { agentUrl } from "@/lib/utils";

/**
 * Company settings → Pipelines access (GRE-1073): every agent's level on
 * every pipeline, with who changed each grant last. Board users with
 * users:manage_permissions can change levels here; the server is the gate.
 * On a phone each agent is a card with one row per pipeline, so no column
 * is cut off.
 */
export function PipelineAccessOverview() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { query, matrix, setLevel } = usePipelineAccess(selectedCompanyId);
  const isPhone = useIsPhone();
  const [agentFilter, setAgentFilter] = useState("");
  const [pipelineFilter, setPipelineFilter] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Pipelines access" }]);
  }, [setBreadcrumbs]);

  const canEdit = matrix?.canManage === true;
  const activePipelines = useMemo(
    () => (matrix?.pipelines ?? []).filter((pipeline) => !pipeline.archivedAt),
    [matrix],
  );
  const pipelines = pipelineFilter
    ? activePipelines.filter((pipeline) => pipeline.id === pipelineFilter)
    : activePipelines;
  const needle = agentFilter.trim().toLowerCase();
  const agents = (matrix?.agents ?? []).filter((agent) => !needle || agent.name.toLowerCase().includes(needle));
  const pending = setLevel.isPending ? setLevel.variables : null;

  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Pipelines access</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          What each agent may do on each pipeline. View sees it, Work cases also works its cases,
          Administer also edits the pipeline, its stages and moves. Under each level is who changed it last.
          {matrix && !canEdit ? " Only owners who manage permissions can change levels." : null}
        </p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          aria-label="Filter agents"
          placeholder="Filter agents"
          value={agentFilter}
          onChange={(event) => setAgentFilter(event.target.value)}
          className="sm:w-64"
        />
        <NativeSelect
          aria-label="Filter pipelines"
          value={pipelineFilter}
          onChange={(event) => setPipelineFilter(event.target.value)}
          className="sm:w-64"
        >
          <option value="">All pipelines</option>
          {activePipelines.map((pipeline) => (
            <option key={pipeline.id} value={pipeline.id}>{pipeline.name}</option>
          ))}
        </NativeSelect>
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading pipelines access…</p>
      ) : query.error ? (
        <p className="text-sm text-destructive">
          Could not load pipelines access. {query.error instanceof Error ? query.error.message : ""}
        </p>
      ) : activePipelines.length === 0 ? (
        <EmptyState icon={ShieldCheck} message="No pipelines yet." description="Create a pipeline first, then give agents access here." />
      ) : agents.length === 0 ? (
        <EmptyState icon={ShieldCheck} message={needle ? "No agents match this filter." : "No agents in this company yet."} />
      ) : isPhone ? (
        <ul className="space-y-3" aria-label="Agent access by pipeline">
          {agents.map((agent) => (
            <li key={agent.agentId} className="rounded-lg border border-border">
              <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
                <Link to={`${agentUrl({ id: agent.agentId, name: agent.name })}/permissions`} className="min-w-0 truncate font-medium hover:underline">
                  {agent.name}
                </Link>
                {pipelineFilter ? null : (
                  <PipelineAccessLevelSelect
                    label={`${agent.name} on all pipelines`}
                    value={agent.allPipelinesLevel}
                    mixedLabel="Per pipeline"
                    canEdit={canEdit}
                    disabled={pending?.agentId === agent.agentId}
                    onChange={(level) => setLevel.mutate({ agentId: agent.agentId, level })}
                  />
                )}
              </div>
              <ul className="divide-y divide-border">
                {pipelines.map((pipeline) => (
                  <li key={pipeline.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0 text-sm">
                      <div className="truncate">{pipeline.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {pipelineAccessChangeText(agent.lastChanges[pipeline.id] ?? null, timeAgo)}
                      </div>
                    </div>
                    <PipelineAccessLevelSelect
                      label={`${agent.name} on ${pipeline.name}`}
                      value={agent.levels[pipeline.id] ?? "view"}
                      canEdit={canEdit}
                      disabled={pending?.agentId === agent.agentId}
                      onChange={(level) => setLevel.mutate({ agentId: agent.agentId, pipelineId: pipeline.id, level })}
                    />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm" aria-label="Agent access by pipeline">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="sticky left-0 z-raised min-w-36 bg-background px-3 py-2 font-medium">Agent</th>
                {pipelineFilter ? null : <th className="px-3 py-2 font-medium">All pipelines</th>}
                {pipelines.map((pipeline) => (
                  <th key={pipeline.id} className="px-3 py-2 font-medium">
                    <Link to={`/pipelines/${pipeline.id}/settings`} className="hover:text-foreground hover:underline">
                      {pipeline.name}
                    </Link>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr key={agent.agentId} className="border-t border-border">
                  <td className="sticky left-0 z-raised bg-background px-3 py-2 align-top">
                    <Link to={`${agentUrl({ id: agent.agentId, name: agent.name })}/permissions`} className="font-medium hover:underline">
                      {agent.name}
                    </Link>
                  </td>
                  {pipelineFilter ? null : (
                    <td className="px-3 py-2 align-top">
                      <PipelineAccessLevelSelect
                        label={`${agent.name} on all pipelines`}
                        value={agent.allPipelinesLevel}
                        mixedLabel="Per pipeline"
                        canEdit={canEdit}
                        disabled={pending?.agentId === agent.agentId}
                        onChange={(level) => setLevel.mutate({ agentId: agent.agentId, level })}
                      />
                    </td>
                  )}
                  {pipelines.map((pipeline) => (
                    <td key={pipeline.id} className="px-3 py-2 align-top">
                      <PipelineAccessLevelSelect
                        label={`${agent.name} on ${pipeline.name}`}
                        value={agent.levels[pipeline.id] ?? "view"}
                        canEdit={canEdit}
                        disabled={pending?.agentId === agent.agentId}
                        onChange={(level) => setLevel.mutate({ agentId: agent.agentId, pipelineId: pipeline.id, level })}
                      />
                      <div className="mt-1 whitespace-nowrap text-xs text-muted-foreground">
                        {pipelineAccessChangeShort(agent.lastChanges[pipeline.id] ?? null, timeAgo)}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
