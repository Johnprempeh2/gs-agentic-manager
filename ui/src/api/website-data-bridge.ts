import { api } from "./client";
import type { CreateWebsiteDataBridgeKey, WebsiteDataBridgeKey, WebsiteDataBridgeStatus } from "@greatstone/shared";

// The website admin bridge (GRE-2323): the "Website data" row on Site connection.
const bridgePath = (companyId: string, siteId: string) =>
  `/companies/${encodeURIComponent(companyId)}/website/sites/${encodeURIComponent(siteId)}/data-bridge`;

export const websiteDataBridgeApi = {
  /** Whether GSAM can read the site's records now (website:view). Checked at most once a minute. */
  status: (companyId: string, siteId: string) => api.get<WebsiteDataBridgeStatus>(`${bridgePath(companyId, siteId)}/status`),
  /** A new read key (website:publish, people only). Returns the public key for the site's GSAM_BRIDGE_KEYS, never the private key. */
  createKey: (companyId: string, siteId: string, input: CreateWebsiteDataBridgeKey) =>
    api.post<WebsiteDataBridgeKey>(`${bridgePath(companyId, siteId)}/key`, input),
};
