import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Project } from "@greatstone/shared";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";

export const quickCreateProjectLabel = (name: string) => (name ? `Create project "${name}"` : "New project");

/**
 * Create a project by name only (no workspace) from a task's project picker.
 * The new project is written into every cached project list so the picker can
 * show it at once, then the lists and sidebar refetch.
 */
export function useQuickCreateProject(companyId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useCallback(async (name: string): Promise<Project> => {
    if (!companyId) throw new Error("Select a company first.");
    const project = await projectsApi.create(companyId, { name: name.trim(), status: "planned" });
    queryClient.setQueriesData<unknown>({ queryKey: queryKeys.projects.all(companyId) }, (current: unknown) =>
      Array.isArray(current) && !current.some((item: Project) => item.id === project.id) ? [...current, project] : current,
    );
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects.all(companyId) });
    return project;
  }, [companyId, queryClient]);
}
