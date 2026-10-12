import type { ThreadMessage, ToolCallMessagePart } from "@assistant-ui/react";
import { useRef, useLayoutEffect, useMemo, type DragEvent as ReactDragEvent } from "react";
import type {
  Agent,
  IssueCommentPresentation,
  IssueCommentMetadata,
  SourceTrustMetadata,
  SuccessfulRunHandoffState,
  FeedbackVoteValue,
} from "@greatstone/shared";
import { useSecondTick } from "../../hooks/useSecondTick";
import type { PaperclipIssueRuntimeReassignment } from "../../hooks/usePaperclipIssueRuntime";
import { formatDurationWords } from "../../lib/issue-chat-messages";
import type { IssueTimelineWorkspace, IssueTimelineEvent } from "../../lib/issue-timeline-events";
import type { ComposerHandoffPreview } from "../../lib/interrupt-handoff";
import { formatAssigneeUserLabel } from "../../lib/assignees";
import type { CompanyUserProfile } from "../../lib/company-members";
import { timeAgo } from "../../lib/timeAgo";
import { isSuccessfulRunHandoffComment } from "../../lib/successful-run-handoff";
import type { SystemNoticeMetadataRow, SystemNoticeMetadataSection } from "../SystemNotice";
import { isCommandTool, displayToolName, summarizeToolInput } from "../../lib/transcriptPresentation";
import { formatShortDate } from "../../lib/utils";

export function resolveAssistantMessageFoldedState(args: {
  messageId: string;
  currentFolded: boolean;
  isFoldable: boolean;
  previousMessageId: string | null;
  previousIsFoldable: boolean;
}) {
  const {
    messageId,
    currentFolded,
    isFoldable,
    previousMessageId,
    previousIsFoldable,
  } = args;

  if (messageId !== previousMessageId) return isFoldable;
  if (!isFoldable) return false;
  if (!previousIsFoldable) return true;
  return currentFolded;
}

export function canStopIssueChatRun(args: {
  runId: string | null;
  runStatus: string | null;
  activeRunIds: ReadonlySet<string>;
}) {
  const { runId, runStatus, activeRunIds } = args;
  if (!runId) return false;
  if (activeRunIds.has(runId)) return true;
  return runStatus === "queued" || runStatus === "running";
}

export function findCoTSegmentIndex(
  messageParts: ReadonlyArray<{ type: string }>,
  cotParts: ReadonlyArray<{ type: string }>,
): number {
  if (cotParts.length === 0) return -1;
  const firstPart = cotParts[0];
  let segIdx = -1;
  let inCoT = false;
  for (const part of messageParts) {
    if (part.type === "reasoning" || part.type === "tool-call") {
      if (!inCoT) {
        segIdx++;
        inCoT = true;
      }
      if (part === firstPart) return segIdx;
    } else {
      inCoT = false;
    }
  }
  return -1;
}

export function useLiveElapsed(
  startMs: number | null | undefined,
  active: boolean,
): string | null {
  // Drive the 1s refresh from the shared page-wide ticker instead of a
  // per-instance setInterval, so a thread with many live elements uses one
  // timer rather than one per element.
  useSecondTick(Boolean(active && startMs));
  if (!active || !startMs) return null;
  return formatDurationWords(Date.now() - startMs);
}

export function readCustomString(
  custom: Record<string, unknown>,
  key: string,
): string {
  return typeof custom[key] === "string" ? custom[key].trim() : "";
}

