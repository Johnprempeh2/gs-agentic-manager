import { z } from "zod";

// The website admin bridge (GRE-2323): GSAM reads the site's customer records
// over a signed, read-only call to `<site>/api/admin/v1/*`.

export const WEBSITE_DATA_RESOURCES = [
  "customers", "quotes", "orders", "invoices", "licences", "portal-documents", "portal-acceptances", "enquiries",
] as const;
export type WebsiteDataResource = (typeof WEBSITE_DATA_RESOURCES)[number];

/**
 * The site's commerce records (GRE-2354 2c(a)), read on the same read key: lists and items like the records above.
 * `imports/:id` pages its rows with `?cursor=&limit=`. The FX rate and the payment report have routes of their own.
 */
export const WEBSITE_COMMERCE_RESOURCES = [
  "offerings", "categories", "vendors", "pricing-rules", "customer-tiers", "imports",
] as const;
export type WebsiteCommerceResource = (typeof WEBSITE_COMMERCE_RESOURCES)[number];

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
  /** GET → `{ item }` (website:view): the USD to GBP display rate, its row version and its last 50 changes. */
  commerceFx: "/companies/:companyId/website/sites/:siteId/commerce/fx",
  /** GET → `{ report: WebsitePaymentReport }` (website:view). `?from=&to=` dates. From the site's database; no Stripe call. */
  commercePayments: "/companies/:companyId/website/sites/:siteId/commerce/payments",
  /** GET → `{ items, nextCursor }` (website:view). `?updatedSince=&cursor=&limit=` */
  commerceList: "/companies/:companyId/website/sites/:siteId/commerce/:resource",
  /** GET → `{ item }` (website:view). `imports/:id` adds `rows` and `nextCursor`, paged with `?cursor=&limit=`. */
  commerceItem: "/companies/:companyId/website/sites/:siteId/commerce/:resource/:itemId",
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

/** Commerce lists have no customer filter. */
export const websiteCommerceListQuerySchema = websiteDataListQuerySchema.omit({ customer: true });
export type WebsiteCommerceListQuery = z.infer<typeof websiteCommerceListQuerySchema>;

/** Only `imports/:id` takes a query: the page of its rows. */
export const websiteCommerceItemQuerySchema = websiteDataListQuerySchema.pick({ cursor: true, limit: true });

const reportDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date, YYYY-MM-DD");
export const websitePaymentReportQuerySchema = z.object({ from: reportDate.optional(), to: reportDate.optional() }).strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "from must not be after to", path: ["from"] });
export type WebsitePaymentReportQuery = z.infer<typeof websitePaymentReportQuerySchema>;

/**
 * The payment report (GRE-2354 section 7), built from the site's own orders: never a Stripe id, never a key.
 * `stripeMode` comes from the prefix of the site's Stripe key. Other fields are the site's to add.
 */
export interface WebsitePaymentReport {
  from: string | null;
  to: string | null;
  stripeMode: "test" | "live" | "unset";
  [field: string]: unknown;
}
