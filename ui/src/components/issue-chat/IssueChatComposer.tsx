import { AgentAvatar } from "@/components/AgentAvatar";
import { TaskChatPausedTakeover } from "../task-chat/TaskChatPausedTakeover";
import {
  forwardRef,
  useState,
  useRef,
  useEffect,
  useImperativeHandle,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  useMemo,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { type IssueWorkMode, buildAgentMentionHref } from "@greatstone/shared";
import {
  loadDraft,
  type ComposerDraftSubmission,
  loadDraftSubmission,
  saveDraft,
  saveDraftSubmission,
  loadDraftAttachments,
  saveDraftAttachments,
  settleDraftSubmission,
  clearDraftSubmission,
  clearDraft,
} from "../../lib/composer-draft";
import { CommentSubmissionUnknownError } from "../../lib/comment-submit-result";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { type MarkdownEditorRef, MarkdownEditor } from "../MarkdownEditor";
import { InlineEntitySelector } from "../InlineEntitySelector";
import {
  type HandoffChipResolvers,
  ComposerMentionCoach,
  ComposerHandoffPreviewRow,
} from "../interrupt-handoff/InterruptHandoffViews";
import {
  type HandoffAgentMention,
  extractAgentMentionIds,
  findPlainAgentNameCandidate,
  computeComposerHandoffPreview,
} from "../../lib/interrupt-handoff";
import { restoreSubmittedCommentDraft } from "../../lib/comment-submit-draft";
import { captureComposerViewportSnapshot, restoreComposerViewportSnapshot } from "../../lib/issue-chat-scroll";
import { formatAssigneeUserLabel } from "../../lib/assignees";
import { useComposerStop } from "@/hooks/useComposerStop";
import { cn } from "../../lib/utils";
import {
  workModeMetaList,
  workModeMetaFor,
  nextWorkMode,
  titleForPendingWorkMode,
} from "../../lib/work-mode-meta";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { PaperclipIcon, Loader2, Check, AlertTriangle, X, ChevronDown, Square } from "lucide-react";
import type { IssueChatComposerHandle, IssueChatComposerProps } from "./types";
import {
  isUnassignedReassignValue,
  parseReassignment,
  shouldImplicitlyReopenComment,
  hasFilePayload,
  formatAttachmentSize,
  shouldRenderComposerHandoffPreview,
} from "./helpers";

const DRAFT_DEBOUNCE_MS = 800;
const COMPOSER_FOCUS_SCROLL_PADDING_PX = 96;
export const SUBMIT_SCROLL_RESERVE_VH = 0.4;

type ComposerAttachmentItem = {
  id: string;
  attachmentId?: string;
  name: string;
  size: number;
  status: "uploading" | "attached" | "error";
  inline: boolean;
  contentPath?: string;
  error?: string;
};

export const IssueChatComposer = forwardRef<
  IssueChatComposerHandle,
  IssueChatComposerProps
>(function IssueChatComposer(
  {
    onSend,
    confirmedSubmissionIds,
    onReviewConversation,
    onStop,
    stopPending,
    stopScope = "leaf",
    onImageUpload,
    onAttachImage,
    draftKey,
    enableReassign = false,
    reassignOptions = [],
    currentAssigneeValue = "",
    suggestedAssigneeValue,
    mentions = [],
    agentMap,
    hasActiveRun = false,
    currentUserId = null,
    userLabelMap = null,
    composerPause = null,
    composerDisabledReason = null,
    composerHint = null,
    issueStatus,
    issueWorkMode,
    onWorkModeChange,
  },
  forwardedRef,
) {
  const stopControl = useComposerStop(onStop, stopPending);
  // Initialize before StrictMode's mount cleanup can flush an empty value over
  // the stored draft. The effect below handles subsequent task-key changes.
  const [body, setBody] = useState(() => (draftKey ? loadDraft(draftKey) : ""));
  const [submitting, setSubmitting] = useState(false);
  const [reviewError, setReviewError] = useState(false);
  const [uncertainSubmission, setUncertainSubmission] =
    useState<ComposerDraftSubmission | null>(() =>
      draftKey ? loadDraftSubmission(draftKey) : null,
    );
  const mountedTaskKey = useRef(draftKey);
  useEffect(() => {
    mountedTaskKey.current = draftKey;
    setUncertainSubmission(draftKey ? loadDraftSubmission(draftKey) : null);
    return () => {
      mountedTaskKey.current = undefined;
    };
  }, [draftKey]);
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const pendingDraftRef = useRef<{
    draftKey: string;
    attemptId: string;
    submittedBody: string;
    submittedAttachmentIds: string[];
  } | null>(null);
  function changeBody(update: string | ((current: string) => string)) {
    const value = typeof update === "function" ? update(bodyRef.current) : update;
    bodyRef.current = value;
    setBody(value);
    const pending = pendingDraftRef.current;
    if (!pending || pending.draftKey !== draftKey ||
        loadDraftSubmission(pending.draftKey)?.attemptId !== pending.attemptId) return;
    // Persist the next draft while delivery is pending, before navigation or a
    // lost response can turn the original submission into an uncertain one.
    saveDraft(pending.draftKey,
      value ? `${pending.submittedBody}\n\n${value}` : pending.submittedBody,
      pending.attemptId);
    saveDraftSubmission(pending.draftKey, {
      attemptId: pending.attemptId, reviewed: false,
      nextDraftOffset: pending.submittedBody.length + (value ? 2 : 0),
      submittedAttachmentIds: pending.submittedAttachmentIds,
    });
  }
  const submittingRef = useRef(submitting);
  submittingRef.current = submitting;
  const [attaching, setAttaching] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [composerAttachments, setComposerAttachmentState] = useState<
    ComposerAttachmentItem[]
  >(() =>
    draftKey
      ? loadDraftAttachments(draftKey).map((item) => ({
          ...item,
          size: item.size ?? 0,
          id: `receipt:${item.attachmentId}`,
          status: "attached",
        }))
      : [],
  );
  const composerAttachmentsRef = useRef(composerAttachments);
  function setComposerAttachments(
    update:
      | ComposerAttachmentItem[]
      | ((previous: ComposerAttachmentItem[]) => ComposerAttachmentItem[]),
  ) {
    const next =
      typeof update === "function"
        ? update(composerAttachmentsRef.current)
        : update;
    composerAttachmentsRef.current = next;
    setComposerAttachmentState(next);
    const pending = pendingDraftRef.current;
    if (pending && pending.draftKey === draftKey) {
      saveDraftAttachments(pending.draftKey, next
        .filter(item => item.status === "attached" && item.attachmentId)
        .map(item => ({ ...item, inline: item.inline === true })), pending.attemptId);
    }
  }
  const dragDepthRef = useRef(0);
  const effectiveSuggestedAssigneeValue =
    suggestedAssigneeValue ?? currentAssigneeValue;
  const [reassignTarget, setReassignTarget] = useState(
    effectiveSuggestedAssigneeValue,
  );
  const [noAssigneeDialogOpen, setNoAssigneeDialogOpen] = useState(false);
  const [dismissedCoachToken, setDismissedCoachToken] = useState<string | null>(
    null,
  );
  const resolvedIssueWorkMode: IssueWorkMode = issueWorkMode ?? "standard";
  const [pendingWorkMode, setPendingWorkMode] = useState<IssueWorkMode>(
    resolvedIssueWorkMode,
  );
  const [workModeMenuOpen, setWorkModeMenuOpen] = useState(false);
  const canToggleWorkMode = typeof onWorkModeChange === "function";
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const reassignTriggerRef = useRef<HTMLButtonElement | null>(null);
  const focusAssigneeOnDialogCloseRef = useRef(false);
  const editorRef = useRef<MarkdownEditorRef>(null);
  const composerContainerRef = useRef<HTMLDivElement | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canAcceptFiles =
    !uncertainSubmission && Boolean(onImageUpload || onAttachImage);
  const uploadUnsettled =
    attaching || composerAttachments.some((item) => item.status !== "attached");
  const attachedFiles = composerAttachments.filter(
    (item) => item.status === "attached" && !item.inline && item.contentPath,
  );

  function queueViewportRestore(
    snapshot: ReturnType<typeof captureComposerViewportSnapshot>,
  ) {
    if (!snapshot) return;
    requestAnimationFrame(() => {
      restoreComposerViewportSnapshot(snapshot, composerContainerRef.current);
    });
  }

  function focusComposer() {
    if (typeof composerContainerRef.current?.scrollIntoView === "function") {
      composerContainerRef.current.scrollIntoView({
        behavior: "smooth",
        block: "end",
      });
    }
    requestAnimationFrame(() => {
      window.scrollBy({
        top: COMPOSER_FOCUS_SCROLL_PADDING_PX,
        behavior: "smooth",
      });
      editorRef.current?.focus();
    });
  }

  useEffect(() => {
    if (!draftKey) return;
    setBody(loadDraft(draftKey));
    setComposerAttachments(
      loadDraftAttachments(draftKey).map((item) => ({
        ...item,
        size: item.size ?? 0,
        id: `receipt:${item.attachmentId}`,
        status: "attached",
      })),
    );
  }, [draftKey]);

  // A server receipt for this exact request settles a restored submission.
  // Text equality is not delivery proof: users may intentionally repeat text.
  useEffect(() => {
    if (!uncertainSubmission || !confirmedSubmissionIds.has(uncertainSubmission.attemptId)) return;
    const nextDraft = uncertainSubmission.nextDraftOffset === undefined
      ? "" : bodyRef.current.slice(uncertainSubmission.nextDraftOffset);
    if (draftKey) settleDraftSubmission(draftKey, uncertainSubmission.attemptId, nextDraft);
    setUncertainSubmission(null);
    setBody(nextDraft);
    bodyRef.current = nextDraft;
    const submittedIds = uncertainSubmission.submittedAttachmentIds;
    setComposerAttachments(current => submittedIds
      ? current.filter(item => !item.attachmentId || !submittedIds.includes(item.attachmentId))
      : []);
  }, [confirmedSubmissionIds, draftKey, uncertainSubmission]);

  useEffect(() => {
    if (
      !draftKey ||
      submitting ||
      composerAttachments !== composerAttachmentsRef.current
    )
      return;
    saveDraftAttachments(
      draftKey,
      composerAttachments.filter(
        (item) => item.status === "attached" && item.attachmentId,
      ),
    );
  }, [composerAttachments, draftKey, submitting]);

  useEffect(() => {
    if (!draftKey || submitting) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      saveDraft(draftKey, body);
    }, DRAFT_DEBOUNCE_MS);
  }, [body, draftKey, submitting]);

  useEffect(() => {
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (draftKey && !submittingRef.current)
        saveDraft(draftKey, bodyRef.current);
    };
  }, [draftKey]);

  useEffect(() => {
    if (!draftKey) return;
    const flushDraft = () => {
      if (!submittingRef.current) saveDraft(draftKey, bodyRef.current);
    };
    window.addEventListener("beforeunload", flushDraft);
    return () => window.removeEventListener("beforeunload", flushDraft);
  }, [draftKey]);

  useEffect(() => {
    setReassignTarget(effectiveSuggestedAssigneeValue);
  }, [effectiveSuggestedAssigneeValue]);

  useEffect(() => {
    setPendingWorkMode(resolvedIssueWorkMode);
  }, [resolvedIssueWorkMode]);

  useImperativeHandle(
    forwardedRef,
    () => ({
      focus: focusComposer,
      restoreDraft: (submittedBody: string) => {
        setBody((current) =>
          restoreSubmittedCommentDraft({
            currentBody: current,
            submittedBody,
          }),
        );
        focusComposer();
      },
    }),
    [],
  );

  const showStop =
    !submitting &&
    !attaching &&
    body.trim().length === 0 &&
    composerAttachments.length === 0 &&
    Boolean(onStop || stopControl.stopping);

  async function handleSubmit() {
    if (composerPause) return;
    const trimmed = body.trim();
    if (
      (!trimmed && attachedFiles.length === 0) ||
      submitting ||
      uploadUnsettled ||
      uncertainSubmission
    )
      return;

    const composerHasAssigneePicker =
      enableReassign && reassignOptions.length > 0;
    if (
      composerHasAssigneePicker &&
      isUnassignedReassignValue(reassignTarget)
    ) {
      setNoAssigneeDialogOpen(true);
      return;
    }

    await submitComment();
  }

  async function submitComment() {
    if (composerPause) return;
    const trimmed = body.trim();
    if (
      (!trimmed && attachedFiles.length === 0) ||
      submitting ||
      uploadUnsettled ||
      uncertainSubmission
    )
      return;

    const hasReassignment =
      enableReassign && reassignTarget !== currentAssigneeValue;
    const reassignment = hasReassignment
      ? (parseReassignment(reassignTarget) ?? undefined)
      : undefined;
    const reopen = shouldImplicitlyReopenComment(
      issueStatus,
      hasReassignment ? reassignTarget : currentAssigneeValue,
    )
      ? true
      : undefined;
    const submittedBody = [
      trimmed,
      ...attachedFiles.map(
        (item) =>
          `[${item.name.replace(/[[\]]/g, "\\$&")}](${item.contentPath})`,
      ),
    ]
      .filter(Boolean)
      .join("\n\n");
    const submittedAttachmentKeys = new Set(
      composerAttachments.map((item) => item.id),
    );
    const attachmentIds = [
      ...new Set(
        composerAttachments
          .filter(
            (item) =>
              item.status === "attached" &&
              item.attachmentId &&
              (!item.inline ||
                (item.contentPath && trimmed.includes(item.contentPath))),
          )
          .map((item) => item.attachmentId!),
      ),
    ];
    const viewportSnapshot = captureComposerViewportSnapshot(
      composerContainerRef.current,
    );

    const workModeChanged = pendingWorkMode !== resolvedIssueWorkMode;
    if (draftKey) saveDraft(draftKey, trimmed);
    setSubmitting(true);
    bodyRef.current = "";
    setBody("");
    let attemptId: string | null = null;
    try {
      if (workModeChanged && onWorkModeChange) {
        await onWorkModeChange(pendingWorkMode);
      }
      const retained = draftKey ? loadDraftSubmission(draftKey) : null;
      if (retained) {
        setUncertainSubmission(retained);
        setBody(trimmed);
        return;
      }
      attemptId = crypto.randomUUID();
      if (draftKey) {
        saveDraft(draftKey, trimmed);
        saveDraftSubmission(draftKey, { attemptId, reviewed: false });
        pendingDraftRef.current = { draftKey, attemptId, submittedBody: trimmed, submittedAttachmentIds: attachmentIds };
        changeBody(bodyRef.current);
      }
      // assistant-ui thread.append is fire-and-forget. Await the actual Board
      // mutation; it already owns optimistic echo and durable error handling.
      const sendPromise = onSend(
        submittedBody, reopen, reassignment,
        attachmentIds.length ? attachmentIds : undefined, attemptId,
      );
      queueViewportRestore(viewportSnapshot);
      await sendPromise;
      // Settle the captured task even if the user navigated away. The exact
      // attempt guard preserves any newer submission in this or another tab.
      if (draftKey) settleDraftSubmission(draftKey, attemptId,
        mountedTaskKey.current === draftKey ? bodyRef.current : undefined);
      if (mountedTaskKey.current !== draftKey) return;
      setComposerAttachments((current) =>
        current.filter((item) => !submittedAttachmentKeys.has(item.id)),
      );
      setReassignTarget(effectiveSuggestedAssigneeValue);
    } catch (error) {
      if (mountedTaskKey.current !== draftKey) return;
      const nextDraft = bodyRef.current;
      if (attemptId && error instanceof CommentSubmissionUnknownError) {
        const uncertain = {
          attemptId, reviewed: false,
          nextDraftOffset: trimmed.length + (nextDraft ? 2 : 0),
          submittedAttachmentIds: attachmentIds,
        };
        setUncertainSubmission(uncertain);
        if (draftKey && loadDraftSubmission(draftKey)?.attemptId === attemptId)
          saveDraftSubmission(draftKey, uncertain);
      } else if (draftKey && attemptId)
        clearDraftSubmission(draftKey, attemptId);
      const restoredBody = nextDraft ? `${trimmed}\n\n${nextDraft}` : trimmed;
      if (draftKey) saveDraft(draftKey, restoredBody, attemptId ?? undefined);
      setBody(restoredBody);
    } finally {
      if (pendingDraftRef.current?.attemptId === attemptId) pendingDraftRef.current = null;
      setSubmitting(false);
      queueViewportRestore(viewportSnapshot);
    }
  }

  async function attachFile(
    file: File,
    insertInline = true,
  ): Promise<string | undefined> {
    const attachmentId = `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`;
    const inline = file.type.startsWith("image/");
    setComposerAttachments((prev) => [
      ...prev,
      {
        id: attachmentId,
        name: file.name,
        size: file.size,
        status: "uploading",
        inline,
      },
    ]);

    try {
      if (!onAttachImage && onImageUpload && inline) {
        const url = await onImageUpload(file);
        if (
          !composerAttachmentsRef.current.some(
            (item) => item.id === attachmentId,
          )
        )
          return undefined;
        const safeName = file.name.replace(/[[\]]/g, "\\$&");
        const markdown = `![${safeName}](${url})`;
        if (insertInline)
          changeBody((prev) => (prev ? `${prev}\n\n${markdown}` : markdown));
        setComposerAttachments((prev) =>
          prev.map((item) =>
            item.id === attachmentId
              ? { ...item, status: "attached", contentPath: url }
              : item,
          ),
        );
        return url;
      } else if (onAttachImage) {
        const attachment = await onAttachImage(file);
        if (!attachment?.contentPath)
          throw new Error("Upload did not return a file URL");
        if (
          !composerAttachmentsRef.current.some(
            (item) => item.id === attachmentId,
          )
        )
          return undefined;
        if (inline && insertInline) {
          const markdown = `![${file.name.replace(/[[\]]/g, "\\$&")}](${attachment.contentPath})`;
          changeBody((prev) => (prev ? `${prev}\n\n${markdown}` : markdown));
        }
        setComposerAttachments((prev) =>
          prev.map((item) =>
            item.id === attachmentId
              ? {
                  ...item,
                  status: "attached",
                  attachmentId: attachment.id,
                  contentPath: attachment?.contentPath,
                  name: attachment?.originalFilename ?? item.name,
                }
              : item,
          ),
        );
        return attachment.contentPath;
      } else {
        setComposerAttachments((prev) =>
          prev.map((item) =>
            item.id === attachmentId
              ? {
                  ...item,
                  status: "error",
                  error: "This file type cannot be attached here",
                }
              : item,
          ),
        );
      }
    } catch (err) {
      setComposerAttachments((prev) =>
        prev.map((item) =>
          item.id === attachmentId
            ? {
                ...item,
                status: "error",
                error: err instanceof Error ? err.message : "Upload failed",
              }
            : item,
        ),
      );
    }
  }

  async function handleAttachFile(evt: ChangeEvent<HTMLInputElement>) {
    const file = evt.target.files?.[0];
    if (!file) return;
    setAttaching(true);
    try {
      await attachFile(file);
    } finally {
      setAttaching(false);
      if (attachInputRef.current) attachInputRef.current.value = "";
    }
  }

  async function handleDroppedFiles(files: FileList | null | undefined) {
    if (!files || files.length === 0) return;
    setAttaching(true);
    try {
      for (const file of Array.from(files)) {
        await attachFile(file);
      }
    } finally {
      setAttaching(false);
    }
  }

  function resetDragState() {
    dragDepthRef.current = 0;
    setIsDragOver(false);
  }

  function handleFileDragEnter(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    evt.stopPropagation();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  }

  function handleFileDragOver(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    evt.stopPropagation();
    evt.dataTransfer.dropEffect = "copy";
  }

  function handleFileDragLeave(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    evt.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragOver(false);
  }

  function handleFileDrop(evt: ReactDragEvent<HTMLDivElement>) {
    if (!canAcceptFiles || !hasFilePayload(evt)) return;
    evt.preventDefault();
    evt.stopPropagation();
    resetDragState();
    void handleDroppedFiles(evt.dataTransfer?.files);
  }

  const canSubmit =
    !submitting &&
    !uploadUnsettled &&
    !uncertainSubmission &&
    (!!body.trim() || attachedFiles.length > 0);

  // Interrupt-handoff clarity (PAP-10669): preview what this comment will durably
  // do, and coach plain agent names toward real mentions.
  const agentMentionOptions = useMemo<HandoffAgentMention[]>(
    () =>
      mentions
        .filter((m) => (m.kind ?? "agent") === "agent" && (m.agentId ?? m.id))
        .map((m) => ({
          agentId: m.agentId ?? m.id.replace(/^agent:/, ""),
          name: m.name,
        })),
    [mentions],
  );
  const handoffResolvers = useMemo<HandoffChipResolvers>(
    () => ({
      agentMap,
      currentUserId,
      resolveUserLabel: (userId: string) =>
        formatAssigneeUserLabel(userId, null, userLabelMap),
    }),
    [agentMap, currentUserId, userLabelMap],
  );
  const mentionedAgentIds = useMemo(() => extractAgentMentionIds(body), [body]);
  const plainNameCandidate = useMemo(
    () =>
      mentionedAgentIds.length > 0
        ? null
        : findPlainAgentNameCandidate(body, agentMentionOptions),
    [body, mentionedAgentIds, agentMentionOptions],
  );
  const handoffPreview = useMemo(
    () =>
      computeComposerHandoffPreview({
        reassignTarget,
        currentAssigneeValue,
        hasActiveRun,
        bodyHasAgentMention: mentionedAgentIds.length > 0,
        mentionedAgentId: mentionedAgentIds[0] ?? null,
        plainNameCandidate,
      }),
    [
      reassignTarget,
      currentAssigneeValue,
      hasActiveRun,
      mentionedAgentIds,
      plainNameCandidate,
    ],
  );
  const coachVisible = Boolean(
    plainNameCandidate &&
    plainNameCandidate.matchedText !== dismissedCoachToken,
  );
  const coachAgentName = plainNameCandidate
    ? (agentMap?.get(plainNameCandidate.agentId)?.name ??
      plainNameCandidate.matchedText)
    : "";

  function insertCoachMention() {
    if (!plainNameCandidate) return;
    const option = mentions.find(
      (m) =>
        (m.agentId ?? m.id.replace(/^agent:/, "")) ===
        plainNameCandidate.agentId,
    );
    const agentId = plainNameCandidate.agentId;
    const name = option?.name ?? plainNameCandidate.matchedText;
    const markdown = `[@${name}](${buildAgentMentionHref(agentId, option?.agentIcon ?? null)}) `;
    // Replace the first bare occurrence of the matched token (outside links).
    const tokenRe = new RegExp(
      `(?<![\\w@/])${plainNameCandidate.matchedText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/])`,
      "i",
    );
    changeBody((current) => {
      if (tokenRe.test(current))
        return current.replace(tokenRe, markdown.trimEnd());
      return current ? `${current} ${markdown}` : markdown;
    });
    setDismissedCoachToken(plainNameCandidate.matchedText);
  }

  if (composerPause) {
    return <TaskChatPausedTakeover {...composerPause} hasDraft={Boolean(body.trim() || attachedFiles.length)} />;
  }

  if (composerDisabledReason) {
    return (
      <div className="rounded-md border border-amber-300/70 bg-amber-50/80 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
        {composerDisabledReason}
      </div>
    );
  }

  const workModeOptions = workModeMetaList();
  const pendingWorkModeMeta = workModeMetaFor(pendingWorkMode);
  const PendingWorkModeIcon = pendingWorkModeMeta.icon;

  function handleComposerKeyDown(evt: ReactKeyboardEvent<HTMLDivElement>) {
    // Match the period via both `code` and `key`: iOS Safari with a hardware
    // keyboard often leaves `code` empty for cmd-period, so relying on it alone
    // lets the event fall through and triggers Safari's default cancel/dismiss
    // (which closes the view). Catching `key === "."` keeps the shortcut working
    // on iOS while preserving desktop behavior.
    const isPeriod = evt.code === "Period" || evt.key === ".";
    if (!(evt.metaKey || evt.ctrlKey) || !isPeriod) return;
    evt.preventDefault();
    setPendingWorkMode((current) => nextWorkMode(current));
  }

  return (
    <div
      ref={composerContainerRef}
      data-testid="issue-chat-composer"
      data-pending-work-mode={pendingWorkMode}
      className={cn(
        "relative rounded-md border border-border/70 bg-background/95 p-(--sz-15px) shadow-(--shadow-extract-4) backdrop-blur transition-(--tp-border-color-background-color-box-shadow) duration-150 supports-[backdrop-filter]:bg-background/85 dark:shadow-(--shadow-extract-5)",
        pendingWorkModeMeta.classes.container,
        isDragOver &&
          "border-primary/45 bg-background shadow-(--shadow-extract-7)",
      )}
      onKeyDownCapture={handleComposerKeyDown}
      onDragEnterCapture={handleFileDragEnter}
      onDragOverCapture={handleFileDragOver}
      onDragLeaveCapture={handleFileDragLeave}
      onDropCapture={handleFileDrop}
    >
      {isDragOver && canAcceptFiles ? (
        <div
          data-testid="issue-chat-composer-drop-overlay"
          className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-sm border border-dashed border-primary/55 bg-background/75 px-4 py-3 text-center shadow-sm backdrop-blur-(--blur-2px) dark:bg-background/65"
        >
          <div className="flex max-w-md items-center gap-3 rounded-md bg-background/80 px-3 py-2 text-left shadow-sm ring-1 ring-border/60">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <PaperclipIcon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">
                Drop to upload
              </div>
              <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
                Images insert into the reply. Other files are added to this
                task.
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {uncertainSubmission ? (
        <div
          role="alert"
          className="mb-3 space-y-2 rounded-md border border-border bg-muted p-3 text-sm"
        >
          <p>
            We couldn’t confirm whether this comment was saved. It may already
            be in the conversation. Review it before starting another draft.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={async () => {
              setReviewError(false);
              try {
                if (!onReviewConversation)
                  throw new Error("Review unavailable");
                await onReviewConversation();
                if (mountedTaskKey.current !== draftKey) return;
                const reviewed = { ...uncertainSubmission, reviewed: true };
                setUncertainSubmission(reviewed);
                if (
                  draftKey &&
                  loadDraftSubmission(draftKey)?.attemptId ===
                    reviewed.attemptId
                )
                  saveDraftSubmission(draftKey, reviewed);
              } catch {
                setReviewError(true);
              }
            }}
          >
            Review conversation
          </Button>
          {reviewError ? (
            <p>Couldn’t refresh the conversation. Try reviewing it again.</p>
          ) : null}
          {uncertainSubmission.reviewed ? (
            <>
              <p>
                Discarding this draft does not remove any saved comment or
                uploaded file.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  if (draftKey)
                    clearDraft(draftKey, uncertainSubmission.attemptId);
                  bodyRef.current = "";
                  setBody("");
                  setComposerAttachments([]);
                  setUncertainSubmission(null);
                }}
              >
                Discard draft and start new
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      <MarkdownEditor
        ref={editorRef}
        readOnly={!!uncertainSubmission}
        value={body}
        onChange={changeBody}
        placeholder="Reply"
        mentions={mentions}
        onSubmit={handleSubmit}
        imageUploadHandler={
          canAcceptFiles
            ? async (file) => {
                const url = await attachFile(file, false);
                if (!url) throw new Error("Upload did not return a file URL");
                return url;
              }
            : undefined
        }
        fileDropTarget="parent"
        bordered={false}
        contentClassName="max-h-(--sz-28dvh) overflow-y-auto pr-1 pb-2 text-sm scrollbar-auto-hide"
      />

      {coachVisible && plainNameCandidate ? (
        <div className="mt-2">
          <ComposerMentionCoach
            candidate={plainNameCandidate}
            agentDisplayName={coachAgentName}
            onInsert={insertCoachMention}
            onDismiss={() =>
              setDismissedCoachToken(plainNameCandidate.matchedText)
            }
          />
        </div>
      ) : null}

      {composerHint ? (
        <div className="inline-flex items-center rounded-full border border-border/70 bg-muted/30 px-2 py-1 text-(length:--text-micro) text-muted-foreground">
          {composerHint}
        </div>
      ) : null}

      {composerAttachments.length > 0 ? (
        <div
          data-testid="issue-chat-composer-attachments"
          className="mb-3 mt-2 space-y-1.5 rounded-md border border-dashed border-border/80 bg-muted/20 p-2"
        >
          {composerAttachments.map((attachment) => {
            const sizeLabel = formatAttachmentSize(attachment.size);
            const statusLabel =
              attachment.status === "uploading"
                ? "Uploading to task"
                : attachment.status === "error"
                  ? (attachment.error ?? "Upload failed")
                  : attachment.inline
                    ? "Inserted inline"
                    : "Attached to task";
            return (
              <div
                key={attachment.id}
                className={cn(
                  "flex min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-xs",
                  attachment.status === "error"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-background/70 text-muted-foreground",
                )}
              >
                {attachment.status === "uploading" ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                ) : attachment.status === "attached" ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {attachment.name}
                </span>
                {sizeLabel ? (
                  <span className="shrink-0 text-muted-foreground">
                    {sizeLabel}
                  </span>
                ) : null}
                <span className="shrink-0 text-muted-foreground">
                  {statusLabel}
                </span>
                {!attachment.inline || attachment.status !== "attached" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${attachment.name}`}
                    disabled={!!uncertainSubmission}
                    onClick={() =>
                      setComposerAttachments((current) =>
                        current.filter((item) => item.id !== attachment.id),
                      )
                    }
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {shouldRenderComposerHandoffPreview(body, handoffPreview) ? (
        <div className="my-2">
          <ComposerHandoffPreviewRow
            preview={handoffPreview}
            resolvers={handoffResolvers}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="mr-auto flex items-center gap-2">
          {canAcceptFiles ? (
            <>
              <input
                ref={attachInputRef}
                type="file"
                className="hidden"
                onChange={handleAttachFile}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => attachInputRef.current?.click()}
                disabled={attaching}
                title="Attach file"
              >
                <PaperclipIcon className="h-4 w-4" />
              </Button>
            </>
          ) : null}
          {canToggleWorkMode ? (
            <Popover open={workModeMenuOpen} onOpenChange={setWorkModeMenuOpen}>
              <PopoverTrigger asChild>
                {/* Single persistent mode chip (PAP-95b mockup rev 5): yellow in
                    planning, neutral in standard, caret opens the switch menu. */}
                <button
                  type="button"
                  data-testid="issue-chat-composer-work-mode-toggle"
                  data-pending-work-mode={pendingWorkMode}
                  aria-haspopup="menu"
                  aria-expanded={workModeMenuOpen}
                  aria-pressed={pendingWorkMode !== "standard"}
                  aria-keyshortcuts="Meta+Period Control+Period"
                  title={titleForPendingWorkMode(pendingWorkMode)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-(length:--text-micro) font-semibold transition-colors",
                    pendingWorkModeMeta.classes.chip,
                  )}
                >
                  <PendingWorkModeIcon className="h-3.5 w-3.5" aria-hidden />
                  <span>{pendingWorkModeMeta.label}</span>
                  <ChevronDown className="h-3 w-3 opacity-60" aria-hidden />
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="w-44 p-1"
                align="start"
                data-testid="issue-chat-composer-work-mode-menu"
              >
                {workModeOptions.map((option) => {
                  const Icon = option.icon;
                  const active = option.value === pendingWorkMode;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      data-testid={`issue-chat-composer-work-mode-menu-${option.value}`}
                      data-pending-work-mode={pendingWorkMode}
                      className={cn(
                        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50",
                        active && "bg-accent",
                        option.classes.menuItem,
                      )}
                      onClick={() => {
                        setPendingWorkMode(option.value);
                        setWorkModeMenuOpen(false);
                      }}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      <span>{option.label}</span>
                      {active ? (
                        <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      ) : null}
                    </button>
                  );
                })}
                <div className="mt-1 border-t px-2 py-1.5 text-(length:--text-nano) text-muted-foreground">
                  Cmd/Ctrl+. cycles modes
                </div>
              </PopoverContent>
            </Popover>
          ) : null}
        </div>

        {enableReassign && reassignOptions.length > 0 ? (
          <InlineEntitySelector
            ref={reassignTriggerRef}
            value={reassignTarget}
            options={reassignOptions}
            placeholder="Responsible"
            noneLabel="No responsible"
            searchPlaceholder="Search responsible..."
            emptyMessage="No responsible found."
            onChange={setReassignTarget}
            className="h-8 text-xs"
            renderTriggerValue={(option) => {
              if (!option)
                return (
                  <span className="text-muted-foreground">Responsible</span>
                );
              const agentId = option.id.startsWith("agent:")
                ? option.id.slice("agent:".length)
                : null;
              const agent = agentId ? agentMap?.get(agentId) : null;
              return (
                <>
                  {agent ? (
                    <AgentAvatar agent={agent} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/>
                  ) : null}
                  <span className="truncate">{option.label}</span>
                </>
              );
            }}
            renderOption={(option) => {
              if (!option.id)
                return <span className="truncate">{option.label}</span>;
              const agentId = option.id.startsWith("agent:")
                ? option.id.slice("agent:".length)
                : null;
              const agent = agentId ? agentMap?.get(agentId) : null;
              return (
                <>
                  {agent ? (
                    <AgentAvatar agent={agent} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/>
                  ) : null}
                  <span className="truncate">{option.label}</span>
                </>
              );
            }}
          />
        ) : null}

        {showStop ? (
          <Button
            size="icon-sm"
            disabled={stopControl.stopping}
            onClick={() => void stopControl.stop()}
            aria-label={stopControl.stopping ? "Stopping…" : "Stop"}
            title="Stop response"
          >
            {stopControl.stopping ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Square className="h-4 w-4 fill-current" aria-hidden />
            )}
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={!canSubmit}
            onClick={() => void handleSubmit()}
          >
            {submitting ? "Posting..." : "Send"}
          </Button>
        )}
      </div>

      {stopControl.error ? (
        <p role="alert" className="text-xs text-destructive">
          {stopControl.error}
        </p>
      ) : null}

      {/* No-assignee warning modal (PAP-128 C): replaces the old press-Send-again toast. */}
      <AlertDialog
        open={noAssigneeDialogOpen}
        onOpenChange={setNoAssigneeDialogOpen}
      >
        <AlertDialogContent
          data-testid="issue-chat-no-assignee-dialog"
          onCloseAutoFocus={(event) => {
            if (!focusAssigneeOnDialogCloseRef.current) return;
            event.preventDefault();
            focusAssigneeOnDialogCloseRef.current = false;
            reassignTriggerRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>No responsible selected</AlertDialogTitle>
            <AlertDialogDescription>
              This comment will be posted without an assignee, so no agent will
              be woken to act on it. Go back to pick a responsible, or send
              anyway.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              data-testid="issue-chat-no-assignee-go-back"
              onClick={() => {
                focusAssigneeOnDialogCloseRef.current = true;
              }}
            >
              Go back
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="issue-chat-no-assignee-send-anyway"
              onClick={() => {
                void submitComment();
              }}
            >
              Send anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
});
