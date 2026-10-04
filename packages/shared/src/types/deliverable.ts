// Deliverables (GRE-388): the finished, polished documents John asked for.
// A deliverable is an `issue_work_products` row of type "deliverable" that
// points at a stored attachment. Registering the same key on the same issue
// again creates the next version.

export type DeliverableKind = "report" | "brief" | "plan" | "deck" | "other";

export type DeliverableStatus = "draft" | "final";

export type DeliverableSort = "newest" | "recently_opened" | "title";

export interface DeliverableIssueSummary {
  id: string;
  identifier: string;
  title: string;
}

export interface DeliverableProjectSummary {
  id: string;
  name: string;
}

export interface DeliverableAgentSummary {
  id: string;
  name: string;
}

export interface Deliverable {
  id: string;
  companyId: string;
  key: string;
  version: number;
  versionCount: number;
  title: string;
  summary: string | null;
  kind: DeliverableKind;
  brand: string;
  status: DeliverableStatus;
  attachmentId: string;
  contentType: string;
  byteSize: number;
  originalFilename: string | null;
  contentPath: string;
  openPath: string;
  downloadPath: string;
  issue: DeliverableIssueSummary;
  project: DeliverableProjectSummary | null;
  createdByAgent: DeliverableAgentSummary | null;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
  /** In-app link to the deliverable on its task. */
  href: string;
}

export interface DeliverableVersion {
  id: string;
  version: number;
  title: string;
  status: DeliverableStatus;
  contentPath: string;
  downloadPath: string;
  createdAt: string;
}

export interface DeliverableDetail extends Deliverable {
  versions: DeliverableVersion[];
}

export interface DeliverableFacets {
  brands: string[];
  agents: DeliverableAgentSummary[];
  projects: DeliverableProjectSummary[];
}

export interface DeliverablesResponse {
  deliverables: Deliverable[];
  total: number;
  nextOffset: number | null;
  facets: DeliverableFacets;
}
