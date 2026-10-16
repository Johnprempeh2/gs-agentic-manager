// CRM organisations (GRE-1472 slice 1, GRE-1477). The organisation is the
// primary CRM record; pipeline cases and imports point at it later.

/** Where the company stands with an organisation. */
export const ORGANISATION_STATUSES = ["target", "prospect", "client", "former"] as const;
export type OrganisationStatus = (typeof ORGANISATION_STATUSES)[number];

export const ORGANISATION_STATUS_LABELS: Record<OrganisationStatus, string> = {
  target: "Target",
  prospect: "Prospect",
  client: "Client",
  former: "Former client",
};

/** Where a record came from. `manual` is typed in the app; others are imports. */
export const ORGANISATION_SOURCES = ["manual", "pipedrive", "csv", "hubspot", "notion"] as const;
export type OrganisationSource = (typeof ORGANISATION_SOURCES)[number];
