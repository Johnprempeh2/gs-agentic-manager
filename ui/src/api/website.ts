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
  type WebsitePage,
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
