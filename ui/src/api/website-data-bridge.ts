import { api } from "./client";
import type {
  CreateWebsiteDataBridgeKey,
  WebsiteDataBridgeKey,
  WebsiteDataBridgeStatus,
  WebsiteDataListQuery,
  WebsiteDataResource,
} from "@greatstone/shared";

// The website admin bridge (GRE-2323): the "Website data" row on Site connection.
const sitePath = (companyId: string, siteId: string) =>
  `/companies/${encodeURIComponent(companyId)}/website/sites/${encodeURIComponent(siteId)}`;
const bridgePath = (companyId: string, siteId: string) => `${sitePath(companyId, siteId)}/data-bridge`;
const dataPath = (companyId: string, siteId: string, resource: WebsiteDataResource) =>
  `${sitePath(companyId, siteId)}/data/${encodeURIComponent(resource)}`;

/** A row as the site returns it, under the site's own column names. */
export type WebsiteDataRecord = Record<string, unknown>;

export const websiteDataBridgeApi = {
  /** Whether GSAM can read the site's records now (website:view). Checked at most once a minute. */
  status: (companyId: string, siteId: string) => api.get<WebsiteDataBridgeStatus>(`${bridgePath(companyId, siteId)}/status`),
  /** A new read key (website:publish, people only). Returns the public key for the site's GSAM_BRIDGE_KEYS, never the private key. */
  createKey: (companyId: string, siteId: string, input: CreateWebsiteDataBridgeKey) =>
    api.post<WebsiteDataBridgeKey>(`${bridgePath(companyId, siteId)}/key`, input),
  /** One page of the site's records, read with the read key (website:view). Read only: the bridge has no write here. */
  list: (companyId: string, siteId: string, resource: WebsiteDataResource, query: WebsiteDataListQuery = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value));
    const search = params.toString();
    return api.get<{ items: WebsiteDataRecord[]; nextCursor: string | null }>(`${dataPath(companyId, siteId, resource)}${search ? `?${search}` : ""}`);
  },
  /** One record (website:view). */
  get: (companyId: string, siteId: string, resource: WebsiteDataResource, itemId: string) =>
    api.get<{ item: WebsiteDataRecord }>(`${dataPath(companyId, siteId, resource)}/${encodeURIComponent(itemId)}`),
};
