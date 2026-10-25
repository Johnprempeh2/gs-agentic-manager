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
  /** `read` (the default) for GSAM's reads; `write` for the Deep Dive sync (GRE-2439). Each has its own key. */
  capability: z.enum(["read", "write"]).optional(),
  /** The bridge address, when it is not `https://<domain>`. Null goes back to the domain. */
  url: z.string().url().refine((u) => u.startsWith("https://"), "must be an https:// address").nullable().optional(),
}).strict();
export type CreateWebsiteDataBridgeKey = z.infer<typeof createWebsiteDataBridgeKeySchema>;

export type WebsiteDataBridgeCapability = "read" | "write";

export interface WebsiteDataBridgeKey {
  keyId: string;
  capability: WebsiteDataBridgeCapability;
  /** Raw Ed25519 public key, base64url. Safe to share: it cannot sign. */
  publicKey: string;
  /** The entry to add to the site's GSAM_BRIDGE_KEYS list. */
  keysEntry: { kid: string; capability: WebsiteDataBridgeCapability; publicKey: string };
}

export const websiteDataListQuerySchema = z.object({
  customer: z.string().uuid().optional(),
  updatedSince: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();
export type WebsiteDataListQuery = z.infer<typeof websiteDataListQuerySchema>;

// ---- Deep Dive sync (GRE-2439) ----
// GSAM pushes one client's Shared Deep Dive items, Shared files, open document requests and published
// deliverables to the site, signed with the site's `write` key. The site calls back, signed with its own key,
// when the client answers a document request. The tenant is the GSAM client (pipeline case) id.

export const DEEP_DIVE_SYNC_SCHEMA = "gs-deep-dive-sync-v1";

export const DEEP_DIVE_SYNC_API_ROUTES = {
  /** GET → `DeepDiveSyncPayload` (website:view). Exactly what a sync would send, without sending it. */
  preview: "/companies/:companyId/website/sites/:siteId/deep-dive-sync/:clientCaseId/preview",
  /** POST → `DeepDiveSyncResult` (website:publish, people only). PUTs the payload to the site. */
  sync: "/companies/:companyId/website/sites/:siteId/deep-dive-sync/:clientCaseId",
  /** PUT `SetWebsiteBridgeSiteKey` → `WebsiteBridgeSiteKey` (website:publish, people only). */
  siteKey: "/companies/:companyId/website/sites/:siteId/data-bridge/site-key",
} as const;

/** The site's call back to GSAM. Signed by the site (gs-bridge-v1), no GSAM sign-in. */
export const WEBSITE_BRIDGE_INBOUND_ROUTES = {
  /** POST `WebsiteDocumentRequestAnswer` → `{ ok, requestId, receivedAt }`. */
  answerDocumentRequest: "/website-bridge/v1/tenants/:tenantId/document-requests/:requestId/answer",
} as const;

/** The site's own path for the push: a full snapshot of one tenant, so a PUT replaces it. */
export const deepDiveSyncSitePath = (tenantId: string) => `/api/admin/v1/deep-dive/tenants/${encodeURIComponent(tenantId)}`;

export interface DeepDiveSyncItem {
  id: string;
  /** `deep_dive`, `deep_dive_stream` or `agent_team_blueprint`. */
  type: string;
  key: string | null;
  title: string;
  summary: string | null;
  status: string;
  fields: Record<string, unknown>;
  /** The parent item, only when the parent is also Shared; otherwise null. */
  parentId: string | null;
  updatedAt: string;
}

export interface DeepDiveSyncFile {
  id: string;
  itemId: string;
  title: string;
  kind: string | null;
  status: "held" | "missing";
  heldAt: string | null;
}

export interface DeepDiveSyncDocumentRequest {
  id: string;
  title: string;
  note: string | null;
  /** The Shared items it is linked to. */
  itemIds: string[];
  status: "open" | "received";
  receivedAt: string | null;
  createdAt: string;
}

export interface DeepDiveSyncDeliverable {
  id: string;
  title: string;
  version: number | null;
  status: "published" | "accepted";
  publishedAt: string;
  acceptedAt: string | null;
}

export interface DeepDiveSyncPayload {
  schema: typeof DEEP_DIVE_SYNC_SCHEMA;
  tenantId: string;
  tenantName: string;
  generatedAt: string;
  items: DeepDiveSyncItem[];
  files: DeepDiveSyncFile[];
  documentRequests: DeepDiveSyncDocumentRequest[];
  deliverables: DeepDiveSyncDeliverable[];
}

export interface DeepDiveSyncResult {
  tenantId: string;
  syncedAt: string;
  counts: { items: number; files: number; documentRequests: number; deliverables: number };
}

const bridgeKidSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/, "3 to 64 lower-case letters, digits or dashes");

export const setWebsiteBridgeSiteKeySchema = z.object({
  keyId: bridgeKidSchema,
  /** Raw 32-byte Ed25519 public key, base64url (43 characters). */
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "a raw Ed25519 public key in base64url"),
}).strict();
export type SetWebsiteBridgeSiteKey = z.infer<typeof setWebsiteBridgeSiteKeySchema>;

export interface WebsiteBridgeSiteKey {
  keyId: string;
  publicKey: string;
}

export const websiteDocumentRequestAnswerSchema = z.object({
  /** The site's own id for this answer; the same id again is the same answer. */
  answerId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  answeredBy: z.object({
    customerId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    name: z.string().trim().max(200).nullable().optional(),
    email: z.string().trim().max(320).nullable().optional(),
  }).strict(),
  note: z.string().max(2000).nullable().optional(),
  fileName: z.string().max(255).nullable().optional(),
}).strict();
export type WebsiteDocumentRequestAnswer = z.infer<typeof websiteDocumentRequestAnswerSchema>;
