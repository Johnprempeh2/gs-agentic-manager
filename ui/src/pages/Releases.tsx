import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, Check, Loader2, Rocket, RotateCcw, ShieldAlert } from "lucide-react";
import {
  releasesApi,
  FINAL_RELEASE_STATES,
  type FlaggedRun,
  type ReleaseCheckStatus,
  type ReleaseHealth,
  type ReleaseProgress,
  type ReleaseProgressState,
  type ReleasesOverview,
  type RestartReport,
} from "@/api/releases";
import { agentsApi } from "@/api/agents";
import { heartbeatsApi } from "@/api/heartbeats";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ReleaseChangelog } from "@/components/ReleaseChangelog";
import { PageSkeleton } from "@/components/PageSkeleton";
import { ReauthCancelledError, useReauth } from "@/components/ReauthDialog";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useConfirm } from "@/context/ConfirmContext";
import { isReleaseInProgress, useCanRelease, useReleases } from "@/hooks/useReleases";
import { queryKeys } from "@/lib/queryKeys";
import { cn, formatDateTime } from "@/lib/utils";

type ChipTone = "done" | "blocked" | "todo" | "backlog" | "in_progress";

/** Status chip on the shared `.status-chip` recipe and task status hues. */
function ReleaseChip({ tone, children }: { tone: ChipTone; children: string }) {
  return (
    <span
      className="status-chip inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap"
      style={{ "--sc": `var(--status-task-${tone})` } as CSSProperties}
    >
      {children}
    </span>
  );
}

const HEALTH_TONE: Record<ReleaseHealth, ChipTone> = { healthy: "done", unhealthy: "blocked", unknown: "backlog" };
const HEALTH_LABEL: Record<ReleaseHealth, string> = { healthy: "Healthy", unhealthy: "Unhealthy", unknown: "Health unknown" };
const CHECK_TONE: Record<ReleaseCheckStatus, ChipTone> = { passed: "done", failed: "blocked", pending: "todo", unknown: "backlog" };
const CHECK_LABEL: Record<ReleaseCheckStatus, string> = { passed: "passed", failed: "failed", pending: "running", unknown: "unknown" };

function shortId(value: string) {
  return value.slice(0, 7);
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm text-foreground">{children}</dd>
    </div>
  );
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** "agent:<id>" / "user:<id>" as a name John recognises. */
function actorLabel(by: string | null, agentNames: Map<string, string>): string | null {
  if (!by) return null;
  const [type, id] = by.split(":", 2);
  if (type === "agent") return (id && agentNames.get(id)) ?? "an agent";
  return "the board";
}

// ── Restart report ──────────────────────────────────────────────────────────

