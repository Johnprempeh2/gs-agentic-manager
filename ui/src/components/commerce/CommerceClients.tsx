import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Building2, Copy, Inbox, Pencil, Plus, ReceiptText, Trash2, UserPlus, Users } from "lucide-react";
import { organisationsApi } from "@/api/organisations";
import { websiteCommerceApi, type CommerceRow } from "@/api/website-commerce";
import { websiteDataBridgeApi } from "@/api/website-data-bridge";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { useCommercePerson, useCommerceWrite } from "@/hooks/useCommerceWrite";
import { maskedLicenceKey, organisationFor, statusLabel, statusTone, text } from "@/lib/commerce";
import { rowOptionLabel } from "@/lib/commerce-catalogue";
import {
  CUSTOMER_FIELDS,
  CUSTOMER_TIER_FIELD,
  ENGAGEMENT_FIELDS,
  ENQUIRY_STATUSES,
  TIER_FIELDS,
  byDateDesc,
  engagementCopy,
  enquirySourceLabel,
  isFrontDoorLead,
} from "@/lib/commerce-settings";
import { rowVersionOf } from "@/lib/commerce-write";
import { queryKeys } from "@/lib/queryKeys";
import { Link, useNavigate } from "@/lib/router";
import { cn, formatDate, formatDateTime } from "@/lib/utils";
import { CommerceRowForm, CommerceWriteError, ConfirmButton, DownloadFileButton, PeopleOnlyNote } from "./CommerceWriteParts";

// Clients, their timeline and licences, enquiries and leads, portal receipts and customer tiers (GRE-4784, on the
// GRE-4782 routes): the website admin's commerce settings, in GSAM. Anyone with Commerce rights edits records and
// statuses. Only a person sets a client's tier, shares a timeline item, issues a licence, deletes a lead or sends a
// receipt again; the server and the website refuse anyone else.

const PAGE_SIZE = 50;
const SECTION = "space-y-3 rounded-xl border border-border bg-card p-4";
const LIST = "divide-y divide-border rounded-xl border border-border bg-card";
const ROW_LINK = "flex min-w-0 items-center gap-3 px-4 py-3 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
const RECORD_LINK = "inline-flex w-fit items-center gap-1 rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function StatusPill({ status }: { status: unknown }) {
  const value = text(status);
  if (!value) return null;
  return <span className={cn("inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-medium", statusTone(value))}>{statusLabel(value)}</span>;
}

function day(value: unknown, withTime = false) {
  const at = text(value);
  if (!at || Number.isNaN(Date.parse(at))) return null;
  return withTime ? formatDateTime(at) : formatDate(at);
}

/** One bridge list, paged. */
function useBridgeList(companyId: string, siteId: string,
  resource: "customers" | "enquiries" | "portal-acceptances" | "licences" | "engagements" | "orders" | "invite-requests",
  customer?: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.website.data(companyId, siteId, resource, "list", customer ?? ""),
    queryFn: ({ pageParam }) => websiteDataBridgeApi.list(companyId, siteId, resource, {
      limit: PAGE_SIZE, ...(customer ? { customer } : {}), ...(pageParam ? { cursor: pageParam } : {}),
    }),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor || undefined,
  });
}

function LoadMore({ query }: { query: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown } }) {
  if (!query.hasNextPage) return null;
  return (
    <div className="flex justify-center">
      <Button variant="outline" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
        {query.isFetchingNextPage ? "Loading" : "Load more"}
      </Button>
    </div>
  );
}

/** The site's customer tiers, as options for a client's tier. */
function useTierOptions(companyId: string, siteId: string) {
  const tiers = useQuery({
    queryKey: queryKeys.website.commerce(companyId, siteId, "customer-tiers", "options"),
    queryFn: () => websiteCommerceApi.list(companyId, siteId, "customer-tiers", { limit: 100 }),
    staleTime: 60_000,
  });
  return useMemo(() => (tiers.data?.items ?? [])
    .map((row) => ({ value: text(row.id) ?? "", label: rowOptionLabel(row) }))
    .filter((option) => option.value)
    .sort((a, b) => a.label.localeCompare(b.label)), [tiers.data]);
}

const tierName = (options: { value: string; label: string }[], id: unknown) => {
  const value = text(id);
  return value ? options.find((option) => option.value === value)?.label ?? null : null;
};

// ---- clients ----

