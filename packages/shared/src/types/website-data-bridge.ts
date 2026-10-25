import { z } from "zod";

// The website admin bridge (GRE-2323): GSAM reads the site's customer records
// over a signed, read-only call to `<site>/api/admin/v1/*`.

export const WEBSITE_DATA_RESOURCES = [
  "customers", "quotes", "orders", "invoices", "licences", "portal-documents", "portal-acceptances", "enquiries",
] as const;
export type WebsiteDataResource = (typeof WEBSITE_DATA_RESOURCES)[number];

export const WEBSITE_DATA_BRIDGE_API_ROUTES = {
  /** GET → `WebsiteDataBridgeStatus` (website:view). Checks the site's health route, cached for 60 s. */
  status: "/companies/:companyId/website/sites/:siteId/data-bridge/status",
  /**
   * POST `CreateWebsiteDataBridgeKey` → 201 `WebsiteDataBridgeKey` (website:publish, people only). Makes a new read
   * key pair, keeps the private key in the vault and returns the public key for the site's GSAM_BRIDGE_KEYS.
   */
  key: "/companies/:companyId/website/sites/:siteId/data-bridge/key",
  /** GET → `{ items, nextCursor }` (website:view). `?customer=&updatedSince=&cursor=&limit=` */
  list: "/companies/:companyId/website/sites/:siteId/data/:resource",
  /** GET → `{ item }` (website:view). */
  item: "/companies/:companyId/website/sites/:siteId/data/:resource/:itemId",
} as const;

export type WebsiteDataBridgeState = "not_set_up" | "connected" | "failing";

export interface WebsiteDataBridgeStatus {
  state: WebsiteDataBridgeState;
  /** The read key's id, as it must appear in the site's GSAM_BRIDGE_KEYS. Never the key. */
  keyId: string | null;
  url: string;
  checkedAt: string | null;
  message: string | null;
  /** The site's clock minus GSAM's, when the site answered. */
  clockSkewSeconds: number | null;
}

export const createWebsiteDataBridgeKeySchema = z.object({
  /** `stg` for the staging site, `live` for the live site: the two never share a key. */
  environment: z.enum(["stg", "live"]),
  /** The bridge address, when it is not `https://<domain>`. Null goes back to the domain. */
  url: z.string().url().refine((u) => u.startsWith("https://"), "must be an https:// address").nullable().optional(),
}).strict();
export type CreateWebsiteDataBridgeKey = z.infer<typeof createWebsiteDataBridgeKeySchema>;

export interface WebsiteDataBridgeKey {
  keyId: string;
  capability: "read";
  /** Raw Ed25519 public key, base64url. Safe to share: it cannot sign. */
  publicKey: string;
  /** The entry to add to the site's GSAM_BRIDGE_KEYS list. */
  keysEntry: { kid: string; capability: "read"; publicKey: string };
}

export const websiteDataListQuerySchema = z.object({
  customer: z.string().uuid().optional(),
  updatedSince: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();
export type WebsiteDataListQuery = z.infer<typeof websiteDataListQuerySchema>;
