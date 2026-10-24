import { api, ApiError, plainHttpErrorMessage } from "./client";
import {
  WEBSITE_NOT_ENTITLED_CODE,
  type CreateWebsiteSitemapOption,
  type UpdateWebsiteSitemapOption,
  type WebsiteSitemapApproveResult,
  type WebsiteSitemapOption,
  type CreateWebsiteProperty,
  type CreateWebsiteSite,
  type UpdateWebsiteProperty,
  type UpdateWebsiteSite,
  type WebsiteMediaItem,
  type WebsitePage,
  type WebsitePageDetail,
  type WebsitePageEditorLoad,
  type WebsiteRevision,
  type WebsiteSaveResult,
  type WebsiteEntry,
  type WebsiteEntryDetail,
  type CreateWebsiteEntry,
  type WebsiteRelease,
  type WebsiteReleaseActionPlan,
  type WebsiteSite,
  type WebsiteGoogleConnectStart,
  type WebsiteHub,
  type WebsiteOverview,
  type WebsiteProperty,
  type WebsiteReport,
} from "@greatstone/shared";

export type {
  WebsiteGoogleConnectStart,
  WebsiteHub,
  WebsiteHubPreviewLink,
  WebsiteHubSitemap,
  WebsiteHubWorkItem,
  WebsiteOverview,
  WebsitePageNotIndexed,
  WebsiteProperty,
  WebsitePullError,
  WebsiteReport,
} from "@greatstone/shared";

/** Website view client (GRE-1088): GA4 and Search Console reports, plus the website hub. */
export const websiteApi = {
  overview: (companyId: string) =>
    api.get<WebsiteOverview>(`/companies/${encodeURIComponent(companyId)}/website`),
  report: (companyId: string, propertyId: string) =>
    api.get<WebsiteReport>(
      `/companies/${encodeURIComponent(companyId)}/website/properties/${encodeURIComponent(propertyId)}/report`,
    ),
  /** Set up a website (owners and admins). The GA4 id and the project are optional. */
  create: (companyId: string, input: CreateWebsiteProperty) =>
    api.post<WebsiteProperty>(`/companies/${encodeURIComponent(companyId)}/website/properties`, input),
  update: (companyId: string, propertyId: string, patch: UpdateWebsiteProperty) =>
    api.patch<WebsiteProperty>(
      `/companies/${encodeURIComponent(companyId)}/website/properties/${encodeURIComponent(propertyId)}`,
      patch,
    ),
  /** The linked project's website work (website hub, 23 Oct 2026). */
  hub: (companyId: string, propertyId: string) =>
    api.get<WebsiteHub>(
      `/companies/${encodeURIComponent(companyId)}/website/properties/${encodeURIComponent(propertyId)}/hub`,
    ),
  connectGoogle: (companyId: string, propertyId: string, returnTo?: string) =>
    api.post<WebsiteGoogleConnectStart>(
      `/companies/${encodeURIComponent(companyId)}/website/properties/${encodeURIComponent(propertyId)}/google/connect`,
      returnTo ? { returnTo } : {},
    ),
};

const sitesPath = (companyId: string) => `/companies/${encodeURIComponent(companyId)}/website/sites`;
const sitePath = (companyId: string, siteId: string) => `${sitesPath(companyId)}/${encodeURIComponent(siteId)}`;
const entryPath = (companyId: string, siteId: string, entryId: string) =>
  `${sitePath(companyId, siteId)}/entries/${encodeURIComponent(entryId)}`;
const releasePath = (companyId: string, siteId: string, releaseId: string) =>
  `${sitePath(companyId, siteId)}/releases/${encodeURIComponent(releaseId)}`;

