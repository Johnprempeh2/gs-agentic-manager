import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink, Loader2, RotateCw, X } from "lucide-react";
import type { WebsiteProductionRun, WebsiteProductionStatus, WebsiteSite } from "@greatstone/shared";
import { websiteModuleApi } from "../../api/website";
import { queryKeys } from "../../lib/queryKeys";
import { cn, formatClockTime, formatShortDate } from "../../lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WEBSITE_ACTIONS } from "../../lib/website-status";
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

// Deploy and Roll back of greatstoneint.com (John, 11 Nov 2026). Staging is checked and shown first; Deploy puts
// exactly that commit and content release live through the website repo's production workflow. Only John sees
// the buttons; everyone else sees what is live and what is waiting.
// 13 Nov (John): Staging and Live sit side by side, each labelled with its address, so it is always clear which one
// an action changes. Deploy straight to live (skip staging) is the second, rarer path: main's head and the approved
// content, with a stronger confirm. Staging stays the default.

const POLL_RUNNING_MS = 5_000;
const POLL_IDLE_MS = 60_000;

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "");
const when = (at: string | null) => (at ? `${formatShortDate(at)} ${formatClockTime(at)}` : "");

/** A run in plain words: "Deploying", "Deployed", "Roll back failed". */
export function runLabel(run: WebsiteProductionRun) {
  if (run.action === "rollback") {
    if (run.status !== "completed") return "Rolling back";
    return run.conclusion === "success" ? "Rolled back" : run.conclusion === "cancelled" ? "Roll back cancelled" : "Roll back failed";
  }
  const what = run.action === "direct" ? "Deploy straight to live" : "Deploy to live";
  if (run.status !== "completed") return run.status === "queued" ? `${what} waiting to start` : run.action === "direct" ? "Deploying straight to live" : "Deploying to live";
  if (run.conclusion === "success") return run.action === "direct" ? "Deployed straight to live" : "Deployed to live";
  return `${what} ${run.conclusion === "cancelled" ? "cancelled" : "failed"}`;
}

/** What Deploy straight to live sends, in plain lines: the confirm lists exactly these. */
export function directContents(status: WebsiteProductionStatus) {
  const { main, commits, approved } = status.direct;
  const items = approved.pages.length + approved.entries.length;
  return {
    code: main ? `Code: main's newest commit ${short(main.sha)} "${main.title}"` : "Code: GSAM could not read main",
    commits: commits.length === 0 ? "No code changes from what is live." : `${commits.length} code change${commits.length === 1 ? "" : "s"} from what is live:`,
    content: items === 0
      ? "Content: a new content release of what is approved. No approved changes are waiting, so it matches what is live."
      : `Content: a new content release with ${approved.pages.length} approved page${approved.pages.length === 1 ? "" : "s"} and ${approved.entries.length} approved entr${approved.entries.length === 1 ? "y" : "ies"} that are not live yet:`,
  };
}

/** What Deploy would change: nothing, or code and content. */
export function waitingCount(status: WebsiteProductionStatus) {
  const content = status.staging.release !== null && status.staging.release !== status.live.release ? 1 : 0;
  return status.commits.length + content;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
      <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </div>
  );
}

