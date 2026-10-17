import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  MinusCircle,
  PaperclipIcon,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { decisionEffectTargetIssueIds, type DecisionEffect, type DecisionOption } from "@greatstone/shared";
import type {
  Decision,
  DecisionEffectExecution,
  DecisionTargetSnapshot,
} from "../api/decisions";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { MarkdownBody } from "./MarkdownBody";
import { useFileIntake } from "../hooks/useFileIntake";

/**
 * Presentational card for a single Decisions-v1 decision (PAP-14966 / PAP-14939
 * §4), modeled on {@link IssueThreadInteractionCard}. It renders every state —
 * pending / stale-target / destructive cancel-tree / decided / partial / failed
 * / expired / cancelled / dismissed — and delegates the actual decide / dismiss
 * mutations to the parent (the feed's `DecisionResolver`, or the history view).
 * It never fetches: issue labels + the cancel-tree preview arrive via resolvers
 * so the same component drives the live feed and the screenshot harness.
 */

export interface DecisionIssueRef {
  id: string;
  identifier: string | null;
  title: string | null;
  href: string;
  status?: string | null;
}

export interface DecisionCardProps {
  decision: Decision;
  /** Per-effect execution rows (present once decided). */
  executions?: DecisionEffectExecution[] | null;
  /** Which target issues drifted since the snapshot (open decisions only). */
  targetChanged?: Record<string, boolean> | null;
  /** Resolve an issue id to a display ref (identifier / title / link). */
  resolveIssue?: (issueId: string) => DecisionIssueRef | null;
  /** Full sub-tree that a `cancel_issue_tree` option would cancel. */
  cancelTreePreview?: (targetIssueId: string) => DecisionIssueRef[] | null;
  originAgentName?: string | null;
  originIssue?: DecisionIssueRef | null;
  runHref?: string | null;
  busy?: boolean;
  errorMessage?: string | null;
  onDecide?: (optionId: string, inputValues: Record<string, string>) => void;
  onDismiss?: (reason?: string) => void;
  /**
   * Upload a file the person attaches to an answer and return where it lives.
   * When set, each answer box takes a picked, dropped or pasted file and adds
   * a link to it in the answer.
   */
  onUploadFile?: (file: File) => Promise<{ name: string; href: string; isImage?: boolean }>;
  className?: string;
}

// --- small helpers ----------------------------------------------------------

function humanStatus(status: string | null | undefined): string {
  if (!status) return "unknown";
  return status.replaceAll("_", " ");
}

function issueLabel(ref: DecisionIssueRef | null, fallbackId: string): string {
  if (ref?.identifier) return ref.identifier;
  if (ref?.title) return ref.title;
  void fallbackId;
  return "a task";
}

