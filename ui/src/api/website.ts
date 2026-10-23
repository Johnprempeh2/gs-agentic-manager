import { api, ApiError } from "./client";
import {
  WEBSITE_NOT_ENTITLED_CODE,
  type CreateWebsiteProperty,
  type UpdateWebsiteProperty,
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

/** True when the server refused because the Website switch is off (`403 not_entitled`). */
export function isWebsiteNotEntitled(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 403) return false;
  const body = error.body as { code?: unknown } | null;
  return body?.code === WEBSITE_NOT_ENTITLED_CODE;
}
