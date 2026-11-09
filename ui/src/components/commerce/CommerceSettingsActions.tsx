import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { CommerceRow } from "@/api/website-commerce";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { useCommercePerson, useCommerceWrite } from "@/hooks/useCommerceWrite";
import { maskedLicenceKey, statusLabel, text } from "@/lib/commerce";
import { LICENCE_FIELDS, ORDER_STATUS_FIELDS, licenceEmailMessage, orderStatusLocked } from "@/lib/commerce-settings";
import { rowVersionOf } from "@/lib/commerce-write";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { CommerceRowForm, CommerceWriteError, ConfirmButton, PeopleOnlyNote } from "./CommerceWriteParts";

// Order status, the licence-issued email and a licence's key (GRE-4784, on the GRE-4782 routes). Anyone with Commerce
// rights sets an order's status and edits a licence's details. Only a person emails the client, issues, re-keys,
// revokes or re-issues a licence. A key typed here goes to the website and is never shown again: GSAM reads the last 4.

const SECTION = "space-y-3 rounded-xl border border-border bg-card p-4";
const NOTICE = "rounded-lg border p-3 text-sm";

export function OrderStatusActions({ companyId, siteId, order }: { companyId: string; siteId: string; order: CommerceRow }) {
  const queryClient = useQueryClient();
  const isPerson = useCommercePerson();
  const orderId = text(order.id) ?? "";
  const itemKey = queryKeys.website.data(companyId, siteId, "orders", "item", orderId);
  const [editing, setEditing] = useState(false);
  const save = useCommerceWrite(companyId, siteId, {
    onSuccess: (item) => { if (item) queryClient.setQueryData(itemKey, { item: { ...order, ...item } }); setEditing(false); },
  });
  const notify = useCommerceWrite(companyId, siteId);
  const locked = orderStatusLocked(order);
  const emailed = notify.data ? licenceEmailMessage(notify.data.email) : null;

  return (
    <section className={SECTION} aria-label="Order status" data-testid="commerce-order-status">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold">Order status</h2>
          <p className="text-sm text-muted-foreground">
            {locked
              ? `This order is ${statusLabel(text(order.status)!).toLowerCase()}. Its status does not change.`
              : "Refunds change the status on their own. Set the rest here."}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <div className="flex flex-wrap gap-2">
            {editing || locked ? null : <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Change status</Button>}
            {isPerson ? (
              <ConfirmButton label="Email the licence" title="Email the client about their licence?"
                description="The website emails the order's address that the licence is ready, with a link to their account. The email holds no key."
                confirmLabel="Send email" disabled={notify.isPending} testId="commerce-order-notify"
                onConfirm={() => notify.mutate({ method: "POST", parts: ["orders", orderId, "notify-licence"] })} />
            ) : null}
          </div>
          {isPerson ? null : <PeopleOnlyNote>A person sends client emails, in GSAM.</PeopleOnlyNote>}
        </div>
      </div>
      {editing ? (
        <CommerceRowForm key={text(order.row_version) ?? orderId} idPrefix="order" fields={ORDER_STATUS_FIELDS} base={order}
          saving={save.isPending} submitLabel="Save status" onCancel={() => { setEditing(false); save.reset(); }}
          onSave={(body) => save.mutate({ method: "PATCH", parts: ["orders", orderId], body: { ...body, expectedRowVersion: rowVersionOf(order) } })} />
      ) : null}
      <CommerceWriteError error={save.error}
        onUseCurrent={(current) => { save.reset(); queryClient.setQueryData(itemKey, { item: { ...order, ...current } }); }} />
      <CommerceWriteError error={notify.error} />
      {emailed ? (
        <p role="status" data-testid="commerce-order-notify-result" className={cn(NOTICE, emailed.tone === "ok"
          ? "border-status-success/40 bg-status-success-soft text-status-success-foreground"
          : "border-status-warning/40 bg-status-warning-soft text-status-warning-foreground")}>
          {emailed.text}
        </p>
      ) : null}
    </section>
  );
}

