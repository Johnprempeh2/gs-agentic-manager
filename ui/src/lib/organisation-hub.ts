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
