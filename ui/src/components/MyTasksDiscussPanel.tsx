import { useEffect, useMemo, useRef, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent, Issue } from "@greatstone/shared";
import { ArrowUpRight, X } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Dialog as DialogPrimitive } from "radix-ui";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { useStandardMarkdownMentionOptions } from "../hooks/useStandardMarkdownMentionOptions";
import { SidePanelFrame } from "./side-panel";
import { IssueChatThread } from "./IssueChatThread";
import { IssueStatusBadge } from "./StatusBadge";
import { ErrorState } from "./ErrorState";

/**
 * My tasks Discuss panel (GRE-620): one task's thread and a reply box next to
 * the list. Below 900px it becomes a full-width dialog over the list.
 */

/** Newest comments the panel shows; the full task page holds the rest. */
const DISCUSS_COMMENT_LIMIT = 50;
const OVERLAY_QUERY = "(width < 56.25rem)";

function subscribeOverlay(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(OVERLAY_QUERY);
  media.addEventListener?.("change", onChange);
  return () => media.removeEventListener?.("change", onChange);
}

function overlaySnapshot() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(OVERLAY_QUERY).matches;
}

/** True below 900px, where the panel covers the list. Without matchMedia it docks. */
export function useMyTasksDiscussOverlay(): boolean {
  return useSyncExternalStore(subscribeOverlay, overlaySnapshot, () => false);
}

export function myTasksDiscussLabel(issue: Pick<Issue, "identifier" | "title">) {
  return `Discuss ${issue.identifier ? `${issue.identifier}: ${issue.title}` : issue.title}`;
}

export function MyTasksDiscussPanel({
  id,
  issue,
  agents,
  currentUserId,
  issueLinkState,
  onReply,
  onClose,
}: {
  id: string;
  issue: Issue;
  agents: Agent[] | undefined;
  currentUserId: string | null;
  issueLinkState?: unknown;
  /** Posts the reply; the page owns the mutation so the row state moves with it. */
  onReply: (body: string, clientRequestId?: string) => Promise<void>;
  onClose: () => void;
}) {
  const overlay = useMyTasksDiscussOverlay();
  const label = myTasksDiscussLabel(issue);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Focus moves in on open and on switching to another row's thread.
  useEffect(() => {
    if (overlay) return;
    closeRef.current?.focus();
  }, [issue.id, overlay]);

  const comments = useQuery({
    queryKey: queryKeys.issues.commentsList(issue.id),
    queryFn: () => issuesApi.listComments(issue.id, { order: "desc", limit: DISCUSS_COMMENT_LIMIT }),
  });
  const threadComments = useMemo(() => [...(comments.data ?? [])].reverse(), [comments.data]);
  const agentMap = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent])), [agents]);
  const mentions = useStandardMarkdownMentionOptions({ companyId: issue.companyId, agents });

  const header = (
    <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-2">
      <div className="flex min-w-0 items-center gap-2">
        {issue.identifier ? (
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{issue.identifier}</span>
        ) : null}
        <IssueStatusBadge status={issue.status} />
      </div>
      <h2 className="truncate text-sm font-semibold text-foreground" title={issue.title}>
        {issue.title}
      </h2>
    </div>
  );

  const controls = (
    <>
      <Button asChild variant="ghost" size="xs" className="text-muted-foreground hover:text-foreground">
        <Link to={createIssueDetailPath(issue.identifier ?? issue.id)} state={issueLinkState}>
          Open task
          <ArrowUpRight aria-hidden />
        </Link>
      </Button>
      <Button
        ref={closeRef}
        type="button"
        variant="ghost"
        size="icon-sm"
        data-my-tasks-discuss-close
        aria-label="Close discussion"
        title="Close discussion"
        onClick={onClose}
        className="text-muted-foreground hover:text-foreground"
      >
        <X aria-hidden />
      </Button>
    </>
  );

  let body: ReactNode;
  if (comments.isLoading) {
    body = <p className="px-1 py-6 text-center text-sm text-muted-foreground">Loading the conversation...</p>;
  } else if (comments.error && !comments.data) {
    body = <ErrorState error={comments.error} onRetry={() => void comments.refetch()} compact />;
  } else {
    body = (
      <IssueChatThread
        key={issue.id}
        comments={threadComments}
        issueId={issue.id}
        companyId={issue.companyId}
        projectId={issue.projectId}
        issueStatus={issue.status}
        issueAssigneeAgentId={issue.assigneeAgentId}
        agentMap={agentMap}
        currentUserId={currentUserId}
        mentions={mentions}
        draftKey={`paperclip:my-tasks-discuss-draft:${issue.id}`}
        onAdd={(text, _reopen, _reassignment, _attachmentIds, clientRequestId) => onReply(text, clientRequestId)}
        variant="embedded"
        showJumpToLatest={false}
        enableLiveTranscriptPolling={false}
        emptyMessage="No messages yet. Write the first one below."
      />
    );
  }

  const frame = (
    <SidePanelFrame
      label={label}
      presentation={overlay ? "sheet" : "embedded"}
      header={header}
      trailingControls={controls}
      bodyClassName="px-3 pb-3"
    >
      {body}
    </SidePanelFrame>
  );

  if (overlay) {
    // Radix gives the overlay its focus trap, Escape and return of focus.
    return (
      <DialogPrimitive.Root open onOpenChange={(open) => (open ? undefined : onClose())}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Content
            id={id}
            aria-describedby={undefined}
            data-my-tasks-discuss-panel={issue.id}
            className="fixed inset-0 z-dialog flex bg-background outline-none"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              closeRef.current?.focus();
            }}
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title>
            {frame}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    );
  }

  // Escape anywhere in the panel closes it, unless a menu inside used the key first.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    onClose();
  };

  return (
    <div
      id={id}
      data-my-tasks-discuss-panel={issue.id}
      onKeyDown={handleKeyDown}
      className="sticky top-0 flex h-(--my-tasks-discuss-height) w-(--my-tasks-discuss-width) shrink-0 self-start"
    >
      {frame}
    </div>
  );
}
