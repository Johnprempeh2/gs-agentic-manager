import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, X } from "lucide-react";
import {
  DEEP_DIVE_CASE_TYPES,
  DEEP_DIVE_LABELS,
  DEEP_DIVE_RECORD_KEY,
  DEEP_DIVE_STREAMS,
  DEEP_DIVE_VISIBILITIES,
  type ClientDocumentRequest,
  type ClientEvidenceItem,
  type ClientEvidenceKind,
  type DeepDiveItemFileLink,
  type DeepDiveVisibility,
  type LinkDeepDiveFile,
} from "@greatstone/shared";
import { casesApi, type CaseSummary } from "@/api/cases";
import { websiteModuleApi } from "@/api/website";
import { websiteDataBridgeApi } from "@/api/website-data-bridge";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { formatShortDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { StatusBadge } from "@/components/StatusBadge";

// Deep Dive evidence and files (GRE-2395): one client file, many items. A file
// stays with the client; each item links to it, Internal unless a person
// shares the link. Held is a file we have; missing is a requested document
// that has not come in yet.

const SELECT_CLASS =
  "h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-(length:--rad-3) focus-visible:ring-ring/50 disabled:text-subtle-foreground";

/** Where a file came from, in the words the team uses. */
export const PROVENANCE_LABELS: Record<ClientEvidenceKind, string> = {
  upload: "Uploaded",
  attachment: "Task attachment",
  document: "Task document",
  link: "Link",
};

interface DeepDiveItem {
  id: string;
  label: string;
  clientCaseId: string | null;
}

/** The record and its nine streams, in grid order. */
export function deepDiveItems(rows: readonly CaseSummary[]): DeepDiveItem[] {
  const items: DeepDiveItem[] = [];
  const record = rows.find((row) => row.caseType === DEEP_DIVE_CASE_TYPES.record && row.key === DEEP_DIVE_RECORD_KEY);
  if (record) items.push({ id: record.id, label: "Deep dive record", clientCaseId: record.clientCaseId });
  for (const stream of DEEP_DIVE_STREAMS) {
    const row = rows.find((entry) => entry.caseType === DEEP_DIVE_CASE_TYPES.stream && entry.key === stream.key);
    if (row) items.push({ id: row.id, label: stream.label, clientCaseId: row.clientCaseId });
  }
  return items;
}

/** A request is in once it has a file in GSAM or the client answered it on the website (GRE-2439). */
export function requestIsIn(request: ClientDocumentRequest): boolean {
  return Boolean(request.received || request.websiteAnswer);
}

/** Who answered on the website, in a few words. */
export function websiteAnswerText(answer: NonNullable<ClientDocumentRequest["websiteAnswer"]>): string {
  const who = answer.answeredBy.name || answer.answeredBy.email || "the client";
  return `Answered on the website ${formatShortDate(answer.answeredAt)} by ${who}${answer.fileName ? `: ${answer.fileName}` : ""}`;
}

/** Held and missing per item: a linked file is held; a linked request is held once it is in. */
export function heldAndMissing(
  itemId: string,
  links: readonly DeepDiveItemFileLink[],
  requests: readonly ClientDocumentRequest[],
): { held: number; missing: number } {
  const requestById = new Map(requests.map((request) => [request.id, request]));
  let held = 0;
  let missing = 0;
  for (const link of links) {
    if (link.caseId !== itemId) continue;
    if (link.evidenceId) held += 1;
    else if (link.documentRequestId && requestById.has(link.documentRequestId) && requestIsIn(requestById.get(link.documentRequestId)!)) held += 1;
    else missing += 1;
  }
  return { held, missing };
}

function provenance(file: ClientEvidenceItem): string {
  const parts = [PROVENANCE_LABELS[file.kind]];
  if (file.addedBy) parts.push(`added by ${file.addedBy.name ?? (file.addedBy.type === "agent" ? "an agent" : "a person")}`);
  parts.push(formatShortDate(file.createdAt));
  return parts.join(", ");
}

function LinkedItems({
  links,
  items,
  target,
  busy,
  onLink,
  onShare,
  onUnlink,
}: {
  links: DeepDiveItemFileLink[];
  items: DeepDiveItem[];
  target: LinkDeepDiveFile;
  busy: boolean;
  onLink: (itemId: string, target: LinkDeepDiveFile) => void;
  onShare: (link: DeepDiveItemFileLink, visibility: DeepDiveVisibility) => void;
  onUnlink: (link: DeepDiveItemFileLink) => void;
}) {
  const labelOf = new Map(items.map((item) => [item.id, item.label]));
  const linkedIds = new Set(links.map((link) => link.caseId));
  const unlinked = items.filter((item) => !linkedIds.has(item.id));
  return (
    <div className="flex flex-wrap items-center gap-2">
      {links.map((link) => (
        <span
          key={link.id}
          data-deep-dive-file-link={link.caseId}
          className="inline-flex items-center gap-1 rounded-md border border-border py-0.5 pl-2 pr-0.5 text-xs"
        >
          {labelOf.get(link.caseId) ?? "Item"}
          <select
            aria-label={`Visibility on ${labelOf.get(link.caseId) ?? "item"}`}
            className={`${SELECT_CLASS} h-6 border-0`}
            value={link.visibility}
            disabled={busy}
            onChange={(event) => onShare(link, event.target.value as DeepDiveVisibility)}
          >
            {DEEP_DIVE_VISIBILITIES.map((value) => (
              <option key={value} value={value}>
                {DEEP_DIVE_LABELS[value]}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Unlink from ${labelOf.get(link.caseId) ?? "item"}`}
            disabled={busy}
            onClick={() => onUnlink(link)}
          >
            <X />
          </Button>
        </span>
      ))}
      {unlinked.length > 0 ? (
        <select
          aria-label="Link to an item"
          className={SELECT_CLASS}
          value=""
          disabled={busy}
          onChange={(event) => {
            if (event.target.value) onLink(event.target.value, target);
          }}
        >
          <option value="">Link to an item...</option>
          {unlinked.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

/**
 * Send this client's Shared items to the website (GRE-2439). The site gets a
 * whole snapshot, so anything unshared since the last send is removed there.
 * Hidden when the company has no website.
 */
function WebsiteSyncCard({ companyId, clientCaseId }: { companyId: string; clientCaseId: string }) {
  const sitesQuery = useQuery({
    queryKey: queryKeys.website.sites(companyId),
    queryFn: () => websiteModuleApi.sites(companyId),
    retry: false,
  });
  const sites = sitesQuery.data ?? [];
  const [siteDraft, setSiteDraft] = useState("");
  const siteId = siteDraft || sites[0]?.id || "";
  const send = useMutation({ mutationFn: () => websiteDataBridgeApi.deepDiveSync(companyId, siteId, clientCaseId) });
  if (sites.length === 0) return null;
  return (
    <Card className="gap-2 px-4 py-3" data-testid="deep-dive-website-sync">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">Client view on the website</p>
          <p className="text-xs text-muted-foreground">
            Sends only Shared items, Shared files and published deliverables. Anything unshared since the last send is
            removed from the site.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {sites.length > 1 ? (
            <select
              aria-label="Website"
              className={SELECT_CLASS}
              value={siteId}
              disabled={send.isPending}
              onChange={(event) => setSiteDraft(event.target.value)}
            >
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          ) : null}
          <Button type="button" size="sm" variant="outline" disabled={!siteId || send.isPending} onClick={() => send.mutate()}>
            {send.isPending ? "Sending..." : "Send to website"}
          </Button>
        </div>
      </div>
      {send.error instanceof Error ? (
        <p role="alert" className="text-xs text-destructive">
          {send.error.message}
        </p>
      ) : null}
      {send.data ? (
        <p role="status" className="text-xs text-muted-foreground">
          Sent {formatShortDate(send.data.syncedAt)}: {send.data.counts.items} items, {send.data.counts.files} files,{" "}
          {send.data.counts.documentRequests} document requests, {send.data.counts.deliverables} deliverables.
        </p>
      ) : null}
    </Card>
  );
}

export function DeepDiveFiles() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? "";
  const [clientDraft, setClientDraft] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Deep Dive", href: "/deep-dive" }, { label: "Evidence and files" }]);
  }, [setBreadcrumbs]);

  const itemsQuery = useQuery({
    queryKey: [...queryKeys.cases.list(companyId), "deep-dive"],
    queryFn: () =>
      casesApi.list(companyId, { types: [DEEP_DIVE_CASE_TYPES.record, DEEP_DIVE_CASE_TYPES.stream], limit: 200 }),
    enabled: !!selectedCompanyId,
  });
  const filesQuery = useQuery({
    queryKey: queryKeys.cases.deepDiveFiles(companyId),
    queryFn: () => casesApi.deepDiveFiles(companyId),
    enabled: !!selectedCompanyId,
  });
  const items = useMemo(() => deepDiveItems(itemsQuery.data ?? []), [itemsQuery.data]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.cases.list(companyId) });

  const chooseClient = useMutation({
    // The record and every stream are about the same client.
    mutationFn: async (clientCaseId: string) => {
      for (const item of items) {
        if (item.clientCaseId !== clientCaseId) await casesApi.patch(item.id, { clientCaseId });
      }
    },
    onSuccess: () => setClientDraft(""),
    onSettled: refresh,
  });
  const link = useMutation({
    mutationFn: ({ itemId, target }: { itemId: string; target: LinkDeepDiveFile }) =>
      casesApi.linkDeepDiveFile(itemId, target),
    onSettled: refresh,
  });
  const share = useMutation({
    mutationFn: ({ link: entry, visibility }: { link: DeepDiveItemFileLink; visibility: DeepDiveVisibility }) =>
      casesApi.setDeepDiveFileVisibility(entry.caseId, entry.id, visibility),
    onSettled: refresh,
  });
  const unlink = useMutation({
    mutationFn: (entry: DeepDiveItemFileLink) => casesApi.unlinkDeepDiveFile(entry.caseId, entry.id),
    onSettled: refresh,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={FolderOpen} message="Select a company to see its deep dive files." />;
  }
  if (itemsQuery.isLoading || filesQuery.isLoading) return <PageSkeleton variant="list" />;
  const loadError = itemsQuery.error ?? filesQuery.error;
  if (loadError || !filesQuery.data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {loadError instanceof Error ? loadError.message : "Could not load the deep dive files."}
      </p>
    );
  }

  const { client, clients, evidence, requests, links } = filesQuery.data;
  const busy = chooseClient.isPending || link.isPending || share.isPending || unlink.isPending;
  const actionError = [chooseClient.error, link.error, share.error, unlink.error].find((error) => error instanceof Error);
  const handlers = {
    items,
    busy,
    onLink: (itemId: string, target: LinkDeepDiveFile) => link.mutate({ itemId, target }),
    onShare: (entry: DeepDiveItemFileLink, visibility: DeepDiveVisibility) => share.mutate({ link: entry, visibility }),
    onUnlink: (entry: DeepDiveItemFileLink) => unlink.mutate(entry),
  };
  const missingRequests = requests.filter((request) => !requestIsIn(request));

  const header = (
    <header className="space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-bold">Evidence and files</h1>
        <Link to="/deep-dive" className="text-xs font-medium underline-offset-4 hover:underline">
          Back to the grid
        </Link>
      </div>
      <p className="max-w-3xl text-sm text-muted-foreground">
        One client file can back many items. Unlinking a file from one item leaves it on the others and on the
        client. Every link is Internal until a person shares it.
      </p>
    </header>
  );

  if (items.length === 0) {
    return (
      <div className="space-y-4">
        {header}
        <EmptyState icon={FolderOpen} message="Start the deep dive record first, then link the client's files here." />
      </div>
    );
  }

  const clientPicker = (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (clientDraft) chooseClient.mutate(clientDraft);
      }}
    >
      <select
        aria-label="Client"
        className={SELECT_CLASS}
        value={clientDraft}
        disabled={busy}
        onChange={(event) => setClientDraft(event.target.value)}
      >
        <option value="">{client ? "Change the client..." : "Choose the client..."}</option>
        {clients
          .filter((entry) => entry.id !== client?.id)
          .map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.title}
            </option>
          ))}
      </select>
      <Button type="submit" size="sm" variant="outline" disabled={!clientDraft || busy}>
        {client ? "Change client" : "Use this client"}
      </Button>
    </form>
  );

  return (
    <div className="space-y-4">
      {header}

      <Card className="gap-2 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm">
            {client ? (
              <>
                This deep dive is about <span className="font-medium">{client.title}</span>.
              </>
            ) : (
              <span className="text-muted-foreground">Choose the client this deep dive is about to link its files.</span>
            )}
          </p>
          {clientPicker}
        </div>
        {client ? (
          <p className="text-xs text-muted-foreground">
            Changing the client makes every item Internal and removes its file links. The files stay with the old client.
          </p>
        ) : null}
      </Card>

      {client ? <WebsiteSyncCard companyId={companyId} clientCaseId={client.id} /> : null}

      {actionError instanceof Error ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError.message}
        </p>
      ) : null}

      {client ? (
        <>
          <section aria-labelledby="deep-dive-files-by-item" className="space-y-2">
            <h2 id="deep-dive-files-by-item" className="text-sm font-semibold">
              Held and missing by item
            </h2>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
              {items.map((item) => {
                const counts = heldAndMissing(item.id, links, requests);
                return (
                  <li
                    key={item.id}
                    data-deep-dive-item-counts={item.id}
                    className="rounded-lg border border-border px-3 py-2"
                  >
                    <p className="truncate text-sm font-medium">{item.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {counts.held} held,{" "}
                      <span className={counts.missing > 0 ? "font-medium text-foreground" : undefined}>
                        {counts.missing} missing
                      </span>
                    </p>
                  </li>
                );
              })}
            </ul>
          </section>

          <section aria-labelledby="deep-dive-files-held" className="space-y-2">
            <h2 id="deep-dive-files-held" className="text-sm font-semibold">
              Files held ({evidence.length})
            </h2>
            {evidence.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No files on {client.title} yet. Add them on the client's page; they show here to link.
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {evidence.map((file) => (
                  <li key={file.id} data-deep-dive-file={file.id} className="space-y-1.5 px-3 py-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <a
                          href={file.openPath}
                          target={file.kind === "link" ? "_blank" : undefined}
                          rel={file.kind === "link" ? "noreferrer" : undefined}
                          className="block truncate text-sm font-medium underline-offset-4 hover:underline"
                        >
                          {file.title}
                        </a>
                        <p className="text-xs text-muted-foreground" data-testid="deep-dive-file-provenance">
                          {provenance(file)}
                          {file.sourceIssue ? (
                            <>
                              , from{" "}
                              <Link to={file.sourceIssue.path} className="underline-offset-4 hover:underline">
                                {file.sourceIssue.identifier ?? file.sourceIssue.title}
                              </Link>
                            </>
                          ) : null}
                        </p>
                      </div>
                      <StatusBadge status="succeeded" label="Held" />
                    </div>
                    <LinkedItems
                      {...handlers}
                      links={links.filter((entry) => entry.evidenceId === file.id)}
                      target={{ evidenceId: file.id }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="deep-dive-files-requested" className="space-y-2">
            <h2 id="deep-dive-files-requested" className="text-sm font-semibold">
              Documents asked for ({requests.length}, {missingRequests.length} missing)
            </h2>
            {requests.length === 0 ? (
              <p className="text-sm text-muted-foreground">No documents asked of {client.title} yet.</p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {requests.map((request) => (
                  <li key={request.id} data-deep-dive-request={request.id} className="space-y-1.5 px-3 py-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{request.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {request.received
                            ? `Received ${formatShortDate(request.received.receivedAt)}: ${request.received.title}`
                            : request.websiteAnswer
                              ? websiteAnswerText(request.websiteAnswer)
                              : `Asked ${formatShortDate(request.createdAt)}, not received yet`}
                        </p>
                      </div>
                      {request.received ? (
                        <StatusBadge status="succeeded" label="Held" />
                      ) : request.websiteAnswer ? (
                        <StatusBadge status="succeeded" label="Received" />
                      ) : (
                        <StatusBadge status="warning" label="Missing" />
                      )}
                    </div>
                    <LinkedItems
                      {...handlers}
                      links={links.filter((entry) => entry.documentRequestId === request.id)}
                      target={{ documentRequestId: request.id }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
