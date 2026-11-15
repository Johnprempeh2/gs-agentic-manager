import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Issue } from "@greatstone/shared";
import { accessApi } from "../../api/access";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { EscalateToOwnerButton } from "../EscalateToOwnerButton";
import { PropertyRow } from "./primitives";

/**
 * "Escalate to owner" on a task (Ben's access, Nov 2026). A review waiting on
 * the viewer moves to the owner; any other open task is handed to them. Not
 * shown to the owner, on chats, or on closed tasks.
 */
export function IssueEscalateRow({ issue, currentUserId }: { issue: Issue; currentUserId: string | null | undefined }) {
  const queryClient = useQueryClient();
  const { data: access } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
  });
  if (!access || access.source === "local_implicit") return null;
  const role = access.memberships?.find((m) => m.companyId === issue.companyId && m.status === "active")?.membershipRole;
  if (!role || role === "owner" || role === "viewer") return null;
  if (issue.status === "done" || issue.status === "cancelled" || issue.conversationAgentId) return null;
  const participant = issue.executionState?.status === "pending" ? issue.executionState.currentParticipant : null;
  // A review that waits on someone else is theirs to hand on.
  if (participant && !(participant.type === "user" && participant.userId === currentUserId)) return null;
  return (
    <PropertyRow label="">
    <EscalateToOwnerButton
      what={participant ? "review" : "task"}
      size="xs"
      onEscalate={(note) => issuesApi.escalate(issue.id, note)}
      onDone={() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
        void queryClient.invalidateQueries({ queryKey: ["issues"] });
      }}
    />
    </PropertyRow>
  );
}
