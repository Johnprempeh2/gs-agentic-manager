import { useEffect, useMemo, useState } from "react";
import { membershipStatusLabel } from "@/lib/membership-labels";
import { ErrorState } from "@/components/ErrorState";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  HUMAN_COMPANY_MEMBERSHIP_ROLE_LABELS,
  hidesCompanyPage,
} from "@greatstone/shared";
import { KeyRound, Shield, ShieldCheck, UserMinus, UserPlus } from "lucide-react";
import { accessApi, type CompanyMember } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { ApiError } from "@/api/client";
import { cloudApi } from "@/api/cloud";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { Link, Navigate, useSearchParams } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { cloudStackInviteUrl } from "@/lib/cloudLinks";
import { usePluginSlots } from "@/plugins/slots";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { PageTabBar } from "@/components/PageTabBar";
import { useHiddenSettings } from "@/hooks/useHiddenSettings";
import { useCloudInstance } from "@/hooks/useCloudInstance";
import { InvitesSection } from "@/components/access/InvitesSection";
import { MemberHandoverDialog } from "@/components/access/MemberHandoverDialog";
import { formatDateTime } from "@/lib/utils";

const LEGACY_BOARD_USER_ID = "local-board";
type EditableMemberStatus = "pending" | "active" | "suspended";