/** One side: Staging (calm, info) or Live (warning tone: it is the public site). */
function SideCard({ side, title, commit, release, changedAt, url, unread, onRetry, retrying }: {
  side: "staging" | "live"; title: string; commit: string | null; release: number | null; changedAt: string | null; url: string;
  unread: boolean; onRetry: () => void; retrying: boolean;
}) {
  const live = side === "live";
  return (
    <div
      data-testid={`website-deploy-${side}`}
      className={cn("min-w-0 space-y-2 rounded-lg border p-3", live ? "border-status-warning/40 bg-status-warning/10" : "border-status-info/30 bg-status-info/10")}
    >
      <p className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-semibold", live ? "bg-status-warning-soft text-status-warning-foreground" : "bg-status-info-soft text-status-info-foreground")}>{title}</p>
      <dl className="space-y-1">
        <Row label="Code commit">
          {commit ? <span className="font-mono">{short(commit)}</span> : unread ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              <span className="text-status-warning-foreground">Could not read</span>
              <Button type="button" size="xs" variant="outline" onClick={onRetry} disabled={retrying}>
                <RotateCw className={cn(retrying && "animate-spin")} aria-hidden />Retry
              </Button>
            </span>
          ) : "None deployed yet"}
        </Row>
        <Row label="Content release">{release ?? "None"}</Row>
        <Row label="Last changed">{changedAt ? when(changedAt) : "Not known"}</Row>
        <Row label="Address">
          <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 break-all underline underline-offset-2">
            {url.replace(/^https:\/\//, "")}<ExternalLink className="size-3 shrink-0" aria-hidden /><span className="sr-only"> (opens in a new tab)</span>
          </a>
        </Row>
      </dl>
    </div>
  );
}

function StepIcon({ status, conclusion }: { status: string; conclusion: string | null }) {
  if (status !== "completed") return <Loader2 className="size-3.5 animate-spin" aria-label="In progress" />;
  if (conclusion === "success") return <Check className="size-3.5 text-status-success" aria-label="Done" />;
  if (conclusion === "skipped") return <span className="size-3.5" aria-label="Skipped" />;
  return <X className="size-3.5 text-status-danger" aria-label="Failed" />;
}

function RunProgress({ run }: { run: WebsiteProductionRun }) {
  const failed = run.status === "completed" && run.conclusion !== "success";
  return (
    <div
      role="status"
      data-testid="website-deploy-run"
      className={cn(
        "space-y-2 rounded-lg border p-3 text-sm",
        failed && "border-status-danger/40 bg-status-danger-soft",
        run.status === "completed" && !failed && "border-status-success/40 bg-status-success-soft",
      )}
    >
      <p className="font-semibold text-foreground">{runLabel(run)}</p>
      {run.steps?.length ? (
        <ol className="space-y-1 text-xs">
          {run.steps.map((step) => (
            <li key={step.name} className={cn("flex items-center gap-2", step.status === "queued" && "text-muted-foreground")}>
              <StepIcon status={step.status} conclusion={step.conclusion} />
              {step.name}
            </li>
          ))}
        </ol>
      ) : null}
      {failed ? (
        <p className="text-xs">
          {run.action === "deploy"
            ? "If the upload had started, the earlier site was put back automatically. greatstoneint.com is as it was. The details say which step stopped."
            : "The details say which step stopped. Check greatstoneint.com now."}
        </p>
      ) : run.status !== "completed" ? (
        <p className="text-xs text-muted-foreground">You can leave this page. It carries on.</p>
      ) : null}
      <a href={run.url} target="_blank" rel="noreferrer" className="text-xs underline underline-offset-2">Details on GitHub</a>
    </div>
  );
}

export function WebsiteDeployPanel({ companyId, site }: { companyId: string; site: WebsiteSite }) {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<"deploy" | "direct" | "rollback" | null>(null);
  const [typed, setTyped] = useState("");
  // GitHub takes a few seconds to list a new run; keep polling quickly once one is started.
  const [starting, setStarting] = useState(false);
  const key = queryKeys.website.production(companyId, site.id);
  const query = useQuery({
    queryKey: key,
    queryFn: () => websiteModuleApi.production(companyId, site.id),
    retry: false,
    refetchInterval: (q) => (q.state.data?.runs.some((run) => run.status !== "completed") || starting ? POLL_RUNNING_MS : POLL_IDLE_MS),
  });
  const status = query.data;
  const settle = () => { setConfirm(null); setStarting(true); void queryClient.invalidateQueries({ queryKey: key }); };
  const deploy = useMutation({
    mutationFn: () => websiteModuleApi.deploy(companyId, site.id, status!.staging.commit!, status!.staging.release!),
    onSuccess: settle,
  });
  const direct = useMutation({
    mutationFn: () => websiteModuleApi.deployDirect(companyId, site.id, status!.direct.main!.sha),
    onSuccess: () => { setTyped(""); settle(); },
  });
  const rollback = useMutation({
    mutationFn: () => websiteModuleApi.rollbackLive(companyId, site.id, status!.rollback!.deployId),
    onSuccess: settle,
  });

  if (query.isLoading) return <p className="text-xs text-muted-foreground">Reading Live and Staging</p>;
  if (query.error || !status) {
    return (
      <section className="space-y-1 rounded-lg border border-border p-3 text-sm" data-testid="website-deploy-panel">
        <h3 className="font-semibold">Staging and live</h3>
        <p className="text-xs text-status-warning-foreground">{query.error ? errorStateMessage(query.error) : "GSAM cannot read Live right now."}</p>
      </section>
    );
  }

  const running = status.runs.find((run) => run.status !== "completed");
  const shown = running ?? status.runs[0];
  const waiting = waitingCount(status);
  const blocked = status.blockers.length > 0;
  const ready = status.workflowReady && !running && !blocked && waiting > 0 && !!status.staging.commit && status.staging.release !== null;
  const reason = running ? "A Deploy or Roll back is running."
    : !status.workflowReady ? "Deploy is not set up in GitHub yet. See the steps below."
      : blocked ? "Staging is not ready (see the checks above)."
        : waiting === 0 ? "Everything on staging is already live." : null;
  const error = deploy.error ?? direct.error ?? rollback.error;
  const busy = deploy.isPending || direct.isPending || rollback.isPending;
  const directReady = status.workflowReady && !running && !!status.direct.main;
  const contents = directContents(status);
  // A side reads "Could not read" when its commit is missing and GSAM reported a problem reading it.
  const unread = (side: "staging" | "live") => status.problems.some((p) => (side === "staging" ? /staging/ : /live site|live content/).test(p));

  return (
    <section className="space-y-3 rounded-lg border border-border p-3 text-sm" data-testid="website-deploy-panel" aria-label="Staging and live">
      <h3 className="font-semibold">Staging and live</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <SideCard side="staging" title="Staging (test copy)" commit={status.staging.commit} release={status.staging.release} changedAt={status.staging.changedAt}
          url={status.staging.url} unread={unread("staging")} onRetry={() => void query.refetch()} retrying={query.isFetching} />
        <SideCard side="live" title="Live (public site)" commit={status.live.commit} release={status.live.release} changedAt={status.live.publishedAt}
          url={status.live.url} unread={unread("live")} onRetry={() => void query.refetch()} retrying={query.isFetching} />
      </div>

      <div className="space-y-1 text-xs">
        <p className="font-medium text-foreground" data-testid="website-deploy-waiting">
          {waiting === 0 ? "Nothing is waiting: live matches staging." : `On staging, waiting to go live (${waiting})`}
        </p>
        {status.staging.release !== null && status.staging.release !== status.live.release ? (
          <p className="text-muted-foreground">Page and catalogue edits: content release {status.staging.release} (live has {status.live.release ?? "none"})</p>
        ) : null}
        {status.commits.length ? (
          <ul className="max-h-48 space-y-0.5 overflow-y-auto text-muted-foreground">
            {status.commits.map((c) => <li key={c.sha} className="truncate"><span className="font-mono">{c.sha.slice(0, 7)}</span> {c.title}</li>)}
          </ul>
        ) : null}
      </div>

      <div className="space-y-1 text-xs" data-testid="website-deploy-checks">
        <p className="font-medium text-foreground">Checks on staging</p>
        {blocked ? (
          <ul className="space-y-0.5">
            {status.blockers.map((b) => <li key={b} className="flex items-start gap-2 text-status-danger"><X className="mt-0.5 size-3.5 shrink-0" aria-hidden />{b}</li>)}
          </ul>
        ) : (
          <p className="flex items-center gap-2 text-muted-foreground"><Check className="size-3.5 text-status-success" aria-hidden />Products, key pages, a product page and shop prices all answer on staging.</p>
        )}
        {status.problems.map((p) => <p key={p} className="text-status-warning-foreground">{p}</p>)}
      </div>

      {shown ? <RunProgress run={shown} /> : null}

      {status.canDeploy ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={!ready || deploy.isPending} onClick={() => setConfirm("deploy")}>{WEBSITE_ACTIONS.deploy}</Button>
          {status.rollback ? (
            <Button type="button" size="sm" variant="ghost" disabled={!!running || !status.workflowReady || rollback.isPending} onClick={() => setConfirm("rollback")}>
              Roll back the live site
            </Button>
          ) : null}
          {reason ? <p className="basis-full text-xs text-muted-foreground">{reason}</p> : null}
          <div className="basis-full space-y-1 border-t border-border pt-2" data-testid="website-deploy-direct">
            <Button type="button" size="sm" variant="outline" disabled={!status.direct.supported || !directReady || direct.isPending} onClick={() => { setTyped(""); setConfirm("direct"); }}>
              {WEBSITE_ACTIONS.direct}
            </Button>
            <p className="text-xs text-muted-foreground">
              {status.direct.supported
                ? "For when staging is not needed: puts main's newest code and the approved content on greatstoneint.com without testing them on staging first."
                : "Waiting for the website update: the website has to accept this kind of Deploy first (a pull request for John to review)."}
            </p>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Only John can deploy to live or roll back. What you approve and publish to staging waits there until he does.</p>
      )}
      {error ? <p role="alert" className="text-xs text-status-danger">{errorStateMessage(error)}</p> : null}

      {/* Shown even when the workflow file exists: the key variable can still be missing, and GitHub does not say. */}
      {status.canDeploy && status.publicKey ? (
        <details className="text-xs" data-testid="website-deploy-setup" open={!status.workflowReady}>
          <summary className="cursor-pointer font-medium">GSAM's public key for GitHub (set up once)</summary>
          <p className="mt-1">In the website repository, environment production, add the variable GSAM_DEPLOY_PUBLIC_KEY with this value. It is GSAM's public key, not a secret:</p>
          <code className="mt-1 block break-all rounded bg-muted p-2 font-mono">{status.publicKey}</code>
        </details>
      ) : null}

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && !busy && setConfirm(null)}>
        <AlertDialogContent data-testid={confirm ? `website-confirm-${confirm}` : undefined}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "deploy" ? "Deploy staging to live: greatstoneint.com?" : confirm === "direct" ? "Deploy straight to live: greatstoneint.com?" : "Roll back live: greatstoneint.com?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "direct"
                ? "Skips staging. Nothing below was checked on staging. greatstoneint.com is still checked straight after, and put back by itself if a check fails."
                : confirm === "deploy"
                ? `Visitors will see code ${short(status.staging.commit)} with content release ${status.staging.release}: ${waiting} change${waiting === 1 ? "" : "s"} from what is live now. It takes about 5 minutes. The site is checked straight after, and put back by itself if a check fails.`
                : `Puts back the live site from ${when(status.rollback?.publishedAt ?? null) || "before the last Deploy"}${status.rollback?.commit ? ` (code ${short(status.rollback.commit)})` : ""}, with the content it served. No rebuild; it takes about a minute.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirm === "direct" ? (
            <div className="min-w-0 space-y-2 text-sm" data-testid="website-direct-contents">
              <p className="font-medium">What goes out</p>
              <p>{contents.code}</p>
              <p className="text-xs text-muted-foreground">{contents.commits}</p>
              {status.direct.commits.length ? (
                <ul className="max-h-32 space-y-0.5 overflow-y-auto text-xs">
                  {status.direct.commits.map((c) => <li key={c.sha} className="truncate"><span className="font-mono">{short(c.sha)}</span> {c.title}</li>)}
                </ul>
              ) : null}
              <p className="text-xs text-muted-foreground">{contents.content}</p>
              {status.direct.approved.pages.length + status.direct.approved.entries.length ? (
                <ul className="max-h-32 space-y-0.5 overflow-y-auto text-xs">
                  {[...status.direct.approved.pages, ...status.direct.approved.entries].map((name) => <li key={name} className="truncate">{name}</li>)}
                </ul>
              ) : null}
              <p className="rounded-md border border-status-warning/40 bg-status-warning-soft p-2 text-xs text-status-warning-foreground">
                Not tested on staging. Staging stays as it is.
              </p>
              <label className="block space-y-1 text-xs">
                <span>Type <span className="font-mono font-semibold">live</span> to confirm</span>
                <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" aria-label="Type live to confirm" />
              </label>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant={confirm === "deploy" ? "default" : "destructive"}
              disabled={busy || (confirm === "direct" && typed.trim().toLowerCase() !== "live")}
              onClick={() => (confirm === "deploy" ? deploy.mutate() : confirm === "direct" ? direct.mutate() : rollback.mutate())}
            >
              {busy ? "Starting" : confirm === "deploy" ? "Deploy to live" : confirm === "direct" ? "Deploy straight to live" : "Roll back live"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
