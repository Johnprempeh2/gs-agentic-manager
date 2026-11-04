import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Plus, Trash2 } from "lucide-react";
import type { Approval } from "@greatstone/shared";
import { approvalsApi } from "@/api/approvals";
import { websiteCommerceApi, type CommerceRow } from "@/api/website-commerce";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useCommercePerson, useCommerceWrite } from "@/hooks/useCommerceWrite";
import { formatMinor, statusLabel, statusTone, text } from "@/lib/commerce";
import {
  isDefiniteAnswer,
  minorToMajor,
  newIdempotencyKey,
  parseMajorToMinor,
  rowVersionOf,
  type CommerceFieldDef,
} from "@/lib/commerce-write";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useNavigate } from "@/lib/router";
import { cn, formatDateTime } from "@/lib/utils";
import { CommerceRowForm, CommerceWriteError, ConfirmButton, PeopleOnlyNote } from "./CommerceWriteParts";

// Quotes, invoices and refunds (GRE-3972 slices 4 and 5). Anyone with Commerce rights edits a quote, converts it to a
// draft invoice, edits that draft, and asks for a refund. Only a person issues an invoice. A refund request opens a
// card for a person to decide; nothing here moves money.

const SECTION = "space-y-3 rounded-xl border border-border bg-card p-4";

const QUOTE_FIELDS: CommerceFieldDef[] = [
  { name: "status", column: "status", label: "Status", kind: "select", required: true,
    options: ["new", "contacted", "quoted", "won", "lost", "cancelled"].map((value) => ({ value, label: statusLabel(value) })) },
  { name: "quotedTotalMinor", column: "quoted_total_minor", label: "Quoted total", kind: "money" },
  { name: "poReference", column: "po_reference", label: "PO reference", kind: "text" },
  { name: "validUntil", column: "valid_until", label: "Valid until", kind: "date" },
];

/** A draft invoice is an order still pending, with no invoice number. */
export function isDraftInvoice(order: CommerceRow): boolean {
  return !text(order.invoice_number) && text(order.status) === "pending";
}

export function QuoteActions({ companyId, siteId, quote }: { companyId: string; siteId: string; quote: CommerceRow }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const quoteId = text(quote.id) ?? "";
  const itemKey = queryKeys.website.data(companyId, siteId, "quotes", "item", quoteId);
  const edit = useCommerceWrite(companyId, siteId, {
    onSuccess: (item) => { if (item) queryClient.setQueryData(itemKey, { item: { ...quote, ...item } }); setEditing(false); },
  });
  const convert = useCommerceWrite(companyId, siteId, {
    onSuccess: (order) => { if (text(order?.id)) navigate(`/commerce/orders/${encodeURIComponent(text(order.id)!)}`); },
  });
  const loadCurrent = (current: CommerceRow) => {
    edit.reset();
    queryClient.setQueryData(itemKey, { item: { ...quote, ...current } });
  };
  return (
    <section className={SECTION} aria-label="Change this quote" data-testid="commerce-quote-actions">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Change this quote</h2>
        <div className="flex flex-wrap gap-2">
          {editing ? null : <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Edit quote</Button>}
          <ConfirmButton label="Convert to invoice" title="Convert this quote to a draft invoice?"
            description="The website makes an order in pending with no invoice number. A person issues it later."
            confirmLabel="Convert" disabled={convert.isPending} testId="commerce-quote-convert"
            onConfirm={() => convert.mutate({ method: "POST", parts: ["quotes", quoteId, "convert"] })} />
        </div>
      </div>
      {editing ? (
        <CommerceRowForm key={text(quote.row_version) ?? quoteId} idPrefix="quote" fields={QUOTE_FIELDS} base={quote} saving={edit.isPending}
          submitLabel="Save quote" onCancel={() => { setEditing(false); edit.reset(); }}
          onSave={(body) => edit.mutate({ method: "PATCH", parts: ["quotes", quoteId], body: { ...body, expectedRowVersion: rowVersionOf(quote) } })} />
      ) : null}
      <CommerceWriteError error={edit.error} onUseCurrent={loadCurrent} />
      <CommerceWriteError error={convert.error} />
    </section>
  );
}

interface LineDraft {
  key: string;
  offeringId: string | null;
  variantId: string | null;
  offeringName: string;
  variantName: string;
  qty: string;
  unitPrice: string;
}

