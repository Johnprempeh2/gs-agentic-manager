import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WebsiteVendorActivationSteps, WebsiteVendorActivationStepsInput } from "@greatstone/shared";
import { websiteCommerceApi, type CommerceRow } from "@/api/website-commerce";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { useCommercePerson } from "@/hooks/useCommerceWrite";
import {
  ACTIVATION_STEPS_MAX,
  activationStepsInput,
  licencesInRangeLabel,
  maskedLicenceKey,
  statusLabel,
  text,
  vendorForLicence,
} from "@/lib/commerce";
import { isDefiniteAnswer, newIdempotencyKey, rowVersionOf } from "@/lib/commerce-write";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { cn, formatNumber } from "@/lib/utils";
import { CommerceWriteError, ConfirmButton, PeopleOnlyNote } from "./CommerceWriteParts";

// Licence activation steps (GRE-3983, on the GRE-3982 route). The steps belong to the vendor, not the licence: the
// site matches a licence to its vendor by product name and shows that vendor's steps beside it. This screen reads only
// the masked key; the steps must never hold a full key, and the site refuses any text that does.

const SECTION = "space-y-3 rounded-xl border border-border bg-card p-4";

type ActivationChange = { vendorId: string; input: WebsiteVendorActivationStepsInput };

/** The vendor row as it is after a save, or after a conflict's `current` (the contract's camelCase fields). */
function vendorAfter(vendor: CommerceRow, item: Partial<WebsiteVendorActivationSteps>): CommerceRow {
  return {
    ...vendor,
    ...(item.activationSteps !== undefined ? { activation_instructions: item.activationSteps } : {}),
    ...(typeof item.rowVersion === "number" ? { row_version: item.rowVersion } : {}),
    ...(item.updatedAt ? { updated_at: item.updatedAt } : {}),
    ...(item.status ? { status: item.status } : {}),
  };
}

