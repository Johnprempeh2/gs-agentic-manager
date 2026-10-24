import { useQuery } from "@tanstack/react-query";
import { CircleAlert, Clock, LoaderCircle } from "lucide-react";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { Link } from "@/lib/router";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import {
  describeTaskRunState,
  refreshTaskRunState,
  type TaskRunState,
} from "../lib/task-run-state";
import { useSecondTick } from "../hooks/useSecondTick";
import { cn } from "../lib/utils";

export interface TaskRunStateChipProps {
  state: TaskRunState;
  /**
   * `compact` for rows and tree nodes: the chip only, the why in its tooltip.
   * `full` for the task header: the chip, then the why with a link to the
   * blocking task.
   */
  variant?: "compact" | "full";
  /** "GRE-2217" for a task id, when the caller knows it. */
  issueLabel?: (issueId: string) => string | null | undefined;
  /** Hide the chip text below `sm`, leaving the icon (dense rows on phones). */
  hideLabelOnPhone?: boolean;
  className?: string;
}

const TONE: Record<TaskRunState["kind"], string> = {
  running: "bg-status-running-soft text-status-running-foreground",
  queued: "border-border bg-transparent text-muted-foreground",
  stuck: "bg-status-warning-soft text-status-warning-foreground",
};

/**
 * Whether a task's agent is working, queued or silent (GRE-2246). Only a
 * running run spins; a queued run is a calm clock that says why it waits.
 */
export function TaskRunStateChip(props: TaskRunStateChipProps) {
  return props.variant === "full" ? <FullTaskRunState {...props} /> : <CompactTaskRunState {...props} />;
}

/** The state re-read against a shared one-second clock while a run is going. */
function useLiveRunState(derived: TaskRunState): { state: TaskRunState; now: number } {
  useSecondTick(derived.kind !== "queued");
  const now = Date.now();
  return { state: refreshTaskRunState(derived, now), now };
}

function CompactTaskRunState({ state: derived, issueLabel, hideLabelOnPhone = false, className }: TaskRunStateChipProps) {
  const { state, now } = useLiveRunState(derived);
  const copy = describeTaskRunState(state, { now, issueLabel });
  return (
    <RunStateChip
      state={state}
      label={copy.label}
      title={copy.detail ? `${copy.label} · ${copy.detail}` : copy.label}
      srDetail={copy.detail}
      hideLabelOnPhone={hideLabelOnPhone}
      className={className}
    />
  );
}

function FullTaskRunState({ state: derived, issueLabel, hideLabelOnPhone = false, className }: TaskRunStateChipProps) {
  const { state, now } = useLiveRunState(derived);

  // Link the blocking task by name; look it up when the caller cannot.
  const blockingIssueId =
    state.kind === "queued" && state.reason.kind === "behind" ? state.reason.blockingIssueId : null;
  const knownLabel = blockingIssueId ? issueLabel?.(blockingIssueId) ?? null : null;
  const { data: blockingIssue } = useQuery({
    queryKey: queryKeys.issues.detail(blockingIssueId ?? "none"),
    queryFn: () => issuesApi.get(blockingIssueId!),
    enabled: !!blockingIssueId && !knownLabel,
    staleTime: 60_000,
  });
  const resolvedLabel = knownLabel ?? blockingIssue?.identifier ?? null;
  const labelFor = (issueId: string) => (issueId === blockingIssueId ? resolvedLabel : issueLabel?.(issueId));
  const copy = describeTaskRunState(state, { now, issueLabel: labelFor });

  return (
    <span
      className={cn("inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground sm:flex-nowrap", className)}
      data-testid="task-run-state"
    >
      <RunStateChip state={state} label={copy.label} hideLabelOnPhone={hideLabelOnPhone} />
      {copy.detail ? <RunStateDetail detail={copy.detail} blockingIssueId={copy.blockingIssueId} issueLabel={labelFor} /> : null}
    </span>
  );
}

function RunStateChip({
  state,
  label,
  title,
  srDetail,
  hideLabelOnPhone,
  className,
}: {
  state: TaskRunState;
  label: string;
  title?: string;
  srDetail?: string | null;
  hideLabelOnPhone?: boolean;
  className?: string;
}) {
  const Icon = state.kind === "running" ? LoaderCircle : state.kind === "stuck" ? CircleAlert : Clock;
  return (
    <span
      data-testid="task-run-state-chip"
      data-run-state={state.kind}
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border border-transparent px-1.5 py-0.5 text-(length:--text-micro) font-medium whitespace-nowrap sm:px-2",
        TONE[state.kind],
        className,
      )}
    >
      <Icon
        className={cn("size-3 shrink-0", state.kind === "running" && "motion-safe:animate-spin")}
        aria-hidden="true"
      />
      <span className={cn(hideLabelOnPhone && "sr-only sm:not-sr-only")}>{label}</span>
      {srDetail ? <span className="sr-only">: {srDetail}</span> : null}
    </span>
  );
}

function RunStateDetail({
  detail,
  blockingIssueId,
  issueLabel,
}: {
  detail: string;
  blockingIssueId: string | null;
  issueLabel?: (issueId: string) => string | null | undefined;
}) {
  const label = blockingIssueId ? issueLabel?.(blockingIssueId) ?? "another task" : null;
  const at = label ? detail.indexOf(label) : -1;
  if (!blockingIssueId || !label || at < 0) {
    return <span className="min-w-0 sm:truncate" title={detail}>{detail}</span>;
  }
  return (
    <span className="min-w-0 sm:truncate" title={detail}>
      {detail.slice(0, at)}
      <Link
        to={createIssueDetailPath(blockingIssueId)}
        className="font-medium text-foreground underline-offset-2 hover:underline focus-visible:underline"
      >
        {label}
      </Link>
      {detail.slice(at + label.length)}
    </span>
  );
}
