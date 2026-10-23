import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import type {
  WebsitePendingReason,
  WebsiteRelease,
  WebsiteReleaseActionPlan,
  WebsiteReleaseStatus,
  WebsiteSite,
} from "@greatstone/shared";
import { accessApi } from "../../api/access";
import { websiteErrorCode, websiteModuleApi } from "../../api/website";
import { buildCompanyUserLabelMap } from "../../lib/company-members";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "../../lib/utils";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { errorStateMessage } from "../ErrorState";
import { useCanManageWebsite } from "./WebsiteSetup";

// Releases, Publish, Pending with Retry, and Roll back (GRE-2133, API in
// GRE-2108). Every word comes from the GRE-2107 copy, sections 1, 9, 10 and
// 11. Retry and Roll back read the server's plan first so the cost shows
// before the click; a rebuild (about 15 credits) needs a confirm.

/** Release status labels and help (copy section 1). */
export const RELEASE_STATUS_COPY: Record<WebsiteReleaseStatus, { label: string; help: string; tone: string }> = {
  building: { label: "Preparing", help: "Collecting the approved changes.", tone: "bg-status-info-soft text-status-info-foreground" },
  checks_failed: { label: "Stopped by checks", help: "A check failed, so nothing was sent. The live site has not changed.", tone: "bg-status-danger-soft text-status-danger" },
  uploading: { label: "Sending", help: "Sending pages and images to the site.", tone: "bg-status-info-soft text-status-info-foreground" },
  switched: { label: "Rebuilding the site", help: "The site is building with this release. This takes about a minute.", tone: "bg-status-info-soft text-status-info-foreground" },
  pending: { label: "Pending", help: "The live check has not passed yet. See what failed and retry.", tone: "bg-status-warning-soft text-status-warning-foreground" },
  live: { label: "Live", help: "Visitors see this release.", tone: "bg-status-success-soft text-status-success-foreground" },
  superseded: { label: "Replaced", help: "A newer release is live. You can roll back to this one.", tone: "bg-status-neutral-soft text-status-neutral-foreground" },
  failed: { label: "Did not finish", help: "Nothing changed on the live site. Publish again when ready.", tone: "bg-status-danger-soft text-status-danger" },
};

/** Statuses a release moves on from by itself; the page polls while it is in one. */
const ACTIVE_STATUSES = new Set<WebsiteReleaseStatus>(["building", "uploading", "switched"]);
export const RELEASE_POLL_MS = 2000;

export function isReleaseActive(status: WebsiteReleaseStatus) {
  return ACTIVE_STATUSES.has(status);
}

// Why a release is Pending. Not in the GRE-2107 copy yet: listed under "New strings" for Harbor.
const PENDING_REASON_TEXT: Record<WebsitePendingReason, string> = {
  build_failed: "The site did not rebuild.",
  build_timeout: "The rebuild took too long.",
  build_not_started: "The rebuild did not start.",
  verify_failed: "The live pages do not show this release yet.",
  server_restarted: "GSAM restarted during this Publish. Retry the check to confirm the live site.",
};

const PUBLISH_STEPS = [
  (n: number) => `Preparing Release ${n}`,
  () => "Checking links, SEO, accessibility and wording",
  () => "Sending pages and images",
  () => "Rebuilding the site",
  () => "Checking the live pages",
];

/** The step a running release is on: 1 checks, 2 send, 3 rebuild, 4 verify. */
function currentStep(release: WebsiteRelease) {
  if (release.status === "building") return 1;
  if (release.status === "uploading") return 2;
  return release.deploy?.state === "ready" ? 4 : 3;
}