/** A new key or download link, for a person. Sent once, never shown back. */
function ReplaceKeyForm({ saving, onSave, onCancel }: {
  saving: boolean;
  onSave: (body: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [field, setField] = useState<"licenceKey" | "downloadUrl">("licenceKey");
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = value.trim();
    if (!next) return setProblem(field === "licenceKey" ? "Enter the new key." : "Enter the download link.");
    if (field === "downloadUrl" && !/^https?:\/\//i.test(next)) return setProblem("The link must start with https://.");
    setProblem(null);
    onSave({ [field]: next });
  };
  return (
    <form className="space-y-3" onSubmit={submit} noValidate>
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="licence-secret-kind" className="text-sm font-medium">Replace</label>
          <NativeSelect id="licence-secret-kind" value={field} onChange={(e) => setField(e.target.value as typeof field)} disabled={saving}>
            <option value="licenceKey">Licence key</option>
            <option value="downloadUrl">Download link</option>
          </NativeSelect>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="licence-secret-value" className="text-sm font-medium">{field === "licenceKey" ? "New key" : "New link"}</label>
          <Input id="licence-secret-value" type={field === "licenceKey" ? "password" : "url"} autoComplete="off" spellCheck={false}
            value={value} onChange={(e) => setValue(e.target.value)} disabled={saving} className="font-mono" />
          <p className="text-xs text-muted-foreground">Goes to the website only. GSAM keeps the last 4 characters of a key.</p>
        </div>
      </div>
      {problem ? <p role="alert" className="text-sm text-destructive">{problem}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={saving}>{saving ? "Saving" : "Save"}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </form>
  );
}

export function LicenceActions({ companyId, siteId, licence }: { companyId: string; siteId: string; licence: CommerceRow }) {
  const queryClient = useQueryClient();
  const isPerson = useCommercePerson();
  const licenceId = text(licence.id) ?? "";
  const itemKey = queryKeys.website.data(companyId, siteId, "licences", "item", licenceId);
  const [mode, setMode] = useState<"view" | "details" | "key">("view");
  const write = useCommerceWrite(companyId, siteId, {
    onSuccess: (item) => { if (item) queryClient.setQueryData(itemKey, { item: { ...licence, ...item } }); setMode("view"); },
  });
  const status = text(licence.status);
  const version = rowVersionOf(licence);
  const loadCurrent = (current: CommerceRow) => { write.reset(); queryClient.setQueryData(itemKey, { item: { ...licence, ...current } }); };

  return (
    <section className={SECTION} aria-label="Change this licence" data-testid="commerce-licence-actions">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold">Change this licence</h2>
          <p className="text-sm text-muted-foreground">Key ending {maskedLicenceKey(licence)}. A revoked licence stops working in the client's account.</p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <div className="flex flex-wrap gap-2">
            {mode === "view" ? <Button size="sm" variant="outline" onClick={() => setMode("details")}>Edit details</Button> : null}
            {isPerson && mode === "view" ? (
              <Button size="sm" variant="outline" onClick={() => setMode("key")} data-testid="commerce-licence-rekey">Replace key</Button>
            ) : null}
            {isPerson && status !== "revoked" ? (
              <ConfirmButton label="Revoke" variant="destructive" destructive title="Revoke this licence?"
                description="The client loses this licence in their account. You can re-issue it later."
                confirmLabel="Revoke" disabled={write.isPending} testId="commerce-licence-revoke"
                onConfirm={() => write.mutate({ method: "POST", parts: ["licences", licenceId, "revoke"], body: { expectedRowVersion: version } })} />
            ) : null}
            {isPerson && status === "revoked" ? (
              <ConfirmButton label="Re-issue" title="Re-issue this licence?" description="The client gets this licence back in their account."
                confirmLabel="Re-issue" disabled={write.isPending} testId="commerce-licence-reissue"
                onConfirm={() => write.mutate({ method: "POST", parts: ["licences", licenceId, "reissue"], body: { expectedRowVersion: version } })} />
            ) : null}
          </div>
          {isPerson ? null : <PeopleOnlyNote>A person changes a key, revokes or re-issues, in GSAM.</PeopleOnlyNote>}
        </div>
      </div>
      {mode === "details" ? (
        <CommerceRowForm key={text(licence.row_version) ?? licenceId} idPrefix="licence" fields={LICENCE_FIELDS} base={licence}
          saving={write.isPending} submitLabel="Save licence" onCancel={() => { setMode("view"); write.reset(); }}
          onSave={(body) => write.mutate({ method: "PATCH", parts: ["licences", licenceId], body: { ...body, expectedRowVersion: version } })} />
      ) : null}
      {mode === "key" ? (
        <ReplaceKeyForm saving={write.isPending} onCancel={() => { setMode("view"); write.reset(); }}
          onSave={(body) => write.mutate({ method: "PATCH", parts: ["licences", licenceId], body: { ...body, expectedRowVersion: version } })} />
      ) : null}
      <CommerceWriteError error={write.error} onUseCurrent={loadCurrent} />
    </section>
  );
}
