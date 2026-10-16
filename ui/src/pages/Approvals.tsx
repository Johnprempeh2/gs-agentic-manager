import { useEffect, useState } from "react";
import { useActiveCompanyPrefix, useNavigate, useLocation } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { approvalsApi } from "../api/approvals";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { Check, ClipboardList, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ApprovalCard } from "../components/ApprovalCard";
import { PageSkeleton } from "../components/PageSkeleton";
import { Badge } from "@/components/ui/badge";
import { ErrorState } from "../components/ErrorState";
import { EmptyState } from "../components/EmptyState";
import { HelpTerm } from "../components/HelpTerm";
import { pendingListText, pendingSummary } from "../lib/approval-wait";
import { useCopyAction } from "../lib/use-copy-action";
import { applyCompanyPrefix } from "../lib/company-routes";
import { approvalLabel } from "../components/ApprovalPayload";

type StatusFilter = "pending" | "all";

export function Approvals() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const pathSegment = location.pathname.split("/").pop() ?? "pending";
  const statusFilter: StatusFilter = pathSegment === "all" ? "all" : "pending";
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Approvals" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!),
    queryFn: () => approvalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.approve(id),
    onSuccess: (_approval, id) => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
      navigate(`/approvals/${id}?resolved=approved`);
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to approve");
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.reject(id),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to reject");
    },
  });

  const listCopy = useCopyAction();
  const companyPrefix = useActiveCompanyPrefix();

  const filtered = (data ?? [])
    .filter(
      (a) => statusFilter === "all" || a.status === "pending" || a.status === "revision_requested",
    )
    // Pending: the request that has waited longest comes first. All: newest first.
    .sort((a, b) =>
      statusFilter === "pending"
        ? new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        : new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  const waitingSummary = statusFilter === "pending" ? pendingSummary(data ?? []) : null;

  const pendingCount = (data ?? []).filter(
    (a) => a.status === "pending" || a.status === "revision_requested",
  ).length;

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">Select an organization first.</p>;
  }

  if (isLoading) {
    return <PageSkeleton variant="approvals" />;
  }

  if (error && !data) {
    return <ErrorState error={error} onRetry={() => void refetch()} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Tabs value={statusFilter} onValueChange={(v) => navigate(`/approvals/${v}`)}>
          <PageTabBar items={[
            { value: "pending", label: <>Pending{pendingCount > 0 && (
              <Badge variant="ghost" className={cn(
                "ml-1.5 px-1.5 text-(length:--text-nano)",
                "bg-yellow-500/20 text-yellow-500"
              )}>
                {pendingCount}
              </Badge>
            )}</> },
            { value: "all", label: "All" },
          ]} />
        </Tabs>
      </div>
      <p className="text-sm text-muted-foreground" data-testid="approvals-intro">
        Each card is a <HelpTerm term="approval">sign-off</HelpTerm> an <HelpTerm term="agent" /> needs before it can go
        ahead, such as hiring another agent or spending more.
      </p>
      {waitingSummary ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="text-sm font-medium text-foreground" data-testid="approvals-waiting-summary">
            {waitingSummary}
          </p>
          <Button
            variant="outline"
            size="sm"
            title="Copy every sign-off waiting for you, with links, ready to paste"
            onClick={() =>
              void listCopy.copy(
                pendingListText(
                  filtered.map((approval) => ({
                    ...approval,
                    label: approvalLabel(approval.type, approval.payload as Record<string, unknown> | null),
                    requester: approval.requestedByAgentId
                      ? (agents ?? []).find((agent) => agent.id === approval.requestedByAgentId)?.name ?? null
                      : null,
                  })),
                  (id) => `${window.location.origin}${applyCompanyPrefix(`/approvals/${id}`, companyPrefix)}`,
                ),
              )
            }
          >
            {listCopy.copied ? <Check className="size-3.5" /> : <ClipboardList className="size-3.5" />}
            {listCopy.copied ? "Copied" : listCopy.failed ? "Could not copy" : "Copy as a list"}
          </Button>
        </div>
      ) : null}

      {error && <ErrorState error={error} onRetry={() => void refetch()} compact />}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}

      {filtered.length === 0 && (
        <EmptyState
          icon={ShieldCheck}
          message={statusFilter === "pending" ? "No pending approvals." : "No approvals yet."}
          description="Agents ask here when a step needs your sign-off."
          action={statusFilter === "pending" ? "Show all approvals" : "Back to Decisions"}
          onAction={() => navigate(statusFilter === "pending" ? "/approvals/all" : "/decisions")}
          hideActionIcon
        />
      )}

      {filtered.length > 0 && (
        <div className="grid gap-3">
          {filtered.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              requesterAgent={approval.requestedByAgentId ? (agents ?? []).find((a) => a.id === approval.requestedByAgentId) ?? null : null}
              onApprove={() => approveMutation.mutate(approval.id)}
              onReject={() => rejectMutation.mutate(approval.id)}
              detailLink={`/approvals/${approval.id}`}
              isPending={approveMutation.isPending || rejectMutation.isPending}
              pendingAction={
                approveMutation.isPending ? "approve" : rejectMutation.isPending ? "reject" : null
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