export function ClientList({ companyId, siteId }: { companyId: string; siteId: string }) {
  const navigate = useNavigate();
  const isPerson = useCommercePerson();
  const clients = useBridgeList(companyId, siteId, "customers");
  const tiers = useTierOptions(companyId, siteId);
  const [adding, setAdding] = useState(false);
  const create = useCommerceWrite(companyId, siteId, {
    onSuccess: (item) => { const id = text(item?.id); if (id) navigate(`/commerce/customers/${encodeURIComponent(id)}`); },
  });
  const fields = isPerson ? [...CUSTOMER_FIELDS, CUSTOMER_TIER_FIELD] : CUSTOMER_FIELDS;
  const rows = [...(clients.data?.pages.flatMap((page) => page.items) ?? [])]
    .sort((a, b) => (text(a.name) ?? "").localeCompare(text(b.name) ?? ""));

  return (
    <section className="space-y-3" aria-label="Clients" data-testid="commerce-clients">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">The client companies on the website. Open one for its timeline and licences.</p>
        {adding ? null : (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" />
            New client
          </Button>
        )}
      </div>
      {adding ? (
        <div className={SECTION}>
          <h2 className="text-sm font-semibold">New client</h2>
          <CommerceRowForm idPrefix="client-new" fields={fields} base={null} refOptions={{ "customer-tiers": tiers }} saving={create.isPending}
            submitLabel="Add client" onCancel={() => { setAdding(false); create.reset(); }}
            onSave={(body) => create.mutate({ method: "POST", parts: ["customers"], body })} />
          {isPerson ? null : <PeopleOnlyNote>A person sets a client's tier, in GSAM.</PeopleOnlyNote>}
          <CommerceWriteError error={create.error} />
        </div>
      ) : null}
      <WaitingSeatRequests companyId={companyId} siteId={siteId} clients={rows} />
      {clients.isLoading ? <PageSkeleton variant="list" /> : null}
      {clients.error ? <ErrorState error={clients.error} onRetry={() => void clients.refetch()} retrying={clients.isFetching} /> : null}
      {clients.data && rows.length === 0 ? <EmptyState icon={Users} message="No client companies on the website yet." /> : null}
      {rows.length ? (
        <ul className={LIST}>
          {rows.map((row) => {
            const id = text(row.id) ?? "";
            const users = Array.isArray(row.users) ? row.users.length : 0;
            const meta = [text(row.domain), tierName(tiers, row.tier_id) ? `Tier ${tierName(tiers, row.tier_id)}` : null,
              users ? `${users} ${users === 1 ? "person" : "people"}` : null].filter(Boolean).join(" · ");
            return (
              <li key={id}>
                <Link to={`/commerce/customers/${encodeURIComponent(id)}`} className={ROW_LINK}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{text(row.name) ?? "Client"}</span>
                    <span className="block truncate text-xs text-muted-foreground">{meta || text(row.slug) || " "}</span>
                  </span>
                  <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
      <LoadMore query={clients} />
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm">{children}</dd>
    </div>
  );
}

export function ClientRecord({ companyId, siteId, clientId }: { companyId: string; siteId: string; clientId: string }) {
  const queryClient = useQueryClient();
  const isPerson = useCommercePerson();
  const itemKey = queryKeys.website.data(companyId, siteId, "customers", "item", clientId);
  const query = useQuery({ queryKey: itemKey, queryFn: () => websiteDataBridgeApi.get(companyId, siteId, "customers", clientId) });
  const organisations = useQuery({
    queryKey: queryKeys.organisations.list(companyId, {}),
    queryFn: () => organisationsApi.list(companyId),
    retry: false,
  });
  const tiers = useTierOptions(companyId, siteId);
  const [editing, setEditing] = useState(false);
  const edit = useCommerceWrite(companyId, siteId, {
    onSuccess: (item) => { if (item) queryClient.setQueryData(itemKey, { item: { ...client, ...item } }); setEditing(false); },
  });

  if (query.isLoading) return <PageSkeleton variant="detail" />;
  if (query.error || !query.data) {
    return <ErrorState error={query.error ?? new Error("The website has no such client.")} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  }
  const client = query.data.item;
  const organisation = organisationFor(client, organisations.data ?? []);
  const fields = isPerson ? [...CUSTOMER_FIELDS, CUSTOMER_TIER_FIELD] : CUSTOMER_FIELDS;
  const people = Array.isArray(client.users) ? (client.users as CommerceRow[]) : [];
  const facts = [
    ["Slug", text(client.slug)], ["Domain", text(client.domain)], ["Customer tier", tierName(tiers, client.tier_id) ?? (text(client.tier_id) ? "Unknown tier" : "None")],
    ["Billing currency", text(client.billing_currency)], ["Added", day(client.created_at, true)],
  ].filter((fact): fact is [string, string] => Boolean(fact[1]));

  return (
    <div className="space-y-6" data-testid="commerce-client">
      <Link to="/commerce/customers" className="inline-flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ArrowLeft className="size-4" aria-hidden="true" />
        All clients
      </Link>
      <header className="min-w-0 space-y-1">
        <p className="text-xs font-medium text-muted-foreground">Client</p>
        <h2 className="break-words text-xl font-bold">{text(client.name) ?? "Client"}</h2>
      </header>

      <section className={SECTION} aria-label="Details">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 className="text-sm font-semibold">Details</h2>
          {editing ? null : <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Edit client</Button>}
        </div>
        {editing ? (
          <>
            <CommerceRowForm key={text(client.row_version) ?? clientId} idPrefix="client" fields={fields} base={client}
              refOptions={{ "customer-tiers": tiers }} saving={edit.isPending} submitLabel="Save client"
              onCancel={() => { setEditing(false); edit.reset(); }}
              onSave={(body) => edit.mutate({ method: "PATCH", parts: ["customers", clientId], body: { ...body, expectedRowVersion: rowVersionOf(client) } })} />
            {isPerson ? null : <PeopleOnlyNote>A person sets a client's tier, in GSAM.</PeopleOnlyNote>}
          </>
        ) : (
          <>
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {facts.map(([label, value]) => <Fact key={label} label={label}>{value}</Fact>)}
            </dl>
            {text(client.notes) ? <p className="whitespace-pre-wrap border-t border-border pt-3 text-sm">{text(client.notes)}</p> : null}
          </>
        )}
        <CommerceWriteError error={edit.error}
          onUseCurrent={(current) => { edit.reset(); queryClient.setQueryData(itemKey, { item: { ...client, ...current } }); }} />
      </section>

      {people.length ? (
        <section className="space-y-2" aria-label="People">
          <h2 className="text-sm font-semibold">People</h2>
          <ul className={LIST}>
            {people.map((person, index) => (
              <li key={text(person.id) ?? index} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm">
                <span className="min-w-0 break-words font-medium">{text(person.full_name) ?? text(person.email)}</span>
                <span className="min-w-0 break-all text-xs text-muted-foreground">{text(person.email)}</span>
                {person.is_primary === true ? <span className="text-xs text-muted-foreground">Main contact</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ClientSeatRequests companyId={companyId} siteId={siteId} clientId={clientId} clientName={text(client.name) ?? "this client"} />
      <ClientTimeline companyId={companyId} siteId={siteId} clientId={clientId} />
      <ClientLicences companyId={companyId} siteId={siteId} clientId={clientId} />

      <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm" aria-label="Linked records">
        {organisation ? (
          <Link to={`/organisations/${organisation.id}`} className={cn(RECORD_LINK, "gap-1.5")}>
            <Building2 className="size-4" aria-hidden="true" />
            {organisation.name} in Organisations
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        ) : null}
        {(["quotes", "orders", "invoices"] as const).map((resource) => (
          <Link key={resource} to={`/commerce/${resource}?customer=${encodeURIComponent(clientId)}`} className={RECORD_LINK}>
            Their {resource}
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        ))}
      </nav>
    </div>
  );
}

// ---- seat requests (admin parity round 2) ----
// A client's company admin asks for a new seat on the website. A person approves (the website adds them to the
// client's portal, as People does) or declines; the website refuses anyone else.

const roleWord = (role: unknown) => (text(role) === "admin" ? "Company admin" : "Member");
const isPending = (row: CommerceRow) => text(row.status) === "pending";

/** The pending seat requests across every client, on Clients, so none waits unseen. Hidden when there are none. */
function WaitingSeatRequests({ companyId, siteId, clients }: { companyId: string; siteId: string; clients: CommerceRow[] }) {
  const requests = useBridgeList(companyId, siteId, "invite-requests");
  const waiting = byDateDesc((requests.data?.pages.flatMap((page) => page.items) ?? []).filter(isPending), "created_at");
  if (!waiting.length) return null;
  const nameOf = (id: unknown) => text(clients.find((client) => text(client.id) === text(id))?.name) ?? "A client";
  return (
    <section className={SECTION} aria-label="Seat requests waiting" data-testid="commerce-seat-requests-waiting" data-tour="commerce-seat-requests-waiting">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <UserPlus className="size-4 text-muted-foreground" aria-hidden="true" />
        {waiting.length === 1 ? "1 seat request is waiting" : `${waiting.length} seat requests are waiting`}
      </h2>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {waiting.map((row) => (
          <li key={text(row.id)}>
            <Link to={`/commerce/customers/${encodeURIComponent(text(row.customer_id) ?? "")}`} className={ROW_LINK}>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{text(row.full_name) ?? text(row.email)} for {nameOf(row.customer_id)}</span>
                <span className="block truncate text-xs text-muted-foreground">{[roleWord(row.role), day(row.created_at)].filter(Boolean).join(" · ")}</span>
              </span>
              <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
      <LoadMore query={requests} />
    </section>
  );
}

function SeatRequestRow({ companyId, siteId, row, clientName }: { companyId: string; siteId: string; row: CommerceRow; clientName: string }) {
  const isPerson = useCommercePerson();
  const decide = useCommerceWrite(companyId, siteId);
  const id = text(row.id) ?? "";
  const who = text(row.full_name) ?? text(row.email) ?? "This person";
  const decided = !isPending(row);
  return (
    <li className="space-y-2 px-4 py-3" data-testid="commerce-seat-request">
      <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2">
        <span className="min-w-0 flex-1 basis-56">
          <span className="block break-words text-sm font-medium">{who}</span>
          {text(row.full_name) ? <span className="block break-all text-xs text-muted-foreground">{text(row.email)}</span> : null}
          <span className="block text-xs text-muted-foreground">{[roleWord(row.role), `Asked ${day(row.created_at) ?? ""}`.trim(),
            decided && day(row.handled_at) ? `Decided ${day(row.handled_at)}` : null].filter(Boolean).join(" · ")}</span>
        </span>
        {decided ? <StatusPill status={text(row.status) === "provisioned" ? "approved" : row.status} /> : isPerson ? (
          <span className="flex shrink-0 flex-wrap items-center gap-2">
            <ConfirmButton label="Approve" variant="default" title={`Give ${who} a seat?`} testId="commerce-seat-approve"
              description={`The website adds ${text(row.email) ?? who} to ${clientName}'s portal as a ${roleWord(row.role).toLowerCase()}. They sign in with that email address.`}
              confirmLabel="Approve and add" disabled={decide.isPending}
              onConfirm={() => decide.mutate({ method: "POST", parts: ["invite-requests", id, "decision"], body: { decision: "approve" } })} />
            <ConfirmButton label="Decline" title={`Decline the request for ${who}?`} testId="commerce-seat-decline"
              description="Nobody is added. The request stays in the list as declined." confirmLabel="Decline request" disabled={decide.isPending}
              onConfirm={() => decide.mutate({ method: "POST", parts: ["invite-requests", id, "decision"], body: { decision: "decline" } })} />
          </span>
        ) : null}
      </div>
      {text(row.note) ? <p className="whitespace-pre-wrap text-sm text-muted-foreground">{text(row.note)}</p> : null}
      <CommerceWriteError error={decide.error} />
    </li>
  );
}

/** A client's seat requests: waiting first, then the decided ones. Hidden when the client has made none. */
function ClientSeatRequests({ companyId, siteId, clientId, clientName }: { companyId: string; siteId: string; clientId: string; clientName: string }) {
  const isPerson = useCommercePerson();
  const requests = useBridgeList(companyId, siteId, "invite-requests", clientId);
  const all = byDateDesc(requests.data?.pages.flatMap((page) => page.items) ?? [], "created_at");
  const rows = [...all.filter(isPending), ...all.filter((row) => !isPending(row))];
  // A website from before seat requests answers not found: say so quietly rather than fill the page with an error.
  if (requests.error) return <p className="text-xs text-muted-foreground" data-testid="commerce-seat-requests-unavailable">Seat requests could not be read from the website. They show here once the website has the latest update.</p>;
  if (!rows.length) return null;
  const waiting = all.filter(isPending).length;
  return (
    <section className={SECTION} aria-label="Seat requests" data-testid="commerce-client-seat-requests" data-tour="commerce-seat-requests">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="text-sm font-semibold">Seat requests{waiting ? ` (${waiting} waiting)` : ""}</h2>
        {isPerson ? null : <PeopleOnlyNote>A person approves or declines a seat, in GSAM.</PeopleOnlyNote>}
      </div>
      <p className="text-xs text-muted-foreground">{clientName}'s company admin asked for these people to have access to the client portal.</p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {rows.map((row) => <SeatRequestRow key={text(row.id)} companyId={companyId} siteId={siteId} row={row} clientName={clientName} />)}
      </ul>
      <LoadMore query={requests} />
    </section>
  );
}

// ---- the client timeline ----

function TimelineItem({ companyId, siteId, clientId, row }: { companyId: string; siteId: string; clientId: string; row: CommerceRow }) {
  const isPerson = useCommercePerson();
  const [editing, setEditing] = useState(false);
  const write = useCommerceWrite(companyId, siteId, { onSuccess: () => setEditing(false) });
  const id = text(row.id) ?? "";
  const title = text(row.title) ?? "Item";
  const shared = text(row.status) === "shared";
  // the client sees a shared item: only a person edits or deletes it
  const canChange = !shared || isPerson;
  const version = rowVersionOf(row);
  const meta = [text(row.kind) ? statusLabel(text(row.kind)!) : null, day(row.occurred_on), text(row.phase), text(row.owner_name)]
    .filter(Boolean).join(" · ");
  return (
    <li className="space-y-3 px-4 py-3" data-testid="commerce-timeline-item">
      <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2">
        <span className="min-w-0 flex-1 basis-48">
          <span className="block break-words text-sm font-medium">{row.pinned === true ? "Pinned · " : ""}{title}</span>
          {meta ? <span className="block truncate text-xs text-muted-foreground">{meta}</span> : null}
          {text(row.summary) && !editing ? <span className="mt-1 block whitespace-pre-wrap text-sm text-muted-foreground">{text(row.summary)}</span> : null}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <StatusPill status={shared ? "shared" : "draft"} />
          {isPerson ? (
            <ConfirmButton label={shared ? "Unshare" : "Share"} variant="ghost" testId={shared ? "commerce-timeline-unshare" : "commerce-timeline-share"}
              title={shared ? "Take this item off the client's timeline?" : "Share this item with the client?"}
              description={shared ? "It goes back to a draft. The client no longer sees it." : "The client sees it on their timeline on the website."}
              confirmLabel={shared ? "Unshare" : "Share"} disabled={write.isPending}
              onConfirm={() => write.mutate({ method: "POST", parts: ["engagements", id, shared ? "unshare" : "share"], body: { expectedRowVersion: version } })} />
          ) : null}
          {canChange && !editing ? (
            <Button type="button" size="icon-xs" variant="ghost" onClick={() => setEditing(true)} aria-label={`Edit ${title}`}>
              <Pencil aria-hidden="true" />
            </Button>
          ) : null}
          <Button type="button" size="icon-xs" variant="ghost" aria-label={`Duplicate ${title}`} disabled={write.isPending}
            onClick={() => write.mutate({ method: "POST", parts: ["customers", clientId, "engagements"], body: engagementCopy(row) })}>
            <Copy aria-hidden="true" />
          </Button>
          {canChange ? (
            <ConfirmButton label={<Trash2 aria-hidden="true" />} ariaLabel={`Delete ${title}`} variant="ghost" destructive
              title="Delete this timeline item?" description={shared ? "The client no longer sees it." : "It is a draft; the client never saw it."}
              confirmLabel="Delete" disabled={write.isPending}
              onConfirm={() => write.mutate({ method: "DELETE", parts: ["engagements", id], body: { expectedRowVersion: version } })} />
          ) : null}
        </span>
      </div>
      {editing ? (
        <CommerceRowForm key={text(row.row_version) ?? id} idPrefix={`engagement-${id}`} fields={ENGAGEMENT_FIELDS} base={row}
          saving={write.isPending} submitLabel="Save item" onCancel={() => { setEditing(false); write.reset(); }}
          onSave={(body) => write.mutate({ method: "PATCH", parts: ["engagements", id], body: { ...body, expectedRowVersion: version } })} />
      ) : null}
      <CommerceWriteError error={write.error} />
    </li>
  );
}

function ClientTimeline({ companyId, siteId, clientId }: { companyId: string; siteId: string; clientId: string }) {
  const isPerson = useCommercePerson();
  const items = useBridgeList(companyId, siteId, "engagements", clientId);
  const [adding, setAdding] = useState(false);
  const create = useCommerceWrite(companyId, siteId, { onSuccess: () => setAdding(false) });
  const rows = byDateDesc(items.data?.pages.flatMap((page) => page.items) ?? [], "occurred_on")
    .sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true));
  return (
    <section className={SECTION} aria-label="Timeline" data-testid="commerce-timeline">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold">Timeline</h2>
          <p className="text-sm text-muted-foreground">New items are drafts. The client sees an item only once it is shared.</p>
        </div>
        {adding ? null : (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" />
            Add item
          </Button>
        )}
      </div>
      {isPerson ? null : <PeopleOnlyNote>A person shares items, and changes a shared one, in GSAM.</PeopleOnlyNote>}
      {adding ? (
        <div className="rounded-lg border border-border p-3">
          <CommerceRowForm idPrefix="engagement-new" fields={ENGAGEMENT_FIELDS} base={null} saving={create.isPending} submitLabel="Add draft"
            onCancel={() => { setAdding(false); create.reset(); }}
            onSave={(body) => create.mutate({ method: "POST", parts: ["customers", clientId, "engagements"], body })} />
        </div>
      ) : null}
      <CommerceWriteError error={create.error} />
      {items.isLoading ? <PageSkeleton variant="list" /> : null}
      {items.error ? <ErrorState error={items.error} onRetry={() => void items.refetch()} retrying={items.isFetching} /> : null}
      {items.data && rows.length === 0 ? <p className="text-sm text-muted-foreground">Nothing on this client's timeline yet.</p> : null}
      {rows.length ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {rows.map((row) => <TimelineItem key={text(row.id)} companyId={companyId} siteId={siteId} clientId={clientId} row={row} />)}
        </ul>
      ) : null}
      <LoadMore query={items} />
    </section>
  );
}

// ---- a client's licences ----

function IssueLicenceForm({ orders, saving, onSave, onCancel }: {
  orders: CommerceRow[];
  saving: boolean;
  onSave: (body: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState({ offeringName: "", variantName: "", secretKind: "licenceKey", secret: "", orderId: "", seats: "", expiresAt: "", notes: "" });
  const [problem, setProblem] = useState<string | null>(null);
  const set = (name: keyof typeof values) => (event: { target: { value: string } }) => setValues((current) => ({ ...current, [name]: event.target.value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!values.offeringName.trim()) return setProblem("Product is required.");
    const secret = values.secret.trim();
    if (!secret) return setProblem("Enter the licence key or a download link.");
    if (values.secretKind === "downloadUrl" && !/^https?:\/\//i.test(secret)) return setProblem("The link must start with https://.");
    const seats = values.seats.trim();
    if (seats && !(Number.isInteger(Number(seats)) && Number(seats) >= 1)) return setProblem("Seats must be a whole number of 1 or more.");
    setProblem(null);
    onSave({
      offeringName: values.offeringName.trim(),
      [values.secretKind]: secret,
      ...(values.variantName.trim() ? { variantName: values.variantName.trim() } : {}),
      ...(values.orderId ? { orderId: values.orderId } : {}),
      ...(seats ? { seats: Number(seats) } : {}),
      ...(values.expiresAt ? { expiresAt: values.expiresAt } : {}),
      ...(values.notes.trim() ? { notes: values.notes.trim() } : {}),
    });
  };
  const field = (id: string, label: string, control: ReactNode, help?: string) => (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      {control}
      {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );
  return (
    <form className="space-y-4 rounded-lg border border-border p-3" onSubmit={submit} noValidate data-testid="commerce-licence-issue-form">
      <div className="grid gap-4 sm:grid-cols-2">
        {field("issue-product", "Product", <Input id="issue-product" value={values.offeringName} onChange={set("offeringName")} disabled={saving} aria-required />)}
        {field("issue-variant", "Edition (optional)", <Input id="issue-variant" value={values.variantName} onChange={set("variantName")} disabled={saving} />)}
        {field("issue-secret-kind", "Delivered as", (
          <NativeSelect id="issue-secret-kind" value={values.secretKind} onChange={set("secretKind")} disabled={saving}>
            <option value="licenceKey">Licence key</option>
            <option value="downloadUrl">Download link</option>
          </NativeSelect>
        ))}
        {field("issue-secret", values.secretKind === "licenceKey" ? "Licence key" : "Download link", (
          <Input id="issue-secret" type={values.secretKind === "licenceKey" ? "password" : "url"} autoComplete="off" spellCheck={false}
            value={values.secret} onChange={set("secret")} disabled={saving} className="font-mono" />
        ), "Goes to the website only. GSAM keeps the last 4 characters of a key.")}
        {field("issue-order", "Order (optional)", (
          <NativeSelect id="issue-order" value={values.orderId} onChange={set("orderId")} disabled={saving}>
            <option value="">None</option>
            {orders.map((order) => (
              <option key={text(order.id)} value={text(order.id) ?? ""}>{text(order.reference) ?? (text(order.id) ?? "").slice(0, 8)}</option>
            ))}
          </NativeSelect>
        ))}
        {field("issue-seats", "Seats (optional)", <Input id="issue-seats" inputMode="numeric" value={values.seats} onChange={set("seats")} disabled={saving} className="tabular-nums" />)}
        {field("issue-expires", "Expires (optional)", <Input id="issue-expires" type="date" value={values.expiresAt} onChange={set("expiresAt")} disabled={saving} />)}
        {field("issue-notes", "Notes (optional)", <Input id="issue-notes" value={values.notes} onChange={set("notes")} disabled={saving} />)}
      </div>
      {problem ? <p role="alert" className="text-sm text-destructive">{problem}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={saving}>{saving ? "Issuing" : "Issue licence"}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </form>
  );
}

function ClientLicences({ companyId, siteId, clientId }: { companyId: string; siteId: string; clientId: string }) {
  const isPerson = useCommercePerson();
  const licences = useBridgeList(companyId, siteId, "licences", clientId);
  const orders = useBridgeList(companyId, siteId, "orders", clientId);
  const [issuing, setIssuing] = useState(false);
  const issue = useCommerceWrite(companyId, siteId, { onSuccess: () => setIssuing(false) });
  const rows = byDateDesc(licences.data?.pages.flatMap((page) => page.items) ?? [], "created_at");
  return (
    <section className={SECTION} aria-label="Licences" data-testid="commerce-client-licences">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="text-sm font-semibold">Licences</h2>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          {isPerson && !issuing ? (
            <Button size="sm" variant="outline" onClick={() => setIssuing(true)} data-testid="commerce-licence-issue">
              <Plus aria-hidden="true" />
              Issue licence
            </Button>
          ) : null}
          {isPerson ? null : <PeopleOnlyNote>A person issues licences, in GSAM.</PeopleOnlyNote>}
        </div>
      </div>
      {issuing ? (
        <IssueLicenceForm orders={orders.data?.pages.flatMap((page) => page.items) ?? []} saving={issue.isPending}
          onCancel={() => { setIssuing(false); issue.reset(); }}
          onSave={(body) => issue.mutate({ method: "POST", parts: ["customers", clientId, "licences"], body })} />
      ) : null}
      <CommerceWriteError error={issue.error} />
      {licences.isLoading ? <PageSkeleton variant="list" /> : null}
      {licences.error ? <ErrorState error={licences.error} onRetry={() => void licences.refetch()} retrying={licences.isFetching} /> : null}
      {licences.data && rows.length === 0 ? <p className="text-sm text-muted-foreground">No licences for this client yet.</p> : null}
      {rows.length ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {rows.map((row) => {
            const id = text(row.id) ?? "";
            const expires = day(row.expires_at);
            return (
              <li key={id}>
                <Link to={`/commerce/licences/${encodeURIComponent(id)}`} className={ROW_LINK}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{[text(row.offering_name), text(row.variant_name)].filter(Boolean).join(", ") || "Licence"}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      <span className="font-mono">{maskedLicenceKey(row)}</span>{expires ? ` · Expires ${expires}` : ""}
                    </span>
                  </span>
                  <StatusPill status={row.status} />
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
      <LoadMore query={licences} />
    </section>
  );
}

// ---- enquiries and leads ----

function EnquiryRow({ companyId, siteId, row }: { companyId: string; siteId: string; row: CommerceRow }) {
  const isPerson = useCommercePerson();
  const write = useCommerceWrite(companyId, siteId);
  const id = text(row.id) ?? "";
  const status = text(row.status) ?? "new";
  const name = text(row.name) ?? text(row.email) ?? "Enquiry";
  const meta = [enquirySourceLabel(row), text(row.organisationName), day(row.createdAt, true)].filter(Boolean).join(" · ");
  return (
    <li className="space-y-2 px-4 py-3" data-testid="commerce-enquiry">
      <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2">
        <span className="min-w-0 flex-1 basis-56">
          <span className="block break-words text-sm font-medium">{name}</span>
          <span className="block break-all text-xs text-muted-foreground">{text(row.email)}</span>
          <span className="block truncate text-xs text-muted-foreground">{meta}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <label htmlFor={`enquiry-status-${id}`} className="sr-only">Status of {name}</label>
          <NativeSelect id={`enquiry-status-${id}`} value={status} disabled={write.isPending} className="h-8 w-36"
            onChange={(e) => write.mutate({ method: "PATCH", parts: ["enquiries", id], body: { status: e.target.value } })}>
            {(ENQUIRY_STATUSES as readonly string[]).includes(status) ? null : <option value={status}>{statusLabel(status)}</option>}
            {ENQUIRY_STATUSES.map((value) => <option key={value} value={value}>{statusLabel(value)}</option>)}
          </NativeSelect>
          {isPerson && isFrontDoorLead(id) ? (
            <ConfirmButton label={<Trash2 aria-hidden="true" />} ariaLabel={`Delete ${name}`} variant="ghost" destructive
              title="Delete this lead for good?" description="The website removes the lead and keeps no copy. This cannot be undone."
              confirmLabel="Delete lead" disabled={write.isPending} testId="commerce-enquiry-delete"
              onConfirm={() => write.mutate({ method: "DELETE", parts: ["enquiries", id] })} />
          ) : null}
        </span>
      </div>
      {text(row.message) ? <p className="line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">{text(row.message)}</p> : null}
      {isFrontDoorLead(id) && row.agentPackage === true ? (
        <div data-tour="commerce-agent-package">
          <DownloadFileButton url={websiteDataBridgeApi.fileUrl(companyId, siteId, "enquiries", id, "agent-package")}
            label="Download agent package (.zip)" ariaLabel={`Download the agent package for ${name}`} testId="commerce-agent-package" />
        </div>
      ) : null}
      <CommerceWriteError error={write.error} />
    </li>
  );
}

export function EnquiryList({ companyId, siteId }: { companyId: string; siteId: string }) {
  const isPerson = useCommercePerson();
  const enquiries = useBridgeList(companyId, siteId, "enquiries");
  const [status, setStatus] = useState<string>("open");
  const all = byDateDesc(enquiries.data?.pages.flatMap((page) => page.items) ?? [], "createdAt");
  const rows = all.filter((row) => status === "all" || (status === "open" ? text(row.status) !== "closed" : text(row.status) === status));
  return (
    <section className="space-y-3" aria-label="Enquiries and leads" data-testid="commerce-enquiries">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Service enquiries and front door leads from the website. Set a status as you work them.</p>
        <div className="flex items-center gap-2">
          <label htmlFor="enquiry-filter" className="text-sm text-muted-foreground">Show</label>
          <NativeSelect id="enquiry-filter" value={status} onChange={(e) => setStatus(e.target.value)} className="h-8 w-36">
            <option value="open">Open</option>
            {ENQUIRY_STATUSES.map((value) => <option key={value} value={value}>{statusLabel(value)}</option>)}
            <option value="all">All</option>
          </NativeSelect>
        </div>
      </div>
      {isPerson ? null : <PeopleOnlyNote>A person deletes a lead, in GSAM.</PeopleOnlyNote>}
      {enquiries.isLoading ? <PageSkeleton variant="list" /> : null}
      {enquiries.error ? <ErrorState error={enquiries.error} onRetry={() => void enquiries.refetch()} retrying={enquiries.isFetching} /> : null}
      {enquiries.data && rows.length === 0 ? (
        <EmptyState icon={Inbox} message={all.length ? "No enquiries with this status." : "No enquiries or leads on the website yet."} />
      ) : null}
      {rows.length ? <ul className={LIST}>{rows.map((row) => <EnquiryRow key={text(row.id)} companyId={companyId} siteId={siteId} row={row} />)}</ul> : null}
      <LoadMore query={enquiries} />
    </section>
  );
}

// ---- portal receipts ----

function ReceiptRow({ companyId, siteId, row, clientName }: { companyId: string; siteId: string; row: CommerceRow; clientName: string | null }) {
  const isPerson = useCommercePerson();
  const resend = useCommerceWrite(companyId, siteId);
  const id = text(row.id) ?? "";
  const signer = text(row.signer_name) ?? text(row.signer_email) ?? "Client";
  const what = [text(row.action) ? statusLabel(text(row.action)!) : null, text(row.document_version) ? `version ${text(row.document_version)}` : null]
    .filter(Boolean).join(", ");
  const meta = [clientName ?? text(row.account_company_name), what, day(row.accepted_at, true)].filter(Boolean).join(" · ");
  const queued = text(resend.data?.item?.status) === "queued";
  return (
    <li className="space-y-2 px-4 py-3" data-testid="commerce-receipt">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 flex-1 basis-56">
          <span className="block break-words text-sm font-medium">{signer}{text(row.signer_title) ? `, ${text(row.signer_title)}` : ""}</span>
          <span className="block break-all text-xs text-muted-foreground">{text(row.signer_email)}</span>
          <span className="block truncate text-xs text-muted-foreground">{meta}</span>
        </span>
        {queued ? <StatusPill status="queued" /> : isPerson ? (
          <ConfirmButton label="Send receipt again" title="Send this receipt again?"
            description="The website queues the same receipt email to the signer. A receipt that was already sent is not sent twice."
            confirmLabel="Send again" disabled={resend.isPending} testId="commerce-receipt-resend"
            onConfirm={() => resend.mutate({ method: "POST", parts: ["portal-acceptances", id, "resend"] })} />
        ) : null}
      </div>
      <CommerceWriteError error={resend.error} />
    </li>
  );
}

export function ReceiptList({ companyId, siteId }: { companyId: string; siteId: string }) {
  const isPerson = useCommercePerson();
  const receipts = useBridgeList(companyId, siteId, "portal-acceptances");
  const clients = useBridgeList(companyId, siteId, "customers");
  const names = new Map((clients.data?.pages.flatMap((page) => page.items) ?? []).map((row) => [text(row.id) ?? "", text(row.name)]));
  const rows = byDateDesc(receipts.data?.pages.flatMap((page) => page.items) ?? [], "accepted_at");
  return (
    <section className="space-y-3" aria-label="Portal receipts" data-testid="commerce-receipts">
      <p className="text-sm text-muted-foreground">Each time a client accepts a portal document, the website emails them a receipt. Send one again if it did not arrive.</p>
      {isPerson ? null : <PeopleOnlyNote>A person sends a receipt again, in GSAM.</PeopleOnlyNote>}
      {receipts.isLoading ? <PageSkeleton variant="list" /> : null}
      {receipts.error ? <ErrorState error={receipts.error} onRetry={() => void receipts.refetch()} retrying={receipts.isFetching} /> : null}
      {receipts.data && rows.length === 0 ? <EmptyState icon={ReceiptText} message="No client has accepted a portal document yet." /> : null}
      {rows.length ? (
        <ul className={LIST}>
          {rows.map((row) => (
            <ReceiptRow key={text(row.id)} companyId={companyId} siteId={siteId} row={row} clientName={names.get(text(row.customer_id) ?? "") ?? null} />
          ))}
        </ul>
      ) : null}
      <LoadMore query={receipts} />
    </section>
  );
}

// ---- customer tiers ----

function TierRow({ companyId, siteId, row }: { companyId: string; siteId: string; row: CommerceRow }) {
  const [editing, setEditing] = useState(false);
  const write = useCommerceWrite(companyId, siteId, { onSuccess: () => setEditing(false) });
  const id = text(row.id) ?? "";
  const name = rowOptionLabel(row);
  return (
    <li className="space-y-3 px-4 py-3" data-testid="commerce-tier">
      <div className="flex min-w-0 items-start gap-3">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {[text(row.slug), text(row.rank) ? `Rank ${text(row.rank)}` : null].filter(Boolean).join(" · ")}
          </span>
          {text(row.description) && !editing ? <span className="mt-1 block text-xs text-muted-foreground">{text(row.description)}</span> : null}
        </span>
        {editing ? null : (
          <Button type="button" size="icon-xs" variant="ghost" onClick={() => setEditing(true)} aria-label={`Edit ${name}`}>
            <Pencil aria-hidden="true" />
          </Button>
        )}
      </div>
      {editing ? (
        <CommerceRowForm idPrefix={`tier-${id}`} fields={TIER_FIELDS} base={row} saving={write.isPending} submitLabel="Save tier"
          onCancel={() => { setEditing(false); write.reset(); }}
          onSave={(body) => write.mutate({ method: "PATCH", parts: ["customer-tiers", id], body })} />
      ) : null}
      <CommerceWriteError error={write.error} />
    </li>
  );
}

export function CustomerTierList({ companyId, siteId }: { companyId: string; siteId: string }) {
  const tiers = useInfiniteQuery({
    queryKey: queryKeys.website.commerce(companyId, siteId, "customer-tiers", "list"),
    queryFn: ({ pageParam }) => websiteCommerceApi.list(companyId, siteId, "customer-tiers", { limit: PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor || undefined,
  });
  const [adding, setAdding] = useState(false);
  const create = useCommerceWrite(companyId, siteId, { onSuccess: () => setAdding(false) });
  const rows = [...(tiers.data?.pages.flatMap((page) => page.items) ?? [])]
    .sort((a, b) => Number(b.rank ?? 0) - Number(a.rank ?? 0) || rowOptionLabel(a).localeCompare(rowOptionLabel(b)));
  return (
    <section className="space-y-3" aria-label="Customer tiers" data-testid="commerce-tiers">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Tiers group clients for pricing rules. Changes save to the website straight away.</p>
        {adding ? null : (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" />
            New customer tier
          </Button>
        )}
      </div>
      {adding ? (
        <div className={SECTION}>
          <h2 className="text-sm font-semibold">New customer tier</h2>
          <CommerceRowForm idPrefix="tier-new" fields={TIER_FIELDS} base={null} saving={create.isPending} submitLabel="Add tier"
            onCancel={() => { setAdding(false); create.reset(); }}
            onSave={(body) => create.mutate({ method: "POST", parts: ["customer-tiers"], body })} />
        </div>
      ) : null}
      <CommerceWriteError error={create.error} />
      {tiers.isLoading ? <PageSkeleton variant="list" /> : null}
      {tiers.error ? <ErrorState error={tiers.error} onRetry={() => void tiers.refetch()} retrying={tiers.isFetching} /> : null}
      {tiers.data && rows.length === 0 ? <EmptyState icon={Users} message="No customer tiers on the website yet." /> : null}
      {rows.length ? <ul className={LIST}>{rows.map((row) => <TierRow key={text(row.id)} companyId={companyId} siteId={siteId} row={row} />)}</ul> : null}
      <LoadMore query={tiers} />
    </section>
  );
}

