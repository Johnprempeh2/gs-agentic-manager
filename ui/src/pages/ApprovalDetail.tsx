import { AgentIdentity } from "@/components/AgentIdentity";
import { useConfirm } from "@/context/ConfirmContext";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { approvalsApi } from "../api/approvals";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { waitingLabel } from "../lib/approval-wait";
import { formatDateTime } from "../lib/utils";
import { StatusBadge } from "../components/StatusBadge";
import { Identity } from "../components/Identity";
import { approvalLabel, typeIcon, defaultTypeIcon, ApprovalPayloadRenderer } from "../components/ApprovalPayload";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CheckCircle2, ChevronRight, Sparkles } from "lucide-react";
import type { ApprovalComment } from "@greatstone/shared";
import { MarkdownBody } from "../components/MarkdownBody";
import { ApprovalNoteDialog, type ApprovalNoteRequest } from "../components/ApprovalNoteDialog";

export function ApprovalDetail() {
  const { approvalId } = useParams<{ approvalId: string }>();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const confirmAction = useConfirm();
  const [commentBody, setCommentBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showRawPayload, setShowRawPayload] = useState(false);
  const [noteAction, setNoteAction] = useState<"reject" | "revision" | null>(null);

  const { data: approval, isLoading } = useQuery({
    queryKey: queryKeys.approvals.detail(approvalId!),
    queryFn: () => approvalsApi.get(approvalId!),
    enabled: !!approvalId,
  });
  const resolvedCompanyId = approval?.companyId ?? selectedCompanyId;

  const { data: comments } = useQuery({
    queryKey: queryKeys.approvals.comments(approvalId!),
    queryFn: () => approvalsApi.listComments(approvalId!),
    enabled: !!approvalId,
  });

  const { data: linkedIssues } = useQuery({
    queryKey: queryKeys.approvals.issues(approvalId!),
    queryFn: () => approvalsApi.listIssues(approvalId!),
    enabled: !!approvalId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(resolvedCompanyId ?? ""),
    queryFn: () => agentsApi.list(resolvedCompanyId ?? ""),
    enabled: !!resolvedCompanyId,
  });

  useEffect(() => {
    if (!approval?.companyId || approval.companyId === selectedCompanyId) return;
    setSelectedCompanyId(approval.companyId, { source: "route_sync" });
  }, [approval?.companyId, selectedCompanyId, setSelectedCompanyId]);

  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents ?? []) map.set(agent.id, agent.name);
    return map;
  }, [agents]);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Approvals", href: "/approvals" },
      { label: approval ? approvalLabel(approval.type, approval.payload as Record<string, unknown> | null) : "Approval" },
    ]);
  }, [setBreadcrumbs, approval, approvalId]);

  const refresh = () => {
    if (!approvalId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.detail(approvalId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.comments(approvalId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.issues(approvalId) });
    if (approval?.companyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(approval.companyId) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.approvals.list(approval.companyId, "pending"),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(approval.companyId) });
    }
  };

  const approveMutation = useMutation({
    mutationFn: () => approvalsApi.approve(approvalId!),
    onSuccess: () => {
      setError(null);
      refresh();
      navigate(`/approvals/${approvalId}?resolved=approved`, { replace: true });
    },
    onError: (err) => setError(`We could not approve this. Please try again. (${err instanceof Error ? err.message : "no details"})`),
  });

  const rejectMutation = useMutation({
    mutationFn: (note?: string) => approvalsApi.reject(approvalId!, note),
    onSuccess: () => {
      setError(null);
      setNoteAction(null);
      refresh();
    },
    onError: (err) => {
      setNoteAction(null);
      setError(`We could not reject this. Please try again. (${err instanceof Error ? err.message : "no details"})`);
    },
  });

  const revisionMutation = useMutation({
    mutationFn: (note?: string) => approvalsApi.requestRevision(approvalId!, note),
    onSuccess: () => {
      setError(null);
      setNoteAction(null);
      refresh();
    },
    onError: (err) => {
      setNoteAction(null);
      setError(`We could not ask for changes. Please try again. (${err instanceof Error ? err.message : "no details"})`);
    },
  });

  const resubmitMutation = useMutation({
    mutationFn: () => approvalsApi.resubmit(approvalId!),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(`We could not send this back for another look. Please try again. (${err instanceof Error ? err.message : "no details"})`),
  });

  const addCommentMutation = useMutation({
    mutationFn: () => approvalsApi.addComment(approvalId!, commentBody.trim()),
    onSuccess: () => {
      setCommentBody("");
      setError(null);
      refresh();
    },
    onError: (err) => setError(`We could not post your comment. Please try again. (${err instanceof Error ? err.message : "no details"})`),
  });

  const deleteAgentMutation = useMutation({
    mutationFn: (agentId: string) => agentsApi.remove(agentId),
    onSuccess: () => {
      setError(null);
      refresh();
      navigate("/approvals");
    },
    onError: (err) => setError(`We could not delete this agent. Please try again. (${err instanceof Error ? err.message : "no details"})`),
  });

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (!approval) return (
      <p className="text-sm text-muted-foreground">
        This request could not be found. It may have been withdrawn.{" "}
        <Link to="/approvals" className="underline underline-offset-2">Back to approvals</Link>
      </p>
    );

  const payload = approval.payload as Record<string, unknown>;
  const linkedAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
  const isActionable = approval.status === "pending" || approval.status === "revision_requested";
  const isBudgetApproval = approval.type === "budget_override_required";
  // GRE-601: a missing-permission request is only granted or denied.
  const isPermissionGrant = approval.type === "permission_grant";
  const TypeIcon = typeIcon[approval.type] ?? defaultTypeIcon;
  const requesterName = approval.requestedByAgentId ? agentNameById.get(approval.requestedByAgentId) ?? null : null;
  const noteRequest: ApprovalNoteRequest | null =
    noteAction === "reject"
      ? {
          title: isPermissionGrant ? "Deny this permission?" : "Reject this request?",
          description: "The agent is told no and will not go ahead.",
          label: "Tell the agent why (optional)",
          placeholder: "For example: not this month, or try a cheaper option",
          confirmLabel: isPermissionGrant ? "Deny" : "Reject",
          destructive: true,
        }
      : noteAction === "revision"
        ? {
            title: "Ask for changes",
            description: "The agent gets your note, makes the changes and asks you again.",
            label: "What should change?",
            placeholder: "For example: lower the budget to 200 a month",
            confirmLabel: "Send to the agent",
            required: true,
          }
        : null;
  const showApprovedBanner = searchParams.get("resolved") === "approved" && approval.status === "approved";
  const primaryLinkedIssue = linkedIssues?.[0] ?? null;
  const resolvedCta =
    primaryLinkedIssue
      ? {
          label:
            (linkedIssues?.length ?? 0) > 1
              ? "Review linked tasks"
              : "Review linked task",
          to: `/issues/${primaryLinkedIssue.identifier ?? primaryLinkedIssue.id}`,
        }
      : linkedAgentId
        ? {
            label: "Open hired agent",
            to: `/agents/${linkedAgentId}`,
          }
        : {
            label: "Back to approvals",
            to: "/approvals",
          };

  return (
    <div className="space-y-6 max-w-3xl">
      {showApprovedBanner && (
        <div className="border border-green-300 dark:border-green-700/40 bg-green-50 dark:bg-green-900/20 rounded-lg px-4 py-3 animate-in fade-in zoom-in-95 duration-300">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <div className="relative mt-0.5">
                <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-300" />
                <Sparkles className="h-3 w-3 text-green-500 dark:text-green-200 absolute -right-2 -top-1 animate-pulse" />
              </div>
              <div>
                <p className="text-sm text-green-800 dark:text-green-100 font-medium">Approved</p>
                <p className="text-xs text-green-700 dark:text-green-200/90">
                  {requesterName ? `${requesterName} has been told and will carry on.` : "The agent has been told and will carry on."}
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="border-green-400 dark:border-green-600/50 text-green-800 dark:text-green-100 hover:bg-green-100 dark:hover:bg-green-900/30"
              onClick={() => navigate(resolvedCta.to)}
            >
              {resolvedCta.label}
            </Button>
          </div>
        </div>
      )}
      <div className="border border-border rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TypeIcon className="h-5 w-5 text-muted-foreground shrink-0" />
            <div>
              <h2 className="text-lg font-semibold">{approvalLabel(approval.type, approval.payload as Record<string, unknown> | null)}</h2>
              <p className="text-xs text-muted-foreground" title={`Reference ${approval.id}`} data-testid="approval-asked">
                Asked {formatDateTime(approval.createdAt)}
                {waitingLabel(approval) ? ` · ${waitingLabel(approval)}` : ""}
              </p>
            </div>
          </div>
          <StatusBadge status={approval.status} />
        </div>
        <div className="text-sm space-y-1">
          {approval.requestedByAgentId && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">Requested by</span>
              <AgentIdentity
                agent={agents?.find((agent) => agent.id === approval.requestedByAgentId) ?? { id: approval.requestedByAgentId, name: "Agent" }}
                size="sm"
              />
            </div>
          )}
          <ApprovalPayloadRenderer type={approval.type} payload={payload} />
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mt-2"
            onClick={() => setShowRawPayload((v) => !v)}
          >
            <ChevronRight className={`h-3 w-3 transition-transform ${showRawPayload ? "rotate-90" : ""}`} />
            See full request
          </button>
          {showRawPayload && (
            <pre className="text-xs bg-muted/40 rounded-md p-3 overflow-x-auto">
              {JSON.stringify(payload, null, 2)}
            </pre>
          )}
          {approval.decisionNote && (
            <p className="text-xs text-muted-foreground">Decision note: {approval.decisionNote}</p>
          )}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {linkedIssues && linkedIssues.length > 0 && (
          <div className="pt-2 border-t border-border/60">
            <p className="text-xs text-muted-foreground mb-1.5">Linked tasks</p>
            <div className="space-y-1.5">
              {linkedIssues.map((issue) => (
                <Link
                  key={issue.id}
                  to={`/issues/${issue.identifier ?? issue.id}`}
                  className="block text-xs rounded border border-border/70 px-2 py-1.5 hover:bg-accent/20"
                >
                  {issue.identifier ? (
                    <span className="font-mono text-muted-foreground mr-2">{issue.identifier}</span>
                  ) : null}
                  <span>{issue.title}</span>
                </Link>
              ))}
            </div>
            <p className="text-(length:--text-micro) text-muted-foreground mt-2">
              Linked tasks remain open until the requesting agent follows up and closes them.
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {isActionable && !isBudgetApproval && (
            <>
              <Button
                size="sm"
                className="bg-green-700 hover:bg-green-600 text-white"
                onClick={() => approveMutation.mutate()}
                disabled={approveMutation.isPending}
              >
                {isPermissionGrant ? "Grant" : "Approve"}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setNoteAction("reject")}
                disabled={rejectMutation.isPending}
              >
                {isPermissionGrant ? "Deny" : "Reject"}
              </Button>
            </>
          )}
          {isBudgetApproval && approval.status === "pending" && (
            <p className="text-sm text-muted-foreground">
              Resolve this budget stop from the budget controls on <Link to="/costs" className="underline underline-offset-2">Costs</Link>.
            </p>
          )}
          {approval.status === "pending" && !isPermissionGrant && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setNoteAction("revision")}
              disabled={revisionMutation.isPending}
            >
              Ask for changes
            </Button>
          )}
          {approval.status === "revision_requested" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => resubmitMutation.mutate()}
              disabled={resubmitMutation.isPending}
            >
              Changes made, review again
            </Button>
          )}
          {approval.status === "rejected" && approval.type === "hire_agent" && linkedAgentId && (
            <Button
              size="sm"
              variant="outline"
              className="text-destructive border-destructive/40"
              onClick={async () => {
                if (!(await confirmAction({ title: "Delete this disapproved agent?", description: "This cannot be undone.", confirmLabel: "Delete agent", tone: "destructive" }))) return;
                deleteAgentMutation.mutate(linkedAgentId);
              }}
              disabled={deleteAgentMutation.isPending}
            >
              Delete disapproved agent
            </Button>
          )}
        </div>
      </div>

      <div className="border border-border rounded-lg p-4 space-y-3">
        <h3 className="text-sm font-medium">Comments ({comments?.length ?? 0})</h3>
        <div className="space-y-2">
          {(comments ?? []).map((comment: ApprovalComment) => (
            <div key={comment.id} className="border border-border/60 rounded-md p-3">
              <div className="flex items-center justify-between mb-1">
                {comment.authorAgentId ? (
                  <Link to={`/agents/${comment.authorAgentId}`} className="hover:underline">
                    <AgentIdentity
                      agent={agents?.find((agent) => agent.id === comment.authorAgentId) ?? { id: comment.authorAgentId, name: "Agent" }}
                      size="sm"
                    />
                  </Link>
                ) : (
                  <Identity name="Board" size="sm" />
                )}
                <span className="text-xs text-muted-foreground">
                  {formatDateTime(comment.createdAt)}
                </span>
              </div>
              <MarkdownBody className="text-sm">{comment.body}</MarkdownBody>
            </div>
          ))}
        </div>
        <Textarea
          value={commentBody}
          onChange={(e) => setCommentBody(e.target.value)}
          placeholder="Add a comment..."
          rows={3}
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={() => addCommentMutation.mutate()}
            disabled={!commentBody.trim() || addCommentMutation.isPending}
          >
            {addCommentMutation.isPending ? "Posting…" : "Post comment"}
          </Button>
        </div>
      </div>
      <ApprovalNoteDialog
        request={noteRequest}
        pending={rejectMutation.isPending || revisionMutation.isPending}
        onCancel={() => setNoteAction(null)}
        onSubmit={(note) => {
          if (noteAction === "reject") rejectMutation.mutate(note);
          else if (noteAction === "revision") revisionMutation.mutate(note);
        }}
      />
    </div>
  );
}