/** Relative under an hour ("4 minutes ago"), then "23 Oct, 14:05" (copy section 0). */
export function releaseTime(at: string, now = Date.now()) {
  const minutes = Math.floor((now - new Date(at).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const date = new Date(at);
  return `${date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

/** "23 Oct 2026, 14:05" (copy `{date}`). */
export function releaseDate(at: string) {
  const date = new Date(at);
  return `${date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}, ${date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

/** Rollback confirm body (copy 11): the cost line only when the rollback rebuilds. */
export function rollbackConfirmBody(plan: WebsiteReleaseActionPlan, liveAt: string) {
  const cost = plan.costsCredits ? " and costs about 15 credits" : "";
  return `Visitors will see the site as it was on ${releaseDate(liveAt)}. This rebuilds the site${cost}. Your drafts and newer changes stay in GSAM; nothing is deleted.`;
}

function useUserLabels(companyId: string) {
  const directory = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId),
    queryFn: () => accessApi.listUserDirectory(companyId),
    retry: false,
  });
  const labels = buildCompanyUserLabelMap(directory.data?.users);
  return (userId: string | null) => (userId ? labels.get(userId) ?? "A person" : "A person");
}

/** The message for a refused Publish, Retry or Roll back: the copy where there is one, else the server's own words. */
function actionErrorText(error: unknown, releases: WebsiteRelease[], personName: (id: string | null) => string) {
  if (websiteErrorCode(error) === "website_publish_running") {
    const running = releases.find((release) => isReleaseActive(release.status));
    return running
      ? `A Publish is running for this site, started by ${personName(running.publishedByUserId)} ${releaseTime(running.createdAt)}. Wait for it to finish, then Publish again.`
      : "A Publish is running for this site. Wait for it to finish, then Publish again.";
  }
  return errorStateMessage(error);
}

function StatusLabel({ status }: { status: WebsiteReleaseStatus }) {
  const copy = RELEASE_STATUS_COPY[status];
  return (
    <span title={copy.help} className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", copy.tone)} data-testid="website-release-status">
      {copy.label}
    </span>
  );
}

function Panel({ title, tone = "neutral", children, testId }: { title: string; tone?: "neutral" | "warning" | "danger" | "success"; children: ReactNode; testId: string }) {
  return (
    <div
      role="status"
      data-testid={testId}
      className={cn(
        "space-y-2 rounded-lg border p-3 text-sm",
        tone === "warning" && "border-status-warning/40 bg-status-warning-soft",
        tone === "danger" && "border-status-danger/40 bg-status-danger-soft",
        tone === "success" && "border-status-success/40 bg-status-success-soft",
      )}
    >
      <p className="font-semibold text-foreground">{title}</p>
      {children}
    </div>
  );
}

/** Progress of a running release: polls it until it leaves building, uploading or switched. */
function ReleaseProgress({ companyId, siteId, release, pollMs, onSettled }: {
  companyId: string;
  siteId: string;
  release: WebsiteRelease;
  pollMs: number;
  onSettled: (release: WebsiteRelease) => void;
}) {
  const query = useQuery({
    queryKey: queryKeys.website.release(companyId, siteId, release.id),
    queryFn: () => websiteModuleApi.release(companyId, siteId, release.id),
    initialData: release,
    refetchInterval: (q) => (q.state.data && isReleaseActive(q.state.data.status) ? pollMs : false),
  });
  const current = query.data ?? release;
  const settled = !isReleaseActive(current.status);
  const notified = useRef(false);
  useEffect(() => {
    if (settled && !notified.current) {
      notified.current = true;
      onSettled(current);
    }
  }, [settled, current, onSettled]);
  if (settled) return null;
  const step = currentStep(current);
  return (
    <Panel title={PUBLISH_STEPS[step]!(current.number)} testId="website-release-progress">
      <ol className="space-y-1 text-xs">
        {PUBLISH_STEPS.map((label, index) => (
          <li key={index} className={cn("flex items-center gap-2", index > step && "text-muted-foreground")}>
            {index < step ? (
              <Check className="size-3.5 text-status-success" aria-label="Done" />
            ) : index === step ? (
              <Loader2 className="size-3.5 animate-spin" aria-label="In progress" />
            ) : (
              <span className="size-3.5" aria-hidden />
            )}
            {label(current.number)}
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">You can leave this page. The Publish carries on.</p>
    </Panel>
  );
}

function ChecksFailed({ release }: { release: WebsiteRelease }) {
  const failed = release.checks.filter((check) => check.kind === "check" && !check.ok);
  return (
    <Panel title="Publish stopped by checks" tone="danger" testId="website-release-checks-failed">
      <p>Nothing was sent and no credits were used. The live site has not changed. Fix these, then Publish again.</p>
      {failed.length ? (
        <ul className="list-disc space-y-0.5 pl-5 text-xs">
          {failed.map((check) => <li key={check.name}>{check.message ?? check.name}</li>)}
        </ul>
      ) : null}
    </Panel>
  );
}

/** One verify line: "/about shows Release 41" (copy 10 case A), else the server's line. */
function verifyLine(message: string | undefined, name: string) {
  const shown = message ? /shows release (\S+), not/i.exec(message)?.[1] : undefined;
  return shown ? `${name} shows Release ${shown}` : message ?? name;
}

/** Pending (copy 10): case A (the check failed, Retry is free) or case B (the build failed, Rebuild again costs credits). */
function PendingPanel({ companyId, site, release, releases, canManage, personName }: {
  companyId: string;
  site: WebsiteSite;
  release: WebsiteRelease;
  releases: WebsiteRelease[];
  canManage: boolean;
  personName: (id: string | null) => string;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const planQuery = useQuery({
    queryKey: queryKeys.website.releasePlan(companyId, site.id, release.id, "retry"),
    queryFn: () => websiteModuleApi.retryPlan(companyId, site.id, release.id),
    enabled: canManage,
    retry: false,
  });
  const plan = planQuery.data;
  const retry = useMutation({
    mutationFn: (confirmRebuild: boolean) => websiteModuleApi.retry(companyId, site.id, release.id, confirmRebuild),
    onSuccess: () => {
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.website.releases(companyId, site.id) });
    },
    onError: (error) => {
      // The plan changed since it was read (the build failed meanwhile): show the new cost and ask.
      if (websiteErrorCode(error) === "website_rebuild_needs_confirm") {
        void planQuery.refetch().then(() => setConfirming(true));
      }
    },
  });
  const buildFailed = plan
    ? plan.action === "build"
    : release.pendingReason === "build_failed" || release.pendingReason === "build_timeout" || release.pendingReason === "build_not_started";
  const failedPages = release.checks.filter((check) => check.kind === "verify" && !check.ok);
  const live = releases.find((entry) => entry.id !== release.id && entry.liveAt && (entry.id === site.liveReleaseId || entry.status === "live"))
    ?? releases.find((entry) => entry.id !== release.id && entry.liveAt);
  const since = release.switchedAt ?? release.updatedAt;
  const needsConfirm = websiteErrorCode(retry.error) === "website_rebuild_needs_confirm";

  return (
    <Panel title={`Release ${release.number} is pending`} tone="warning" testId="website-release-pending">
      <p className="text-xs text-muted-foreground">Pending since {releaseTime(since)}</p>
      {release.pendingReason ? (
        <p className="text-xs"><span className="font-medium">What failed: </span>{PENDING_REASON_TEXT[release.pendingReason]}</p>
      ) : null}
      {buildFailed ? (
        <p data-testid="website-pending-case">{live ? `The site did not rebuild. Visitors still see Release ${live.number}.` : "The site did not rebuild."}</p>
      ) : (
        <>
          <p data-testid="website-pending-case">
            {failedPages.length === 1
              ? `The site rebuilt, but 1 check page does not show Release ${release.number} yet. This often clears in a minute.`
              : `The site rebuilt, but ${failedPages.length} check pages do not show Release ${release.number} yet. This often clears in a minute.`}
          </p>
          {failedPages.length ? (
            <ul className="list-disc space-y-0.5 pl-5 font-mono text-xs">
              {failedPages.map((check) => <li key={check.name}>{verifyLine(check.message, check.name)}</li>)}
            </ul>
          ) : null}
        </>
      )}
      {canManage ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {planQuery.isLoading ? (
            <p className="text-xs text-muted-foreground">Reading what Retry will do</p>
          ) : plan ? (
            <>
              <Button
                type="button"
                size="sm"
                variant={plan.costsCredits ? "outline" : "default"}
                disabled={retry.isPending}
                onClick={() => (plan.costsCredits ? setConfirming(true) : retry.mutate(false))}
              >
                {retry.isPending && !plan.costsCredits ? "Checking again" : plan.costsCredits ? "Rebuild again" : "Retry check"}
              </Button>
              <p className="text-xs text-muted-foreground" data-testid="website-retry-cost">
                {plan.costsCredits ? "About 15 credits." : "Checks the live pages again. Free. Safe to repeat."}
              </p>
            </>
          ) : planQuery.error ? (
            <p role="alert" className="text-xs text-status-danger">{errorStateMessage(planQuery.error)}</p>
          ) : null}
        </div>
      ) : null}
      {retry.isError && !needsConfirm ? (
        <p role="alert" className="text-xs text-status-danger">{actionErrorText(retry.error, releases, personName)}</p>
      ) : null}
      {buildFailed && release.deploy?.errorMessage ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Details</summary>
          <p className="mt-1 whitespace-pre-wrap break-all font-mono">{release.deploy.errorMessage}</p>
        </details>
      ) : null}
      <AlertDialog open={confirming} onOpenChange={(open) => !retry.isPending && setConfirming(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rebuild again</AlertDialogTitle>
            <AlertDialogDescription>
              Start one more rebuild? It costs about 15 credits. If it fails again, ask your website team before you retry.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={retry.isPending}>Cancel</AlertDialogCancel>
            <Button type="button" disabled={retry.isPending} onClick={() => retry.mutate(true)}>
              {retry.isPending ? "Starting" : "Rebuild again"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  );
}

/** Roll back confirm (copy 11): reads the plan when it opens, so the cost line is right before the click. */
function RollbackDialog({ companyId, siteId, target, releases, personName, onClose }: {
  companyId: string;
  siteId: string;
  target: WebsiteRelease;
  releases: WebsiteRelease[];
  personName: (id: string | null) => string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const planQuery = useQuery({
    queryKey: queryKeys.website.releasePlan(companyId, siteId, target.id, "rollback"),
    queryFn: () => websiteModuleApi.rollbackPlan(companyId, siteId, target.id),
    retry: false,
    staleTime: 0,
  });
  const plan = planQuery.data;
  const rollback = useMutation({
    mutationFn: (confirmRebuild: boolean) => websiteModuleApi.rollback(companyId, siteId, target.id, confirmRebuild),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.website.releases(companyId, siteId) });
      onClose();
    },
    onError: (error) => {
      // The free restore is no longer possible: read the plan again so the cost line shows before the next click.
      if (websiteErrorCode(error) === "website_rebuild_needs_confirm") void planQuery.refetch();
    },
  });
  const code = websiteErrorCode(rollback.error);
  const errorText = code === "website_rollback_file_missing"
    ? `The files for Release ${target.number} are not on the site any more, so GSAM cannot roll back to it. Choose another release.`
    : code === "website_rebuild_needs_confirm"
      ? null
      : rollback.isError ? actionErrorText(rollback.error, releases, personName) : null;

  return (
    <AlertDialog open onOpenChange={(open) => !open && !rollback.isPending && onClose()}>
      <AlertDialogContent data-testid="website-rollback-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Roll back to Release {target.number}?</AlertDialogTitle>
          <AlertDialogDescription data-testid="website-rollback-body">
            {plan && target.liveAt
              ? rollbackConfirmBody(plan, target.liveAt)
              : planQuery.isFetching ? "Reading what this roll back will do" : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {planQuery.error ? <p role="alert" className="text-sm text-status-danger">{errorStateMessage(planQuery.error)}</p> : null}
        {errorText ? <p role="alert" className="text-sm text-status-danger">{errorText}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={rollback.isPending}>Cancel</AlertDialogCancel>
          <Button
            type="button"
            disabled={!plan || planQuery.isFetching || rollback.isPending}
            onClick={() => plan && rollback.mutate(plan.costsCredits)}
          >
            {rollback.isPending ? "Starting" : "Roll back"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ReleaseRow({ release, rollbackOf, personName, canRollBack, onRollBack }: {
  release: WebsiteRelease;
  rollbackOf: WebsiteRelease | null;
  personName: (id: string | null) => string;
  canRollBack: boolean;
  onRollBack: () => void;
}) {
  const hasDetails = release.checks.length > 0 || release.deploy;
  return (
    <li className="space-y-1.5 py-3" data-testid="website-release-row" id={`website-release-${release.id}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">Release {release.number}</span>
        <StatusLabel status={release.status} />
        {rollbackOf ? <span className="text-xs text-muted-foreground">Roll back to Release {rollbackOf.number}</span> : null}
        {canRollBack ? (
          <Button type="button" variant="ghost" size="xs" className="ml-auto" onClick={onRollBack}>Roll back to this release</Button>
        ) : null}
      </div>
      <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
        <div className="flex gap-1"><dt>Went live</dt><dd className="text-foreground">{release.liveAt ? releaseTime(release.liveAt) : "Not yet"}</dd></div>
        <div className="flex gap-1"><dt>By</dt><dd className="text-foreground">{personName(release.publishedByUserId)}</dd></div>
        {release.status === "pending" && release.pendingReason ? (
          <div className="flex gap-1"><dt>What failed</dt><dd className="text-foreground">{PENDING_REASON_TEXT[release.pendingReason]}</dd></div>
        ) : null}
      </dl>
      {hasDetails ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Details</summary>
          <div className="mt-1 space-y-1">
            {release.checks.length ? (
              <ul className="space-y-0.5">
                {release.checks.map((check) => (
                  <li key={`${check.kind}-${check.name}`} className="flex gap-2">
                    <span className={check.ok ? "text-status-success" : "text-status-danger"}>{check.ok ? "Passed" : "Failed"}</span>
                    <span className="min-w-0 break-all font-mono">{check.kind === "verify" ? check.name : check.message ?? check.name}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {release.deploy ? (
              <p className="break-all font-mono text-muted-foreground">
                Netlify {release.deploy.method} {release.deploy.state}
                {release.deploy.deployId ? `, deploy ${release.deploy.deployId}` : ""}
                {release.deploy.errorMessage ? `: ${release.deploy.errorMessage}` : ""}
              </p>
            ) : null}
          </div>
        </details>
      ) : null}
    </li>
  );
}

/** The Releases panel of a connected site: Publish, the running release, Pending with Retry, and Roll back. */
export function WebsiteReleases({ companyId, site, pollMs = RELEASE_POLL_MS }: { companyId: string; site: WebsiteSite; pollMs?: number }) {
  const queryClient = useQueryClient();
  const { canManage } = useCanManageWebsite(companyId);
  const personName = useUserLabels(companyId);
  const [confirmingPublish, setConfirmingPublish] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<WebsiteRelease | null>(null);
  const [finished, setFinished] = useState<string | null>(null);
  const releasesKey = queryKeys.website.releases(companyId, site.id);
  const releasesQuery = useQuery({
    queryKey: releasesKey,
    queryFn: () => websiteModuleApi.releases(companyId, site.id),
  });
  const releases = releasesQuery.data ?? [];
  const latest = releases[0] ?? null;
  const publish = useMutation({
    mutationFn: () => websiteModuleApi.publish(companyId, site.id),
    onSuccess: () => {
      setConfirmingPublish(false);
      void queryClient.invalidateQueries({ queryKey: releasesKey });
    },
    onError: () => {
      setConfirmingPublish(false);
      void queryClient.invalidateQueries({ queryKey: releasesKey });
    },
  });
  const onSettled = (release: WebsiteRelease) => {
    setFinished(release.id);
    void queryClient.invalidateQueries({ queryKey: releasesKey });
  };
  const running = latest && isReleaseActive(latest.status);
  const newerPending = latest?.status === "pending";
  const byId = new Map(releases.map((release) => [release.id, release]));

  let latestPanel: ReactNode = null;
  if (latest) {
    if (isReleaseActive(latest.status)) {
      latestPanel = <ReleaseProgress key={latest.id} companyId={companyId} siteId={site.id} release={latest} pollMs={pollMs} onSettled={onSettled} />;
    } else if (latest.status === "pending") {
      latestPanel = <PendingPanel companyId={companyId} site={site} release={latest} releases={releases} canManage={canManage} personName={personName} />;
    } else if (latest.status === "checks_failed") {
      latestPanel = <ChecksFailed release={latest} />;
    } else if (latest.status === "failed") {
      latestPanel = (
        <Panel title={`Release ${latest.number} did not finish`} tone="danger" testId="website-release-failed">
          <p>Nothing changed on the live site. Your approved changes are still waiting. Publish again when ready.</p>
        </Panel>
      );
    } else if (latest.status === "live" && finished === latest.id) {
      const restored = latest.rollbackOfReleaseId ? byId.get(latest.rollbackOfReleaseId) : null;
      const pages = latest.checks.filter((check) => check.kind === "verify").length;
      latestPanel = (
        <Panel title={restored ? `Release ${latest.number} is live. It restores Release ${restored.number}.` : `Release ${latest.number} is live.`} tone="success" testId="website-release-done">
          {restored ? (
            <p className="text-xs">Pages changed since Release {restored.number} show "Live, with changes" until you Publish again.</p>
          ) : (
            <p className="text-xs">
              {personName(latest.publishedByUserId)} started this Publish at {releaseTime(latest.createdAt)}. {pages === 1 ? "1 page checked." : `${pages} pages checked.`}
            </p>
          )}
        </Panel>
      );
    }
  }

  return (
    <section className="gs-glass-card min-w-0 space-y-3 rounded-xl border p-4" aria-labelledby={`website-releases-${site.id}-title`} data-testid="website-releases">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`website-releases-${site.id}-title`} className="text-sm font-semibold">Releases</h2>
        {canManage ? (
          <Button type="button" size="sm" disabled={!!running || publish.isPending} onClick={() => setConfirmingPublish(true)}>
            Publish
          </Button>
        ) : null}
      </div>
      {canManage ? null : (
        <p className="text-xs text-muted-foreground">
          You can save changes and send them for review. A person with Publish rights approves them and starts the Publish.
        </p>
      )}
      {publish.isError ? (
        <p role="alert" className="text-xs text-status-danger" data-testid="website-publish-error">
          {actionErrorText(publish.error, releases, personName)}
        </p>
      ) : null}
      {latestPanel}
      {releasesQuery.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading releases</p>
      ) : releasesQuery.error ? (
        <p role="alert" className="text-xs text-status-danger">{errorStateMessage(releasesQuery.error)}</p>
      ) : releases.length === 0 ? (
        <div className="space-y-1 text-sm" data-testid="website-releases-empty">
          <p className="font-medium">No releases yet</p>
          <p className="text-xs text-muted-foreground">Your first Publish shows here, with what went live and who sent it.</p>
        </div>
      ) : (
        <ul className="divide-y text-sm">
          {releases.map((release) => (
            <ReleaseRow
              key={release.id}
              release={release}
              rollbackOf={release.kind === "rollback" && release.rollbackOfReleaseId ? byId.get(release.rollbackOfReleaseId) ?? null : null}
              personName={personName}
              canRollBack={canManage && !running && !!release.liveAt && (release.status === "superseded" || (release.status === "live" && newerPending))}
              onRollBack={() => setRollbackTarget(release)}
            />
          ))}
        </ul>
      )}
      <AlertDialog open={confirmingPublish} onOpenChange={(open) => !publish.isPending && setConfirmingPublish(open)}>
        <AlertDialogContent data-testid="website-publish-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Publish to {site.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This updates the live site. It takes about a minute and costs about 15 credits. Saving drafts is free, so group your changes into one Publish.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={publish.isPending}>Cancel</AlertDialogCancel>
            <Button type="button" disabled={publish.isPending} onClick={() => publish.mutate()}>
              {publish.isPending ? "Starting" : "Publish now"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {rollbackTarget ? (
        <RollbackDialog
          companyId={companyId}
          siteId={site.id}
          target={rollbackTarget}
          releases={releases}
          personName={personName}
          onClose={() => setRollbackTarget(null)}
        />
      ) : null}
    </section>
  );
}
