// The links register (GRE-4252): every link we share (Netlify sites, client
// portals, previews, deliverables, Notion pages), in one searchable list by
// client and project. It replaces the old Notion "Netlify Link Register".

export const LINK_TYPES = ["proposal", "demo", "recap", "portal", "deck", "report", "preview", "other"] as const;
export type LinkType = (typeof LINK_TYPES)[number];

export const LINK_STATUSES = ["live", "draft", "archived", "broken"] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

/** How the row got here: by hand, captured from a deliverable or preview, or imported. */
export const LINK_SOURCES = ["manual", "deliverable", "preview", "import"] as const;
export type LinkSource = (typeof LINK_SOURCES)[number];

export interface LinkRef {
  id: string;
  name: string;
}

export interface LinkSourceIssue {
  id: string;
  identifier: string | null;
  title: string;
  /** In-app link to the task, e.g. /GRE/issues/GRE-12. */
  path: string;
}

export interface LinkAddedBy {
  type: "agent" | "user";
  id: string;
  name: string | null;
}

export interface LinkItem {
  id: string;
  companyId: string;
  url: string;
  title: string;
  type: LinkType;
  status: LinkStatus;
  source: LinkSource;
  /** The client page this link belongs to, when there is one. */
  clientCase: LinkRef | null;
  /** The client as written when no client page matched (imported rows). */
  clientName: string | null;
  project: LinkRef | null;
  /** The project as written when no GSAM project matched (imported rows). */
  projectName: string | null;
  sourceIssue: LinkSourceIssue | null;
  addedBy: LinkAddedBy | null;
  notes: string | null;
  deployedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LinksFacets {
  clients: LinkRef[];
  projects: LinkRef[];
}

export interface LinksResponse {
  links: LinkItem[];
  total: number;
  facets: LinksFacets;
}

export interface LinksImportResult {
  created: number;
  updated: number;
  skipped: Array<{ row: number; reason: string }>;
}

export interface LinksBackfillResult {
  scanned: number;
  created: number;
  updated: number;
}
