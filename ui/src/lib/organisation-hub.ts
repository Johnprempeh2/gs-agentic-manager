import type {
  ClientDocumentRequest,
  ClientJourneyStage,
  DeepDiveSyncPayload,
  OrganisationHistoryCase,
} from "@greatstone/shared";

// The per-client hub (GRE-2614): one page per organisation with a tab for each
// thing we collected from the client or delivered to it. Every tab reads the
// owning record and links to it; nothing is copied.

export const ORGANISATION_HUB_TABS = [
  { value: "overview", label: "Overview" },
  { value: "discovery", label: "Executive Discovery" },
  { value: "interviews", label: "Interviews" },
  { value: "deep-dive", label: "Deep Dive" },
  { value: "documents", label: "Documents" },
  { value: "deliverables", label: "Deliverables" },
  { value: "commerce", label: "Commerce" },
  { value: "billing", label: "Billing" },
  { value: "activity", label: "Activity" },
  { value: "client-view", label: "Client view" },
] as const;

export type OrganisationHubTab = (typeof ORGANISATION_HUB_TABS)[number]["value"];

export function organisationHubTab(requested: string | null): OrganisationHubTab {
  return ORGANISATION_HUB_TABS.some((tab) => tab.value === requested) ? (requested as OrganisationHubTab) : "overview";
}

/**
 * The engagement the hub shows: the one asked for in the address when it is
 * this organisation's, else the newest open one, else the newest of any.
 */
export function engagementCaseId(
  cases: Pick<OrganisationHistoryCase, "id" | "terminalKind" | "createdAt">[],
  requested: string | null,
): string | null {
  if (requested && cases.some((item) => item.id === requested)) return requested;
  const newest = [...cases].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return (newest.find((item) => !item.terminalKind) ?? newest[0])?.id ?? null;
}

/** The task that stores the website organisation id on GSAM organisations. */
export const WEBSITE_LINK_TASK = "GRE-2682";

/**
 * The client's website organisation id (the website's `customers.id`): the one
 * key for every website read about this client (GRE-2609). GSAM does not store
 * it yet; GRE-2682 adds it as `websiteOrganisationId`. Until then every
 * organisation reads as not linked. Never match a client by name or email.
 */
export function websiteOrganisationIdOf(organisation: object): string | null {
  const value = (organisation as { websiteOrganisationId?: unknown }).websiteOrganisationId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A client user as the website returns it on the customer record (`customer_users`), read only. */
export interface WebsiteClientUser {
  id: string;
  name: string | null;
  email: string | null;
  role: string | null;
}

export function websiteClientUsers(customer: Record<string, unknown> | null | undefined): WebsiteClientUser[] {
  const rows = Array.isArray(customer?.customer_users) ? customer.customer_users : [];
  const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const record = row as Record<string, unknown>;
    const id = str(record.id);
    return id ? [{ id, name: str(record.name), email: str(record.email), role: str(record.role) }] : [];
  });
}

/** What the website client hub gets for this client (the Deep Dive sync preview), by id. */
export interface ClientShared {
  documentRequestIds: Set<string>;
  publicationIds: Set<string>;
  itemIds: Set<string>;
  fileCount: number;
}

export function clientShared(payload: DeepDiveSyncPayload | null | undefined): ClientShared {
  return {
    documentRequestIds: new Set(payload?.documentRequests.map((request) => request.id) ?? []),
    publicationIds: new Set(payload?.deliverables.map((deliverable) => deliverable.id) ?? []),
    itemIds: new Set(payload?.items.map((item) => item.id) ?? []),
    fileCount: payload?.files.length ?? 0,
  };
}

export interface HubDocumentRequest {
  request: ClientDocumentRequest;
  stageName: string;
  /** received: we hold the file; answered: the client answered on the website; missing: still open. */
  state: "received" | "answered" | "missing";
  /** When it was received or answered; null while missing. */
  at: string | null;
}

/** Every document asked of the client across the journey, open ones first, then newest first. */
export function hubDocumentRequests(stages: Pick<ClientJourneyStage, "name" | "requests">[]): HubDocumentRequest[] {
  const rows: HubDocumentRequest[] = stages.flatMap((stage) =>
    (stage.requests ?? []).map((request) => {
      if (request.received) return { request, stageName: stage.name, state: "received" as const, at: request.received.receivedAt };
      if (request.websiteAnswer) return { request, stageName: stage.name, state: "answered" as const, at: request.websiteAnswer.answeredAt };
      return { request, stageName: stage.name, state: "missing" as const, at: null };
    }),
  );
  return rows.sort((a, b) => {
    const open = Number(b.state === "missing") - Number(a.state === "missing");
    return open || b.request.createdAt.localeCompare(a.request.createdAt);
  });
}