export function toTimestampOrNull(value: string): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function useStableEvent<T extends (...args: never[]) => unknown>(
  callback: T | undefined,
): T | undefined {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  return useMemo(() => {
    if (!callback) return undefined;
    return ((...args: Parameters<T>) => callbackRef.current?.(...args)) as T;
    // Keep the wrapper stable while the callback identity changes; the ref above
    // carries the current callback implementation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(callback)]);
}

export interface CommentReassignment {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

export function shouldRenderComposerHandoffPreview(
  body: string,
  preview: ComposerHandoffPreview,
): boolean {
  return Boolean(body.trim()) && preview.kind !== "none";
}

export function fallbackAuthorLabel(message: ThreadMessage) {
  const custom = message.metadata?.custom as
    Record<string, unknown> | undefined;
  if (typeof custom?.["authorName"] === "string") return custom["authorName"];
  if (typeof custom?.["runAgentName"] === "string")
    return custom["runAgentName"];
  if (message.role === "assistant") return "Agent";
  if (message.role === "user") return "You";
  return "System";
}

export function fallbackTextParts(message: ThreadMessage) {
  const contentLines: string[] = [];
  for (const part of message.content) {
    if (part.type === "text" || part.type === "reasoning") {
      if (part.text.trim().length > 0) contentLines.push(part.text);
      continue;
    }
    if (part.type === "tool-call") {
      const lines = [`Tool: ${part.toolName}`];
      if (part.argsText?.trim()) lines.push(`Args:\n${part.argsText}`);
      if (typeof part.result === "string" && part.result.trim())
        lines.push(`Result:\n${part.result}`);
      contentLines.push(lines.join("\n\n"));
    }
  }

  const custom = message.metadata?.custom as
    Record<string, unknown> | undefined;
  if (
    contentLines.length === 0 &&
    typeof custom?.["waitingText"] === "string" &&
    custom["waitingText"].trim()
  ) {
    contentLines.push(custom["waitingText"]);
  }
  return contentLines;
}

export function hasFilePayload(evt: ReactDragEvent<HTMLDivElement>) {
  return Array.from(evt.dataTransfer?.types ?? []).includes("Files");
}

export function formatAttachmentSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function toIsoString(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.toISOString();
}

/**
 * ISO timestamp for display, or undefined when the value does not parse as a
 * real date. Comment timestamps can arrive malformed (e.g. a server
 * serialization bug turning Dates into `{}`); formatting must degrade to "no
 * timestamp" instead of throwing mid-render (PAP-16607).
 */
export function toValidIsoString(
  value: Date | string | number | undefined,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function parseReassignment(
  target: string,
): PaperclipIssueRuntimeReassignment | null {
  if (!target || target === "__none__") {
    return { assigneeAgentId: null, assigneeUserId: null };
  }
  if (target.startsWith("agent:")) {
    const assigneeAgentId = target.slice("agent:".length);
    return assigneeAgentId ? { assigneeAgentId, assigneeUserId: null } : null;
  }
  if (target.startsWith("user:")) {
    const assigneeUserId = target.slice("user:".length);
    return assigneeUserId ? { assigneeAgentId: null, assigneeUserId } : null;
  }
  return null;
}

export function shouldImplicitlyReopenComment(
  issueStatus: string | undefined,
  assigneeValue: string,
) {
  const resumesToTodo =
    issueStatus === "done" ||
    issueStatus === "cancelled" ||
    issueStatus === "blocked";
  return resumesToTodo && assigneeValue.startsWith("agent:");
}

export function isUnassignedReassignValue(value: string): boolean {
  return !value || value === "__none__";
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function commentDateLabel(date: Date | string | undefined): string {
  if (!date) return "";
  const then = new Date(date).getTime();
  if (Date.now() - then < WEEK_MS) return timeAgo(date);
  return formatShortDate(date);
}

export function humanizeValue(value: string | null) {
  if (!value) return "None";
  return value.replace(/_/g, " ");
}

export function initialsForName(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export function formatInteractionActorLabel(args: {
  agentId?: string | null;
  userId?: string | null;
  agentMap?: Map<string, Agent>;
  currentUserId?: string | null;
  userLabelMap?: ReadonlyMap<string, string> | null;
}) {
  const { agentId, userId, agentMap, currentUserId, userLabelMap } = args;
  if (agentId) return agentMap?.get(agentId)?.name ?? agentId.slice(0, 8);
  if (userId) {
    return (
      userLabelMap?.get(userId) ??
      formatAssigneeUserLabel(userId, currentUserId, userLabelMap) ??
      "Board"
    );
  }
  return "System";
}

export function resolveIssueChatHumanAuthor(args: {
  authorName?: string | null;
  authorUserId?: string | null;
  currentUserId?: string | null;
  userProfileMap?: ReadonlyMap<string, CompanyUserProfile> | null;
}) {
  const { authorName, authorUserId, currentUserId, userProfileMap } = args;
  const profile = authorUserId
    ? (userProfileMap?.get(authorUserId) ?? null)
    : null;
  const isCurrentUser = Boolean(
    authorUserId && currentUserId && authorUserId === currentUserId,
  );
  const resolvedAuthorName =
    profile?.label?.trim() ||
    authorName?.trim() ||
    (authorUserId === "local-board" ? "Board" : isCurrentUser ? "You" : "User");

  return {
    isCurrentUser,
    authorName: resolvedAuthorName,
    avatarUrl: profile?.image ?? null,
  };
}

export function toolCountSummary(toolParts: ToolCallMessagePart[]): string | null {
  if (toolParts.length === 0) return null;
  let commands = 0;
  let other = 0;
  for (const tool of toolParts) {
    if (isCommandTool(tool.toolName, tool.args)) commands++;
    else other++;
  }
  const parts: string[] = [];
  if (commands > 0)
    parts.push(`ran ${commands} command${commands === 1 ? "" : "s"}`);
  if (other > 0) parts.push(`called ${other} tool${other === 1 ? "" : "s"}`);
  return parts.join(", ");
}

export function cleanToolDisplayText(tool: ToolCallMessagePart): string {
  const name = displayToolName(tool.toolName, tool.args);
  if (isCommandTool(tool.toolName, tool.args)) return name;
  const summary =
    tool.result === undefined
      ? summarizeToolInput(tool.toolName, tool.args)
      : null;
  return summary ? `${name} ${summary}` : name;
}

export function isIssueCommentPresentation(
  value: unknown,
): value is IssueCommentPresentation {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.kind === "system_notice" || v.kind === "message";
}

export function isIssueCommentMetadata(value: unknown): value is IssueCommentMetadata {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && Array.isArray(v.sections);
}

export function isSourceTrustMetadata(value: unknown): value is SourceTrustMetadata {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.preset === "low_trust_review" &&
    (v.disposition === "quarantined" || v.disposition === "promoted")
  );
}

function issueStatusIsTerminalDisposition(issueStatus: string | undefined) {
  return issueStatus === "done" || issueStatus === "cancelled";
}

function sourceRunIdFromSuccessfulRunHandoffMetadata(
  metadata: IssueCommentMetadata | null,
) {
  if (metadata?.sourceRunId) return metadata.sourceRunId;
  const runLinks = [];
  for (const section of metadata?.sections ?? []) {
    for (const row of section.rows) {
      if (row.type === "run_link") runLinks.push(row.runId);
    }
  }
  return runLinks.length === 1 ? runLinks[0] : null;
}

export function isStaleSuccessfulRunHandoffNotice(input: {
  bodyText: string;
  issueStatus?: string;
  successfulRunHandoff?: SuccessfulRunHandoffState | null;
  runId?: string | null;
  metadata: IssueCommentMetadata | null;
}) {
  if (!isSuccessfulRunHandoffComment(input.bodyText)) return false;

  const currentHandoff = input.successfulRunHandoff ?? null;
  if (currentHandoff?.state === "resolved") return true;
  if (issueStatusIsTerminalDisposition(input.issueStatus)) return true;
  // A live continuation (running/queued run or queued wake) means an agent is
  // already handling the issue — fold the warning until the issue is actually
  // stuck again.
  if (currentHandoff?.hasLiveContinuation) return true;

  const noticeSourceRunId =
    sourceRunIdFromSuccessfulRunHandoffMetadata(input.metadata) ??
    input.runId ??
    null;
  if (
    noticeSourceRunId &&
    currentHandoff?.sourceRunId &&
    noticeSourceRunId !== currentHandoff.sourceRunId
  ) {
    return true;
  }

  return false;
}

export function metadataRowKey(row: SystemNoticeMetadataRow) {
  switch (row.kind) {
    case "issue":
      return `issue:${row.label}:${row.identifier}:${row.href ?? ""}:${row.title ?? ""}`;
    case "agent":
      return `agent:${row.label}:${row.name}:${row.href ?? ""}`;
    case "run":
      return `run:${row.label}:${row.runId}:${row.href ?? ""}:${row.status ?? ""}`;
    default:
      return `${row.kind}:${row.label}:${row.value}`;
  }
}

export function metadataSectionKey(section: SystemNoticeMetadataSection) {
  return `${section.title ?? "details"}:${section.rows.map(metadataRowKey).join("|")}`;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isTimelineWorkspace(value: unknown): value is IssueTimelineWorkspace {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const workspace = value as Record<string, unknown>;
  return (
    isNullableString(workspace.label) &&
    isNullableString(workspace.projectWorkspaceId) &&
    isNullableString(workspace.executionWorkspaceId) &&
    isNullableString(workspace.mode)
  );
}

export function isTimelineWorkspaceChange(
  value: unknown,
): value is NonNullable<IssueTimelineEvent["workspaceChange"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const change = value as Record<string, unknown>;
  return isTimelineWorkspace(change.from) && isTimelineWorkspace(change.to);
}

export function issueChatMessageCustom(
  message: ThreadMessage,
): Record<string, unknown> {
  return (message.metadata?.custom ?? {}) as Record<string, unknown>;
}

export function issueChatMessageKind(message: ThreadMessage): string {
  const custom = issueChatMessageCustom(message);
  return typeof custom.kind === "string" ? custom.kind : message.role;
}

function issueChatMessageCommentId(message: ThreadMessage): string | null {
  const custom = issueChatMessageCustom(message);
  return typeof custom.commentId === "string" ? custom.commentId : null;
}

function issueChatMessageRunId(message: ThreadMessage): string | null {
  const custom = issueChatMessageCustom(message);
  return typeof custom.runId === "string" ? custom.runId : null;
}

function issueChatMessageQueueTargetRunId(
  message: ThreadMessage,
): string | null {
  const custom = issueChatMessageCustom(message);
  return typeof custom.queueTargetRunId === "string"
    ? custom.queueTargetRunId
    : null;
}

export function issueChatMessageActiveVote(
  message: ThreadMessage,
  feedbackVoteByTargetId: ReadonlyMap<string, FeedbackVoteValue>,
): FeedbackVoteValue | null {
  const commentId = issueChatMessageCommentId(message);
  return commentId ? (feedbackVoteByTargetId.get(commentId) ?? null) : null;
}

export function issueChatMessageRunIsActive(
  message: ThreadMessage,
  activeRunIds: ReadonlySet<string>,
): boolean {
  const runId = issueChatMessageRunId(message);
  return Boolean(runId && activeRunIds.has(runId));
}

export function issueChatMessageRunIsStopping(
  message: ThreadMessage,
  stoppingRunId: string | null | undefined,
): boolean {
  const runId = issueChatMessageRunId(message);
  return Boolean(runId && stoppingRunId === runId);
}

export function issueChatMessageQueuedRunIsInterrupting(
  message: ThreadMessage,
  interruptingQueuedRunId: string | null | undefined,
): boolean {
  const queueTargetRunId = issueChatMessageQueueTargetRunId(message);
  return Boolean(
    queueTargetRunId && interruptingQueuedRunId === queueTargetRunId,
  );
}

export function issueChatMessageIsDeleted(message: ThreadMessage): boolean {
  const custom = issueChatMessageCustom(message);
  return Boolean(custom.deletedAt);
}

export function issueChatMessageDeletedAt(message: ThreadMessage): string | null {
  const custom = issueChatMessageCustom(message);
  return typeof custom.deletedAt === "string" ? custom.deletedAt : null;
}