function linesOf(order: CommerceRow): LineDraft[] {
  const items = Array.isArray(order.items) ? (order.items as CommerceRow[]) : [];
  return items.map((item, index) => ({
    key: text(item.id) ?? `line-${index}`,
    offeringId: text(item.offering_id),
    variantId: text(item.variant_id),
    offeringName: text(item.offering_name) ?? "",
    variantName: text(item.variant_name) ?? "",
    qty: text(item.qty) ?? "1",
    unitPrice: minorToMajor(item.unit_price_minor),
  }));
}

export function DraftInvoiceActions({ companyId, siteId, order }: { companyId: string; siteId: string; order: CommerceRow }) {
  const queryClient = useQueryClient();
  const isPerson = useCommercePerson();
  const orderId = text(order.id) ?? "";
  const currency = text(order.currency);
  const itemKey = queryKeys.website.data(companyId, siteId, "orders", "item", orderId);
  const [editing, setEditing] = useState(false);
  const [lines, setLines] = useState<LineDraft[]>(() => linesOf(order));
  const [poReference, setPoReference] = useState(text(order.po_reference) ?? "");
  const [total, setTotal] = useState(minorToMajor(order.total_minor));
  const [problem, setProblem] = useState<string | null>(null);
  const save = useCommerceWrite(companyId, siteId, {
    onSuccess: (item) => { if (item) queryClient.setQueryData(itemKey, { item }); setEditing(false); },
  });
  const issue = useCommerceWrite(companyId, siteId, {
    onSuccess: (item) => { if (item) queryClient.setQueryData(itemKey, { item }); },
  });

  const startEditing = (from: CommerceRow = order) => {
    setLines(linesOf(from));
    setPoReference(text(from.po_reference) ?? "");
    setTotal(minorToMajor(from.total_minor));
    setProblem(null);
    save.reset();
    setEditing(true);
  };
  const parsedLines = lines.map((line) => ({ line, qty: Number(line.qty), unit: parseMajorToMinor(line.unitPrice) }));
  const subtotal = parsedLines.reduce((sum, { qty, unit }) => sum + (Number.isInteger(qty) && typeof unit === "number" ? qty * unit : 0), 0);
  const setLine = (key: string, patch: Partial<LineDraft>) => setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const bad = parsedLines.find(({ line, qty, unit }) => !line.offeringName.trim() || !Number.isInteger(qty) || qty < 1 || typeof unit !== "number");
    if (bad) return setProblem("Each line needs a product name, a whole quantity of 1 or more, and a price.");
    const totalMinor = parseMajorToMinor(total);
    if (typeof totalMinor !== "number") return setProblem("Enter the total, like 120.00.");
    const body: Record<string, unknown> = {
      expectedRowVersion: rowVersionOf(order),
      lines: parsedLines.map(({ line, qty, unit }) => ({
        ...(line.offeringId ? { offeringId: line.offeringId } : {}),
        ...(line.variantId ? { variantId: line.variantId } : {}),
        offeringName: line.offeringName.trim(),
        variantName: line.variantName.trim() || null,
        qty,
        unitPriceMinor: unit,
      })),
      subtotalMinor: subtotal,
      totalMinor,
    };
    if (poReference.trim() !== (text(order.po_reference) ?? "")) body.poReference = poReference.trim() || null;
    setProblem(null);
    save.mutate({ method: "PATCH", parts: ["invoices", orderId], body });
  };
  const loadCurrent = (current: CommerceRow) => {
    queryClient.setQueryData(itemKey, { item: { ...order, ...current } });
    startEditing({ ...order, ...current });
  };

  return (
    <section className={SECTION} aria-label="Draft invoice" data-testid="commerce-draft-invoice">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold">Draft invoice</h2>
          <p className="text-sm text-muted-foreground">It has no invoice number yet. Edit it, then a person issues it.</p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <div className="flex flex-wrap gap-2">
            {editing ? null : <Button size="sm" variant="outline" onClick={() => startEditing()}>Edit draft</Button>}
            {isPerson ? (
              <ConfirmButton label="Issue invoice" variant="default" title="Issue this invoice?"
                description="The website gives it the next invoice number and confirms the order. It cannot go back to a draft."
                confirmLabel="Issue" disabled={issue.isPending || editing} testId="commerce-invoice-issue"
                onConfirm={() => issue.mutate({ method: "POST", parts: ["invoices", orderId, "issue"], body: { expectedRowVersion: rowVersionOf(order) } })} />
            ) : null}
          </div>
          {isPerson ? null : <PeopleOnlyNote>A person issues invoices, in GSAM.</PeopleOnlyNote>}
        </div>
      </div>
      {editing ? (
        <form className="space-y-4" onSubmit={submit} noValidate>
          <ul className="space-y-3" aria-label="Lines">
            {lines.map((line, index) => (
              <li key={line.key} className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_1fr_5rem_7rem_auto] sm:items-end">
                <div className="flex min-w-0 flex-col gap-1">
                  <label htmlFor={`line-${line.key}-name`} className="text-xs font-medium">Product</label>
                  <Input id={`line-${line.key}-name`} value={line.offeringName} onChange={(e) => setLine(line.key, { offeringName: e.target.value })} />
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  <label htmlFor={`line-${line.key}-variant`} className="text-xs font-medium">Edition (optional)</label>
                  <Input id={`line-${line.key}-variant`} value={line.variantName} onChange={(e) => setLine(line.key, { variantName: e.target.value })} />
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  <label htmlFor={`line-${line.key}-qty`} className="text-xs font-medium">Qty</label>
                  <Input id={`line-${line.key}-qty`} inputMode="numeric" value={line.qty} onChange={(e) => setLine(line.key, { qty: e.target.value })} className="tabular-nums" />
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  <label htmlFor={`line-${line.key}-price`} className="text-xs font-medium">Unit price</label>
                  <Input id={`line-${line.key}-price`} inputMode="decimal" value={line.unitPrice} onChange={(e) => setLine(line.key, { unitPrice: e.target.value })} className="tabular-nums" />
                </div>
                <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove line ${index + 1}`}
                  onClick={() => setLines((current) => current.filter((l) => l.key !== line.key))}>
                  <Trash2 aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
          <Button type="button" size="sm" variant="outline"
            onClick={() => setLines((current) => [...current, { key: `new-${Date.now()}`, offeringId: null, variantId: null, offeringName: "", variantName: "", qty: "1", unitPrice: "" }])}>
            <Plus aria-hidden="true" />
            Add line
          </Button>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Subtotal</span>
              <span className="flex h-9 items-center text-sm tabular-nums">{formatMinor(subtotal, currency) ?? "0.00"}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="invoice-total" className="text-sm font-medium">Total</label>
              <Input id="invoice-total" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} className="tabular-nums" />
              <button type="button" className="w-fit text-xs text-primary underline-offset-4 hover:underline" onClick={() => setTotal(minorToMajor(subtotal))}>
                Use the subtotal
              </button>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="invoice-po" className="text-sm font-medium">PO reference (optional)</label>
              <Input id="invoice-po" value={poReference} onChange={(e) => setPoReference(e.target.value)} />
            </div>
          </div>
          {problem ? <p role="alert" className="text-sm text-destructive">{problem}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={save.isPending}>{save.isPending ? "Saving" : "Save draft"}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setEditing(false); save.reset(); }} disabled={save.isPending}>Cancel</Button>
          </div>
        </form>
      ) : null}
      <CommerceWriteError error={save.error} onUseCurrent={loadCurrent} />
      <CommerceWriteError error={issue.error} onUseCurrent={(current) => { issue.reset(); queryClient.setQueryData(itemKey, { item: { ...order, ...current } }); }} />
    </section>
  );
}

const APPROVAL_LABEL: Record<string, string> = {
  pending: "Waiting for a decision", revision_requested: "Waiting for a decision", approved: "Approved", rejected: "Rejected", cancelled: "Cancelled",
};

/** The refund requests on one order, from their GSAM cards. */
function useRefundCards(companyId: string, siteId: string, orderId: string) {
  return useQuery({
    queryKey: queryKeys.approvals.list(companyId),
    queryFn: () => approvalsApi.list(companyId),
    select: (approvals: Approval[]) => approvals
      .filter((approval) => approval.type === "commerce_refund_request" && approval.payload.orderId === orderId && approval.payload.siteId === siteId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    retry: false,
  });
}

export function RefundRequest({ companyId, siteId, order }: { companyId: string; siteId: string; order: CommerceRow }) {
  const queryClient = useQueryClient();
  const orderId = text(order.id) ?? "";
  const currency = text(order.currency);
  const refundable = Math.max(0, Number(order.total_minor ?? 0) - Number(order.refunded_minor ?? 0));
  const cards = useRefundCards(companyId, siteId, orderId);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(minorToMajor(refundable));
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  // the same request again (after a network error or a 5xx) keeps its key, so the site records it once
  const pending = useRef<{ signature: string; key: string } | null>(null);
  const request = useMutation({
    mutationFn: (input: { orderId: string; amountMinor: number; reason: string }) => {
      const signature = JSON.stringify(input);
      if (pending.current?.signature !== signature) pending.current = { signature, key: newIdempotencyKey() };
      return websiteCommerceApi.requestRefund(companyId, siteId, input, pending.current.key);
    },
    onSuccess: () => {
      pending.current = null;
      setOpen(false);
      setReason("");
      void queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(companyId) });
    },
    onError: (error) => { if (isDefiniteAnswer(error)) pending.current = null; },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const minor = parseMajorToMinor(amount);
    if (typeof minor !== "number" || minor <= 0) return setProblem("Enter the amount to refund, like 120.00.");
    if (minor > refundable) return setProblem(`At most ${formatMinor(refundable, currency)} is left to refund on this order.`);
    if (!reason.trim()) return setProblem("Say why, in a line.");
    setProblem(null);
    request.mutate({ orderId, amountMinor: minor, reason: reason.trim() });
  };

  const list = cards.data ?? [];
  return (
    <section className={SECTION} aria-label="Refunds" data-testid="commerce-refund">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold">Refunds</h2>
          <p className="text-sm text-muted-foreground">
            A request opens a card for a person to decide. GSAM moves no money: a person refunds in Stripe, and the website marks the request done.
          </p>
        </div>
        {open || refundable <= 0 ? null : (
          <Button size="sm" variant="outline" onClick={() => { setAmount(minorToMajor(refundable)); setOpen(true); request.reset(); }} data-testid="commerce-refund-open">
            Request a refund
          </Button>
        )}
      </div>
      {refundable <= 0 ? <p className="text-sm text-muted-foreground">Nothing is left to refund on this order.</p> : null}
      {open ? (
        <form className="space-y-3" onSubmit={submit} noValidate>
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="refund-amount" className="text-sm font-medium">Amount{currency ? ` (${currency.toUpperCase()})` : ""}</label>
              <Input id="refund-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="tabular-nums" />
              <p className="text-xs text-muted-foreground">Up to {formatMinor(refundable, currency)}</p>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor="refund-reason" className="text-sm font-medium">Reason</label>
              <Textarea id="refund-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
            </div>
          </div>
          {problem ? <p role="alert" className="text-sm text-destructive">{problem}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={request.isPending}>{request.isPending ? "Sending" : "Send refund request"}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setOpen(false); request.reset(); }} disabled={request.isPending}>Cancel</Button>
          </div>
        </form>
      ) : null}
      <CommerceWriteError error={request.error} />
      {request.data ? (
        <p role="status" className="rounded-lg border border-status-info/40 bg-status-info-soft p-3 text-sm text-status-info-foreground" data-testid="commerce-refund-sent">
          Refund request sent. {request.data.request ? "The website recorded it." : "The website has not confirmed it yet; deciding the card records it."}{" "}
          <Link to={`/approvals/${encodeURIComponent(request.data.approval.id)}`} className="font-medium underline underline-offset-4">Open the card</Link>
        </p>
      ) : null}
      {list.length ? (
        <ul className="divide-y divide-border rounded-lg border border-border" data-testid="commerce-refund-cards">
          {list.map((card) => {
            const siteStatus = typeof card.payload.requestStatus === "string" ? card.payload.requestStatus : null;
            return (
              <li key={card.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                <span className="font-medium tabular-nums">{formatMinor(card.payload.amountMinor, card.payload.currency ?? currency) ?? "Refund"}</span>
                <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium", statusTone(card.status === "pending" ? "requested" : card.status))}>
                  {APPROVAL_LABEL[card.status] ?? statusLabel(card.status)}
                </span>
                {siteStatus ? <span className="text-xs text-muted-foreground">On the website: {statusLabel(siteStatus)}</span> : null}
                <span className="text-xs text-muted-foreground">{formatDateTime(String(card.createdAt))}</span>
                <Link to={`/approvals/${encodeURIComponent(card.id)}`} className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline">
                  Card
                  <ArrowRight className="size-3.5" aria-hidden="true" />
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
