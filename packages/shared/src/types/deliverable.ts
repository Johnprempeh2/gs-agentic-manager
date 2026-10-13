// Deliverables (GRE-388): the finished, polished documents John asked for.
// A deliverable is an `issue_work_products` row of type "deliverable" that
// points at a stored attachment. Registering the same key on the same issue
// again creates the next version.

export type DeliverableKind = "report" | "brief" | "plan" | "deck" | "other";

export type DeliverableStatus = "draft" | "final";

export type DeliverableSort = "newest" | "recently_opened" | "title";

/** Who may see a deliverable (see deliverableConfidentialitySchema). */
export type DeliverableConfidentiality = "internal" | "client" | "public";

/** The last daily check of a link deliverable's site. */
export interface DeliverableLinkCheck {
  lastCheckedAt: string;
  /** Final HTTP status, or null when the site could not be reached at all. */
  httpStatus: number | null;
  /** False means the link is broken (not found, server error or unreachable). */
  ok: boolean;
}

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

export interface DeliverableClientCaseSummary {
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
  confidentiality: DeliverableConfidentiality;
  /** The stored file; null for a link deliverable. */
  attachmentId: string | null;
  /** True for a link deliverable: a live site at `url` instead of a stored file. */
  external: boolean;
  url: string | null;
  /** Stored screenshot of a link deliverable's site, for its card. */
  screenshotPath: string | null;
  screenshotCapturedAt: string | null;
  linkCheck: DeliverableLinkCheck | null;
  /** Password protected or unlisted: marked by hand, or the site answered 401 or 403. */
  restricted: boolean;
  contentType: string;
  byteSize: number;
  originalFilename: string | null;
  contentPath: string;
  openPath: string;
  downloadPath: string;
  issue: DeliverableIssueSummary;
  project: DeliverableProjectSummary | null;
  /** The client (pipeline) case the deliverable's task is linked to (GRE-1488). */
  clientCase: DeliverableClientCaseSummary | null;
  createdByAgent: DeliverableAgentSummary | null;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
  /** In-app link to the deliverable on its task. */
  href: string;
  /** In-app path that opens this deliverable in Quick Look on the Deliverables page. */
  appPath: string;
  /** `appPath` as an absolute URL; set on deliverables API responses. */
  appUrl?: string;
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

export type DeliverableCommentStatus = "draft" | "sent";

/**
 * What a comment is pinned to (GRE-1223): a passage of text, one element such
 * as an image, chart or table, or a box drawn over part of the page.
 */
export type DeliverableCommentAnchorKind = "text" | "element" | "region";

/** A box as fractions (0 to 1) of the element it was drawn on. */
export interface DeliverableCommentBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * How to find a picked element again. `path` is a CSS path of
 * `tag:nth-of-type(n)` steps from `body`; `tag` and `label` let the viewer
 * re-find it by name when the path no longer matches. For a region, the path
 * names the element the box was drawn on and `box` is the box inside it.
 */
export interface DeliverableCommentLocator {
  path: string;
  tag: string;
  label: string | null;
  box: DeliverableCommentBox | null;
}

/**
 * A note pinned to a passage of one deliverable version (GRE-982). A text
 * anchor is the quoted text plus a little context on each side, so the viewer
 * can find the passage again; `textStart` breaks ties when the quote repeats.
 * An element or region anchor has a `locator` instead, and `quote` holds a
 * readable label such as "Image: Q3 revenue chart".
 */
export interface DeliverableComment {
  id: string;
  companyId: string;
  deliverableId: string;
  issueId: string;
  anchorKind: DeliverableCommentAnchorKind;
  quote: string;
  prefix: string | null;
  suffix: string | null;
  textStart: number | null;
  locator: DeliverableCommentLocator | null;
  body: string;
  status: DeliverableCommentStatus;
  authorUserId: string;
  sentCommentId: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeliverableCommentsResponse {
  comments: DeliverableComment[];
}

export interface SendDeliverableCommentsResponse {
  sent: DeliverableComment[];
  commentId: string;
  /** The task's assignee agent woken to revise, or null when no agent owns the task. */
  agentId: string | null;
  woken: boolean;
}
