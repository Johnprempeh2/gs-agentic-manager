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

// Global CRM fields (GRE-1539, slice 2 of GRE-1538).

/** Head-count bands, for when the exact employee count is not known. */
export const ORGANISATION_SIZE_BANDS = ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5001+"] as const;
export type OrganisationSizeBand = (typeof ORGANISATION_SIZE_BANDS)[number];

export const ORGANISATION_SIZE_BAND_LABELS: Record<OrganisationSizeBand, string> = {
  "1-10": "1 to 10 employees",
  "11-50": "11 to 50 employees",
  "51-200": "51 to 200 employees",
  "201-500": "201 to 500 employees",
  "501-1000": "501 to 1,000 employees",
  "1001-5000": "1,001 to 5,000 employees",
  "5001+": "5,001+ employees",
};

export const ORGANISATION_OWNERSHIP_TYPES = [
  "private",
  "public",
  "subsidiary",
  "government",
  "non_profit",
  "partnership",
  "other",
] as const;
export type OrganisationOwnershipType = (typeof ORGANISATION_OWNERSHIP_TYPES)[number];

export const ORGANISATION_OWNERSHIP_TYPE_LABELS: Record<OrganisationOwnershipType, string> = {
  private: "Private company",
  public: "Public (listed) company",
  subsidiary: "Subsidiary",
  government: "Government",
  non_profit: "Non-profit",
  partnership: "Partnership",
  other: "Other",
};

/** At most this many tags per organisation, each at most this long. */
export const ORGANISATION_MAX_TAGS = 30;
export const ORGANISATION_TAG_MAX_LENGTH = 60;