export function CompanyAccess() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const cloud = useCloudInstance();
  const cloudStacksQuery = useQuery({
    queryKey: queryKeys.cloud.stacks,
    queryFn: () => cloudApi.listStacks(),
    enabled: Boolean(cloud && selectedCompanyId),
    staleTime: 30_000,
    retry: false,
  });
  const currentStack = cloudStacksQuery.data?.stacks.find((stack) => stack.isCurrent);
  // Company roles can differ from Cloud roles. Only the current stack's
  // owner/admin may invite, even if another portfolio entry grants ownership.
  const cloudInviteUrl = cloud && !cloudStacksQuery.isError &&
    (currentStack?.role === "owner" || currentStack?.role === "admin")
    ? cloudStackInviteUrl(cloud.cloudBaseUrl, currentStack.stackSlug)
    : null;
  // Invites render as a tab of this page; `company.invites` hides just that
  // tab while `company.members` (the route gate) hides the whole page.
  const { hidden: hiddenSettings } = useHiddenSettings();
  const hideInvitesTab = hidesCompanyPage(hiddenSettings, "company.invites");
  const requestedTab = searchParams.get("tab") === "invites" ? "invites" : "members";
  const activeTab = hideInvitesTab ? "members" : requestedTab;
  const handleTabChange = (value: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === "invites") {
          next.set("tab", "invites");
        } else {
          next.delete("tab");
        }
        return next;
      },
      { replace: true },
    );
  };
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  // Kept as a snapshot: once handed over, the person leaves the list but the
  // dialog still shows the result.
  const [handingOverMember, setHandingOverMember] = useState<CompanyMember | null>(null);
  const [resettingTwoStepMember, setResettingTwoStepMember] = useState<CompanyMember | null>(null);
  const [draftRole, setDraftRole] = useState<CompanyMember["membershipRole"]>(null);
  const [draftStatus, setDraftStatus] = useState<EditableMemberStatus>("active");
  const [draftReviewOverride, setDraftReviewOverride] = useState(false);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Members" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const membersQuery = useQuery({
    queryKey: queryKeys.access.companyMembers(selectedCompanyId ?? ""),
    queryFn: () => accessApi.listMembers(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Removed people are listed separately so the main list (and its cache,
  // shared with other pages) keeps its current shape.
  const archivedMembersQuery = useQuery({
    queryKey: ["access", "company-members-archived", selectedCompanyId ?? ""],
    queryFn: () => accessApi.listMembers(selectedCompanyId!, { includeArchived: true }),
    enabled: !!selectedCompanyId,
  });

  const joinRequestsQuery = useQuery({
    queryKey: queryKeys.access.joinRequests(selectedCompanyId ?? "", "pending_approval"),
    queryFn: () => accessApi.listJoinRequests(selectedCompanyId!, "pending_approval"),
    enabled: !!selectedCompanyId && !!membersQuery.data?.access.canApproveJoinRequests,
  });

  const refreshAccessData = async () => {
    if (!selectedCompanyId) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.access.companyMembers(selectedCompanyId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(selectedCompanyId, "pending_approval") });
    await queryClient.invalidateQueries({ queryKey: ["access", "company-members-archived", selectedCompanyId] });
  };

  const updateMemberMutation = useMutation({
    mutationFn: async (input: {
      memberId: string;
      membershipRole: CompanyMember["membershipRole"];
      status: EditableMemberStatus;
      /** Set only when the review override grant changes. */
      grants?: CompanyMember["grants"];
    }) => {
      const updated = await accessApi.updateMember(selectedCompanyId!, input.memberId, {
        membershipRole: input.membershipRole,
        status: input.status,
      });
      if (!input.grants) return updated;
      return accessApi.updateMemberPermissions(selectedCompanyId!, input.memberId, {
        grants: input.grants.map((grant) => ({ permissionKey: grant.permissionKey, scope: grant.scope })),
      });
    },
    onSuccess: async () => {
      setEditingMemberId(null);
      await refreshAccessData();
      pushToast({
        title: "Member updated",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Your change to this person was not saved",
        body: error instanceof Error ? error.message : "Something went wrong. Try again.",
        tone: "error",
      });
    },
  });

  const approveJoinRequestMutation = useMutation({
    mutationFn: (requestId: string) => accessApi.approveJoinRequest(selectedCompanyId!, requestId),
    onSuccess: async () => {
      await refreshAccessData();
      pushToast({
        title: "Join request approved",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Could not let them in",
        body: error instanceof Error ? error.message : "Something went wrong. Try again.",
        tone: "error",
      });
    },
  });

  const rejectJoinRequestMutation = useMutation({
    mutationFn: (requestId: string) => accessApi.rejectJoinRequest(selectedCompanyId!, requestId),
    onSuccess: async () => {
      await refreshAccessData();
      pushToast({
        title: "Join request rejected",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Could not turn down the request",
        body: error instanceof Error ? error.message : "Something went wrong. Try again.",
        tone: "error",
      });
    },
  });

  const editingMember = useMemo(
    () => membersQuery.data?.members.find((member) => member.id === editingMemberId) ?? null,
    [editingMemberId, membersQuery.data?.members],
  );

  const restoreMemberMutation = useMutation({
    mutationFn: (memberId: string) => accessApi.restoreMember(selectedCompanyId!, memberId),
    onSuccess: async () => {
      await refreshAccessData();
      pushToast({ title: "Access restored", body: "Moved work stays where it is.", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Could not restore access",
        body: error instanceof Error ? error.message : "Something went wrong. Try again.",
        tone: "error",
      });
    },
  });

  const resetTwoStepMutation = useMutation({
    mutationFn: (memberId: string) => accessApi.resetMemberTwoStep(selectedCompanyId!, memberId),
    onSuccess: async () => {
      setResettingTwoStepMember(null);
      await refreshAccessData();
      pushToast({
        title: "Two-step sign-in reset",
        body: "They are signed out. They sign in with their password and set it up again.",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Could not reset two-step sign-in",
        body: error instanceof Error ? error.message : "Unknown error",
        tone: "error",
      });
    },
  });

  useEffect(() => {
    if (!editingMember) return;
    setDraftRole(editingMember.membershipRole);
    setDraftStatus(isEditableMemberStatus(editingMember.status) ? editingMember.status : "suspended");
    setDraftReviewOverride(memberHasReviewOverrideGrant(editingMember));
  }, [editingMember]);

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">Choose an organisation to manage access.</div>;
  }

  if (membersQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading organisation access…</div>;
  }

  if (membersQuery.error) {
    const message =
      membersQuery.error instanceof ApiError && membersQuery.error.status === 403
        ? "You do not have permission to manage organisation members."
        : null;
    if (!message) {
      return (
        <ErrorState
          error={membersQuery.error}
          title="Team members did not load"
          onRetry={() => void membersQuery.refetch()}
          retrying={membersQuery.isFetching}
        />
      );
    }
    return <div className="text-sm text-destructive">{message}</div>;
  }

  const members = membersQuery.data?.members ?? [];
  const access = membersQuery.data?.access;
  const pendingHumanJoinRequests =
    joinRequestsQuery.data?.filter((request) => request.requestType === "human") ?? [];
  const joinRequestActionPending =
    approveJoinRequestMutation.isPending || rejectJoinRequestMutation.isPending;
  const archivedMembers = (archivedMembersQuery.data?.members ?? []).filter((member) => member.status === "archived");
  const primaryOwner = [...members]
    .filter((member) => member.status === "active" && member.membershipRole === "owner" && member.principalId !== LEGACY_BOARD_USER_ID)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  const currentUserPrincipalId = access?.currentUserId ?? null;
  const defaultSuccessorUserId = handingOverMember?.principalId === LEGACY_BOARD_USER_ID
    ? primaryOwner?.principalId ?? null
    : currentUserPrincipalId;

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Organisation members</h1>
        </div>
        {cloudInviteUrl && (
          <Button asChild>
            <a href={cloudInviteUrl}><UserPlus />Invite people</a>
          </Button>
        )}
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="flex flex-col gap-4">
        {!hideInvitesTab && (
          <PageTabBar
            items={[
              { value: "members", label: "Members" },
              { value: "invites", label: "Invites" },
            ]}
            align="start"
            value={activeTab}
            onValueChange={handleTabChange}
          />
        )}
        <TabsContent value="members" className="space-y-8">

      {access && !access.currentUserRole && (
        <div className="rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          This account can manage access here through instance-admin privileges, but it does not currently hold an active organisation membership.
        </div>
      )}

      <section className="space-y-4">
        {access?.canApproveJoinRequests && pendingHumanJoinRequests.length > 0 ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">Pending human joins</h3>
                <p className="text-sm text-muted-foreground">
                  Review pending join requests before they become active organisation members.
                </p>
              </div>
              <Badge variant="outline">{pendingHumanJoinRequests.length} pending</Badge>
            </div>
            <div className="space-y-3">
              {pendingHumanJoinRequests.map((request) => (
                <PendingJoinRequestCard
                  key={request.id}
                  title={
                    request.requesterUser?.name ||
                    request.requestEmailSnapshot ||
                    request.requestingUserId ||
                    "Unknown human requester"
                  }
                  subtitle={
                    request.requesterUser?.email ||
                    request.requestEmailSnapshot ||
                    request.requestingUserId ||
                    "No email available"
                  }
                  context={
                    request.invite
                      ? `${request.invite.allowedJoinTypes} join invite${request.invite.humanRole ? ` • default role ${request.invite.humanRole}` : ""}`
                      : "Invite metadata unavailable"
                  }
                  detail={`Submitted ${formatDateTime(request.createdAt)}`}
                  approveLabel="Approve human"
                  rejectLabel="Reject human"
                  disabled={joinRequestActionPending}
                  onApprove={() => approveJoinRequestMutation.mutate(request.id)}
                  onReject={() => rejectJoinRequestMutation.mutate(request.id)}
                />
              ))}
            </div>
          </div>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full min-w-(--sz-44rem) text-left text-sm">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Email</th>
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {members.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-muted-foreground">
                    No user memberships found for this organisation yet.
                  </td>
                </tr>
              ) : members.map((member) => {
                const handover = member.handover ?? null;
                const displayName = memberDisplayName(member);
                return (
                  <tr key={member.id} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-3">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Avatar size="sm">
                          {member.user?.image ? <AvatarImage src={member.user.image} alt={displayName} /> : null}
                          <AvatarFallback>{memberInitials(member)}</AvatarFallback>
                        </Avatar>
                        <span className="truncate font-medium">{displayName}</span>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {member.user?.email || member.principalId}
                    </td>
                    <td className="px-3 py-3">
                      {member.membershipRole
                        ? HUMAN_COMPANY_MEMBERSHIP_ROLE_LABELS[member.membershipRole]
                        : "Unset"}
                    </td>
                    <td className="px-3 py-3">
                      <Badge variant={member.status === "active" ? "secondary" : member.status === "suspended" ? "destructive" : "outline"}>
                        {membershipStatusLabel(member.status)}
                      </Badge>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="flex justify-end gap-2">
                        {handover?.canRestore ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => restoreMemberMutation.mutate(member.id)}
                            disabled={restoreMemberMutation.isPending}
                          >
                            Restore
                          </Button>
                        ) : null}
                        <Button size="sm" variant="outline" onClick={() => setEditingMemberId(member.id)}>
                          Edit
                        </Button>
                        {member.twoStep?.canReset ? (
                          <Button size="sm" variant="outline" onClick={() => setResettingTwoStepMember(member)}>
                            <KeyRound className="mr-1 h-3.5 w-3.5" />
                            Reset two-step
                          </Button>
                        ) : null}
                        {member.status === "active" || member.status === "pending" ? (
                          <span
                            className="inline-flex"
                            title={handover && !handover.canHandOver ? handover.handOverReason ?? undefined : undefined}
                          >
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setHandingOverMember(member)}
                              disabled={!handover?.canHandOver}
                              title={handover && !handover.canHandOver ? handover.handOverReason ?? undefined : undefined}
                            >
                              <UserMinus className="mr-1 h-3.5 w-3.5" />
                              Hand over and remove
                            </Button>
                          </span>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {archivedMembers.length > 0 ? (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Removed people</h3>
            <div className="rounded-lg border border-border">
              {archivedMembers.map((member) => (
                <div key={member.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{memberDisplayName(member)}</div>
                    <div className="truncate text-muted-foreground">{member.user?.email || member.principalId}</div>
                  </div>
                  {member.handover?.canRestore ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => restoreMemberMutation.mutate(member.id)}
                      disabled={restoreMemberMutation.isPending}
                    >
                      Restore
                    </Button>
                  ) : (
                    <span className="text-muted-foreground" title={member.handover?.restoreReason ?? undefined}>Archived</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <Dialog open={!!editingMember} onOpenChange={(open) => !open && setEditingMemberId(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit member</DialogTitle>
            <DialogDescription>
              Change the role and access for {editingMember?.user?.name || editingMember?.user?.email || editingMember?.principalId}.
            </DialogDescription>
          </DialogHeader>
          {editingMember && (
            <div className="space-y-5">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2 text-sm">
                  <span className="font-medium">Role</span>
                  <select
                    className="w-full rounded-md border border-border bg-background px-3 py-2"
                    value={draftRole ?? ""}
                    onChange={(event) =>
                      setDraftRole((event.target.value || null) as CompanyMember["membershipRole"])
                    }
                  >
                    <option value="">Unset</option>
                    {Object.entries(HUMAN_COMPANY_MEMBERSHIP_ROLE_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-2 text-sm">
                  <span className="font-medium">Membership status</span>
                  <select
                    className="w-full rounded-md border border-border bg-background px-3 py-2"
                    value={draftStatus}
                    onChange={(event) =>
                      setDraftStatus(event.target.value as EditableMemberStatus)
                    }
                  >
                    <option value="active">Active</option>
                    <option value="pending">Pending</option>
                    <option value="suspended">Suspended</option>
                  </select>
                </label>
              </div>
              {access?.canManageMembers ? (
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox
                    checked={draftRole === "owner" || draftReviewOverride}
                    disabled={draftRole === "owner"}
                    onCheckedChange={(checked) => setDraftReviewOverride(checked === true)}
                    aria-label={REVIEW_OVERRIDE_LABEL}
                  />
                  <span className="space-y-0.5">
                    <span className="block font-medium">{REVIEW_OVERRIDE_LABEL}</span>
                    <span className="block text-muted-foreground">
                      {draftRole === "owner"
                        ? "Owners always have this."
                        : "They can approve or send back a task that waits on another reviewer. They must give a reason, and the reviewer sees it."}
                    </span>
                  </span>
                </label>
              ) : null}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingMemberId(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!editingMember) return;
                const reviewOverrideChanged = draftReviewOverride !== memberHasReviewOverrideGrant(editingMember);
                updateMemberMutation.mutate({
                  memberId: editingMember.id,
                  membershipRole: draftRole,
                  status: draftStatus,
                  grants: reviewOverrideChanged
                    ? withReviewOverrideGrant(editingMember.grants, draftReviewOverride)
                    : undefined,
                });
              }}
              disabled={updateMemberMutation.isPending}
            >
              {updateMemberMutation.isPending ? "Saving…" : "Save member"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!resettingTwoStepMember} onOpenChange={(open) => !open && setResettingTwoStepMember(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset two-step sign-in?</DialogTitle>
            <DialogDescription>
              For when {resettingTwoStepMember ? memberDisplayName(resettingTwoStepMember) : "this person"} has lost
              their phone and their backup codes. They are signed out everywhere and can then sign in with their
              password alone, so check it is really them asking. If two-step sign-in is required, they set it up again
              straight away.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResettingTwoStepMember(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => resettingTwoStepMember && resetTwoStepMutation.mutate(resettingTwoStepMember.id)}
              disabled={resetTwoStepMutation.isPending}
            >
              {resetTwoStepMutation.isPending ? "Resetting…" : "Reset two-step sign-in"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <MemberHandoverDialog
        companyId={selectedCompanyId}
        member={handingOverMember}
        members={members}
        agents={agentsQuery.data ?? []}
        defaultSuccessorUserId={defaultSuccessorUserId}
        canRemoveInstanceAdmin={access?.currentUserRole === "owner"}
        open={!!handingOverMember}
        onOpenChange={(open) => !open && setHandingOverMember(null)}
      />
        </TabsContent>
        {!hideInvitesTab && (
          <TabsContent value="invites">
            <InvitesSection />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

export function CompanyAccessLegacyRoute() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { slots, isLoading, errorMessage } = usePluginSlots({
    slotTypes: ["companySettingsPage"],
    companyId: selectedCompanyId,
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Access" },
    ]);
  }, [setBreadcrumbs]);

  const permissionsSlot = slots.find((slot) => slot.routePath === "permissions");
  if (permissionsSlot) {
    return <Navigate to="/company/settings/permissions" replace />;
  }

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Checking for advanced permission extensions...</div>;
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Advanced Permissions</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Advanced access, scoped assignment, and explicit grant controls are provided by installed organisation settings extensions.
        </p>
      </div>

      <div className="space-y-4 rounded-xl border border-border px-5 py-5">
        <div className="space-y-2">
          <h2 className="text-sm font-semibold">Advanced permissions unavailable</h2>
          <p className="text-sm text-muted-foreground">
            Core GS Agentic Manager keeps enforcing organisation boundaries and any existing restrictive policy data, but editing advanced permissions requires an installed extension.
          </p>
          {errorMessage ? (
            <p className="text-sm text-destructive">Plugin extensions unavailable: {errorMessage}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link to="/company/settings/members">Open Members</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/company/settings/members?tab=invites">Open Invites</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

const REVIEW_OVERRIDE_LABEL = "Approve or send back reviews on someone else's behalf";

function memberHasReviewOverrideGrant(member: CompanyMember) {
  return member.grants.some((grant) => grant.permissionKey === "reviews:override");
}

/** The member's grants with reviews:override added or removed; the route replaces the whole set. */
export function withReviewOverrideGrant(grants: CompanyMember["grants"], enabled: boolean): CompanyMember["grants"] {
  const others = grants.filter((grant) => grant.permissionKey !== "reviews:override");
  if (!enabled) return others;
  return [...others, { permissionKey: "reviews:override", scope: null } as CompanyMember["grants"][number]];
}

function memberDisplayName(member: CompanyMember | null) {
  if (!member) return "this member";
  return member.user?.name?.trim() || member.user?.email || member.principalId;
}

function memberInitials(member: CompanyMember) {
  const value = memberDisplayName(member).trim();
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    return `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}`.toUpperCase();
  }
  return value.slice(0, 2).toUpperCase();
}

function isEditableMemberStatus(status: CompanyMember["status"]): status is EditableMemberStatus {
  return status === "pending" || status === "active" || status === "suspended";
}

function PendingJoinRequestCard({
  title,
  subtitle,
  context,
  detail,
  detailSecondary,
  approveLabel,
  rejectLabel,
  disabled,
  onApprove,
  onReject,
}: {
  title: string;
  subtitle: string;
  context: string;
  detail: string;
  detailSecondary?: string;
  approveLabel: string;
  rejectLabel: string;
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <div>
            <div className="font-medium">{title}</div>
            <div className="text-sm text-muted-foreground">{subtitle}</div>
          </div>
          <div className="text-sm text-muted-foreground">{context}</div>
          <div className="text-sm text-muted-foreground">{detail}</div>
          {detailSecondary ? <div className="text-sm text-muted-foreground">{detailSecondary}</div> : null}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onReject} disabled={disabled}>
            {rejectLabel}
          </Button>
          <Button type="button" onClick={onApprove} disabled={disabled}>
            {approveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
