import { useDispositionRecoverySnapshot, DispositionRecoveryNotice } from "../DispositionRecoveryNotice";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useEmailComment } from "../EmailMessageCard";
import type { ThreadMessage } from "@assistant-ui/react";
import { useContext, useState, useId, type ReactNode } from "react";
import { Link } from "@/lib/router";
import type { IssueCommentMetadata } from "@greatstone/shared";
import { useOptionalToastActions } from "../../context/ToastContext";
import { copyTextToClipboard } from "../../lib/clipboard";
import {
  type RequestConfirmationInteraction,
  buildIssueThreadInteractionSummary,
  isIssueThreadInteraction,
} from "../../lib/issue-thread-interactions";
import { type IssueTimelineAssignee, formatTimelineWorkspaceLabel } from "../../lib/issue-timeline-events";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { MarkdownBody } from "../MarkdownBody";
import { IssueThreadInteractionCard } from "../IssueThreadInteractionCard";
import {
  type HandoffChipResolvers,
  AssigneeChip,
  HandoffWakeRow,
  RunStatusBadge,
} from "../interrupt-handoff/InterruptHandoffViews";
import { formatAssigneeUserLabel } from "../../lib/assignees";
import { timeAgo } from "../../lib/timeAgo";
import {
  type SystemNoticeMetadataRow,
  type SystemNoticeMetadataSection,
  type SystemNoticeTone,
  type SystemNoticeProps,
  SystemNotice,
} from "../SystemNotice";
import {
  mapCommentMetadataToSystemNoticeSections,
  buildSystemNoticeProps,
  systemNoticeLabelForTone,
} from "../../lib/system-notice-comment";
import { cn, formatDateTime } from "../../lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ChevronDown, Check, PaperclipIcon, Copy, ClipboardList, ArrowRight } from "lucide-react";
import { IssueChatCtx } from "./IssueChatContext";
import {
  formatInteractionActorLabel,
  initialsForName,
  metadataSectionKey,
  metadataRowKey,
  commentDateLabel,
  isIssueCommentPresentation,
  isIssueCommentMetadata,
  isStaleSuccessfulRunHandoffNotice,
  toValidIsoString,
  isTimelineWorkspaceChange,
  humanizeValue,
} from "./helpers";

function ExpiredRequestConfirmationActivity({
  message,
  anchorId,
  interaction,
}: {
  message: ThreadMessage;
  anchorId?: string;
  interaction: RequestConfirmationInteraction;
}) {
  const {
    agentMap,
    currentUserId,
    userLabelMap,
    onAcceptInteraction,
    onRejectInteraction,
    onCancelInteraction,
    onUploadImage,
    externalReferences,
  } = useContext(IssueChatCtx);
  const [expanded, setExpanded] = useState(false);
  const hasResolvedActor = Boolean(
    interaction.resolvedByAgentId || interaction.resolvedByUserId,
  );
  const actorAgentId = hasResolvedActor
    ? (interaction.resolvedByAgentId ?? null)
    : (interaction.createdByAgentId ?? null);
  const actorUserId = hasResolvedActor
    ? (interaction.resolvedByUserId ?? null)
    : (interaction.createdByUserId ?? null);
  const actorName = formatInteractionActorLabel({
    agentId: actorAgentId,
    userId: actorUserId,
    agentMap,
    currentUserId,
    userLabelMap,
  });
  const actorIcon = actorAgentId
    ? agentMap?.get(actorAgentId)?.icon
    : undefined;
  const isCurrentUser = Boolean(
    actorUserId && currentUserId && actorUserId === currentUserId,
  );
  const detailsId = anchorId
    ? `${anchorId}-details`
    : `${interaction.id}-details`;
  const summary = buildIssueThreadInteractionSummary(interaction);

  const rowContent = (
    <div className="min-w-0 flex-1">
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs",
          isCurrentUser && "justify-end",
        )}
      >
        <span className="font-medium text-foreground">{actorName}</span>
        <span className="text-muted-foreground">updated this task</span>
        <a
          href={anchorId ? `#${anchorId}` : undefined}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
        >
          {timeAgo(message.createdAt)}
        </a>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-background/70 px-1.5 py-0.5 text-(length:--text-micro) font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((current) => !current)}
        >
          <ChevronDown
            className={cn(
              "h-3 w-3 transition-transform",
              expanded && "rotate-180",
            )}
          />
          {expanded ? "Hide confirmation" : "Expired confirmation"}
        </button>
      </div>
      {expanded ? (
        <p
          className={cn(
            "mt-1 text-xs text-muted-foreground",
            isCurrentUser && "text-right",
          )}
        >
          {summary}
        </p>
      ) : null}
    </div>
  );

  return (
    <div id={anchorId}>
      {isCurrentUser ? (
        <div className="flex items-start justify-end gap-2 py-1">
          {rowContent}
        </div>
      ) : (
        <div className="flex items-start gap-2.5 py-1">
          {actorAgentId ? (
            <AgentAvatar agent={agentMap?.get(actorAgentId) ?? { id: actorAgentId, name: actorName }} size={32} />
          ) : (
            <Avatar size="sm" className="mt-0.5"><AvatarFallback>{initialsForName(actorName)}</AvatarFallback></Avatar>
          )}
          {rowContent}
        </div>
      )}
      {expanded ? (
        <div id={detailsId} className="mt-2">
          <IssueThreadInteractionCard
            interaction={interaction}
            agentMap={agentMap}
            currentUserId={currentUserId}
            userLabelMap={userLabelMap}
            onAcceptInteraction={onAcceptInteraction}
            onRejectInteraction={onRejectInteraction}
            onCancelInteraction={onCancelInteraction}
            onUploadImage={onUploadImage}
            externalReferences={externalReferences}
          />
        </div>
      ) : null}
    </div>
  );
}

