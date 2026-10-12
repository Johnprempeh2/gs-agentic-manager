import { useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { pipelinesApi } from "../api/pipelines";
import { projectsApi } from "../api/projects";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { projectUrl } from "../lib/utils";
import { Button } from "./ui/button";
import { NativeSelect } from "./ui/native-select";

/**
 * Projects linked to a pipeline case, with the goals that come through them
 * (GRE-1047). For a client case these are the client's projects and goals.
 */
export function PipelineCaseProjects({ caseId, companyId }: { caseId: string; companyId: string | null }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [selectedProjectId, setSelectedProjectId] = useState("");

  const links = useQuery({
    queryKey: queryKeys.pipelines.caseProjectLinks(caseId),
    queryFn: () => pipelinesApi.getCaseProjectLinks(caseId),
  });
  const projects = useQuery({
    queryKey: companyId ? queryKeys.projects.list(companyId) : ["projects", "pipeline-case-projects", "none"],
    queryFn: () => projectsApi.list(companyId!),
    enabled: Boolean(companyId),
  });

  const linkedIds = useMemo(() => new Set((links.data ?? []).map((row) => row.project.id)), [links.data]);
  const linkable = useMemo(
    () => (projects.data ?? []).filter((project) => !linkedIds.has(project.id)),
    [projects.data, linkedIds],
  );
  const goals = useMemo(() => {
    const byId = new Map<string, { id: string; title: string; status: string }>();
    for (const row of links.data ?? []) for (const goal of row.goals) byId.set(goal.id, goal);
    return [...byId.values()];
  }, [links.data]);

  const invalidate = (projectId: string) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseProjectLinks(caseId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseEvents(caseId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.projectCases(projectId) }),
    ]);

  const linkProject = useMutation({
    mutationFn: (projectId: string) => pipelinesApi.linkCaseProject(caseId, projectId),
    onSuccess: async (_link, projectId) => {
      setSelectedProjectId("");
      await invalidate(projectId);
    },
    onError: () => pushToast({ title: "Could not link the project", tone: "error" }),
  });
  const unlinkProject = useMutation({
    mutationFn: (projectId: string) => pipelinesApi.unlinkCaseProject(caseId, projectId),
    onSuccess: async (_result, projectId) => invalidate(projectId),
    onError: () => pushToast({ title: "Could not remove the project link", tone: "error" }),
  });

  if (links.isLoading) {
    return <p className="py-3 text-sm text-muted-foreground">Loading projects...</p>;
  }
  if (links.error) {
    return <p className="py-3 text-sm text-destructive">Could not load linked projects.</p>;
  }

  return (
    <div className="space-y-3 py-3">
      {(links.data ?? []).length > 0 ? (
        <ul className="divide-y divide-border">
          {(links.data ?? []).map((row) => (
            <li key={row.link.id} className="flex items-center gap-2 py-2 text-sm">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: row.project.color ?? "var(--project-seed)" }}
              />
              <Link to={projectUrl(row.project)} className="min-w-0 flex-1 truncate font-medium text-foreground hover:underline">
                {row.project.name}
              </Link>
              <span className="shrink-0 text-xs text-muted-foreground">{row.project.status.replace(/_/g, " ")}</span>
              <button
                type="button"
                className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                aria-label={`Remove link to ${row.project.name}`}
                disabled={unlinkProject.isPending}
                onClick={() => unlinkProject.mutate(row.project.id)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No linked projects.</p>
      )}

      <div>
        <h3 className="mb-1 text-xs font-medium text-muted-foreground">Goals</h3>
        {goals.length > 0 ? (
          <ul className="space-y-1">
            {goals.map((goal) => (
              <li key={goal.id} className="text-sm">
                <Link to={`/goals/${goal.id}`} className="text-foreground hover:underline">{goal.title}</Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Goals show here from the linked projects.</p>
        )}
      </div>

      {companyId ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (selectedProjectId) linkProject.mutate(selectedProjectId);
          }}
        >
          <NativeSelect
            aria-label="Project to link"
            value={selectedProjectId}
            onChange={(event) => setSelectedProjectId(event.target.value)}
            disabled={linkProject.isPending || linkable.length === 0}
            className="h-8 min-w-0 flex-1"
          >
            <option value="">{linkable.length === 0 ? "No more projects" : "Choose a project"}</option>
            {linkable.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </NativeSelect>
          <Button type="submit" size="sm" variant="outline" disabled={!selectedProjectId || linkProject.isPending}>
            {linkProject.isPending ? "Linking..." : "Link"}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