function pluralize(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function isDestructiveOption(option: DecisionOption): boolean {
  return option.style === "destructive" || option.effects.some((effect) => effect.type === "cancel_issue_tree");
}

function cancelTreeEffect(option: DecisionOption): Extract<DecisionEffect, { type: "cancel_issue_tree" }> | null {
  return (option.effects.find((effect) => effect.type === "cancel_issue_tree") ?? null) as
    | Extract<DecisionEffect, { type: "cancel_issue_tree" }>
    | null;
}

/** One-line feed-forward preview of what an effect will do, before you commit. */
function effectSummary(
  effect: DecisionEffect,
  resolve: (id: string) => DecisionIssueRef | null,
  snapshots: Record<string, DecisionTargetSnapshot>,
): string {
  const target = issueLabel(resolve(effect.targetIssueId), effect.targetIssueId);
  switch (effect.type) {
    case "comment_on_issue":
      return `Comment on ${target}`;
    case "create_issue": {
      const parent = effect.draft.parentId
        ? issueLabel(resolve(effect.draft.parentId), effect.draft.parentId)
        : target;
      return `Create issue “${effect.draft.title}” under ${parent}`;
    }
    case "update_issue_status":
      return `Set ${target} to ${humanStatus(effect.status)}`;
    case "assign_issue":
      return `Reassign ${target}`;
    case "resolve_blocker":
      return `Unblock ${target}: remove ${pluralize(effect.removeBlockedByIssueIds.length, "blocker")}`;
    case "cancel_issue_tree": {
      const snapshot = snapshots[effect.targetIssueId];
      const descendantCount = snapshot?.descendantCount ?? snapshot?.descendantIds?.length ?? snapshot?.childCount ?? 0;
      return `Cancel ${target} and its sub-tree (${pluralize(descendantCount + 1, "issue")})`;
    }
    default:
      return "Apply effect";
  }
}

const FAILURE_CAUSE: Record<string, string> = {
  deny_decision_intersection: "blocked by the permission boundary (fail-closed)",
  invalid_effect_reference: "a referenced issue no longer exists",
  target_changed: "the target changed since this was proposed",
  effect_execution_failed: "the effect errored while running",
};

interface ResultRow {
  key: string;
  status: DecisionEffectExecution["status"];
  summary: string;
  link: DecisionIssueRef | null;
}

function executionRow(
  execution: DecisionEffectExecution,
  resolve: (id: string) => DecisionIssueRef | null,
): ResultRow {
  const targetRef = resolve(execution.targetIssueId);
  const target = issueLabel(targetRef, execution.targetIssueId);
  const result = execution.result ?? {};
  if (execution.status === "skipped") {
    return { key: execution.id, status: "skipped", summary: `Skipped ${target}: target changed since proposal`, link: targetRef };
  }
  if (execution.status === "failed") {
    const cause = FAILURE_CAUSE[execution.error ?? ""] ?? execution.error ?? "the effect could not run";
    return { key: execution.id, status: "failed", summary: `Failed on ${target}: ${cause}`, link: targetRef };
  }
  if (execution.status === "claimed") {
    return { key: execution.id, status: "claimed", summary: `Running on ${target}…`, link: targetRef };
  }
  // executed
  switch (execution.effectType) {
    case "comment_on_issue":
      return { key: execution.id, status: "executed", summary: `Commented on ${target}`, link: targetRef };
    case "create_issue": {
      const createdId = typeof result.issueId === "string" ? result.issueId : null;
      const created = createdId ? resolve(createdId) : null;
      return {
        key: execution.id,
        status: "executed",
        summary: `Created ${created ? issueLabel(created, createdId!) : "a new task"}`,
        link: created ?? targetRef,
      };
    }
    case "update_issue_status":
      return { key: execution.id, status: "executed", summary: `Set ${target} to ${humanStatus(typeof result.status === "string" ? result.status : null)}`, link: targetRef };
    case "assign_issue":
      return { key: execution.id, status: "executed", summary: `Reassigned ${target}`, link: targetRef };
    case "resolve_blocker": {
      const removed = Array.isArray(result.removedBlockedByIssueIds) ? result.removedBlockedByIssueIds.length : 0;
      return { key: execution.id, status: "executed", summary: `Removed ${pluralize(removed, "blocker")} from ${target}`, link: targetRef };
    }
    case "cancel_issue_tree": {
      const cancelled = Array.isArray(result.cancelledIssueIds) ? result.cancelledIssueIds.length : 0;
      return { key: execution.id, status: "executed", summary: `Cancelled ${pluralize(cancelled, "issue")} under ${target}`, link: targetRef };
    }
    default:
      return { key: execution.id, status: "executed", summary: `Applied effect on ${target}`, link: targetRef };
  }
}

// --- shell / badge palette (matches IssueThreadInteractionCard) --------------

type CardTone = "pending" | "destructive" | "success" | "partial" | "failed" | "neutral";

const SHELL: Record<CardTone, string> = {
  pending: "border-sky-500/70",
  destructive: "border-2 border-rose-500/80",
  success: "border-emerald-400/70",
  partial: "border-amber-400/70",
  failed: "border-rose-400/70",
  neutral: "border-border/60",
};

const BADGE: Record<CardTone, string> = {
  pending: "border-sky-500/60 bg-sky-500/10 text-sky-900 dark:bg-sky-500/15 dark:text-sky-100",
  destructive: "border-rose-500/60 bg-rose-500/10 text-rose-800 dark:bg-rose-500/15 dark:text-rose-100",
  success: "border-emerald-500/60 bg-emerald-500/10 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-100",
  partial: "border-amber-500/60 bg-amber-500/10 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100",
  failed: "border-rose-500/60 bg-rose-500/10 text-rose-800 dark:bg-rose-500/15 dark:text-rose-100",
  neutral: "border-border/70 bg-muted/50 text-muted-foreground",
};

function IssueLink({ ref: link }: { ref: DecisionIssueRef | null }) {
  if (!link) return null;
  return (
    <a
      href={link.href}
      className="inline-flex items-center gap-1 rounded-sm border border-border/70 bg-background px-1.5 py-0.5 text-xs font-medium text-foreground hover:border-sky-500/70 hover:text-sky-700 dark:hover:text-sky-300"
    >
      {issueLabel(link, link.id)}
      <ExternalLink className="h-3 w-3" aria-hidden />
    </a>
  );
}

const RESULT_ICON: Record<ResultRow["status"], ReactNode> = {
  executed: <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />,
  failed: <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" aria-hidden />,
  skipped: <MinusCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />,
  claimed: <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />,
};

type DecisionInputDef = NonNullable<Decision["inputs"]>[number];

function attachmentMarkdown(file: { name: string; href: string; isImage?: boolean }) {
  const label = file.name.replace(/[[\]]/g, "");
  return `${file.isImage ? "!" : ""}[${label}](${file.href})`;
}

function DecisionInputField({
  field,
  value,
  onChange,
  onUploadFile,
  onUploadingChange,
}: {
  field: DecisionInputDef;
  value: string;
  onChange: (update: (previous: string) => string) => void;
  onUploadFile?: DecisionCardProps["onUploadFile"];
  onUploadingChange: (delta: number) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const upload = async (files: File[]) => {
    if (!onUploadFile) return;
    setUploadError(null);
    for (const file of files) {
      setUploading((count) => count + 1);
      onUploadingChange(1);
      try {
        const stored = await onUploadFile(file);
        const link = attachmentMarkdown(stored);
        onChange((previous) => (previous.trim() ? `${previous.replace(/\s+$/, "")}\n${link}` : link));
      } catch (error) {
        setUploadError(`Could not attach ${file.name}. ${error instanceof Error ? error.message : "Try again."}`);
      } finally {
        setUploading((count) => count - 1);
        onUploadingChange(-1);
      }
    }
  };

  const intake = useFileIntake((files) => void upload(files), { disabled: !onUploadFile });
  const { tabIndex: _tabIndex, ...dropProps } = intake.targetProps;

  return (
    <div
      {...(onUploadFile ? dropProps : {})}
      data-testid={`decision-input-${field.id}`}
      data-dragging={intake.dragging || undefined}
      className={cn("block rounded-md transition-colors", intake.dragging && "bg-accent ring-2 ring-primary")}
    >
      <label className="block">
        <span className="text-xs font-medium text-muted-foreground">
          {field.label}
          {field.required && <span className="text-rose-500"> *</span>}
        </span>
        <Textarea
          value={value}
          onChange={(event) => {
            const next = event.target.value;
            onChange(() => next);
          }}
          placeholder={field.placeholder ?? undefined}
          maxLength={field.maxLength ?? undefined}
          className="mt-1 min-h-16 bg-background text-sm"
        />
      </label>
      {onUploadFile && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={uploading > 0}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading > 0 ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <PaperclipIcon className="mr-1 h-3.5 w-3.5" aria-hidden />
            )}
            {uploading > 0 ? "Attaching" : "Attach a file"}
          </Button>
          <span>or drop or paste one into the box</span>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            aria-label={`Attach a file to ${field.label}`}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              void upload(files);
            }}
          />
        </div>
      )}
      {uploadError && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {uploadError}
        </p>
      )}
    </div>
  );
}