export function LicenceActivationSteps({ companyId, siteId, licence }: { companyId: string; siteId: string; licence: CommerceRow }) {
  const queryClient = useQueryClient();
  const isPerson = useCommercePerson();
  const vendorsKey = queryKeys.website.commerce(companyId, siteId, "vendors", "options");
  const vendors = useQuery({
    queryKey: vendorsKey,
    queryFn: () => websiteCommerceApi.list(companyId, siteId, "vendors", { limit: 100 }),
    staleTime: 60_000,
  });
  const rows = vendors.data?.items ?? [];
  const matched = vendorForLicence(licence.offering_name, rows);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const vendorId = chosenId ?? text(matched?.id);
  const vendor = rows.find((row) => text(row.id) === vendorId) ?? null;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const setVendorRow = (next: CommerceRow) => queryClient.setQueryData<{ items: CommerceRow[]; nextCursor: string | null }>(vendorsKey,
    (list) => list ? { ...list, items: list.items.map((row) => (text(row.id) === text(next.id) ? next : row)) } : list);

  // the same change again (after a network error or a 5xx) keeps its key, so the site writes it once
  const pending = useRef<{ signature: string; key: string } | null>(null);
  const save = useMutation({
    mutationFn: (change: ActivationChange) => {
      const signature = JSON.stringify(change);
      if (pending.current?.signature !== signature) pending.current = { signature, key: newIdempotencyKey() };
      return websiteCommerceApi.putActivationSteps(companyId, siteId, change.vendorId, change.input, pending.current.key);
    },
    onSuccess: (result) => {
      pending.current = null;
      if (vendor) setVendorRow(vendorAfter(vendor, result.item));
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.website.siteData(companyId, siteId) });
    },
    onError: (error) => { if (isDefiniteAnswer(error)) pending.current = null; },
  });

  const steps = text(vendor?.activation_instructions);
  const published = text(vendor?.status) !== "draft";
  // the site lets an agent change only a draft vendor; a published range's steps need a person
  const canEdit = Boolean(vendor) && (isPerson || !published);
  const version = rowVersionOf(vendor);

  const startEditing = (from: string | null = steps) => {
    setDraft(from ?? "");
    setProblem(null);
    save.reset();
    setEditing(true);
  };
  const send = (value: string) => {
    if (!vendor || !vendorId) return;
    if (version === undefined) return setProblem("The website did not send this vendor's version. Reload the page, then try again.");
    const input = activationStepsInput(value, version);
    if (!input) return setProblem(`Keep the steps to ${formatNumber(ACTIVATION_STEPS_MAX)} characters or fewer.`);
    setProblem(null);
    save.mutate({ vendorId, input });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim() && !steps) return setProblem("Write the steps first.");
    send(draft);
  };
  const useCurrent = (current: CommerceRow) => {
    if (!vendor) return;
    const next = vendorAfter(vendor, current as Partial<WebsiteVendorActivationSteps>);
    setVendorRow(next);
    startEditing(text(next.activation_instructions));
  };

  const saved = save.data?.item;
  return (
    <section className={SECTION} aria-label="Activation steps" data-testid="commerce-activation-steps">
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-sm font-semibold">Activation steps</h2>
          <p className="text-sm text-muted-foreground">
            What the customer does with licence <span className="font-mono" data-testid="commerce-activation-key">{maskedLicenceKey(licence)}</span>.
            The steps belong to the vendor, so they show beside every licence in its range, on the account page and in the licence email.
          </p>
        </div>
        {editing || !canEdit ? null : (
          <Button size="sm" variant="outline" className="shrink-0" onClick={() => startEditing()} data-testid="commerce-activation-edit">
            {steps ? "Edit steps" : "Add steps"}
          </Button>
        )}
      </div>

      {vendors.isLoading ? <p className="text-sm text-muted-foreground">Loading the website's vendors</p> : null}
      {vendors.error ? <CommerceWriteError error={vendors.error} /> : null}
      {vendors.data && rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          The website has no vendors yet. <Link to="/commerce/vendors/new" className="font-medium text-primary underline-offset-4 hover:underline">Add a vendor</Link>
        </p>
      ) : null}

      {rows.length ? (
        <div className="flex min-w-0 flex-col gap-1.5 sm:max-w-sm">
          <label htmlFor="activation-vendor" className="text-sm font-medium">Vendor</label>
          <NativeSelect id="activation-vendor" value={vendorId ?? ""} disabled={editing || save.isPending} aria-describedby="activation-vendor-help"
            onChange={(e) => { setChosenId(e.target.value || null); save.reset(); setProblem(null); }}>
            {vendorId ? null : <option value="">Choose one</option>}
            {rows.map((row) => <option key={text(row.id)} value={text(row.id) ?? ""}>{text(row.name) ?? text(row.slug) ?? text(row.id)}</option>)}
          </NativeSelect>
          <p id="activation-vendor-help" className="text-xs text-muted-foreground">
            {matched && text(matched.id) === vendorId
              ? "Matched to this licence's product name, as the website matches it."
              : matched ? `The website matches this licence to ${text(matched.name)}.`
                : "No vendor matches this licence's product name, so the website shows no steps beside it."}
          </p>
        </div>
      ) : null}

      {vendor && !editing ? (
        steps ? (
          <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-3 text-sm" data-testid="commerce-activation-current">{steps}</p>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="commerce-activation-empty">{text(vendor.name) ?? "This vendor"} has no activation steps yet.</p>
        )
      ) : null}
      {vendor && !canEdit ? (
        <PeopleOnlyNote>{statusLabel(text(vendor.status) ?? "published")} vendor: a person changes its steps, in GSAM.</PeopleOnlyNote>
      ) : null}

      {editing ? (
        <form className="space-y-3" onSubmit={submit} noValidate>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor="activation-steps" className="text-sm font-medium">Steps for {text(vendor?.name) ?? "this vendor"}</label>
            <Textarea id="activation-steps" rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={save.isPending}
              aria-describedby="activation-steps-help" />
            <p id="activation-steps-help" className="flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground">
              <span>Write the steps only. Never paste a licence key: the website refuses text that holds one.</span>
              <span className={cn("tabular-nums", draft.trim().length > ACTIVATION_STEPS_MAX && "text-destructive")}>
                {formatNumber(draft.trim().length)} / {formatNumber(ACTIVATION_STEPS_MAX)}
              </span>
            </p>
          </div>
          {problem ? <p role="alert" className="text-sm text-destructive">{problem}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={save.isPending}>{save.isPending ? "Saving" : "Save steps"}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setEditing(false); setProblem(null); save.reset(); }} disabled={save.isPending}>
              Cancel
            </Button>
            {steps ? (
              <ConfirmButton label="Clear steps" variant="ghost" destructive title={`Clear ${text(vendor?.name) ?? "this vendor"}'s activation steps?`}
                description="No steps show beside its licences until someone adds them again."
                confirmLabel="Clear" disabled={save.isPending} testId="commerce-activation-clear" onConfirm={() => send("")} />
            ) : null}
          </div>
        </form>
      ) : null}

      <CommerceWriteError error={save.error} onUseCurrent={useCurrent} />
      {saved && !editing ? (
        <p role="status" className="rounded-lg border border-status-success/40 bg-status-success-soft p-3 text-sm text-status-success-foreground"
          data-testid="commerce-activation-saved">
          {saved.activationSteps === null
            ? `Cleared ${saved.vendorName}'s steps. No steps show beside its licences now.`
            : `Saved ${saved.vendorName}'s steps. ${licencesInRangeLabel(saved.licencesInRange)}.`}
        </p>
      ) : null}
    </section>
  );
}