/** Which runs went on after the update and which were lost. */
export function RestartReportSummary({ report }: { report: RestartReport }) {
  const resumed = report.resumedRunIds.length;
  const lost = report.lostRunIds;
  const parts = [
    report.adoptedRunIds.length ? `${report.adoptedRunIds.length} kept running` : null,
    report.finishedWhileDownRunIds.length ? `${report.finishedWhileDownRunIds.length} continued from a checkpoint` : null,
  ].filter(Boolean);
  return (
    <div className="space-y-1 text-sm" data-testid="restart-report">
      <p className="text-foreground">
        {resumed === 0 ? "No runs needed to resume." : `${plural(resumed, "run")} resumed after the update`}
        {resumed > 0 && parts.length ? ` (${parts.join(", ")}).` : resumed > 0 ? "." : ""}
      </p>
      {lost.length === 0 ? (
        <p className="text-muted-foreground">Nothing was lost.</p>
      ) : (
        <p className="text-destructive">
          {plural(lost.length, "run")} lost (needs recovery):{" "}
          {lost.map((id, index) => (
            <span key={id}>
              {index > 0 ? ", " : ""}
              <span className="font-mono text-xs">{shortId(id)}</span>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

// ── Progress ────────────────────────────────────────────────────────────────

const STEPS: { state: ReleaseProgressState; label: string }[] = [
  { state: "checking", label: "Checking" },
  { state: "holding", label: "Holding new runs" },
  { state: "switching", label: "Switching" },
  { state: "restarting", label: "Restarting" },
  { state: "healthy", label: "Healthy" },
];

function progressTarget(progress: ReleaseProgress): string {
  if (progress.targetTitle && progress.targetTag) return `${progress.targetTitle} (${progress.targetTag})`;
  return progress.targetTitle ?? progress.targetTag ?? "the next version";
}

function progressHeadline(progress: ReleaseProgress): string {
  const target = progressTarget(progress);
  const verb = progress.kind === "rollback" ? "Rolling back to" : "Releasing";
  switch (progress.state) {
    case "checking":
      return `${verb} ${target}: checking`;
    case "holding": {
      const n = progress.waitingForFlaggedRuns ?? 0;
      if (progress.overridden) return `${verb} ${target}: holding new runs, not waiting for flagged runs`;
      if (n === 0) return `${verb} ${target}: holding new runs`;
      return `${verb} ${target}: holding new runs, waiting for ${plural(n, "run")} marked finish before update`;
    }
    case "switching":
      return `${verb} ${target}: switching live`;
    case "restarting":
      return `${verb} ${target}: restarting live`;
    case "healthy":
      return `${target} is live and healthy`;
    case "rolled_back":
      return `Rolled back. ${target} did not go live`;
    case "failed":
      return `${progress.kind === "rollback" ? "Rollback" : "Release"} of ${target} failed`;
    case "cancelled":
      return `Cancelled. Live was not changed`;
  }
}

function FlaggedRunLine({ run, agentNames }: { run: FlaggedRun; agentNames: Map<string, string> }) {
  // An agent usually flags its own run; name it even when the agent list lacks it.
  const by =
    run.flaggedBy === `agent:${run.agentId}` && run.agentName
      ? run.agentName
      : actorLabel(run.flaggedBy, agentNames);
  return (
    <>
      <span className="font-medium text-foreground">{run.agentName ?? agentNames.get(run.agentId) ?? "Agent"}</span>
      {run.issueIdentifier ? <span className="text-muted-foreground"> on {run.issueIdentifier}</span> : null}
      <span className="font-mono text-xs text-muted-foreground"> · {shortId(run.runId)}</span>
      {run.reason ? <span className="block text-xs text-muted-foreground">{run.reason}</span> : null}
      {by ? <span className="block text-xs text-muted-foreground">Marked by {by}</span> : null}
    </>
  );
}

export function ReleaseProgressPanel({
  progress,
  flaggedRuns = [],
  agentNames = new Map(),
  onCancel,
  cancelling,
  onOverride,
  overriding = false,
  actionError,
  connectionLost,
  onDismiss,
}: {
  progress: ReleaseProgress;
  flaggedRuns?: FlaggedRun[];
  agentNames?: Map<string, string>;
  onCancel: () => void;
  cancelling: boolean;
  onOverride?: () => void;
  overriding?: boolean;
  actionError: string | null;
  connectionLost: boolean;
  onDismiss: () => void;
}) {
  const final = FINAL_RELEASE_STATES.has(progress.state);
  const bad = progress.state === "rolled_back" || progress.state === "failed";
  const currentIndex = STEPS.findIndex((step) => step.state === progress.state);
  const holding = progress.state === "holding";
  const waiting = holding && !progress.overridden && (progress.waitingForFlaggedRuns ?? 0) > 0;

  return (
    <Card className={cn("gap-4 py-5", bad && "border-destructive")} data-testid="release-progress" data-state={progress.state}>
      <CardHeader className="px-5">
        <CardTitle className="text-base">Progress</CardTitle>
        <CardAction>
          {holding ? (
            <div className="flex flex-wrap justify-end gap-2">
              {waiting && onOverride ? (
                <Button size="sm" variant="outline" onClick={onOverride} disabled={overriding || cancelling}>
                  {overriding ? "Releasing…" : "Release without waiting"}
                </Button>
              ) : null}
              <Button size="sm" variant="outline" onClick={onCancel} disabled={cancelling || overriding}>
                {cancelling ? "Cancelling…" : "Cancel"}
              </Button>
            </div>
          ) : final ? (
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              Dismiss
            </Button>
          ) : null}
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3 px-5">
        <p role="status" aria-live="polite" className={cn("text-sm font-medium", bad ? "text-destructive" : "text-foreground")}>
          {progressHeadline(progress)}
        </p>
        {bad && progress.reason ? <p className="text-sm text-foreground">{progress.reason}</p> : null}
        {!final || progress.state === "healthy" ? (
          <ol className="flex flex-wrap gap-x-4 gap-y-2">
            {STEPS.map((step, index) => {
              const done = progress.state === "healthy" || index < currentIndex;
              const current = !done && index === currentIndex;
              return (
                <li
                  key={step.state}
                  aria-current={current ? "step" : undefined}
                  className={cn(
                    "flex items-center gap-1.5 text-xs",
                    done ? "text-foreground" : current ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  {done ? (
                    <Check className="size-3.5" aria-hidden />
                  ) : current ? (
                    <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
                  ) : (
                    <span className="size-3.5 rounded-full border border-border" aria-hidden />
                  )}
                  {step.label}
                </li>
              );
            })}
          </ol>
        ) : null}
        {waiting && flaggedRuns.length > 0 ? (
          <ul className="space-y-2 rounded-md border border-border p-3 text-sm" data-testid="release-progress-flagged">
            {flaggedRuns.map((run) => (
              <li key={run.runId}>
                <FlaggedRunLine run={run} agentNames={agentNames} />
              </li>
            ))}
          </ul>
        ) : null}
        {progress.restartReport ? <RestartReportSummary report={progress.restartReport} /> : null}
        {connectionLost && !final ? (
          <p className="text-xs text-muted-foreground">Cannot reach live right now; it is down while it switches and restarts. This page reconnects on its own.</p>
        ) : null}
        {actionError ? (
          <p role="alert" className="text-sm text-destructive">
            {actionError}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ── Finish before update ────────────────────────────────────────────────────

interface RunRow {
  runId: string;
  agentId: string;
  agentName: string;
  flag: FlaggedRun | null;
}

function FinishBeforeUpdateCard({
  companyId,
  flaggedRuns,
  agentNames,
  disabled,
}: {
  companyId: string;
  flaggedRuns: FlaggedRun[];
  agentNames: Map<string, string>;
  disabled: boolean;
}) {
  const queryClient = useQueryClient();
  const liveRuns = useQuery({
    queryKey: queryKeys.liveRuns(companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
  });
  const flagMutation = useMutation({
    mutationFn: ({ runId, enabled }: { runId: string; enabled: boolean }) =>
      releasesApi.setFinishBeforeUpdate(runId, enabled),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.releases(companyId) }),
  });

  const rows = useMemo<RunRow[]>(() => {
    const byId = new Map<string, RunRow>();
    for (const run of liveRuns.data ?? []) {
      if (run.status !== "running") continue;
      byId.set(run.id, { runId: run.id, agentId: run.agentId, agentName: run.agentName, flag: null });
    }
    for (const flag of flaggedRuns) {
      const existing = byId.get(flag.runId);
      byId.set(flag.runId, {
        runId: flag.runId,
        agentId: flag.agentId,
        agentName: existing?.agentName ?? flag.agentName ?? agentNames.get(flag.agentId) ?? "Agent",
        flag,
      });
    }
    // Flagged first, then by agent name.
    return [...byId.values()].sort(
      (a, b) => Number(!!b.flag) - Number(!!a.flag) || a.agentName.localeCompare(b.agentName),
    );
  }, [liveRuns.data, flaggedRuns, agentNames]);

  const pendingRunId = flagMutation.isPending ? flagMutation.variables?.runId : null;

  return (
    <Card className="gap-0 py-0" data-testid="release-flagged-runs">
      <CardHeader className="px-5 py-4">
        <CardTitle className="text-base">Finish before update</CardTitle>
        <CardDescription>
          Running runs are checkpointed and resume after an update. A run marked here is waited for instead.
        </CardDescription>
      </CardHeader>
      {rows.length === 0 ? (
        <CardContent className="px-5 pb-5">
          <p className="text-sm text-muted-foreground">No runs are running.</p>
        </CardContent>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {rows.map((row) => (
            <li key={row.runId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3" data-testid={`release-run-${row.runId}`}>
              <div className="min-w-0 text-sm">
                {row.flag ? (
                  <FlaggedRunLine run={{ ...row.flag, agentName: row.agentName }} agentNames={agentNames} />
                ) : (
                  <>
                    <span className="font-medium text-foreground">{row.agentName}</span>
                    <span className="font-mono text-xs text-muted-foreground"> · {shortId(row.runId)}</span>
                  </>
                )}
              </div>
              <div className="flex items-center gap-2">
                {row.flag ? <ReleaseChip tone="in_progress">Finish before update</ReleaseChip> : null}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled || pendingRunId === row.runId}
                  onClick={() => flagMutation.mutate({ runId: row.runId, enabled: !row.flag })}
                >
                  {row.flag ? "Clear" : "Mark finish before update"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {flagMutation.error ? (
        <CardContent className="px-5 pb-4">
          <p role="alert" className="text-sm text-destructive">
            {errorText(flagMutation.error)}
          </p>
        </CardContent>
      ) : null}
    </Card>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

function errorText(error: unknown): string | null {
  if (!error || error instanceof ReauthCancelledError) return null;
  return error instanceof Error ? error.message : "Something went wrong.";
}

/**
 * "Promote to Stable" (GRE-127). The notes become the stable tag's message,
 * which clients read as "What's new". The server checks them and names the tag.
 */
function PromoteDialog({
  entry,
  pending,
  error,
  onPromote,
  onClose,
}: {
  entry: { tag: string; title: string } | null;
  pending: boolean;
  error: string | null;
  onPromote: (notes: string) => void;
  onClose: () => void;
}) {
  const [notes, setNotes] = useState("");
  useEffect(() => {
    if (entry) setNotes("");
  }, [entry]);
  return (
    <Dialog open={entry !== null} onOpenChange={(open) => (!open && !pending ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-lg" data-testid="promote-dialog">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (notes.trim()) onPromote(notes);
          }}
        >
          <DialogHeader>
            <DialogTitle>{entry ? `Promote ${entry.title} to Stable?` : "Promote to Stable"}</DialogTitle>
            <DialogDescription>
              {entry
                ? `Clients get ${entry.title} (${entry.tag}) at their next update. Live does not change.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="promote-notes">Client notes</Label>
            <Textarea
              id="promote-notes"
              rows={6}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="What is new for clients, in plain words."
              aria-invalid={error ? true : undefined}
              aria-describedby="promote-notes-help"
            />
            <p id="promote-notes-help" className="text-xs text-muted-foreground">
              Clients see these notes as “What's new”. Features only; no pull request or GRE numbers.
            </p>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !notes.trim()}>
              {pending ? "Promoting…" : "Promote to Stable"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const HOT_RESTART_TEXT =
  "New runs are held. Running runs are checkpointed and resume after the update; runs marked finish before update are waited for. Live then restarts and this page reconnects on its own.";

function useAgentNames(companyId: string): Map<string, string> {
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  return useMemo(() => new Map((agents.data ?? []).map((agent) => [agent.id, agent.name])), [agents.data]);
}

export function ReleasesView({
  companyId,
  overview,
  fetchError,
}: {
  companyId: string;
  overview: ReleasesOverview;
  fetchError: string | null;
}) {
  const confirm = useConfirm();
  const { withReauth, dialog: reauthDialog } = useReauth();
  const queryClient = useQueryClient();
  const agentNames = useAgentNames(companyId);
  const [dismissedJobId, setDismissedJobId] = useState<string | null>(null);
  const [promoteEntry, setPromoteEntry] = useState<{ tag: string; title: string } | null>(null);
  const { live, next, history, progress, flaggedRuns, disabledReason } = overview;
  const inProgress = isReleaseInProgress(overview);

  const applyProgress = ({ progress: nextProgress }: { progress: ReleaseProgress }) => {
    queryClient.setQueryData<ReleasesOverview>(queryKeys.releases(companyId), (current) =>
      current ? { ...current, progress: nextProgress } : current,
    );
    void queryClient.invalidateQueries({ queryKey: queryKeys.releases(companyId) });
  };

  const releaseMutation = useMutation({
    mutationFn: () => withReauth("release", (options) => releasesApi.releaseNow(companyId, options)),
    onSuccess: applyProgress,
  });
  const rollbackMutation = useMutation({
    mutationFn: (tag: string) => withReauth("rollback", (options) => releasesApi.rollback(companyId, tag, options)),
    onSuccess: applyProgress,
  });
  const promoteMutation = useMutation({
    mutationFn: ({ tag, notes }: { tag: string; notes: string }) =>
      withReauth("promote", (options) => releasesApi.promote(companyId, tag, notes, options)),
    onSuccess: () => {
      setPromoteEntry(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.releases(companyId) });
    },
  });
  const cancelMutation = useMutation({
    mutationFn: () => releasesApi.cancel(companyId),
    onSuccess: applyProgress,
  });
  const overrideMutation = useMutation({
    mutationFn: () => releasesApi.override(companyId),
    onSuccess: applyProgress,
  });
  const actionError = errorText(releaseMutation.error) ?? errorText(rollbackMutation.error);
  const busy = inProgress || releaseMutation.isPending || rollbackMutation.isPending;
  const off = !!disabledReason;
  const liveName = live ? (live.title ?? live.tag ?? shortId(live.commit)) : null;
  const liveLabel = live ? (live.title && live.tag ? `${live.title} (${live.tag})` : liveName) : null;

  async function onRelease() {
    if (!next) return;
    const lines = [
      liveLabel ? `Live moves from ${liveLabel} to ${next.proposedTitle}.` : `Live moves to ${next.proposedTitle}.`,
      [
        ...next.changelog.features.map((item) => `• ${item}`),
        ...next.changelog.fixes.map((item) => `• Fix: ${item}`),
      ].join("\n"),
      "The tag is cut from origin/main. Fork CI on main is checked first; the release stops if it has not passed.",
      HOT_RESTART_TEXT,
    ].filter(Boolean);
    const ok = await confirm({
      title: `Release ${next.proposedTitle}?`,
      description: lines.join("\n\n"),
      confirmLabel: "Release now",
    });
    if (ok) {
      rollbackMutation.reset();
      releaseMutation.mutate();
    }
  }

  async function onRollback(entry: { tag: string; title: string }) {
    const ok = await confirm({
      title: `Roll back to ${entry.title}?`,
      description: [
        liveLabel
          ? `Live moves from ${liveLabel} back to ${entry.title} (${entry.tag}).`
          : `Live moves back to ${entry.title} (${entry.tag}).`,
        HOT_RESTART_TEXT,
      ].join("\n\n"),
      confirmLabel: "Roll back",
      tone: "destructive",
    });
    if (ok) {
      releaseMutation.reset();
      rollbackMutation.mutate(entry.tag);
    }
  }

  async function onOverride() {
    const n = progress?.waitingForFlaggedRuns ?? 0;
    const ok = await confirm({
      title: "Release without waiting?",
      description: `${plural(n, "run")} marked finish before update ${n === 1 ? "is" : "are"} still running. They are checkpointed like the others and resume after the update, but may repeat or lose their last step.`,
      confirmLabel: "Release without waiting",
      tone: "destructive",
    });
    if (ok) overrideMutation.mutate();
  }

  const showProgress = progress && progress.id !== dismissedJobId;
  const titleBy = next ? actorLabel(next.titleEditedBy, agentNames) : null;

  return (
    <div className="mx-auto max-w-3xl space-y-4" data-testid="releases-page">
      {reauthDialog}
      <PromoteDialog
        entry={promoteEntry}
        pending={promoteMutation.isPending}
        error={errorText(promoteMutation.error)}
        onPromote={(notes) => promoteEntry && promoteMutation.mutate({ tag: promoteEntry.tag, notes })}
        onClose={() => setPromoteEntry(null)}
      />
      {fetchError && !inProgress ? (
        <p role="alert" className="text-sm text-destructive">
          {fetchError}
        </p>
      ) : null}

      {disabledReason ? (
        <div className="rounded-lg border border-border bg-card p-4 text-sm" data-testid="release-disabled">
          <p className="font-medium text-foreground">Release is off on this server.</p>
          <p className="text-muted-foreground">{disabledReason}</p>
        </div>
      ) : null}

      {showProgress ? (
        <ReleaseProgressPanel
          progress={progress}
          flaggedRuns={flaggedRuns}
          agentNames={agentNames}
          onCancel={() => cancelMutation.mutate()}
          cancelling={cancelMutation.isPending}
          onOverride={() => void onOverride()}
          overriding={overrideMutation.isPending}
          actionError={errorText(cancelMutation.error) ?? errorText(overrideMutation.error)}
          connectionLost={!!fetchError}
          onDismiss={() => setDismissedJobId(progress.id)}
        />
      ) : null}

      <Card className="gap-4 py-5" data-testid="release-live">
        <CardHeader className="px-5">
          <CardDescription>Live now</CardDescription>
          <CardTitle className="text-lg">{liveName ?? "No live version recorded"}</CardTitle>
          {live ? (
            <CardAction>
              <ReleaseChip tone={HEALTH_TONE[live.health]}>{HEALTH_LABEL[live.health]}</ReleaseChip>
            </CardAction>
          ) : null}
        </CardHeader>
        {live ? (
          <CardContent className="px-5">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Meta label="Tag">
                <span className="font-mono text-xs">{live.tag ?? "Untagged"}</span>
              </Meta>
              <Meta label="Released">{live.date ? formatDateTime(live.date) : "Unknown"}</Meta>
              <Meta label="Commit">
                <span className="font-mono text-xs">{shortId(live.commit)}</span>
              </Meta>
              <Meta label="Released by">{live.releasedBy ?? "Unknown"}</Meta>
            </dl>
          </CardContent>
        ) : null}
      </Card>

      <Card className="gap-4 py-5" data-testid="release-next">
        <CardHeader className="px-5">
          <CardTitle className="text-base">
            Dev <span className="text-sm font-normal text-muted-foreground">· next version</span>
          </CardTitle>
          <p className="text-lg font-semibold leading-none text-foreground" data-testid="release-next-name">
            {next ? next.proposedTitle : "Nothing new on main"}
          </p>
          {next ? (
            <CardDescription data-testid="release-next-title-source">
              {titleBy && next.titleEditedAt
                ? `Title set by ${titleBy}, ${formatDateTime(next.titleEditedAt)}.`
                : "Title proposed from the pull request titles. Keystone can change it."}
            </CardDescription>
          ) : (
            <CardDescription>Main is the same as live. Anything merged into main shows here.</CardDescription>
          )}
        </CardHeader>
        {next ? (
          <CardContent className="space-y-4 px-5">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>
                {next.baseTag ? (
                  <>
                    Since <span className="font-mono">{next.baseTag}</span> ·{" "}
                  </>
                ) : null}
                main at <span className="font-mono">{shortId(next.commit)}</span>
              </span>
              {next.forkCi.url ? (
                <a href={next.forkCi.url} target="_blank" rel="noreferrer" className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <ReleaseChip tone={CHECK_TONE[next.forkCi.status]}>{`Fork CI ${CHECK_LABEL[next.forkCi.status]}`}</ReleaseChip>
                </a>
              ) : (
                <ReleaseChip tone={CHECK_TONE[next.forkCi.status]}>{`Fork CI ${CHECK_LABEL[next.forkCi.status]}`}</ReleaseChip>
              )}
            </div>
            <ReleaseChangelog changelog={next.changelog} />
            {next.changes.length > 0 ? (
              <div className="space-y-1">
                <p className="text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
                  {plural(next.changes.length, "change")} merged
                </p>
                <ul className="divide-y divide-border rounded-md border border-border" data-testid="release-next-changes">
                  {next.changes.map((change) => (
                    <li key={change.commit} className="flex items-baseline gap-2 px-3 py-2 text-sm">
                      <span className="w-14 shrink-0 text-xs text-muted-foreground">{change.kind === "fix" ? "Fix" : "Feature"}</span>
                      <span className="min-w-0 flex-1 break-words text-foreground">{change.title}</span>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {[change.pr ? `#${change.pr}` : null, change.issue].filter(Boolean).join(" · ") || shortId(change.commit)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        ) : null}
        <CardContent className="flex flex-wrap items-center gap-3 px-5">
          <Button onClick={() => void onRelease()} disabled={busy || off || !next}>
            <Rocket aria-hidden />
            {releaseMutation.isPending ? "Starting…" : "Release now"}
          </Button>
          {inProgress ? <span className="text-xs text-muted-foreground">A release is in progress.</span> : null}
        </CardContent>
      </Card>

      {actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

      <FinishBeforeUpdateCard companyId={companyId} flaggedRuns={flaggedRuns} agentNames={agentNames} disabled={off} />

      <Card className="gap-0 py-0" data-testid="release-history">
        <CardHeader className="px-5 py-4">
          <CardTitle className="text-base">History</CardTitle>
        </CardHeader>
        {history.length === 0 ? (
          <CardContent className="px-5 pb-5">
            <p className="text-sm text-muted-foreground">No releases yet.</p>
          </CardContent>
        ) : (
          <ul className="divide-y divide-border border-t border-border">
            {history.map((entry) => {
              const isLive = live?.tag === entry.tag;
              return (
                <li key={entry.tag} className="space-y-3 px-5 py-4" data-testid={`release-history-${entry.tag}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                        {entry.title}
                        {isLive ? <ReleaseChip tone="done">Live</ReleaseChip> : null}
                        {entry.neverRan ? <ReleaseChip tone="blocked">Never ran</ReleaseChip> : null}
                        {entry.stableTag ? <ReleaseChip tone="in_progress">Stable</ReleaseChip> : null}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        <span className="font-mono">{entry.tag}</span>
                        {entry.date ? ` · ${formatDateTime(entry.date)}` : ""}
                        {entry.releasedBy ? ` · by ${entry.releasedBy}` : ""}
                        {entry.stableTag ? (
                          <>
                            {" · Stable as "}
                            <span className="font-mono">{entry.stableTag}</span>
                          </>
                        ) : null}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {!entry.stableTag && !entry.neverRan ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={off || promoteMutation.isPending}
                          onClick={() => {
                            promoteMutation.reset();
                            setPromoteEntry(entry);
                          }}
                        >
                          <BadgeCheck aria-hidden />
                          Promote to Stable
                        </Button>
                      ) : null}
                      {!isLive && !entry.neverRan ? (
                        <Button size="sm" variant="outline" disabled={busy || off} onClick={() => void onRollback(entry)}>
                          <RotateCcw aria-hidden />
                          Roll back to this version
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <ReleaseChangelog changelog={entry.changelog} />
                  {entry.restartReport ? <RestartReportSummary report={entry.restartReport} /> : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

export function Releases() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { canRelease, isLoading: accessLoading } = useCanRelease(selectedCompanyId);
  const releases = useReleases(selectedCompanyId, { enabled: canRelease });

  useEffect(() => {
    setBreadcrumbs([{ label: "Releases" }]);
  }, [setBreadcrumbs]);

  if (accessLoading) return <PageSkeleton variant="list" />;

  if (!canRelease || !selectedCompanyId) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-6">
          <div className="flex items-center gap-2 text-foreground">
            <ShieldAlert className="h-5 w-5 text-muted-foreground" aria-hidden />
            <h1 className="text-lg font-semibold">Releases are for the board</h1>
          </div>
          <p className="text-sm text-muted-foreground">Only the board can see and release versions of the app.</p>
        </div>
      </div>
    );
  }

  if (releases.isLoading) return <PageSkeleton variant="list" />;

  if (!releases.data) {
    const notOnServer = releases.error instanceof ApiError && releases.error.status === 404;
    return (
      <p role="alert" className="mx-auto max-w-3xl text-sm text-destructive">
        {notOnServer
          ? "This server cannot release from the app yet."
          : (errorText(releases.error) ?? "Releases are not available.")}
      </p>
    );
  }

  return (
    <ReleasesView
      companyId={selectedCompanyId}
      overview={releases.data}
      fetchError={releases.isError ? errorText(releases.error) : null}
    />
  );
}
