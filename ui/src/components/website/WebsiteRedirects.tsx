import { useId, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Pencil, Plus, Trash2 } from "lucide-react";
import {
  WEBSITE_REDIRECT_STATUSES,
  websiteRedirectInputSchema,
  type WebsiteEntryStatus,
  type WebsiteRedirect,
  type WebsiteRedirectStatus,
} from "@greatstone/shared";
import { websiteModuleApi } from "../../api/website";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmButton } from "@/components/commerce/CommerceWriteParts";
import { ErrorState, errorStateMessage } from "../ErrorState";
import { useEntryStatusWord } from "./WebsiteCollections";

// Redirects (GRE-4785, GRE-4079 step 5d): old addresses that send visitors on. Each change is a draft of a
// `redirect` entry; a person with Publish rights approves it, Publish puts it on staging and Deploy puts it live.

export const REDIRECT_STATUS_LABEL: Record<WebsiteRedirectStatus, string> = {
  301: "Permanent (301)",
  308: "Permanent, keeps the form data (308)",
  302: "Temporary (302)",
  307: "Temporary, keeps the form data (307)",
};
const REDIRECT_STATUS_ORDER: WebsiteRedirectStatus[] = [301, 308, 302, 307];

const STATE_PILL: Record<WebsiteEntryStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  review: "bg-status-warning-soft text-status-warning-foreground",
  approved: "bg-status-info-soft text-status-info-foreground",
  published: "bg-status-success-soft text-status-success-foreground",
};
const PILL = "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium";

