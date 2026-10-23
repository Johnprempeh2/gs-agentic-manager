// Website module (GRE-2105, ADR GRE-1914): the website's content inside GSAM.
// A site holds pages and collection entries; each page and entry keeps its
// JSON in a document whose revisions are the edit history.

/** planned = in the sitemap with no content yet; then the publish status machine. */
export const WEBSITE_PAGE_STATUSES = ["planned", "draft", "review", "approved", "published"] as const;
export type WebsitePageStatus = (typeof WEBSITE_PAGE_STATUSES)[number];

export const WEBSITE_ENTRY_STATUSES = ["draft", "review", "approved", "published"] as const;
export type WebsiteEntryStatus = (typeof WEBSITE_ENTRY_STATUSES)[number];

export const WEBSITE_PAGE_MENUS = ["header", "footer", "none"] as const;
export type WebsitePageMenu = (typeof WEBSITE_PAGE_MENUS)[number];

/** Largest page or entry body GSAM saves (ADR section 3: about 280 times today's largest page). */
export const WEBSITE_CONTENT_MAX_BYTES = 2 * 1024 * 1024;

export interface WebsiteSite {
  id: string;
  companyId: string;
  name: string;
  domain: string;
  repoUrl: string | null;
  netlifySiteId: string;
  /** True when a Netlify token is stored in the company's secrets. The token is never returned. */
  hasNetlifyToken: boolean;
  blobsStoreName: string;
  engineVersion: string | null;
  releaseSchemaVersion: number;
  propertyId: string | null;
  editorOrigins: string[];
  checkPaths: string[];
  liveReleaseId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebsitePageSeo {
  title?: string;
  description?: string;
  canonical?: string;
  ogImageAssetId?: string;
  noindex?: boolean;
}

interface WebsiteContentRow {
  id: string;
  companyId: string;
  siteId: string;
  documentId: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  approvedRevisionId: string | null;
  publishedRevisionId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebsitePage extends WebsiteContentRow {
  /** The page's URL path, e.g. `/` or `/consultancy/deep-dive`. */
  slug: string;
  title: string;
  navOrder: number | null;
  parentPageId: string | null;
  menu: WebsitePageMenu;
  menuOrder: number | null;
  status: WebsitePageStatus;
  seo: WebsitePageSeo;
}

export interface WebsiteEntry extends WebsiteContentRow {
  collection: string;
  entryKey: string;
  orgId: string | null;
  status: WebsiteEntryStatus;
  sortOrder: number | null;
}

/** A page or entry with its latest content (parsed JSON). */
export type WebsitePageDetail = WebsitePage & { content: unknown };
export type WebsiteEntryDetail = WebsiteEntry & { content: unknown };

export interface WebsiteRevision {
  id: string;
  revisionNumber: number;
  changeSummary: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: string;
}

/**
 * Save states of the editor frame contract (plan 3.4): `saved` (200),
 * `conflict` (409: someone saved first) or `failed` (422: nothing written).
 */
export type WebsiteSaveResult =
  | { state: "saved"; revisionId: string; revisionNumber: number }
  | { state: "conflict"; latestRevisionId: string | null; latestRevisionNumber: number; message: string }
  | { state: "failed"; message: string };

/**
 * Release statuses (ADR GRE-1914 section 2.4). `pending` = `current` points at
 * this release but the rebuild or the check pages have not passed yet.
 */
export const WEBSITE_RELEASE_STATUSES = [
  "building",
  "checks_failed",
  "uploading",
  "switched",
  "pending",
  "live",
  "superseded",
  "failed",
] as const;
export type WebsiteReleaseStatus = (typeof WEBSITE_RELEASE_STATUSES)[number];

export type WebsiteReleaseKind = "publish" | "rollback";

/** Why a release is Pending; the UI shows it next to Retry. */
export type WebsitePendingReason = "build_failed" | "build_timeout" | "verify_failed" | "server_restarted" | "build_not_started";

/**
 * How Netlify serves a release (GRE-2108). `build` is a content-only rebuild
 * (one production deploy, about 15 credits); `restore` publishes an earlier
 * deploy again (0 credits).
 */
export interface WebsiteReleaseDeploy {
  method: "build" | "restore";
  requestedAt: string;
  deployId: string | null;
  commitRef: string | null;
  state: "requested" | "building" | "ready" | "error";
  errorMessage?: string | null;
}

/** One pre-upload check or one verify fetch. */
export interface WebsiteReleaseCheck {
  kind: "check" | "verify";
  name: string;
  ok: boolean;
  message?: string;
}

export interface WebsiteRelease {
  id: string;
  companyId: string;
  siteId: string;
  number: number;
  kind: WebsiteReleaseKind;
  rollbackOfReleaseId: string | null;
  status: WebsiteReleaseStatus;
  pendingReason: WebsitePendingReason | null;
  blobsKey: string | null;
  releaseSha256: string | null;
  checks: WebsiteReleaseCheck[];
  deploy: WebsiteReleaseDeploy | null;
  publishedByUserId: string | null;
  switchedAt: string | null;
  liveAt: string | null;
  failedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * What a person's click on Retry or Rollback will do, shown before the click.
 * `verify` and `restore` are free; `build` is one production deploy (about 15
 * credits) and the request must carry `confirmRebuild: true`.
 */
export interface WebsiteReleaseActionPlan {
  action: "verify" | "build" | "restore";
  costsCredits: boolean;
  reason: string;
}

export const WEBSITE_MODULE_API_ROUTES = {
  /** GET → `WebsiteSite[]` the caller can view. POST `CreateWebsiteSite` → 201 `WebsiteSite` (website:publish). */
  sites: "/companies/:companyId/website/sites",
  /** GET → `WebsiteSite`. PATCH `UpdateWebsiteSite` → `WebsiteSite` (website:publish). */
  site: "/companies/:companyId/website/sites/:siteId",
  /** GET → `WebsitePage[]` (`?includeArchived=true`). POST `CreateWebsitePage` → 201 `WebsitePageDetail` (website:edit). */
  pages: "/companies/:companyId/website/sites/:siteId/pages",
  /** GET → `WebsitePageDetail`. PATCH `UpdateWebsitePage` → `WebsitePage` (website:edit). */
  page: "/companies/:companyId/website/sites/:siteId/pages/:pageId",
  /** PUT `SaveWebsiteContent` → `WebsiteSaveResult` (website:edit). */
  pageContent: "/companies/:companyId/website/sites/:siteId/pages/:pageId/content",
  /** POST → `WebsitePage` (website:edit). Archive, never delete. */
  pageArchive: "/companies/:companyId/website/sites/:siteId/pages/:pageId/archive",
  /** GET → `WebsiteRevision[]`, newest first. */
  pageRevisions: "/companies/:companyId/website/sites/:siteId/pages/:pageId/revisions",
  /** GET → `WebsiteEntry[]` (`?collection=product`). POST `CreateWebsiteEntry` → 201 `WebsiteEntryDetail`. */
  entries: "/companies/:companyId/website/sites/:siteId/entries",
  /** GET → `WebsiteEntryDetail`. PATCH `UpdateWebsiteEntry` → `WebsiteEntry`. */
  entry: "/companies/:companyId/website/sites/:siteId/entries/:entryId",
  /** PUT `SaveWebsiteContent` → `WebsiteSaveResult`. */
  entryContent: "/companies/:companyId/website/sites/:siteId/entries/:entryId/content",
  /** POST → `WebsiteEntry`. */
  entryArchive: "/companies/:companyId/website/sites/:siteId/entries/:entryId/archive",
  /** GET → `WebsiteRevision[]`. */
  entryRevisions: "/companies/:companyId/website/sites/:siteId/entries/:entryId/revisions",
  /**
   * GET → `WebsiteRelease[]`, newest first (website:view). POST → 202
   * `WebsiteRelease` (website:publish, a person's click only; 409 while a
   * publish or rollback runs for the site).
   */
  releases: "/companies/:companyId/website/sites/:siteId/releases",
  /** GET → `WebsiteRelease`. */
  release: "/companies/:companyId/website/sites/:siteId/releases/:releaseId",
  /** GET → `WebsiteReleaseActionPlan`. POST `{ confirmRebuild? }` → 202 `WebsiteRelease` (a Pending release only). */
  releaseRetry: "/companies/:companyId/website/sites/:siteId/releases/:releaseId/retry",
  /** GET → `WebsiteReleaseActionPlan`. POST `{ confirmRebuild? }` → 202 `WebsiteRelease` (the new rollback release). */
  releaseRollback: "/companies/:companyId/website/sites/:siteId/releases/:releaseId/rollback",
} as const;
