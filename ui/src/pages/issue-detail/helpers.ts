import { useNavigationType } from "@/lib/router";
import type { QueryClient } from "@tanstack/react-query";
import { ApiError } from "../../api/client";
import type { ActiveRunForIssue, LiveRunForIssue } from "../../api/heartbeats";
import type { CurrentBoardAccess } from "../../api/access";
import { queryKeys } from "../../lib/queryKeys";
import {
  type IssueCommentReassignment,
  type OptimisticIssueComment,
  ISSUE_COMMENT_PAGE_SIZE,
} from "../../lib/optimistic-issue-comments";
import {
  type Issue,
  type SuggestTasksInteraction,
  type RequestConfirmationInteraction,
  type RequestCheckboxConfirmationInteraction,
  type IssueComment,
  type IssueThreadInteraction,
  type WorkspaceFileRef,
  workspaceFileRefSchema,
  type FeedbackVote,
} from "@greatstone/shared";

// Stable empty array for React Query `data` defaults. A literal `= []` default
// creates a new array reference on every render while `data` is undefined
// (loading/idle), which destabilizes downstream memos and panel keys that
// depend on it. Reusing one shared reference keeps those values stable.
export const EMPTY_ISSUES: Issue[] = [];

type StopAndFinalizeRunError = Error & {
  runCancelledBeforeStatusUpdateFailed?: boolean;
};

export function createRunCancelledStatusUpdateError(
  err: unknown,
): StopAndFinalizeRunError {
  const message =
    err instanceof Error
      ? `Run was stopped, but updating the task failed: ${err.message}`
      : "Run was stopped, but updating the task failed. Retry the task status update.";
  const error = new Error(message) as StopAndFinalizeRunError;
  error.runCancelledBeforeStatusUpdateFailed = true;
  return error;
}

export function didRunCancelBeforeStatusUpdateFail(
  err: unknown,
): err is StopAndFinalizeRunError {
  return (
    err instanceof Error &&
    (err as StopAndFinalizeRunError).runCancelledBeforeStatusUpdateFailed ===
      true
  );
}

export type CommentReassignment = IssueCommentReassignment;
export type ActionableIssueThreadInteraction =
  | SuggestTasksInteraction
  | RequestConfirmationInteraction
  | RequestCheckboxConfirmationInteraction;
export type ResolveRecoveryActionOutcome =
  "restored" | "false_positive" | "blocked" | "cancelled";
export type IssueDetailComment = (IssueComment | OptimisticIssueComment) & {
  runId?: string | null;
  runAgentId?: string | null;
  interruptedRunId?: string | null;
  queueState?: "queued";
  queueTargetRunId?: string | null;
  queueReason?: "hold" | "active_run" | "other";
  consumedByRunId?: string | null;
  steeredIntoRunId?: string | null;
  conversationAnchorAt?: Date | string | null;
  conversationAnchorSequence?: number;
};

export function isPlanConfirmationInteraction(
  interaction: IssueThreadInteraction,
): interaction is RequestConfirmationInteraction {
  return (
    interaction.kind === "request_confirmation" &&
    interaction.payload.target?.type === "issue_document" &&
    interaction.payload.target.key === "plan"
  );
}

export function buildPlanDecisionResponseText(
  interaction: RequestConfirmationInteraction,
) {
  if (interaction.status === "accepted") return "Approved plan";
  const reason = interaction.result?.reason?.trim();
  return reason ? `Requested changes\n\n${reason}` : "Requested changes";
}

export const FEEDBACK_TERMS_URL =
  import.meta.env.VITE_FEEDBACK_TERMS_URL?.trim() ||
  null;
export const ISSUE_COMMENT_AUTOLOAD_LIMIT = ISSUE_COMMENT_PAGE_SIZE * 3;
export const JUMP_TO_LATEST_MAX_COMMENT_PAGES = 10;
export function treeControlPreviewErrorCopy(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403)
      return "Only board users can preview subtree controls.";
    if (error.status === 409)
      return "Preview is stale because subtree hold state changed. Retry to refresh.";
    if (error.status === 422)
      return "This subtree action is currently invalid for the selected tasks.";
  }
  return error instanceof Error ? error.message : "Unable to load preview.";
}

export function canBoardResolveRecoveryAction(
  companyId: string | null | undefined,
  boardAccess: CurrentBoardAccess | undefined,
) {
  if (!companyId || !boardAccess) return false;
  if (boardAccess.source === "local_implicit" || boardAccess.isInstanceAdmin)
    return true;
  if (!boardAccess.memberships || boardAccess.memberships.length === 0) {
    return boardAccess.companyIds.includes(companyId);
  }

  const membership = boardAccess.memberships.find(
    (item) => item.companyId === companyId && item.status === "active",
  );
  if (!membership) return false;
  return (
    membership.membershipRole !== "viewer" && membership.membershipRole !== null
  );
}

