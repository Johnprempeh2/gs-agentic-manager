import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { buildCompanyUserProfileMap } from "../lib/company-members";
import type { TaskTreePeople } from "../components/task-tree/TaskTreeOwner";

/** Who can own a task in a tree: the company's agents and people, and the viewer. */
export function useTaskTreePeople(companyId: string | null | undefined): TaskTreePeople {
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId!),
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId,
  });
  const { data: members } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId!),
    queryFn: () => accessApi.listUserDirectory(companyId!),
    enabled: !!companyId,
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const viewerUserId = session?.user?.id ?? session?.session?.userId ?? null;
  return useMemo<TaskTreePeople>(
    () => ({
      agents: new Map((agents ?? []).map((agent) => [agent.id, agent])),
      users: buildCompanyUserProfileMap(members?.users),
      viewerUserId,
    }),
    [agents, members?.users, viewerUserId],
  );
}
