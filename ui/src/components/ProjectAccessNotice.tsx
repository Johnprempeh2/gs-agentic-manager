import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { activityApi } from "../api/activity";
import { agentsApi } from "../api/agents";
import { Button } from "./ui/button";
import { Link } from "../lib/router";
import { queryKeys } from "../lib/queryKeys";

export function ProjectAccessNotice({ companyId, issueId, projectId, assigneeAgentId, onRetried }: {
  companyId: string;
  issueId: string;
  projectId: string | null;
  assigneeAgentId: string | null;
  onRetried: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: runs } = useQuery({ queryKey: queryKeys.issues.runs(issueId), queryFn: () => activityApi.runsForIssue(issueId) });
  const latest = runs?.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const denied = latest?.status === "failed" && latest.errorCode === "low_trust_boundary_mismatch" &&
    latest.agentId === assigneeAgentId && Boolean(projectId);
  const { data: access } = useQuery({
    queryKey: ["agents", assigneeAgentId, "project-access"],
    queryFn: () => agentsApi.getProjectAccess(assigneeAgentId!, companyId),
    enabled: denied,
  });
  const ready = Boolean(projectId && access?.projectIds.includes(projectId));
  const retry = useMutation({
    mutationFn: () => agentsApi.retryFailedRun(latest!.agentId, latest!.runId, companyId),
    onSuccess: () => {
      onRetried();
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(issueId) });
    },
  });
  if (!denied) return null;
  return <div role="status" className="mx-(--sz-execution-blocker-inline) my-(--sz-execution-blocker-block) flex flex-wrap items-center justify-between gap-2 execution-blocker-notice border border-border bg-muted text-foreground">
    <span>{ready ? "Project access is saved. Retry the task to continue." : access && !access.canManage
      ? "This agent cannot access this task's project. An agent manager must add it."
      : "This agent cannot access this task's project."}</span>
    {ready ? <Button variant="outline" size="sm" disabled={retry.isPending} onClick={() => retry.mutate()}>{retry.isPending ? "Retrying…" : "Retry task"}</Button>
      : access?.canManage ? <Button variant="outline" size="sm" asChild><Link to={`/agents/${assigneeAgentId}/permissions`}>Manage project access</Link></Button> : null}
    {retry.isError ? <p role="alert" className="w-full text-destructive">{retry.error.message}</p> : null}
  </div>;
}