function StaleDispositionWarningMetadataRow({
  row,
}: {
  row: SystemNoticeMetadataRow;
}) {
  const label = (
    <span className="text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
      {row.label}
    </span>
  );
  const value = (() => {
    switch (row.kind) {
      case "text":
        return <span>{row.value}</span>;
      case "code":
        return (
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-(length:--text-micro) text-foreground/80">
            {row.value}
          </code>
        );
      case "issue": {
        const content = (
          <>
            <span>{row.identifier}</span>
            {row.title ? (
              <span className="text-muted-foreground"> - {row.title}</span>
            ) : null}
          </>
        );
        return row.href ? (
          <a
            href={row.href}
            className="font-medium text-foreground underline-offset-2 hover:underline"
          >
            {content}
          </a>
        ) : (
          <span className="font-medium text-foreground">{content}</span>
        );
      }
      case "agent":
        return row.href ? (
          <a
            href={row.href}
            className="font-medium text-foreground underline-offset-2 hover:underline"
          >
            {row.name}
          </a>
        ) : (
          <span className="font-medium text-foreground">{row.name}</span>
        );
      case "run": {
        const runShort =
          row.runId.length > 12 ? `${row.runId.slice(0, 8)}...` : row.runId;
        const content = (
          <>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-(length:--text-micro) text-foreground/80">
              {runShort}
            </code>
            {row.status ? <span>{row.status}</span> : null}
          </>
        );
        return row.href ? (
          <a
            href={row.href}
            className="inline-flex items-center gap-1.5 underline-offset-2 hover:underline"
          >
            {content}
          </a>
        ) : (
          <span className="inline-flex items-center gap-1.5">{content}</span>
        );
      }
    }
  })();

  return (
    <div className="grid grid-cols-(--gtc-7) gap-2 text-xs leading-5">
      {label}
      <div className="min-w-0 break-words text-foreground/80">{value}</div>
    </div>
  );
}

