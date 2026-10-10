import { api, ApiError } from "./client";
import {
  WEBSITE_NOT_ENTITLED_CODE,
  type WebsiteGoogleConnectStart,
  type WebsiteOverview,
  type WebsiteReport,
} from "@greatstone/shared";

export type {
  WebsiteGoogleConnectStart,
  WebsiteOverview,
  WebsitePageNotIndexed,
  WebsiteProperty,
  WebsitePullError,
  WebsiteReport,
} from "@greatstone/shared";

/** Website view client (GRE-1088): read-only GA4 and Search Console reports. */
export const websiteApi = {
  overview: (companyId: string) =>
    api.get<WebsiteOverview>(`/companies/${encodeURIComponent(companyId)}/website`),
  report: (companyId: string, propertyId: string) =>
    api.get<WebsiteReport>(
      `/companies/${encodeURIComponent(companyId)}/website/properties/${encodeURIComponent(propertyId)}/report`,
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
