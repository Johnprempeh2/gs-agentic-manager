import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, X } from "lucide-react";
import type { WebsiteProductionRun, WebsiteProductionStatus, WebsiteSite } from "@greatstone/shared";
import { websiteModuleApi } from "../../api/website";
import { queryKeys } from "../../lib/queryKeys";
import { cn, formatClockTime, formatShortDate } from "../../lib/utils";
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

// Deploy and Roll back of greatstoneint.com (John, 11 Nov 2026). Staging is checked and shown first; Deploy puts
// exactly that commit and content release live through the website repo's production workflow. Only John sees
// the buttons; everyone else sees what is live and what is waiting.

const POLL_RUNNING_MS = 5_000;
const POLL_IDLE_MS = 60_000;

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "unknown");
const when = (at: string | null) => (at ? `${formatShortDate(at)} ${formatClockTime(at)}` : "");

/** A run in plain words: "Deploying", "Deployed", "Roll back failed". */
export function runLabel(run: WebsiteProductionRun) {
  const deploy = run.action === "deploy";
  if (run.status !== "completed") return deploy ? (run.status === "queued" ? "Deploy waiting to start" : "Deploying") : "Rolling back";
  if (run.conclusion === "success") return deploy ? "Deployed" : "Rolled back";
  if (run.conclusion === "cancelled") return deploy ? "Deploy cancelled" : "Roll back cancelled";
  return deploy ? "Deploy failed" : "Roll back failed";
}

/** What Deploy would change: nothing, or code and content. */
export function waitingCount(status: WebsiteProductionStatus) {
  const content = status.staging.release !== null && status.staging.release !== status.live.release ? 1 : 0;
  return status.commits.length + content;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
      <span className="w-16 shrink-0 font-medium text-foreground">{label}</span>
      <span className="min-w-0 text-muted-foreground">{children}</span>
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
  const [confirm, setConfirm] = useState<"deploy" | "rollback" | null>(null);
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
  const rollback = useMutation({
    mutationFn: () => websiteModuleApi.rollbackLive(companyId, site.id, status!.rollback!.deployId),
    onSuccess: settle,
  });

  if (query.isLoading) return <p className="text-xs text-muted-foreground">Reading Live and Staging</p>;
  if (query.error || !status) {
    return (
      <section className="space-y-1 rounded-lg border border-border p-3 text-sm" data-testid="website-deploy-panel">
        <h3 className="font-semibold">Live site</h3>
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
  const error = deploy.error ?? rollback.error;

  return (
    <section className="space-y-3 rounded-lg border border-border p-3 text-sm" data-testid="website-deploy-panel" aria-label="Deploy to greatstoneint.com">
      <div className="space-y-1">
        <h3 className="font-semibold">Live site: greatstoneint.com</h3>
        <Row label="Live">Code {short(status.live.commit)}, content release {status.live.release ?? "none"}{status.live.publishedAt ? `, since ${when(status.live.publishedAt)}` : ""}</Row>
        <Row label="Staging">Code {short(status.staging.commit)}, content release {status.staging.release ?? "none"}</Row>
      </div>

      <div className="space-y-1 text-xs">
        <p className="font-medium text-foreground" data-testid="website-deploy-waiting">
          {waiting === 0 ? "Nothing is waiting: Live matches Staging." : `Waiting to go live (${waiting})`}
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
          <Button type="button" size="sm" disabled={!ready || deploy.isPending} onClick={() => setConfirm("deploy")}>Deploy to greatstoneint.com</Button>
          {status.rollback ? (
            <Button type="button" size="sm" variant="ghost" disabled={!!running || !status.workflowReady || rollback.isPending} onClick={() => setConfirm("rollback")}>
              Roll back to the previous live site
            </Button>
          ) : null}
          {reason ? <p className="basis-full text-xs text-muted-foreground">{reason}</p> : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Only John can Deploy or Roll back. What you approve and publish waits on staging until he does.</p>
      )}
      {error ? <p role="alert" className="text-xs text-status-danger">{errorStateMessage(error)}</p> : null}

      {status.canDeploy && !status.workflowReady && status.publicKey ? (
        <details className="text-xs" data-testid="website-deploy-setup">
          <summary className="cursor-pointer font-medium">Set up Deploy in GitHub (once)</summary>
          <p className="mt-1">In the website repository, environment production, add the variable GSAM_DEPLOY_PUBLIC_KEY with this value. It is GSAM's public key, not a secret:</p>
          <code className="mt-1 block break-all rounded bg-muted p-2 font-mono">{status.publicKey}</code>
        </details>
      ) : null}

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && !deploy.isPending && !rollback.isPending && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "deploy" ? "Deploy staging to greatstoneint.com?" : "Roll back greatstoneint.com?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "deploy"
                ? `Visitors will see code ${short(status.staging.commit)} with content release ${status.staging.release}: ${waiting} change${waiting === 1 ? "" : "s"} from what is live now. It takes about 5 minutes. The site is checked straight after, and put back by itself if a check fails.`
                : `Puts back the live site from ${when(status.rollback?.publishedAt ?? null) || "before the last Deploy"}${status.rollback?.commit ? ` (code ${short(status.rollback.commit)})` : ""}, with the content it served. No rebuild; it takes about a minute.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deploy.isPending || rollback.isPending}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant={confirm === "rollback" ? "destructive" : "default"}
              disabled={deploy.isPending || rollback.isPending}
              onClick={() => (confirm === "deploy" ? deploy.mutate() : rollback.mutate())}
            >
              {deploy.isPending || rollback.isPending ? "Starting" : confirm === "deploy" ? "Deploy" : "Roll back"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
