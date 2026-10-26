import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { agentsApi } from "../api/agents";

export function AgentProjectAccessSettings({ agentId, companyId, projects }: {
  agentId: string;
  companyId: string;
  projects: { id: string; name: string }[];
}) {
  const queryClient = useQueryClient();
  const queryKey = ["agents", agentId, "project-access"];
  const [selected, setSelected] = useState("");
  const { data, isPending, error } = useQuery({
    queryKey,
    queryFn: () => agentsApi.projectAccess(agentId, companyId),
  });
  const save = useMutation({
    mutationFn: (projectId: string) => agentsApi.addProjectAccess(agentId, [projectId], companyId),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, result);
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      setSelected("");
    },
  });
  const available = projects.filter(project => !data?.projectIds.includes(project.id));

  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <h3 className="text-sm font-medium">Allowed projects</h3>
      <p className="text-xs text-muted-foreground">Add a project to this agent's review boundary. Existing access and restrictions stay in place. The task needs a separate retry.</p>
      {isPending ? <p className="text-sm text-muted-foreground">Loading project access…</p> : null}
      {error ? <p role="alert" className="text-sm text-destructive">Could not load project access: {error.message}</p> : null}
      {data ? <p className="text-sm">{data.projectIds.length} allowed project{data.projectIds.length === 1 ? "" : "s"}</p> : null}
      {data?.canManage && available.length > 0 ? (
        <div className="flex items-end gap-3">
          <label className="flex-1 text-sm">
            <span className="block mb-1">Project to add</span>
            <select className="w-full rounded-md border border-border bg-transparent px-3 py-2" value={selected} onChange={event => setSelected(event.target.value)} disabled={save.isPending}>
              <option value="">Select a project</option>
              {available.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <Button type="button" disabled={!selected || save.isPending} onClick={() => save.mutate(selected)}>
            {save.isPending ? "Saving…" : "Add project"}
          </Button>
        </div>
      ) : null}
      {data && !data.canManage ? <p className="text-sm text-muted-foreground">Project access is read only for this account or agent state.</p> : null}
      {save.error ? <p role="alert" className="text-sm text-destructive">Could not save project access: {save.error.message}</p> : null}
    </div>
  );
}
