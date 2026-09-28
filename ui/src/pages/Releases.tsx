import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Rocket, RotateCcw, ShieldAlert } from "lucide-react";
import {
  releasesApi,
  FINAL_RELEASE_STATES,
  type ReleaseCheckStatus,
  type ReleaseHealth,
  type ReleaseProgress,
  type ReleaseProgressState,
  type ReleasesOverview,
} from "@/api/releases";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ReleaseChangelog } from "@/components/ReleaseChangelog";
import { PageSkeleton } from "@/components/PageSkeleton";
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

function shortCommit(commit: string) {
  return commit.slice(0, 7);
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm text-foreground">{children}</dd>
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

function progressHeadline(progress: ReleaseProgress): string {
  const target = `${progress.targetTitle} (${progress.targetTag})`;
  const verb = progress.kind === "rollback" ? "Rolling back to" : "Releasing";
  switch (progress.state) {
    case "checking":
      return `${verb} ${target}: checking`;
    case "holding": {
      const n = progress.runsStillRunning ?? 0;
      return `${verb} ${target}: holding new runs, ${n} still running`;
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

export function ReleaseProgressPanel({
  progress,
  onCancel,
  cancelling,
  cancelError,
  connectionLost,
  onDismiss,
}: {
  progress: ReleaseProgress;
  onCancel: () => void;
  cancelling: boolean;
  cancelError: string | null;
  connectionLost: boolean;
  onDismiss: () => void;
}) {
  const final = FINAL_RELEASE_STATES.has(progress.state);
  const bad = progress.state === "rolled_back" || progress.state === "failed";
  const currentIndex = STEPS.findIndex((step) => step.state === progress.state);

  return (
    <Card className={cn("gap-4 py-5", bad && "border-destructive")} data-testid="release-progress" data-state={progress.state}>
      <CardHeader className="px-5">
        <CardTitle className="text-base">Progress</CardTitle>
        <CardAction>
          {progress.state === "holding" ? (
            <Button size="sm" variant="outline" onClick={onCancel} disabled={cancelling}>
              {cancelling ? "Cancelling…" : "Cancel"}
            </Button>
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
        {connectionLost && !final ? (
          <p className="text-xs text-muted-foreground">Cannot reach live right now; it is down while it switches and restarts. This page reconnects on its own.</p>
        ) : null}
        {cancelError ? (
          <p role="alert" className="text-sm text-destructive">
            {cancelError}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

function errorText(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : "Something went wrong.";
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
  const queryClient = useQueryClient();
  const [dismissedJobId, setDismissedJobId] = useState<string | null>(null);
  const { live, candidate, history, progress } = overview;
  const inProgress = isReleaseInProgress(overview);

  const applyProgress = ({ progress: next }: { progress: ReleaseProgress }) => {
    queryClient.setQueryData<ReleasesOverview>(queryKeys.releases(companyId), (current) =>
      current ? { ...current, progress: next } : current,
    );
    void queryClient.invalidateQueries({ queryKey: queryKeys.releases(companyId) });
  };

  const releaseMutation = useMutation({
    mutationFn: (tag: string) => releasesApi.release(companyId, tag),
    onSuccess: applyProgress,
  });
  const rollbackMutation = useMutation({
    mutationFn: (tag: string) => releasesApi.rollback(companyId, tag),
    onSuccess: applyProgress,
  });
  const cancelMutation = useMutation({
    mutationFn: () => releasesApi.cancel(companyId),
    onSuccess: applyProgress,
  });
  const actionError = errorText(releaseMutation.error) ?? errorText(rollbackMutation.error);
  const busy = inProgress || releaseMutation.isPending || rollbackMutation.isPending;

  async function onRelease() {
    if (!candidate) return;
    const lines = [
      live
        ? `Live moves from ${live.title} (${live.tag}) to ${candidate.title} (${candidate.tag}).`
        : `Live moves to ${candidate.title} (${candidate.tag}).`,
      [
        ...candidate.changelog.features.map((item) => `• ${item}`),
        ...candidate.changelog.fixes.map((item) => `• Fix: ${item}`),
      ].join("\n"),
      "New agent runs pause while it switches; runs already going finish first. Live then restarts and this page reconnects on its own.",
    ].filter(Boolean);
    const ok = await confirm({
      title: `Release ${candidate.title}?`,
      description: lines.join("\n\n"),
      confirmLabel: `Release ${candidate.title}`,
    });
    if (ok) {
      rollbackMutation.reset();
      releaseMutation.mutate(candidate.tag);
    }
  }

  async function onRollback(entry: { tag: string; title: string }) {
    const ok = await confirm({
      title: `Roll back to ${entry.title}?`,
      description: [
        live
          ? `Live moves from ${live.title} (${live.tag}) back to ${entry.title} (${entry.tag}).`
          : `Live moves back to ${entry.title} (${entry.tag}).`,
        "New agent runs pause while it switches; runs already going finish first. Live then restarts and this page reconnects on its own.",
      ].join("\n\n"),
      confirmLabel: "Roll back",
      tone: "destructive",
    });
    if (ok) {
      releaseMutation.reset();
      rollbackMutation.mutate(entry.tag);
    }
  }

  const showProgress = progress && progress.id !== dismissedJobId;
  const candidateIsLive = !!candidate && !!live && candidate.tag === live.tag;

  return (
    <div className="mx-auto max-w-3xl space-y-4" data-testid="releases-page">
      {fetchError && !inProgress ? (
        <p role="alert" className="text-sm text-destructive">
          {fetchError}
        </p>
      ) : null}

      {showProgress ? (
        <ReleaseProgressPanel
          progress={progress}
          onCancel={() => cancelMutation.mutate()}
          cancelling={cancelMutation.isPending}
          cancelError={errorText(cancelMutation.error)}
          connectionLost={!!fetchError}
          onDismiss={() => setDismissedJobId(progress.id)}
        />
      ) : null}

      <Card className="gap-4 py-5" data-testid="release-live">
        <CardHeader className="px-5">
          <CardDescription>Live now</CardDescription>
          <CardTitle className="text-lg">{live ? live.title : "No live version recorded"}</CardTitle>
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
                <span className="font-mono text-xs">{live.tag}</span>
              </Meta>
              <Meta label="Released">{formatDateTime(live.date)}</Meta>
              <Meta label="Commit">
                <span className="font-mono text-xs">{shortCommit(live.commit)}</span>
              </Meta>
              <Meta label="Released by">{live.releasedBy ?? "Unknown"}</Meta>
            </dl>
          </CardContent>
        ) : null}
      </Card>

      <Card className="gap-4 py-5" data-testid="release-candidate">
        <CardHeader className="px-5">
          <CardDescription>Ready to go live</CardDescription>
          <CardTitle className="text-lg">{candidate ? candidate.title : "Nothing waiting"}</CardTitle>
          {candidate ? (
            <CardDescription>
              <span className="font-mono text-xs">{candidate.tag}</span> · {formatDateTime(candidate.date)} ·{" "}
              <span className="font-mono text-xs">{shortCommit(candidate.commit)}</span>
            </CardDescription>
          ) : (
            <CardDescription>A verified candidate shows here once its checks pass.</CardDescription>
          )}
        </CardHeader>
        {candidate ? (
          <CardContent className="space-y-4 px-5">
            <div className="flex flex-wrap items-center gap-2">
              {candidate.forkCi.url ? (
                <a href={candidate.forkCi.url} target="_blank" rel="noreferrer" className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <ReleaseChip tone={CHECK_TONE[candidate.forkCi.status]}>{`Fork CI ${CHECK_LABEL[candidate.forkCi.status]}`}</ReleaseChip>
                </a>
              ) : (
                <ReleaseChip tone={CHECK_TONE[candidate.forkCi.status]}>{`Fork CI ${CHECK_LABEL[candidate.forkCi.status]}`}</ReleaseChip>
              )}
              <ReleaseChip tone={CHECK_TONE[candidate.flintCheck.status]}>{`Flint check ${CHECK_LABEL[candidate.flintCheck.status]}`}</ReleaseChip>
              {candidate.flintCheck.summary ? (
                <span className="text-xs text-muted-foreground">
                  {candidate.flintCheck.summary}
                  {candidate.flintCheck.issueIdentifier ? ` (${candidate.flintCheck.issueIdentifier})` : ""}
                </span>
              ) : null}
            </div>
            <ReleaseChangelog changelog={candidate.changelog} />
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => void onRelease()} disabled={busy || candidateIsLive}>
                <Rocket aria-hidden />
                {releaseMutation.isPending ? "Starting…" : `Release ${candidate.title}`}
              </Button>
              {candidateIsLive ? <span className="text-xs text-muted-foreground">Already live.</span> : null}
              {inProgress ? <span className="text-xs text-muted-foreground">A release is in progress.</span> : null}
            </div>
          </CardContent>
        ) : null}
      </Card>

      {actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      ) : null}

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
                      </p>
                      <p className="text-xs text-muted-foreground">
                        <span className="font-mono">{entry.tag}</span> · {formatDateTime(entry.date)}
                        {entry.releasedBy ? ` · by ${entry.releasedBy}` : ""}
                      </p>
                    </div>
                    {!isLive ? (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => void onRollback(entry)}>
                        <RotateCcw aria-hidden />
                        Roll back to this version
                      </Button>
                    ) : null}
                  </div>
                  <ReleaseChangelog changelog={entry.changelog} />
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