function StaleDispositionWarningDetails({
  sections,
}: {
  sections: SystemNoticeMetadataSection[];
}) {
  if (sections.length === 0) {
    return (
      <div className="text-xs leading-5 text-muted-foreground">
        No additional details.
      </div>
    );
  }

  return (
    <div className="space-y-3 text-left">
      {sections.map((section) => (
        <div key={metadataSectionKey(section)} className="space-y-1.5">
          {section.title ? (
            <div className="text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
              {section.title}
            </div>
          ) : null}
          <div className="space-y-1">
            {section.rows.map((row) => (
              <StaleDispositionWarningMetadataRow
                key={metadataRowKey(row)}
                row={row}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function StaleDispositionWarningRow({
  anchorId,
  message,
  metadata,
  runAgentId,
}: {
  anchorId?: string;
  message: ThreadMessage;
  metadata: IssueCommentMetadata | null;
  runAgentId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const sections = mapCommentMetadataToSystemNoticeSections(metadata, {
    runAgentId,
  });

  return (
    <div id={anchorId} data-testid="stale-disposition-warning">
      <div className="flex items-start gap-2.5 py-1.5">
        <span className="size-6 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            className="group flex w-full items-center gap-2 py-0.5 text-left"
            onClick={() => setOpen((value) => !value)}
          >
            <span className="text-sm font-medium text-foreground/80">
              Stale disposition warning
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              {message.createdAt ? (
                <span
                  data-testid="stale-disposition-warning-time"
                  className="text-(length:--text-micro) text-subtle-foreground"
                >
                  {commentDateLabel(message.createdAt)}
                </span>
              ) : null}
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 text-subtle-foreground transition-transform",
                  open && "rotate-180",
                )}
              />
            </span>
          </button>
          <div id={detailsId} hidden={!open} className="space-y-1 py-1">
            <StaleDispositionWarningDetails sections={sections} />
          </div>
        </div>
      </div>
    </div>
  );
}

// Tone-colored dot for the fully-collapsed compact notice row. Tone is never
// conveyed by color alone — the adjacent title text names the notice.
const COMPACT_TONE_DOT: Record<SystemNoticeTone, string> = {
  neutral: "bg-muted-foreground/40",
  info: "bg-sky-500 dark:bg-sky-400",
  success: "bg-emerald-500 dark:bg-emerald-400",
  warning: "bg-amber-500 dark:bg-amber-400",
  danger: "bg-red-500 dark:bg-red-400",
};

// A system notice whose presentation opts into `density: "compact"` collapses to
// a single quiet row — tone dot + title (+ author) + timestamp + chevron.
// Expanding reveals the full SystemNotice card (body + details), so no
// information is lost. Generalized from the StaleDispositionWarningRow precedent.
function CompactSystemNoticeRow({
  anchorId,
  message,
  tone,
  title,
  source,
  noticeProps,
  defaultOpen = false,
}: {
  anchorId?: string;
  message: ThreadMessage;
  tone: SystemNoticeTone;
  title: string;
  source?: SystemNoticeProps["source"];
  noticeProps: SystemNoticeProps;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const detailsId = useId();

  return (
    <div id={anchorId} data-testid="compact-system-notice" className="group">
      <div className="flex items-start gap-2.5 py-1.5">
        <span className="size-6 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            className="-mx-1 flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-accent/5"
            onClick={() => setOpen((value) => !value)}
          >
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                COMPACT_TONE_DOT[tone],
              )}
              aria-hidden
            />
            <span className="truncate text-sm font-medium text-foreground/80">
              {title}
            </span>
            {source ? (
              <span className="truncate text-(length:--text-micro) text-muted-foreground">
                · {source.label}
              </span>
            ) : null}
            {/* Trailing meta never shrinks — keeps the timestamp on one line so the
                collapsed row stays a single quiet line on narrow / mobile widths. */}
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {message.createdAt ? (
                <span
                  data-testid="compact-system-notice-time"
                  className="whitespace-nowrap text-(length:--text-micro) text-subtle-foreground"
                >
                  {commentDateLabel(message.createdAt)}
                </span>
              ) : null}
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 shrink-0 text-subtle-foreground transition-transform group-hover:text-subtle-foreground",
                  open && "rotate-180",
                )}
              />
            </span>
          </button>
          <div id={detailsId} hidden={!open} className="py-1">
            <SystemNotice {...noticeProps} />
          </div>
        </div>
      </div>
    </div>
  );
}

function SystemNoticeCommentRow(props: { message: ThreadMessage; anchorId?: string }) {
  const custom = props.message.metadata.custom as Record<string, unknown>;
  const email = useEmailComment(typeof custom.commentId === "string" ? custom.commentId : props.message.id);
  return email ?? <SystemNoticeCommentContent {...props} />;
}
function SystemNoticeCommentContent({
  message,
  anchorId,
}: {
  message: ThreadMessage;
  anchorId?: string;
}) {
  const { onImageClick, agentMap, issueStatus, successfulRunHandoff } =
    useContext(IssueChatCtx);
  const toastActions = useOptionalToastActions();
  const custom = message.metadata.custom as Record<string, unknown>;
  const presentation = isIssueCommentPresentation(custom.presentation)
    ? custom.presentation
    : null;
  const commentMetadata = isIssueCommentMetadata(custom.commentMetadata)
    ? custom.commentMetadata
    : null;
  const recoverySnapshot = useDispositionRecoverySnapshot(commentMetadata);
  const runAgentId =
    typeof custom.runAgentId === "string" ? custom.runAgentId : null;
  const runId = typeof custom.runId === "string" ? custom.runId : null;
  const authorType =
    typeof custom.authorType === "string" ? custom.authorType : null;
  const authorName =
    typeof custom.authorName === "string" ? custom.authorName : null;
  const bodyText = message.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n\n");
  const staleSuccessfulRunHandoffNotice = isStaleSuccessfulRunHandoffNotice({
    bodyText,
    issueStatus,
    successfulRunHandoff,
    runId,
    metadata: commentMetadata,
  });
  const [copied, setCopied] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  const source = (() => {
    const runAgentName = runAgentId
      ? (agentMap?.get(runAgentId)?.name ?? null)
      : null;
    if (authorType === "system") {
      const label = runAgentName ?? "GS Agentic Manager";
      if (runAgentId && runId)
        return { label, href: `/agents/${runAgentId}/runs/${runId}` };
      return { label };
    }
    if (runAgentId && runId) {
      return {
        label: authorName ?? runAgentName ?? "GS Agentic Manager",
        href: `/agents/${runAgentId}/runs/${runId}`,
      };
    }
    if (authorName) return { label: authorName };
    return undefined;
  })();

  const props = buildSystemNoticeProps({
    presentation,
    metadata: commentMetadata,
    body: (
      <MarkdownBody
        className="text-sm leading-6"
        softBreaks
        onImageClick={onImageClick}
      >
        {bodyText}
      </MarkdownBody>
    ),
    timestamp: toValidIsoString(message.createdAt),
    source,
    runAgentId,
  });

  const handleCopy = () => {
    void copyTextToClipboard(bodyText)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch((error) => {
        toastActions?.pushToast({
          title: "Copy failed",
          body:
            error instanceof Error
              ? error.message
              : "Unable to copy system notice",
          tone: "error",
        });
      });
  };

  const handleCopyLink = () => {
    if (!anchorId || typeof window === "undefined") return;
    const url = `${window.location.origin}${window.location.pathname}#${anchorId}`;
    void copyTextToClipboard(url)
      .then(() => {
        setCopiedLink(true);
        setTimeout(() => setCopiedLink(false), 2000);
      })
      .catch((error) => {
        toastActions?.pushToast({
          title: "Copy failed",
          body:
            error instanceof Error
              ? error.message
              : "Unable to copy system notice link",
          tone: "error",
        });
      });
  };

  if (authorType === "system" && recoverySnapshot) {
    return <div id={anchorId}><DispositionRecoveryNotice snapshot={recoverySnapshot} createdAt={toValidIsoString(message.createdAt)} defaultExpanded={presentation?.detailsDefaultOpen} /></div>;
  }

  if (staleSuccessfulRunHandoffNotice) {
    return (
      <StaleDispositionWarningRow
        anchorId={anchorId}
        message={message}
        metadata={commentMetadata}
        runAgentId={runAgentId}
      />
    );
  }

  // Compact presentation collapses the notice to a single quiet row. Notices
  // without `density` (old comments / old data) keep today's full card.
  if (presentation?.density === "compact") {
    const tone = presentation.tone ?? "neutral";
    const title = systemNoticeLabelForTone(tone, presentation.title);
    return (
      <CompactSystemNoticeRow
        anchorId={anchorId}
        message={message}
        tone={tone}
        title={title}
        source={source}
        noticeProps={props}
        defaultOpen={Boolean(presentation.detailsDefaultOpen)}
      />
    );
  }

  return (
    <div id={anchorId} className="group">
      <div className="py-1">
        <SystemNotice {...props} />
        <div className="mt-1 flex items-center justify-end gap-1.5 px-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={anchorId ? `#${anchorId}` : undefined}
                className="text-(length:--text-micro) text-muted-foreground hover:text-foreground hover:underline"
              >
                {message.createdAt ? commentDateLabel(message.createdAt) : ""}
              </a>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">
              {message.createdAt ? formatDateTime(message.createdAt) : ""}
            </TooltipContent>
          </Tooltip>
          {anchorId ? (
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
              title="Copy link"
              aria-label="Copy link to system notice"
              onClick={handleCopyLink}
            >
              {copiedLink ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <PaperclipIcon className="h-3.5 w-3.5" />
              )}
            </button>
          ) : null}
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
            title="Copy notice text"
            aria-label="Copy system notice"
            onClick={handleCopy}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// Non-comment timeline items (run/status events, "updated this task",
// "worked for N minutes") render as quiet, subordinate metadata rows hung off a
// left rail — visually distinct from the bubbles used for genuine comments.
// Virtualized rows are absolutely positioned, so each row carries its own rail
// segment; stacked rows read as one continuous rail. See PAP-95 mockup rev 5.
function IssueChatMetadataRow({
  anchorId,
  icon,
  children,
  testid = "issue-chat-metadata-row",
}: {
  anchorId?: string;
  icon: ReactNode;
  children: ReactNode;
  testid?: string;
}) {
  return (
    <div id={anchorId} data-testid={testid}>
      <div className="ml-3 flex items-start gap-2.5 border-l-2 border-border/50 py-0.5 pl-3">
        <span className="mt-px flex size-(--sz-18px) shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted/30 text-subtle-foreground">
          {icon}
        </span>
        <div className="min-w-0 flex-1 space-y-1">{children}</div>
      </div>
    </div>
  );
}

export function IssueChatSystemMessage({ message }: { message: ThreadMessage }) {
  const {
    agentMap,
    currentUserId,
    userLabelMap,
    onAcceptInteraction,
    onRejectInteraction,
    onSubmitInteractionAnswers,
    onCancelInteraction,
    onSubmitInteractionVerdicts,
    onUploadImage,
    externalReferences,
  } = useContext(IssueChatCtx);
  const custom = message.metadata.custom as Record<string, unknown>;
  const anchorId =
    typeof custom.anchorId === "string" ? custom.anchorId : undefined;
  const runId = typeof custom.runId === "string" ? custom.runId : null;
  const runAgentId =
    typeof custom.runAgentId === "string" ? custom.runAgentId : null;
  const runAgentName =
    typeof custom.runAgentName === "string" ? custom.runAgentName : null;
  const runStatus =
    typeof custom.runStatus === "string" ? custom.runStatus : null;
  const actorName =
    typeof custom.actorName === "string" ? custom.actorName : null;
  const actorType =
    typeof custom.actorType === "string" ? custom.actorType : null;
  const actorId = typeof custom.actorId === "string" ? custom.actorId : null;
  const statusChange =
    typeof custom.statusChange === "object" && custom.statusChange
      ? (custom.statusChange as { from: string | null; to: string | null })
      : null;
  const assigneeChange =
    typeof custom.assigneeChange === "object" && custom.assigneeChange
      ? (custom.assigneeChange as {
          from: IssueTimelineAssignee;
          to: IssueTimelineAssignee;
        })
      : null;
  const workspaceChange = isTimelineWorkspaceChange(custom.workspaceChange)
    ? custom.workspaceChange
    : null;
  const interaction = isIssueThreadInteraction(custom.interaction)
    ? custom.interaction
    : null;

  if (custom.kind === "system_notice") {
    return <SystemNoticeCommentRow message={message} anchorId={anchorId} />;
  }

  if (custom.kind === "interaction" && interaction) {
    if (
      interaction.kind === "request_confirmation" &&
      interaction.status === "expired" &&
      !interaction.payload.secretProposal
    ) {
      return (
        <ExpiredRequestConfirmationActivity
          message={message}
          anchorId={anchorId}
          interaction={interaction}
        />
      );
    }

    return (
      <div id={anchorId}>
        <div className="py-1.5">
          <IssueThreadInteractionCard
            interaction={interaction}
            agentMap={agentMap}
            currentUserId={currentUserId}
            userLabelMap={userLabelMap}
            onAcceptInteraction={onAcceptInteraction}
            onRejectInteraction={onRejectInteraction}
            onSubmitInteractionAnswers={onSubmitInteractionAnswers}
            onCancelInteraction={onCancelInteraction}
            onSubmitInteractionVerdicts={onSubmitInteractionVerdicts}
            onUploadImage={onUploadImage}
            externalReferences={externalReferences}
          />
        </div>
      </div>
    );
  }

  if (custom.kind === "event" && actorName) {
    const isAgent = actorType === "agent";
    const agentIcon = isAgent && actorId ? agentMap?.get(actorId)?.icon : undefined;
    const isCurrentUser = actorType === "user" && !!currentUserId && actorId === currentUserId;
    const rowIcon = isAgent
      ? <AgentAvatar agent={actorId ? agentMap?.get(actorId) ?? { id: actorId } : undefined} size={16} />
      : <ClipboardList className="h-3 w-3" />;
    const handoffResolvers: HandoffChipResolvers = {
      agentMap,
      currentUserId,
      resolveUserLabel: (userId) =>
        formatAssigneeUserLabel(userId, null, userLabelMap),
    };

    return (
      <IssueChatMetadataRow anchorId={anchorId} icon={rowIcon}>
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs">
          <span className="font-medium text-foreground">{actorName}</span>
          <span className="text-muted-foreground">
            {custom.followUpRequested === true
              ? "requested follow-up"
              : "updated this task"}
          </span>
          <a
            href={anchorId ? `#${anchorId}` : undefined}
            className="text-xs text-subtle-foreground transition-colors hover:text-foreground hover:underline"
          >
            {timeAgo(message.createdAt)}
          </a>
        </div>

        {statusChange ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-(length:--text-nano) font-medium uppercase tracking-wider text-subtle-foreground">
              Status
            </span>
            <span className="text-muted-foreground">
              {humanizeValue(statusChange.from)}
            </span>
            <ArrowRight className="h-3 w-3 text-subtle-foreground" />
            <span className="font-medium text-foreground">
              {humanizeValue(statusChange.to)}
            </span>
          </div>
        ) : null}

        {assigneeChange ? (
          <div className="space-y-1">
            <div
              className={cn(
                "flex flex-wrap items-center gap-1.5 text-xs",
                isCurrentUser && "justify-end",
              )}
            >
              <span className="text-(length:--text-nano) font-medium uppercase tracking-wider text-subtle-foreground">
                Assignee
              </span>
              <AssigneeChip
                assignee={assigneeChange.from}
                resolvers={handoffResolvers}
              />
              <ArrowRight className="h-3 w-3 text-subtle-foreground" />
              <AssigneeChip
                assignee={assigneeChange.to}
                resolvers={handoffResolvers}
              />
            </div>
            <div className={cn(isCurrentUser && "flex justify-end")}>
              <HandoffWakeRow
                to={assigneeChange.to}
                resolvers={handoffResolvers}
                interruptedRunAttached={custom.interruptedRunId != null}
              />
            </div>
          </div>
        ) : null}

        {workspaceChange ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-(length:--text-nano) font-medium uppercase tracking-wider text-subtle-foreground">
              Workspace
            </span>
            <span className="text-muted-foreground">
              {formatTimelineWorkspaceLabel(workspaceChange.from)}
            </span>
            <ArrowRight className="h-3 w-3 text-subtle-foreground" />
            <span className="font-medium text-foreground">
              {formatTimelineWorkspaceLabel(workspaceChange.to)}
            </span>
          </div>
        ) : null}
      </IssueChatMetadataRow>
    );
  }

  const displayedRunAgentName =
    runAgentName ??
    (runAgentId
      ? (agentMap?.get(runAgentId)?.name ?? runAgentId.slice(0, 8))
      : null);
  const runAgentIcon = runAgentId ? agentMap?.get(runAgentId)?.icon : undefined;
  if (custom.kind === "run" && runId && runAgentId && displayedRunAgentName && runStatus) {
    const rowIcon = <AgentAvatar agent={agentMap?.get(runAgentId) ?? { id: runAgentId }} size={16} />;

    return (
      <IssueChatMetadataRow anchorId={anchorId} icon={rowIcon}>
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
          <Link
            to={`/agents/${runAgentId}`}
            className="font-medium text-foreground transition-colors hover:underline"
          >
            {displayedRunAgentName}
          </Link>
          <span className="text-muted-foreground">run</span>
          <Link
            to={`/agents/${runAgentId}/runs/${runId}`}
            className="inline-flex items-center rounded-md border border-border bg-accent/40 px-1.5 py-0.5 font-mono text-(length:--text-nano) text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            {runId.slice(0, 8)}
          </Link>
          <RunStatusBadge
            status={runStatus}
            operatorInterrupted={custom.runOperatorInterrupted === true}
          />
          <a
            href={anchorId ? `#${anchorId}` : undefined}
            className="text-xs text-subtle-foreground transition-colors hover:text-foreground hover:underline"
          >
            {timeAgo(message.createdAt)}
          </a>
        </div>
      </IssueChatMetadataRow>
    );
  }

  return null;
}
