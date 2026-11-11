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

/** greatstoneint.com's Netlify site: its record publishes to staging, and only Deploy reaches it. */
export const PUBLIC_NETLIFY_SITE_ID = "3b1e97e6-e184-4251-badd-deed532be3ab";

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

/** What `importHtml` did: paths by outcome. Every change is a draft; nothing is published. */
export interface WebsiteHtmlImportResult {
  /** Live paths that moved to their sitemap path, each with a draft 301 redirect. */
  redirects: Array<{ from: string; to: string }>;
  updated: string[];
  created: string[];
  unchanged: string[];
  chrome: string[];
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
  /** FAQ items the site engine writes as FAQPage JSON-LD (up to 50; q up to 500, a up to 4000 characters). */
  faq?: WebsitePageFaqItem[];
}

export interface WebsitePageFaqItem {
  q: string;
  a: string;
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

/**
 * The few fields a list needs to say what an entry is, read from its content. Never the whole content.
 * The names match the site's catalogue rows, so one set of screen helpers reads both.
 */
export interface WebsiteEntrySummary {
  name: string | null;
  slug: string | null;
  /** The entry's own one-line text: a product's short description, a person's role, a form's intro. */
  short_description: string | null;
  /** The start of the long description, cut short. */
  description: string | null;
  from_price_minor: number | null;
  from_price_currency: string | null;
  vendor: string | null;
  category: string | null;
  /** A product's editions, for search by SKU. */
  variants: { sku: string | null; name: string | null }[];
}

export interface WebsiteEntry extends WebsiteContentRow {
  /** Set on the entry list and the review list. Null when the content names nothing. */
  summary?: WebsiteEntrySummary | null;
  collection: string;
  entryKey: string;
  orgId: string | null;
  status: WebsiteEntryStatus;
  sortOrder: number | null;
}

/** The pages and entries waiting for a person with Publish rights (GRE-4078). */
export interface WebsiteReviewQueue {
  pages: WebsitePage[];
  entries: WebsiteEntry[];
}

/** One item the bulk approve did not approve, and why. */
export interface WebsiteReviewSkipped {
  kind: "page" | "entry";
  id: string;
  title: string;
  reason: string;
}

/** The answer to a bulk approve: what was approved, and what was left in review. */
export interface WebsiteReviewApproveResult {
  approvedPageIds: string[];
  approvedEntryIds: string[];
  skipped: WebsiteReviewSkipped[];
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
  /** The public site's content release is in staging's store (staging rebuilds it); only Deploy takes it live. */
  "staged",
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
  /** Version numbers, ids and script names for the website team, shown under "Details". */
  details?: string;
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
  /** Pages: the URL path, e.g. `/consultancy`. */
  path?: string;
  /** Pages: what changed against the version live now, in words (empty when unknown). */
  changeLines?: string[];
  /** Pages: the first added or edited section, so a link can land on it. */
  firstChangedBlockId?: string | null;
  /** Pages: the SEO title and description this Publish puts live. */
  seoTitle?: string | null;
  seoDescription?: string | null;
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

/** An image stored on a change request task (GRE-2527). */
export interface WebsiteChangeImage {
  attachmentId: string;
  issueId: string;
  contentType: string;
  byteSize: number;
  originalFilename: string | null;
  contentPath: string;
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

export interface WebsiteEnquiryLead {
  id: string;
  pipelineId: string;
  title: string;
  organisationId: string | null;
  contactEmail: string | null;
  source: string | null;
  page: string | null;
  submittedAt: string | null;
  createdAt: string;
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
  /** GET → website enquiry leads in GSAM, newest first (website:view). */
  enquiries: "/companies/:companyId/website/sites/:siteId/enquiries",
  /** POST → import counts from the read-only admin bridge (website:edit). */
  enquiriesCheck: "/companies/:companyId/website/sites/:siteId/enquiries/check",
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
  /** POST → `LiveDesignView`: open live design on the page (website:edit; plan revision 8). */
  pageLive: "/companies/:companyId/website/sites/:siteId/pages/:pageId/live",
  /** GET `?revision=` → HTML: the page with Impeccable's live tools, in the attachment sandbox (website:view). */
  pageLiveFrame: "/companies/:companyId/website/sites/:siteId/pages/:pageId/live-frame",
  /** POST `{ revisionId }` → `LiveDesignView`: bring an earlier version back as the newest one (website:edit). */
  pageLiveRestore: "/companies/:companyId/website/sites/:siteId/pages/:pageId/live-restore",
  /** GET `?revision=` → `{ page, chrome, stylesheet }`: the draft the site's /live-design route renders (website:view). */
  pageLiveDraft: "/companies/:companyId/website/sites/:siteId/pages/:pageId/live-draft",
  /** GET → `WebsiteDeployChanges`: commits on staging that the public site does not have yet, for the editor's deploy button (website:view). 503 when GitHub or Netlify cannot say. */
  siteDeployChanges: "/companies/:companyId/website/sites/:siteId/deploy-changes",
  /** GET → `WebsiteProductionStatus`: what staging serves, what is live, what Deploy would change, the checks and recent Deploys and Roll backs (website:view). */
  production: "/companies/:companyId/website/sites/:siteId/production",
  /** POST `{ stagingCommit, stagingRelease }` → 202 `{ request }`: John's Deploy of what staging serves to the public site (website:deploy, a signed-in person). */
  productionDeploy: "/companies/:companyId/website/sites/:siteId/production/deploy",
  /** POST `{ deployId }` → 202 `{ request }`: put the previous live deploy back (website:deploy, a signed-in person). */
  productionRollback: "/companies/:companyId/website/sites/:siteId/production/rollback",
  /** GET → text/css: the site stylesheet for schema 2 pages, for agents (website:view). */
  siteStylesheet: "/companies/:companyId/website/sites/:siteId/stylesheet",
  /** POST a schema 2 release file → `{ updated, created, unchanged, chrome }`: import the site's pages as HTML drafts (people, website:edit). */
  importHtml: "/companies/:companyId/website/sites/:siteId/import-html",
  /**
   * GET → `WebsitePageComment[]`, the page's open comments, oldest first (website:view).
   * POST `CreateWebsiteChangeRequest` → 201 `WebsiteChangeRequestResult` (website:edit). One task for the website agent; 200 with the same task on a repeated requestId.
   */
  pageChangeRequests: "/companies/:companyId/website/sites/:siteId/pages/:pageId/change-requests",
  /**
   * POST multipart `file` → 201 `WebsiteChangeImage` (website:edit). GRE-2527: an image the person
   * attached to that page's change request task. PNG, JPEG, WebP or GIF by its bytes, no SVG, at most 8 MB.
   */
  pageChangeRequestImages: "/companies/:companyId/website/sites/:siteId/pages/:pageId/change-requests/:issueId/images",
  /** GET → `WebsiteMediaItem[]`, the site's media entries. */
  media: "/companies/:companyId/website/sites/:siteId/media",
  /** GET → the file of one of the site's own media entries, released or not, by its site name `<sha256>.<ext>`; else 404 (website:view). The live design frame loads `/media/…` from here. */
  mediaFile: "/companies/:companyId/website/sites/:siteId/media/:file",
  /** POST → `WebsitePage` (website:edit). Draft to review: asks a person with Publish rights to approve it. */
  pageSubmit: "/companies/:companyId/website/sites/:siteId/pages/:pageId/submit",
  /** POST → `WebsitePage` (website:publish, people only). The latest revision becomes the approved one. */
  pageApprove: "/companies/:companyId/website/sites/:siteId/pages/:pageId/approve",
  /** POST `{ note }` → `WebsitePage` (website:publish, people only). Back to draft. */
  pageSendBack: "/companies/:companyId/website/sites/:siteId/pages/:pageId/send-back",
  /** GET → `WebsiteReviewQueue` (website:view): every page and entry in review. */
  review: "/companies/:companyId/website/sites/:siteId/review",
  /**
   * POST `ApproveWebsiteReview` → `WebsiteReviewApproveResult` (website:publish, people only).
   * Approves every page and entry in review, or the chosen ones; items not in review are left as they are.
   */
  reviewApprove: "/companies/:companyId/website/sites/:siteId/review/approve",
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
  /** GET → `WebsiteSiteStyle` (website:view): colours, fonts and building blocks from the site's stylesheet and release theme. */
  style: "/companies/:companyId/website/sites/:siteId/style",
  /**
   * GET → `WebsiteRedirect[]` (website:view). POST `WebsiteRedirectInput` → 201 `WebsiteRedirect` draft (website:edit);
   * 200 with the same redirect when one from that path to the same place is already there (GRE-4785).
   */
  redirects: "/companies/:companyId/website/sites/:siteId/redirects",
  /** PATCH `SaveWebsiteRedirect` → `WebsiteRedirect`, a new draft. DELETE → `{ entryId }`: it leaves the site at the next Publish (website:edit). */
  redirect: "/companies/:companyId/website/sites/:siteId/redirects/:entryId",
  /**
   * PATCH `RenameWebsiteMedia` → `WebsiteMediaItem`. DELETE → `{ entryId }`, or 409 `website_media_in_use` with
   * `details.usedBy`: it leaves the site at the next Publish, and the file stays in the company's files (website:edit).
   */
  mediaEntry: "/companies/:companyId/website/sites/:siteId/media/:entryId",
} as const;

/** The status codes the site's release schema takes for a redirect. 301 is the default. */
export const WEBSITE_REDIRECT_STATUSES = [301, 302, 307, 308] as const;
export type WebsiteRedirectStatus = (typeof WEBSITE_REDIRECT_STATUSES)[number];

/** One redirect on the site: a `redirect` collection entry, published with the site release (GRE-4785). */
export interface WebsiteRedirect {
  entryId: string;
  key: string;
  from: string;
  to: string;
  status: WebsiteRedirectStatus;
  state: WebsiteEntryStatus;
  latestRevisionId: string | null;
  updatedAt: string;
}

/** A page or entry whose draft, approved or live content uses a media file, so the media cannot be deleted. */
export interface WebsiteMediaUse {
  kind: "page" | "entry";
  id: string;
  title: string;
}

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

/** A GSAM issue as the Home links to it. */
export interface WebsiteHomeIssueLink {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
}

/** Where this week's website release train is (GRE-2641). `none`: no train this week. */
export type WebsiteTrainState = "none" | "cut" | "checking" | "waiting_for_approval" | "approved" | "rejected" | "live";

/** The weekly website release train (GRE-2641, 25 Oct 2026). */
export interface WebsiteHomeTrain {
  /** The newest issue the "Weekly website release train" routine made; null before the first run. */
  issue: WebsiteHomeIssueLink | null;
  /** The `web-rc-YYYY-MM-DD` tag named on that issue, once cut. */
  tag: string | null;
  state: WebsiteTrainState;
  /** The `weekly-release` card on that issue. */
  card: {
    id: string;
    status: string;
    /** The person who accepted or rejected it. */
    resolvedByName: string | null;
    resolvedAt: string | null;
  } | null;
  /** When the routine makes the next train. */
  nextRunAt: string | null;
}

/** The launch date of the new site and the gates in front of it (GRE-2641). */
export interface WebsiteHomeLaunch {
  /** `YYYY-MM-DD`; null when no date is set. */
  targetDate: string | null;
  /** `agreed` once John or Ben accepts the launch card. */
  agreement: "proposed" | "agreed";
  /** Whole days from today (London) to the target; negative once passed. */
  daysLeft: number | null;
  /** The issue that holds the launch card. */
  cardIssue: WebsiteHomeIssueLink | null;
  gates: { label: string; identifier: string; issue: WebsiteHomeIssueLink | null }[];
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
  /** Approved pages and entries: what the next Publish takes live. */
  approvedChanges: number;
  activity: WebsiteHomeActivity[];
  /**
   * Whether the Live view's address (the mirror when set, else
   * `https://{domain}/`) lets GSAM show it in a frame, from its
   * X-Frame-Options and CSP frame-ancestors headers. `unknown` when unreachable.
   */
  liveFraming: "allowed" | "refused" | "unknown";
  /** The same check of the In development address; `unknown` when there is none. */
  devFraming: "allowed" | "refused" | "unknown";
  train: WebsiteHomeTrain;
  launch: WebsiteHomeLaunch;
}

/** What the editor's deploy button would put live: staging's commits that are not on the public site. */
/** One run of the production workflow (deploy-production.yml): a Deploy or a Roll back. */
export interface WebsiteProductionRun {
  id: number;
  action: "deploy" | "rollback";
  /** GSAM's id for the request (the ticket id). */
  request: string;
  status: "queued" | "in_progress" | "completed";
  /** When completed: "success", "failure", "cancelled" and so on, as GitHub says. */
  conclusion: string | null;
  createdAt: string;
  url: string;
  /** The steps of the newest run, while it runs and once it ends. */
  steps?: { name: string; status: string; conclusion: string | null }[];
}

/** What the Deploy panel shows (John, 11 Nov 2026): Live, Staging, the difference and the checks. */
export interface WebsiteProductionStatus {
  staging: { commit: string | null; release: number | null };
  live: { commit: string | null; release: number | null; deployId: string | null; publishedAt: string | null };
  /** Commits on staging the public site does not have, newest first. */
  commits: { sha: string; title: string }[];
  /** Reasons Deploy must not run now, in plain words; empty when it may. */
  blockers: string[];
  /** The live deploy before the current one, which Roll back puts back. */
  rollback: { deployId: string; commit: string | null; publishedAt: string | null } | null;
  runs: WebsiteProductionRun[];
  /** True only for a signed-in person holding website:deploy. */
  canDeploy: boolean;
  /** GitHub has the production workflow on main. */
  workflowReady: boolean;
  /** The public half of GSAM's deploy signing key, for the GitHub environment variable (only for a person who can deploy). */
  publicKey: string | null;
  /** When GSAM could not read part of this, in plain words. */
  problems: string[];
}

export interface WebsiteDeployChanges {
  /** The commit the public site was last deployed from. */
  liveCommit: string;
  /** The commit staging serves: what Deploy promotes. */
  stagingCommit: string;
  /** The GSAM content release the public site's store points at (null: none yet). */
  liveContentRelease: number | null;
  /** The content release staging's store points at: what Deploy promotes with the commit. */
  stagingContentRelease: number | null;
  /** Newest first. */
  commits: { sha: string; title: string }[];
}