export function DecisionCard({
  decision,
  executions,
  targetChanged,
  resolveIssue = () => null,
  cancelTreePreview,
  originAgentName,
  originIssue,
  runHref,
  busy = false,
  errorMessage,
  onDecide,
  onDismiss,
  onUploadFile,
  className,
}: DecisionCardProps) {
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [uploadingCount, setUploadingCount] = useState(0);
  const [confirmOptionId, setConfirmOptionId] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");

  const open = decision.status === "open";
  const dismissed =
    decision.chosenOptionId === "dismissed" || (decision.metadata as { dismissed?: boolean } | null)?.dismissed === true;
  const snapshots = (decision.targetSnapshots ?? {}) as Record<string, DecisionTargetSnapshot>;

  const staleTargetIds = useMemo(
    () => (open ? Object.entries(targetChanged ?? {}).filter(([, changed]) => changed).map(([id]) => id) : []),
    [open, targetChanged],
  );
  const staleTargetIdSet = useMemo(() => new Set(staleTargetIds), [staleTargetIds]);
  const isStale = staleTargetIds.length > 0;
  const hasCancelTree = decision.options.some((option) => option.effects.some((effect) => effect.type === "cancel_issue_tree"));

  const tone: CardTone = open
    ? hasCancelTree
      ? "destructive"
      : "pending"
    : decision.status !== "decided"
      ? "neutral" // expired / cancelled
      : dismissed
        ? "neutral"
        : decision.executionStatus === "succeeded"
          ? "success"
          : decision.executionStatus === "partial"
            ? "partial"
            : "failed";

  const badgeLabel = open
    ? "Pending"
    : decision.status === "expired"
      ? "Expired"
      : decision.status === "cancelled"
        ? "Cancelled"
        : dismissed
          ? "Dismissed"
          : decision.executionStatus === "succeeded"
            ? "Decided"
            : decision.executionStatus === "partial"
              ? "Partial"
              : "Failed";

  const requiredUnmet = (decision.inputs ?? []).some(
    (field) => field.required && !(inputValues[field.id] ?? "").trim(),
  );

  const runOption = (option: DecisionOption) => {
    if (busy) return;
    const cancelTree = cancelTreeEffect(option);
    if (cancelTree && confirmOptionId !== option.id) {
      setConfirmOptionId(option.id);
      setConfirmText("");
      return;
    }
    onDecide?.(option.id, inputValues);
  };

  const dimmed = decision.status === "expired" || decision.status === "cancelled";
  const expiredReason = (decision.metadata as { expiredReason?: string } | null)?.expiredReason;

  // The issues this decision acts on. The origin issue is only where the agent
  // was running when it proposed the decision — the queue links there, but the
  // decision may target a different issue entirely, so name the targets
  // explicitly or the card is undiscoverable from the issue it applies to.
  const targetRefs = useMemo(() => {
    const ids = new Set<string>();
    for (const option of decision.options) {
      for (const effect of option.effects) {
        for (const id of decisionEffectTargetIssueIds(effect)) ids.add(id);
      }
    }
    if (originIssue?.id) ids.delete(originIssue.id);
    return [...ids].map((id) => ({ id, ref: resolveIssue(id) }));
  }, [decision.options, originIssue?.id, resolveIssue]);

  return (
    <div
      className={cn(
        "rounded-xl border bg-card p-4 text-sm",
        SHELL[tone],
        dimmed && "opacity-80",
        className,
      )}
      data-decision-state={badgeLabel.toLowerCase()}
    >
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="min-w-0 flex-1 text-base font-semibold text-foreground">{decision.title}</h3>
        <div className="flex shrink-0 items-center gap-1.5">
          {open && hasCancelTree && (
            <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-(length:--text-micro) font-semibold uppercase tracking-wide", BADGE.destructive)}>
              <ShieldAlert className="h-3 w-3" aria-hidden /> Destructive
            </span>
          )}
          <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-(length:--text-micro) font-semibold uppercase tracking-wide", BADGE[tone])}>
            {badgeLabel}
          </span>
        </div>
      </div>

      {/* Provenance */}
      <p className="mt-1 text-xs text-muted-foreground">
        Proposed by <span className="font-medium text-foreground">{originAgentName ?? "an agent"}</span>
        {originIssue && (
          <>
            {" "}while running{" "}
            <a href={originIssue.href} className="font-medium text-primary underline-offset-2 hover:underline">
              {issueLabel(originIssue, originIssue.id)}
            </a>
          </>
        )}
        {targetRefs.length > 0 && (
          <>
            {" · applies to "}
            {targetRefs.map(({ id, ref }, index) => (
              <span key={id}>
                {index > 0 && ", "}
                {ref ? (
                  <a href={ref.href} className="font-medium text-primary underline-offset-2 hover:underline">
                    {issueLabel(ref, id)}
                  </a>
                ) : (
                  <span className="font-medium text-foreground">{issueLabel(null, id)}</span>
                )}
              </span>
            ))}
          </>
        )}
        {runHref && (
          <>
            {" · "}
            <a href={runHref} className="hover:underline">see what the agent did</a>
          </>
        )}
      </p>

      {/* Body */}
      {decision.body?.trim() && (
        <div className="mt-3 text-sm leading-6 text-foreground">
          <MarkdownBody>{decision.body}</MarkdownBody>
        </div>
      )}

      {/* Stale-target warning (open only) */}
      {open && isStale && (
        <div className="mt-3 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2">
          <div className="flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            {pluralize(staleTargetIds.length, "task")} changed since this was asked
          </div>
          <ul className="mt-1.5 space-y-1 text-xs text-amber-900/90 dark:text-amber-100/90">
            {staleTargetIds.map((id) => {
              const ref = resolveIssue(id);
              const from = snapshots[id];
              return (
                <li key={id} className="flex flex-wrap items-center gap-1">
                  <span className="font-medium">{issueLabel(ref, id)}:</span>
                  <span className="tabular-nums">{humanStatus(from?.status)}</span>
                  <ArrowRight className="h-3 w-3" aria-hidden />
                  <span className="tabular-nums">{humanStatus(ref?.status) || "changed"}</span>
                </li>
              );
            })}
          </ul>
          <p className="mt-1.5 text-xs text-amber-800/80 dark:text-amber-200/80">
            Options that require an unchanged target are disabled below.
          </p>
        </div>
      )}

      {/* Inputs (open only) */}
      {open && (decision.inputs ?? []).length > 0 && (
        <div className="mt-3 space-y-2">
          {(decision.inputs ?? []).map((field) => (
            <DecisionInputField
              key={field.id}
              field={field}
              value={inputValues[field.id] ?? ""}
              onChange={(update) =>
                setInputValues((prev) => ({ ...prev, [field.id]: update(prev[field.id] ?? "") }))
              }
              onUploadFile={onUploadFile}
              onUploadingChange={(delta) => setUploadingCount((count) => count + delta)}
            />
          ))}
        </div>
      )}

      {/* Options (open only) */}
      {open && (
        <div className="mt-3 space-y-2">
          {decision.options.map((option) => {
            const destructive = isDestructiveOption(option);
            const blockedStale = option.effects.some(
              (effect) => effect.staleness === "strict" && decisionEffectTargetIssueIds(effect).some((id) => staleTargetIdSet.has(id)),
            );
            const disabled = busy || uploadingCount > 0 || requiredUnmet || blockedStale;
            const cancelTree = cancelTreeEffect(option);
            const confirming = confirmOptionId === option.id;
            const previewRows = cancelTree && cancelTreePreview ? cancelTreePreview(cancelTree.targetIssueId) : null;
            const confirmRef = cancelTree ? resolveIssue(cancelTree.targetIssueId) : null;
            const confirmToken = confirmRef?.identifier ?? confirmRef?.id ?? cancelTree?.targetIssueId ?? "";
            return (
              <div key={option.id} className="space-y-2">
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => runOption(option)}
                  className={cn(
                    "w-full rounded-sm border px-4 py-3 text-left transition-colors outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50",
                    disabled && "cursor-not-allowed text-subtle-foreground",
                    destructive
                      ? "border-rose-500/70 bg-rose-500/5 text-foreground hover:border-rose-500 hover:bg-rose-500/10"
                      : "border-border/70 bg-field text-foreground hover:border-sky-500/70 hover:bg-sky-500/10",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={cn("text-sm font-medium", destructive && "text-rose-700 dark:text-rose-300")}>
                      {option.label}
                    </span>
                    {blockedStale && (
                      <span className="shrink-0 rounded-full border border-amber-500/60 bg-amber-500/10 px-2 py-0.5 text-(length:--text-micro) font-medium text-amber-800 dark:text-amber-200">
                        Out of date
                      </span>
                    )}
                  </div>
                  {option.description && (
                    <div className="mt-1 text-sm leading-6 text-muted-foreground">{option.description}</div>
                  )}
                  {option.effects.length > 0 && (
                    <ul className="mt-2 space-y-0.5">
                      {option.effects.map((effect, index) => (
                        <li
                          key={index}
                          className={cn(
                            "flex items-start gap-1.5 text-xs",
                            effect.type === "cancel_issue_tree" ? "text-rose-700 dark:text-rose-300" : "text-muted-foreground",
                          )}
                        >
                          <ArrowRight className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                          {effectSummary(effect, resolveIssue, snapshots)}
                        </li>
                      ))}
                    </ul>
                  )}
                </button>

                {/* Destructive cancel-tree confirm gate */}
                {confirming && cancelTree && (
                  <div className="rounded-lg border border-rose-500/50 bg-rose-500/5 p-3">
                    <div className="flex items-center gap-2 text-sm font-semibold text-rose-700 dark:text-rose-300">
                      <Ban className="h-4 w-4" aria-hidden /> This cancels this task and every task under it
                    </div>
                    {previewRows && previewRows.length > 0 ? (
                      <>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {pluralize(previewRows.length, "task")} will be cancelled:
                        </p>
                        <ul className="mt-1 max-h-40 space-y-0.5 overflow-auto text-xs">
                          {previewRows.map((row) => (
                            <li key={row.id} className="flex items-center gap-1.5">
                              <Ban className="h-3 w-3 shrink-0 text-rose-500" aria-hidden />
                              <span className="font-medium">{issueLabel(row, row.id)}</span>
                              {row.title && row.identifier && (
                                <span className="truncate text-muted-foreground">{row.title}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <p className="mt-1 text-xs text-muted-foreground">
                        This task and every task under it will be cancelled.
                      </p>
                    )}
                    <p className="mt-2 text-xs text-muted-foreground">
                      Type <span className="font-mono font-medium text-foreground">{confirmToken}</span> to confirm.
                    </p>
                    <Input
                      value={confirmText}
                      onChange={(event) => setConfirmText(event.target.value)}
                      placeholder={confirmToken}
                      aria-label="Type the task number to confirm"
                      autoFocus
                      className="mt-1"
                    />
                    <div className="mt-2 flex justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setConfirmOptionId(null);
                          setConfirmText("");
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={busy || confirmText.trim() !== confirmToken}
                        onClick={() => onDecide?.(option.id, inputValues)}
                      >
                        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                        {previewRows ? `Cancel ${pluralize(previewRows.length, "task")}` : "Cancel these tasks"}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Always-present zero-effect Dismiss (telemetered "no", distinct from expiry) */}
          {!decision.options.some((option) => option.effects.length === 0) && (
            <div className="flex items-center justify-between gap-2 pt-1">
              <span className="text-xs text-muted-foreground">None of these? Close it and nothing happens.</span>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => onDismiss?.()}>
                Dismiss
              </Button>
            </div>
          )}
          {errorMessage && <p className="text-xs text-rose-600 dark:text-rose-400">{errorMessage}</p>}
        </div>
      )}

      {/* Terminal states */}
      {!open && (
        <div className="mt-3 space-y-2">
          {decision.status === "expired" && (
            <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-2 font-medium text-foreground">
                <Clock className="h-4 w-4" aria-hidden /> The decision window closed
              </div>
              <p className="mt-1">
                {expiredReason === "target_gone"
                  ? "A task this was about was cancelled before anyone decided."
                  : expiredReason === "target_completed"
                    ? "The tasks this was about were finished before anyone decided."
                    : "Nobody answered before the deadline."}
                {decision.continuationPolicy === "wake_origin_agent" && " The agent that asked has been told."}
              </p>
            </div>
          )}
          {decision.status === "cancelled" && (
            <p className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              The agent withdrew this before anyone answered.
            </p>
          )}
          {decision.status === "decided" && dismissed && (
            <p className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              Dismissed. Nothing was changed.
            </p>
          )}
          {decision.status === "decided" && !dismissed && (executions ?? []).length > 0 && (
            <>
              <ul className="space-y-1.5">
                {(executions ?? []).map((execution) => {
                  const row = executionRow(execution, resolveIssue);
                  return (
                    <li key={row.key} className="flex items-start gap-2">
                      {RESULT_ICON[row.status]}
                      <span className="min-w-0 flex-1 text-sm text-foreground">{row.summary}</span>
                      <IssueLink ref={row.link} />
                    </li>
                  );
                })}
              </ul>
              {decision.executionStatus !== "succeeded" && (
                <p className="text-xs text-muted-foreground">
                  Some effects may already have been applied. Review the results before asking the proposer to re-propose.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
