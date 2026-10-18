import { useEffect, useState } from "react";
import { ErrorState } from "@/components/ErrorState";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus2 } from "lucide-react";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";

const JOIN_REQUEST_STATUS_LABELS: Record<string, string> = {
  pending_approval: "Waiting for you",
  approved: "Approved",
  rejected: "Declined",
};

const INVITE_JOIN_TYPE_LABELS: Record<string, string> = {
  human: "people",
  agent: "agents",
  both: "people and agents",
};

export function JoinRequestQueue() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"pending_approval" | "approved" | "rejected">("pending_approval");
  const [requestType, setRequestType] = useState<"all" | "human" | "agent">("all");

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Organisation", href: "/dashboard" },
      { label: "Inbox", href: "/inbox" },
      { label: "Join Requests" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const requestsQuery = useQuery({
    queryKey: queryKeys.access.joinRequests(selectedCompanyId ?? "", `${status}:${requestType}`),
    queryFn: () =>
      accessApi.listJoinRequests(
        selectedCompanyId!,
        status,
        requestType === "all" ? undefined : requestType,
      ),
    enabled: !!selectedCompanyId,
  });

  const approveMutation = useMutation({
    mutationFn: (requestId: string) => accessApi.approveJoinRequest(selectedCompanyId!, requestId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(selectedCompanyId!, `${status}:${requestType}`) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.companyMembers(selectedCompanyId!) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!) });
      pushToast({ title: "Join request approved", tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: "Join request not approved", body: err instanceof Error ? err.message : "Please try again.", tone: "error" });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (requestId: string) => accessApi.rejectJoinRequest(selectedCompanyId!, requestId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(selectedCompanyId!, `${status}:${requestType}`) });
      pushToast({ title: "Join request declined", tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: "Join request not declined", body: err instanceof Error ? err.message : "Please try again.", tone: "error" });
    },
  });

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">Choose an organisation to review join requests.</div>;
  }

  if (requestsQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading join requests…</div>;
  }

  if (requestsQuery.error) {
    const message =
      requestsQuery.error instanceof ApiError && requestsQuery.error.status === 403
        ? "You do not have permission to review join requests for this organisation."
        : null;
    if (!message) {
      return (
        <ErrorState
          error={requestsQuery.error}
          title="Join requests did not load"
          onRetry={() => void requestsQuery.refetch()}
          retrying={requestsQuery.isFetching}
        />
      );
    }
    return <div className="text-sm text-destructive">{message}</div>;
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <UserPlus2 className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">People and agents asking to join</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Approve or decline everyone who has asked to join this organisation. These are the same requests that appear in your inbox.
        </p>
      </div>

      <Card className="flex-row flex-wrap gap-3 p-4">
        <label className="space-y-2 text-sm">
          <span className="font-medium">Status</span>
          <select
            className="rounded-md border border-border bg-background px-3 py-2"
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as "pending_approval" | "approved" | "rejected")
            }
          >
            <option value="pending_approval">Waiting for you</option>
            <option value="approved">Approved</option>
            <option value="rejected">Declined</option>
          </select>
        </label>
        <label className="space-y-2 text-sm">
          <span className="font-medium">Who is asking</span>
          <select
            className="rounded-md border border-border bg-background px-3 py-2"
            value={requestType}
            onChange={(event) =>
              setRequestType(event.target.value as "all" | "human" | "agent")
            }
          >
            <option value="all">All</option>
            <option value="human">People</option>
            <option value="agent">Agents</option>
          </select>
        </label>
      </Card>

      <div className="space-y-4">
        {(requestsQuery.data ?? []).length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-8 text-sm text-muted-foreground">
            No requests match these filters.
          </div>
        ) : (
          requestsQuery.data!.map((request) => (
            <Card key={request.id} className="block p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={request.status === "pending_approval" ? "secondary" : request.status === "approved" ? "outline" : "destructive"}>
                      {JOIN_REQUEST_STATUS_LABELS[request.status] ?? request.status.replaceAll("_", " ")}
                    </Badge>
                    <Badge variant="outline">{request.requestType === "human" ? "Person" : "Agent"}</Badge>
                  </div>
                  <div>
                    <div className="text-base font-medium">
                      {request.requestType === "human"
                        ? request.requesterUser?.name || request.requestEmailSnapshot || "Unknown person"
                        : request.agentName || "Unknown agent requester"}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {request.requestType === "human"
                        ? request.requesterUser?.email || request.requestEmailSnapshot
                        : request.capabilities}
                    </div>
                  </div>
                </div>

                {request.status === "pending_approval" ? (
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      onClick={() => rejectMutation.mutate(request.id)}
                      disabled={rejectMutation.isPending}
                    >
                      Decline
                    </Button>
                    <Button
                      onClick={() => approveMutation.mutate(request.id)}
                      disabled={approveMutation.isPending}
                    >
                      Approve
                    </Button>
                  </div>
                ) : null}
              </div>

              <div className="mt-4 grid gap-3 text-sm text-muted-foreground md:grid-cols-2">
                <div className="rounded-lg border border-border bg-background px-3 py-2">
                  <div className="text-xs font-medium uppercase tracking-wide">About the invite</div>
                  <div className="mt-2">
                    {request.invite
                      ? `Invite for ${INVITE_JOIN_TYPE_LABELS[request.invite.allowedJoinTypes] ?? request.invite.allowedJoinTypes}${request.invite.humanRole ? ` • joins as ${request.invite.humanRole}` : ""}`
                      : "No invite details"}
                  </div>
                  {request.invite?.inviteMessage ? (
                    <div className="mt-2 text-foreground">{request.invite.inviteMessage}</div>
                  ) : null}
                </div>
                <div className="rounded-lg border border-border bg-background px-3 py-2">
                  <div className="text-xs font-medium uppercase tracking-wide">When and where</div>
                  <div className="mt-2">Submitted {new Date(request.createdAt).toLocaleString()}</div>
                  <div>Sent from {request.requestIp}</div>
                  {request.requestType === "agent" && request.capabilities ? <div>{request.capabilities}</div> : null}
                </div>
              </div>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
