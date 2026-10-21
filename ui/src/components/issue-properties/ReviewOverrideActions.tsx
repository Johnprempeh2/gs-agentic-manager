import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Issue } from "@greatstone/shared";
import { accessApi, type CurrentBoardAccess } from "../../api/access";
import { queryKeys } from "../../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * Client mirror of the server's review override rule: the company owner, or a
 * person granted reviews:override. The server stays authoritative.
 */
export function canOverrideReviews(companyId: string, access: CurrentBoardAccess | undefined) {
  if (!access) return false;
  if (access.source === "local_implicit") return true;
  const membership = access.memberships?.find((item) => item.companyId === companyId && item.status === "active");
  if (!membership) return false;
  return membership.membershipRole === "owner" || Boolean(access.reviewOverrideCompanyIds?.includes(companyId));
}

type Decision = "approve" | "request_changes";

/** "Approve on their behalf" for a review that waits on someone else. */
export function ReviewOverrideActions({
  issue,
  currentUserId,
  reviewerLabel,
  onUpdate,
}: {
  issue: Pick<Issue, "companyId" | "executionState">;
  currentUserId: string | null | undefined;
  reviewerLabel: string | null;
  onUpdate: (data: Record<string, unknown>) => void;
}) {
  const [decision, setDecision] = useState<Decision | null>(null);
  const [reason, setReason] = useState("");
  const { data: access } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
  });

  const state = issue.executionState;
  const reviewer = state?.status === "pending" ? state.currentParticipant : null;
  const waitsOnSomeoneElse = Boolean(reviewer) && !(reviewer?.type === "user" && reviewer.userId === currentUserId);
  if (!waitsOnSomeoneElse || !canOverrideReviews(issue.companyId, access)) return null;

  const who = reviewerLabel ?? "the reviewer";
  const close = () => {
    setDecision(null);
    setReason("");
  };
  const submit = () => {
    const trimmed = reason.trim();
    if (!decision || !trimmed) return;
    onUpdate({
      status: decision === "approve" ? "done" : "in_progress",
      reviewOverride: true,
      overrideReason: trimmed,
    });
    close();
  };

  if (!decision) {
    return (
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => setDecision("approve")}>
          Approve on their behalf
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setDecision("request_changes")}>
          Request changes on their behalf
        </Button>
      </div>
    );
  }

  return (
    <form
      className="w-full space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className="block space-y-1 text-sm">
        <span className="text-muted-foreground">
          {decision === "approve" ? `Why are you approving for ${who}?` : `What should change? You are deciding for ${who}.`}
        </span>
        <Textarea
          autoFocus
          rows={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          aria-label="Reason"
        />
      </label>
      <p className="text-xs text-muted-foreground">{who} sees your name and reason on the task.</p>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!reason.trim()}>
          {decision === "approve" ? "Approve" : "Request changes"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={close}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