function RedirectForm({ companyId, siteId, redirect, open, onClose, onSaved }: {
  companyId: string;
  siteId: string;
  /** The redirect to change, or null to add one. */
  redirect: WebsiteRedirect | null;
  open: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const id = useId();
  const [from, setFrom] = useState(redirect?.from ?? "");
  const [to, setTo] = useState(redirect?.to ?? "");
  const [status, setStatus] = useState<WebsiteRedirectStatus>(redirect?.status ?? 301);
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (input: { from: string; to: string; status: WebsiteRedirectStatus }) =>
      redirect
        ? websiteModuleApi.saveRedirect(companyId, siteId, redirect.entryId, { ...input, baseRevisionId: redirect.latestRevisionId! })
        : websiteModuleApi.createRedirect(companyId, siteId, input),
    onSuccess: () => {
      onSaved(redirect ? "Redirect changed. It is a draft again: send it for review." : "Redirect added as a draft. Send it for review.");
      onClose();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = websiteRedirectInputSchema.safeParse({ from, to, status });
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? "Check the addresses.");
      return;
    }
    setProblem(null);
    save.mutate(parsed.data);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-lg" data-testid="website-redirect-form">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{redirect ? "Change redirect" : "Add redirect"}</DialogTitle>
            <DialogDescription>Visitors who open the old path go to the new address. Once approved, Publish puts it on staging and Deploy puts it live.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-from`} className="text-sm font-medium">Old path</label>
            <Input id={`${id}-from`} value={from} onChange={(event) => setFrom(event.target.value)} placeholder="/old-page" required maxLength={2000}
              className="font-mono" data-testid="redirect-from" />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-to`} className="text-sm font-medium">New address</label>
            <Input id={`${id}-to`} value={to} onChange={(event) => setTo(event.target.value)} placeholder="/new-page" required maxLength={2000}
              aria-describedby={`${id}-to-help`} className="font-mono" data-testid="redirect-to" />
            <p id={`${id}-to-help`} className="text-xs text-muted-foreground">A path on this site, or an address that starts with https://.</p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-status`} className="text-sm font-medium">Type</label>
            <NativeSelect id={`${id}-status`} value={String(status)} onChange={(event) => setStatus(Number(event.target.value) as WebsiteRedirectStatus)}>
              {REDIRECT_STATUS_ORDER.filter((code) => WEBSITE_REDIRECT_STATUSES.includes(code)).map((code) => (
                <option key={code} value={code}>{REDIRECT_STATUS_LABEL[code]}</option>
              ))}
            </NativeSelect>
          </div>
          {problem || save.error ? <p role="alert" className="text-sm text-destructive">{problem ?? errorStateMessage(save.error)}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={save.isPending || !from.trim() || !to.trim()} data-testid="redirect-save">
              {save.isPending ? "Saving" : redirect ? "Save draft" : "Add redirect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function WebsiteRedirects({ companyId, siteId }: { companyId: string; siteId: string }) {
  const queryClient = useQueryClient();
  const redirects = useQuery({
    queryKey: queryKeys.website.redirects(companyId, siteId),
    queryFn: () => websiteModuleApi.redirects(companyId, siteId),
  });
  const access = useQuery({
    queryKey: queryKeys.website.access(companyId, siteId),
    queryFn: () => websiteModuleApi.access(companyId, siteId),
    retry: false,
  });
  const canEdit = access.data?.edit ?? false;
  const canApprove = access.data?.publish ?? false;
  const statusWord = useEntryStatusWord();
  const [editing, setEditing] = useState<WebsiteRedirect | null | undefined>(undefined);
  const [message, setMessage] = useState<string | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.website.redirects(companyId, siteId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.website.review(companyId, siteId) });
  };
  const step = useMutation({
    mutationFn: async ({ action, redirect }: { action: "review" | "approve" | "delete"; redirect: WebsiteRedirect }): Promise<unknown> =>
      action === "review"
        ? websiteModuleApi.submitEntry(companyId, siteId, redirect.entryId)
        : action === "approve"
          // A person with Publish rights approves a draft in one click: the server approves only what is in review.
          ? (redirect.state === "draft" ? websiteModuleApi.submitEntry(companyId, siteId, redirect.entryId) : Promise.resolve()).then(() => websiteModuleApi.approveEntry(companyId, siteId, redirect.entryId))
          : websiteModuleApi.deleteRedirect(companyId, siteId, redirect.entryId),
    onSuccess: (_result, { action, redirect }) => {
      setMessage(
        action === "review" ? `Sent ${redirect.from} for review.`
          : action === "approve" ? `Approved ${redirect.from}. Publish puts it on staging, and Deploy puts it live.`
            : `Deleted ${redirect.from}. It stops working on the site when you Publish.`,
      );
      refresh();
    },
    onError: () => refresh(),
  });

  const list = redirects.data ?? [];
  return (
    <section className="space-y-4" data-testid="website-redirects">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-base font-semibold">Redirects</h3>
          <p className="text-sm text-muted-foreground">
            Old addresses that send visitors to a new one. A person with Publish rights approves each change. Publish puts it on staging, and Deploy puts it live.
          </p>
        </div>
        {canEdit ? (
          <Button onClick={() => { setMessage(null); setEditing(null); }} className="shrink-0" data-testid="redirect-add">
            <Plus />
            Add redirect
          </Button>
        ) : null}
      </div>
      {message ? <p role="status" className="text-sm text-status-success">{message}</p> : null}
      {step.error ? <p role="alert" className="text-sm text-destructive">{errorStateMessage(step.error)}</p> : null}
      {redirects.error ? (
        <ErrorState error={redirects.error} onRetry={() => void redirects.refetch()} />
      ) : redirects.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading redirects</p>
      ) : list.length === 0 ? (
        <div className="space-y-1 rounded-lg border border-dashed border-border p-6 text-center">
          <h4 className="font-medium">No redirects</h4>
          <p className="text-sm text-muted-foreground">Add one when a page moves, so old links keep working.</p>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Redirects">
          {list.map((redirect) => (
            <li key={redirect.entryId} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between" data-testid="redirect-row">
              <div className="min-w-0 space-y-1.5">
                <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-mono text-sm">
                  <span className="break-all">{redirect.from}</span>
                  <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-label="goes to" />
                  <span className="break-all">{redirect.to}</span>
                </p>
                <p className="flex flex-wrap items-center gap-2">
                  <span className={cn(PILL, STATE_PILL[redirect.state])}>{statusWord(redirect.state)}</span>
                  <span className="text-xs text-muted-foreground">{REDIRECT_STATUS_LABEL[redirect.status]}</span>
                </p>
              </div>
              {canEdit ? (
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {redirect.state === "draft" && !canApprove ? (
                    <Button size="sm" variant="outline" disabled={step.isPending} onClick={() => step.mutate({ action: "review", redirect })}>Send for review</Button>
                  ) : null}
                  {(redirect.state === "draft" || redirect.state === "review") && canApprove ? (
                    <Button size="sm" variant="outline" disabled={step.isPending} onClick={() => step.mutate({ action: "approve", redirect })}>Approve</Button>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => { setMessage(null); setEditing(redirect); }} aria-label={`Change redirect from ${redirect.from}`}>
                    <Pencil />
                    Change
                  </Button>
                  <ConfirmButton
                    label={<Trash2 />}
                    ariaLabel={`Delete redirect from ${redirect.from}`}
                    variant="ghost"
                    destructive
                    title="Delete this redirect?"
                    description={`${redirect.from} stops sending visitors to ${redirect.to} after the next Publish and Deploy. Its history stays.`}
                    confirmLabel="Delete"
                    disabled={step.isPending}
                    onConfirm={() => step.mutate({ action: "delete", redirect })}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editing !== undefined ? (
        <RedirectForm
          key={editing?.entryId ?? "new"}
          companyId={companyId}
          siteId={siteId}
          redirect={editing}
          open
          onClose={() => setEditing(undefined)}
          onSaved={(text) => { setMessage(text); refresh(); }}
        />
      ) : null}
    </section>
  );
}