export function shouldScrollIssueDetailToTopOnNavigation(input: {
  previousIssueId: string | undefined;
  nextIssueId: string | undefined;
  navigationType: ReturnType<typeof useNavigationType>;
}): boolean {
  if (input.navigationType === "POP") return false;
  return input.previousIssueId !== input.nextIssueId;
}

export function resolveInterruptibleIssueRun(
  activeRun: ActiveRunForIssue | null | undefined,
  liveRuns: readonly LiveRunForIssue[] | undefined,
) {
  const issueLiveRun =
    (liveRuns ?? []).find((run) => run.status === "running") ??
    (liveRuns ?? []).find((run) => run.status === "queued") ??
    null;
  return (
    issueLiveRun ??
    (activeRun?.status === "running" || activeRun?.status === "queued"
      ? activeRun
      : null)
  );
}

function dedupeLiveRunsById(liveRuns: readonly LiveRunForIssue[]) {
  const seen = new Set<string>();
  return liveRuns.filter((run) => {
    if (seen.has(run.id)) return false;
    seen.add(run.id);
    return true;
  });
}

export function readIssueRunStateFromCache(
  queryClient: QueryClient,
  issueId: string,
  issue: Pick<Issue, "executionRunId"> | null | undefined,
) {
  const liveRuns = queryClient.getQueryData<LiveRunForIssue[]>(
    queryKeys.issues.liveRuns(issueId),
  );
  const activeRun = queryClient.getQueryData<ActiveRunForIssue | null>(
    queryKeys.issues.activeRun(issueId),
  );
  const activeRunIsLive = Boolean(
    activeRun && liveRuns?.some((run) => run.id === activeRun.id),
  );
  const activeRunMatchesIssueLock = Boolean(
    activeRun && issue?.executionRunId && activeRun.id === issue.executionRunId,
  );
  const resolvedActiveRun =
    activeRunIsLive || activeRunMatchesIssueLock ? activeRun : null;
  return {
    liveRuns,
    activeRun: resolvedActiveRun,
    interruptibleIssueRun: resolveInterruptibleIssueRun(
      resolvedActiveRun,
      liveRuns,
    ),
  };
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  return value as Record<string, unknown>;
}

export function extractWorkspaceFileRefFromWorkProduct(workProduct: {
  metadata: Record<string, unknown> | null;
}): WorkspaceFileRef | null {
  const metadata = asRecord(workProduct.metadata);
  if (!metadata) return null;
  const parsed = workspaceFileRefSchema.safeParse(metadata.resourceRef);
  return parsed.success ? parsed.data : null;
}

export function usageNumber(usage: Record<string, unknown> | null, ...keys: string[]) {
  if (!usage) return 0;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

export function isMarkdownFile(file: File) {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".md") ||
    name.endsWith(".markdown") ||
    file.type === "text/markdown"
  );
}

export function fileBaseName(filename: string) {
  return filename.replace(/\.[^.]+$/, "");
}

export function slugifyDocumentKey(input: string) {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "document";
}

export function titleizeFilename(input: string) {
  return input
    .split(/[-_ ]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function mergeOptimisticFeedbackVote(
  previousVotes: FeedbackVote[] | undefined,
  nextVote: {
    issueId: string;
    targetType: "issue_comment" | "issue_document_revision";
    targetId: string;
    vote: "up" | "down";
    reason?: string;
  },
  currentUserId: string | null,
): FeedbackVote[] {
  const now = new Date();
  const existingVotes = previousVotes ?? [];
  const existingIndex = existingVotes.findIndex(
    (feedbackVote) =>
      feedbackVote.targetType === nextVote.targetType &&
      feedbackVote.targetId === nextVote.targetId &&
      (!currentUserId || feedbackVote.authorUserId === currentUserId),
  );

  if (existingIndex >= 0) {
    const existingVote = existingVotes[existingIndex]!;
    const updatedVote: FeedbackVote = {
      ...existingVote,
      vote: nextVote.vote,
      reason:
        nextVote.reason !== undefined
          ? nextVote.reason.trim() || null
          : existingVote.reason,
      updatedAt: now,
    };
    const nextVotes = [...existingVotes];
    nextVotes[existingIndex] = updatedVote;
    return nextVotes;
  }

  return [
    ...existingVotes,
    {
      id: `optimistic:${nextVote.targetType}:${nextVote.targetId}`,
      companyId: "",
      issueId: nextVote.issueId,
      targetType: nextVote.targetType,
      targetId: nextVote.targetId,
      authorUserId: currentUserId ?? "current-user",
      vote: nextVote.vote,
      reason: nextVote.reason?.trim() || null,
      sharedWithLabs: false,
      sharedAt: null,
      consentVersion: null,
      redactionSummary: null,
      createdAt: now,
      updatedAt: now,
    },
  ];
}
