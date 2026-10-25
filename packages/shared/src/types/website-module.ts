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

export type WebsiteNetlifyTokenSource = "own" | "shared";

/** A company secret a site can use as its Netlify token: id and name only. */
export interface WebsiteTokenSecretOption {
  id: string;
  name: string;
}

/**
 * What the caller may do on the website: for the company (no `siteId`) or for one site.
 * Connecting a site needs `publish` for the company; changing a site needs `publish` for that site.
 */
export interface WebsiteAccess {
  view: boolean;
  edit: boolean;
  publish: boolean;
}

export interface WebsiteSite {
  id: string;
  companyId: string;
  name: string;
  domain: string;
  repoUrl: string | null;
  netlifySiteId: string;
  /** True when a Netlify token is stored in the company's secrets. The token is never returned. */
  hasNetlifyToken: boolean;
  /** `own`: a token pasted for this site, in its own secret. `shared`: a company secret the site uses but never changes. */
  netlifyTokenSource: WebsiteNetlifyTokenSource | null;
  /** The linked secret's name, never its value. */
  netlifyTokenSecretName: string | null;
  blobsStoreName: string;
  engineVersion: string | null;
  releaseSchemaVersion: number;
  propertyId: string | null;
  editorOrigins: string[];
  /** The frame's own origin (the dedicated editor host), or null: no editor opens until it is set. */
  editorFrameOrigin: string | null;
  /** A frameable exact copy of the live deploy for the Live preview, or null: the live domain. */
  livePreviewUrl: string | null;
  /** The development build for the In development preview, or null: the editor address. */
  devPreviewUrl: string | null;
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
  | { state: "failed"; message: string; code?: WebsiteSaveFailureCode };

/**
 * Why a save failed. `origin-changed`: the editor address of the site changed
 * after this editor session opened (frame contract rule C2.4). Never retryable.
 */
export type WebsiteSaveFailureCode = "invalid" | "archived" | "origin-changed" | "error";

/** A media entry (`collection = 'media'`) whose asset is in the same company. */
export interface WebsiteMediaItem {
  entryId: string;
  entryKey: string;
  assetId: string;
  alt: string;
  caption: string | null;
  contentType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  /** GSAM's company-scoped asset path. The host fetches it and hands the frame a `Blob`. */
  contentPath: string;
}

export interface WebsiteNavigationItem {
  pageId: string;
  title: string;
  slug: string;
  menu: WebsitePageMenu;
  menuOrder: number | null;
}

/** Everything the host needs for the frame's `load-draft` (frame contract section 5.2). */
export interface WebsitePageEditorLoad {
  page: WebsitePage;
  revisionId: string;
  data: unknown;
  theme: Record<string, unknown>;
  site: { name: string; settings: { domain: string }; navigation: WebsiteNavigationItem[] };
  editorFrameOrigin: string;
  media: WebsiteMediaItem[];
}

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

/** Approval type of a proposed Publish (GRE-2109, ADR GRE-1914 section 6). */
export const WEBSITE_PUBLISH_APPROVAL_TYPE = "website_publish";

/** One approved page or entry that a proposed Publish takes live. */
export interface WebsitePublishChange {
  kind: "page" | "entry";
  id: string;
  /** The approved revision at the time of the proposal. */
  revisionId: string;
  /** Page title, or `collection/entryKey` for an entry. */
  label: string;
}

/** Payload of a `website_publish` approval. The server builds it; callers cannot set it. */
export interface WebsitePublishApprovalPayload {
  siteId: string;
  siteName: string;
  /** Card title and body, from the copy (GRE-2107 section 8). */
  title: string;
  summary: string;
  changeCount: number;
  manifest: { pages: Array<{ pageId: string; revisionId: string }>; entries: Array<{ entryId: string; revisionId: string }> };
  changes: WebsitePublishChange[];
  /** Set when the approval started a Publish. */
  releaseId?: string;
}

/** The task click to change made for the website agent. */
export interface WebsiteChangeRequestResult {
  issueId: string;
  identifier: string | null;
  title: string;
  assigneeAgentId: string | null;
  projectId: string | null;
}

/**
 * An open comment on a page (GRE-2350): a change request task that is not done
 * or cancelled. `number` is its place among the page's open comments, oldest
 * first, as the editor shows it. `blockId` null means the whole page.
 */
export interface WebsitePageComment {
  number: number;
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  /** The person's words, as sent. */
  request: string;
  blockId: string | null;
  blockType: string | null;
  blockLabel: string | null;
  pageRevisionId: string | null;
  width: string | null;
  assigneeAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const WEBSITE_MODULE_API_ROUTES = {
  /** GET → `WebsiteSite[]` the caller can view. POST `CreateWebsiteSite` → 201 `WebsiteSite` (website:publish). */
  sites: "/companies/:companyId/website/sites",
  /** GET → `WebsiteAccess` for the caller (`?siteId=` for one site). Never 403: a missing right is `false`. */
  access: "/companies/:companyId/website/access",
  /** GET → `WebsiteTokenSecretOption[]`: the company's active secrets by name, to use as a site's Netlify token (website:publish, people only). */
  tokenSecrets: "/companies/:companyId/website/token-secrets",
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
  /** GET → the revision's content (`{ revision, content }`). */
  pageRevision: "/companies/:companyId/website/sites/:siteId/pages/:pageId/revisions/:revisionId",
  /** POST `RestoreWebsiteRevision` → `WebsiteSaveResult` (website:edit). A new revision with the old content. */
  pageRevisionRestore: "/companies/:companyId/website/sites/:siteId/pages/:pageId/revisions/:revisionId/restore",
  /** GET → `WebsitePageEditorLoad` (website:view; saves need website:edit). 404 until the site's editor frame origin is set and passes C1.1. */
  pageEditor: "/companies/:companyId/website/sites/:siteId/pages/:pageId/editor",
  /**
   * GET → `WebsitePageComment[]`, the page's open comments, oldest first (website:view).
   * POST `CreateWebsiteChangeRequest` → 201 `WebsiteChangeRequestResult` (website:edit). One task for the website agent; 200 with the same task on a repeated requestId.
   */
  pageChangeRequests: "/companies/:companyId/website/sites/:siteId/pages/:pageId/change-requests",
  /** GET → `WebsiteMediaItem[]`, the site's media entries. */
  media: "/companies/:companyId/website/sites/:siteId/media",
  /** POST → `WebsitePage` (website:edit). Draft to review: asks a person with Publish rights to approve it. */
  pageSubmit: "/companies/:companyId/website/sites/:siteId/pages/:pageId/submit",
  /** POST → `WebsitePage` (website:publish, people only). The latest revision becomes the approved one. */
  pageApprove: "/companies/:companyId/website/sites/:siteId/pages/:pageId/approve",
  /** POST `{ note }` → `WebsitePage` (website:publish, people only). Back to draft. */
  pageSendBack: "/companies/:companyId/website/sites/:siteId/pages/:pageId/send-back",
  /** GET → `WebsiteEntry[]` (`?collection=product`). POST `CreateWebsiteEntry` → 201 `WebsiteEntryDetail`. */
  entries: "/companies/:companyId/website/sites/:siteId/entries",
  /** POST → imported draft counts from the dated public snapshot. */
  entryImport: "/companies/:companyId/website/sites/:siteId/entries/import-public-drafts",
  /** GET → `WebsiteEntryDetail`. PATCH `UpdateWebsiteEntry` → `WebsiteEntry`. */
  entry: "/companies/:companyId/website/sites/:siteId/entries/:entryId",
  /** PUT `SaveWebsiteContent` → `WebsiteSaveResult`. */
  entryContent: "/companies/:companyId/website/sites/:siteId/entries/:entryId/content",
  /** POST → `WebsiteEntry`. */
  entryArchive: "/companies/:companyId/website/sites/:siteId/entries/:entryId/archive",
  /** GET → `WebsiteRevision[]`. */
  entryRevisions: "/companies/:companyId/website/sites/:siteId/entries/:entryId/revisions",
  /** GET → one historic entry's JSON fields, scoped to the entry's document. */
  entryRevision: "/companies/:companyId/website/sites/:siteId/entries/:entryId/revisions/:revisionId",
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
  /** POST → `WebsiteEntry` (website:edit). */
  entrySubmit: "/companies/:companyId/website/sites/:siteId/entries/:entryId/submit",
  /** POST → `WebsiteEntry` (website:publish, people only). */
  entryApprove: "/companies/:companyId/website/sites/:siteId/entries/:entryId/approve",
  /** POST `{ note }` → `WebsiteEntry` (website:publish, people only). */
  entrySendBack: "/companies/:companyId/website/sites/:siteId/entries/:entryId/send-back",
  /**
   * POST → 201 (new) or 200 (one is already open) `Approval` of type `website_publish` (website:edit).
   * Proposes a Publish of every approved change; a person with website:publish approves it.
   */
  publishProposals: "/companies/:companyId/website/sites/:siteId/publish-proposals",
  /** GET → `WebsiteHomeSummary` (website:view): the Home tab's counts, releases and last 8 events in one read. */
  home: "/companies/:companyId/website/sites/:siteId/home",
} as const;

/** A release as the Home shows it: who published it by name. */
export interface WebsiteHomeRelease {
  id: string;
  number: number;
  kind: WebsiteReleaseKind;
  status: WebsiteReleaseStatus;
  liveAt: string | null;
  createdAt: string;
  publishedByName: string | null;
}

/** One website event in the Home's recent activity. */
export interface WebsiteHomeActivity {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actorType: string;
  /** The agent's or person's name; null when the actor is gone. */
  actorName: string | null;
  /** The page title, entry key, release number or sitemap option the event is about. */
  subject: string | null;
  createdAt: string;
}

/** The Website Home at a glance (24 Oct 2026): one read instead of five lists. */
export interface WebsiteHomeSummary {
  /** Non-archived pages by status. */
  pages: Record<WebsitePageStatus, number>;
  sitemap: {
    approved: { id: string; name: string; approvedAt: string | null; changedSinceApproval: boolean } | null;
    /** Draft options waiting for a person to approve one. */
    awaitingReview: number;
  };
  releases: { latest: WebsiteHomeRelease | null; live: WebsiteHomeRelease | null };
  /** The open `website_publish` proposal, when an agent or editor has asked for a Publish. */
  publishApproval: { id: string; title: string; changeCount: number; createdAt: string } | null;
  /** Non-archived entries by collection (media excluded). */
  collections: Record<string, number>;
  activity: WebsiteHomeActivity[];
  /**
   * Whether the Live view's address (the mirror when set, else
   * `https://{domain}/`) lets GSAM show it in a frame, from its
   * X-Frame-Options and CSP frame-ancestors headers. `unknown` when unreachable.
   */
  liveFraming: "allowed" | "refused" | "unknown";
  /** The same check of the In development address; `unknown` when there is none. */
  devFraming: "allowed" | "refused" | "unknown";
}
