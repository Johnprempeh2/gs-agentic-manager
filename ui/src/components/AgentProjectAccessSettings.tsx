import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { Button } from "@/components/ui/button";

export function AgentProjectAccessSettings({ agentId, companyId, projects }: {
  agentId: string;
  companyId: string;
  projects: { id: string; name: string }[];
}) {
  const queryClient = useQueryClient();
  const queryKey = ["agents", agentId, "project-access"];
  const { data, isLoading, error } = useQuery({ queryKey, queryFn: () => agentsApi.getProjectAccess(agentId, companyId) });
  const [selected, setSelected] = useState("");
  const add = useMutation({
    mutationFn: (projectId: string) => agentsApi.addProjectAccess(agentId, [projectId], companyId),
    onSuccess: async () => {
      setSelected("");
      await queryClient.invalidateQueries({ queryKey });
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
  });
  const available = projects.filter((project) => !data?.projectIds.includes(project.id));

  return <section className="rounded-lg border border-border p-4 space-y-3">
    <div>
      <h3 className="text-sm font-medium">Allowed projects</h3>
      <p className="text-xs text-muted-foreground">Add a project to this agent’s review boundary. Existing limits stay in place. Saving access does not retry a task.</p>
    </div>
    {isLoading ? <p className="text-sm text-muted-foreground">Loading project access…</p> : null}
    {error ? <p role="alert" className="text-sm text-destructive">Could not load project access.</p> : null}
    {data ? <>
      <p className="text-sm">{data.projectIds.length ? projects.filter((project) => data.projectIds.includes(project.id)).map((project) => project.name).join(", ") || `${data.projectIds.length} projects` : "No projects allowed"}</p>
      {data.canManage && available.length ? <div className="flex flex-wrap items-center gap-2">
        <select className="rounded-md border border-input bg-background px-3 py-2 text-sm" aria-label="Project to allow" value={selected} onChange={(event) => setSelected(event.target.value)} disabled={add.isPending}>
          <option value="">Select project</option>
          {available.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <Button type="button" disabled={!selected || add.isPending} onClick={() => add.mutate(selected)}>Add project</Button>
      </div> : null}
      {add.error ? <p role="alert" className="text-sm text-destructive">{add.error instanceof Error ? add.error.message : "Could not save project access."}</p> : null}
    </> : null}
  </section>;
}