/** Website module client (GRE-2105): connected sites and their pages. */
export const websiteModuleApi = {
  sites: (companyId: string) => api.get<WebsiteSite[]>(sitesPath(companyId)),
  /** Connect a site (website:publish). The Netlify token goes to the company's secrets and is never returned. */
  createSite: (companyId: string, input: CreateWebsiteSite) => api.post<WebsiteSite>(sitesPath(companyId), input),
  updateSite: (companyId: string, siteId: string, patch: UpdateWebsiteSite) =>
    api.patch<WebsiteSite>(sitePath(companyId, siteId), patch),
  pages: (companyId: string, siteId: string) => api.get<WebsitePage[]>(`${sitePath(companyId, siteId)}/pages`),
  page: (companyId: string, siteId: string, pageId: string) => api.get<WebsitePageDetail>(pagePath(companyId, siteId, pageId)),
  /** Draft, theme, site and media for the editor frame's `load-draft`. */
  pageEditor: (companyId: string, siteId: string, pageId: string) =>
    api.get<WebsitePageEditorLoad>(`${pagePath(companyId, siteId, pageId)}/editor`, { cache: "no-store" }),
  /** A save; `conflict` (409) and `failed` (422) answers are returned, not thrown. */
  savePageContent: (
    companyId: string,
    siteId: string,
    pageId: string,
    body: { baseRevisionId: string; content: unknown; editorOrigin?: string; changeSummary?: string },
  ) => saveAnswer(api.put<WebsiteSaveResult>(`${pagePath(companyId, siteId, pageId)}/content`, body)),
  revisions: (companyId: string, siteId: string, pageId: string) =>
    api.get<WebsiteRevision[]>(`${pagePath(companyId, siteId, pageId)}/revisions`),
  revision: (companyId: string, siteId: string, pageId: string, revisionId: string) =>
    api.get<{ revision: WebsiteRevision; content: unknown }>(
      `${pagePath(companyId, siteId, pageId)}/revisions/${encodeURIComponent(revisionId)}`,
    ),
  restoreRevision: (companyId: string, siteId: string, pageId: string, revisionId: string, baseRevisionId: string) =>
    saveAnswer(
      api.post<WebsiteSaveResult>(
        `${pagePath(companyId, siteId, pageId)}/revisions/${encodeURIComponent(revisionId)}/restore`,
        { baseRevisionId },
      ),
    ),
  media: (companyId: string, siteId: string) => api.get<WebsiteMediaItem[]>(`${sitePath(companyId, siteId)}/media`),
  entries: (companyId: string, siteId: string, collection: string) =>
    api.get<WebsiteEntry[]>(`${sitePath(companyId, siteId)}/entries?collection=${encodeURIComponent(collection)}`),
  importPublicDrafts: (companyId: string, siteId: string) =>
    api.post<{ imported: number; skipped: number; capturedAt: string }>(`${sitePath(companyId, siteId)}/entries/import-public-drafts`, {}),
  entry: (companyId: string, siteId: string, entryId: string) =>
    api.get<WebsiteEntryDetail>(entryPath(companyId, siteId, entryId)),
  createEntry: (companyId: string, siteId: string, input: CreateWebsiteEntry) =>
    api.post<WebsiteEntryDetail>(`${sitePath(companyId, siteId)}/entries`, input),
  saveEntry: (companyId: string, siteId: string, entryId: string, input: { baseRevisionId: string; content: unknown }) =>
    api.put<WebsiteSaveResult>(`${entryPath(companyId, siteId, entryId)}/content`, input),
  updateEntry: (companyId: string, siteId: string, entryId: string, patch: { status?: "draft" | "review"; entryKey?: string; sortOrder?: number | null }) =>
    api.patch<WebsiteEntry>(entryPath(companyId, siteId, entryId), patch),
  submitEntry: (companyId: string, siteId: string, entryId: string) =>
    api.post<WebsiteEntry>(`${entryPath(companyId, siteId, entryId)}/submit`, {}),
  approveEntry: (companyId: string, siteId: string, entryId: string) =>
    api.post<WebsiteEntry>(`${entryPath(companyId, siteId, entryId)}/approve`, {}),
  archiveEntry: (companyId: string, siteId: string, entryId: string) =>
    api.post<WebsiteEntry>(`${entryPath(companyId, siteId, entryId)}/archive`, {}),
  entryRevisions: (companyId: string, siteId: string, entryId: string) =>
    api.get<WebsiteRevision[]>(`${entryPath(companyId, siteId, entryId)}/revisions`),
  entryRevision: (companyId: string, siteId: string, entryId: string, revisionId: string) =>
    api.get<{ revisionNumber: number; content: unknown }>(`${entryPath(companyId, siteId, entryId)}/revisions/${encodeURIComponent(revisionId)}`),
  /** Sitemap options (GRE-2111). */
  sitemapOptions: (companyId: string, siteId: string) =>
    api.get<WebsiteSitemapOption[]>(`${sitePath(companyId, siteId)}/sitemap/options`),
  createSitemapOption: (companyId: string, siteId: string, input: CreateWebsiteSitemapOption) =>
    api.post<WebsiteSitemapOption>(`${sitePath(companyId, siteId)}/sitemap/options`, input),
  updateSitemapOption: (companyId: string, siteId: string, optionId: string, patch: UpdateWebsiteSitemapOption) =>
    api.put<WebsiteSitemapOption>(`${sitePath(companyId, siteId)}/sitemap/options/${encodeURIComponent(optionId)}`, patch),
  approveSitemapOption: (companyId: string, siteId: string, optionId: string) =>
    api.post<WebsiteSitemapApproveResult>(`${sitePath(companyId, siteId)}/sitemap/options/${encodeURIComponent(optionId)}/approve`, {}),
  archiveSitemapOption: (companyId: string, siteId: string, optionId: string) =>
    api.post<WebsiteSitemapOption>(`${sitePath(companyId, siteId)}/sitemap/options/${encodeURIComponent(optionId)}/archive`, {}),
  /** The sitemap.xml preview, as text. */
  sitemapXml: async (companyId: string, siteId: string) => {
    const res = await fetch(`/api${sitePath(companyId, siteId)}/sitemap.xml`, { credentials: "include" });
    if (!res.ok) throw new ApiError(plainHttpErrorMessage(res.status), res.status, null);
    return res.text();
  },
  /** Releases of a site, newest first (GRE-2108). */
  releases: (companyId: string, siteId: string) => api.get<WebsiteRelease[]>(`${sitePath(companyId, siteId)}/releases`),
  release: (companyId: string, siteId: string, releaseId: string) =>
    api.get<WebsiteRelease>(releasePath(companyId, siteId, releaseId)),
  /** Start a Publish (a signed-in person's click only). 202, or 409 `website_publish_running` while one runs. */
  publish: (companyId: string, siteId: string) => api.post<WebsiteRelease>(`${sitePath(companyId, siteId)}/releases`, {}),
  /** What Retry on a Pending release will do, and whether it costs credits. */
  retryPlan: (companyId: string, siteId: string, releaseId: string) =>
    api.get<WebsiteReleaseActionPlan>(`${releasePath(companyId, siteId, releaseId)}/retry`),
  retry: (companyId: string, siteId: string, releaseId: string, confirmRebuild: boolean) =>
    api.post<WebsiteRelease>(`${releasePath(companyId, siteId, releaseId)}/retry`, confirmRebuild ? { confirmRebuild: true } : {}),
  /** What rolling back to a release will do, and whether it costs credits. */
  rollbackPlan: (companyId: string, siteId: string, releaseId: string) =>
    api.get<WebsiteReleaseActionPlan>(`${releasePath(companyId, siteId, releaseId)}/rollback`),
  rollback: (companyId: string, siteId: string, releaseId: string, confirmRebuild: boolean) =>
    api.post<WebsiteRelease>(`${releasePath(companyId, siteId, releaseId)}/rollback`, confirmRebuild ? { confirmRebuild: true } : {}),
};

const pagePath = (companyId: string, siteId: string, pageId: string) =>
  `${sitePath(companyId, siteId)}/pages/${encodeURIComponent(pageId)}`;

/** Conflict and failed saves come back as 409 and 422 with a `WebsiteSaveResult` body. */
async function saveAnswer(pending: Promise<WebsiteSaveResult>): Promise<WebsiteSaveResult> {
  try {
    return await pending;
  } catch (error) {
    const body = error instanceof ApiError ? (error.body as Partial<WebsiteSaveResult> | null) : null;
    if (body && (body.state === "conflict" || body.state === "failed")) return body as WebsiteSaveResult;
    throw error;
  }
}

/** The `code` of a website API refusal, for example `website_rebuild_needs_confirm`. */
export function websiteErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const code = (error.body as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/** True when the server refused because the Website switch is off (`403 not_entitled`). */
export function isWebsiteNotEntitled(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 403) return false;
  const body = error.body as { code?: unknown } | null;
  return body?.code === WEBSITE_NOT_ENTITLED_CODE;
}
