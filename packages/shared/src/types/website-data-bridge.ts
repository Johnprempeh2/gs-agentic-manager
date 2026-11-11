import { z } from "zod";

// The website admin bridge (GRE-2323): GSAM reads the site's customer records
// over a signed, read-only call to `<site>/api/admin/v1/*`.

export const WEBSITE_DATA_RESOURCES = [
  "customers", "quotes", "orders", "invoices", "licences", "portal-documents", "portal-acceptances", "enquiries", "billing-lines",
  // the client timeline (GRE-4782): live items only, `?customer=` for one client
  "engagements",
  // a client admin's request for a new seat (admin parity round 2): `?customer=` for one client
  "invite-requests",
] as const;
export type WebsiteDataResource = (typeof WEBSITE_DATA_RESOURCES)[number];

/**
 * The site's commerce records (GRE-2354 2c(a)), read on the same read key: lists and items like the records above.
 * `imports/:id` pages its rows with `?cursor=&limit=`. The FX rate and the payment report have routes of their own.
 */
export const WEBSITE_COMMERCE_RESOURCES = [
  "offerings", "categories", "vendors", "pricing-rules", "customer-tiers", "imports", "billing-lines",
] as const;
export type WebsiteCommerceResource = (typeof WEBSITE_COMMERCE_RESOURCES)[number];

/** A billing line returned by the website's admin bridge (minor units are decimal strings). */
export interface WebsiteBillingLine {
  id: string;
  customer_id: string;
  description: string;
  qty: number;
  unit_price_minor: string;
  currency: string;
  billing_period: "monthly" | "quarterly" | "annual" | "multi_year";
  next_bill_on: string | null;
  status: "active" | "paused" | "ended";
}

export const WEBSITE_DATA_BRIDGE_API_ROUTES = {
  /** GET → `WebsiteDataBridgeStatus` (website:view). Checks the site's health route, cached for 60 s. */
  status: "/companies/:companyId/website/sites/:siteId/data-bridge/status",
  /** GET → signed bridge health, including siteContract: 1 (website:view). */
  health: "/companies/:companyId/website/sites/:siteId/data-bridge/health",
  /** GET → signed, bounded activity page. Requires decimal cursor and limit 1–100 (website:view). */
  activityEvents: "/companies/:companyId/website/sites/:siteId/data-bridge/activity-events",
  /** GET → table existence booleans only; no customer rows (website:view). */
  schemaProbe: "/companies/:companyId/website/sites/:siteId/data-bridge/schema",
  /**
   * POST `CreateWebsiteDataBridgeKey` → 201 `WebsiteDataBridgeKey` (website:publish, people only). Makes a new read
   * key pair, keeps the private key in the vault and returns the public key for the site's GSAM_BRIDGE_KEYS.
   */
  key: "/companies/:companyId/website/sites/:siteId/data-bridge/key",
  /** GET → `{ items, nextCursor }` (website:view). `?customer=&updatedSince=&cursor=&limit=` */
  list: "/companies/:companyId/website/sites/:siteId/data/:resource",
  /** GET → `{ item }` (website:view). */
  item: "/companies/:companyId/website/sites/:siteId/data/:resource/:itemId",
  /**
   * GET → the file itself, as a download (website:view; admin parity round 2): `quotes/:id/po-document` and
   * `orders/:id/po-document` (the buyer's uploaded PO), `enquiries/fd-:uuid/agent-package` (a front door lead's agent
   * package .zip). GSAM fetches it over the signed bridge and streams it to the signed-in caller; there is no public link.
   */
  file: "/companies/:companyId/website/sites/:siteId/data/:resource/:itemId/:file",
  /** GET → `{ item }` (website:view): the USD to GBP display rate, its row version and its last 50 changes. */
  commerceFx: "/companies/:companyId/website/sites/:siteId/commerce/fx",
  /** GET → `{ report: WebsitePaymentReport }` (website:view). `?from=&to=` dates. From the site's database; no Stripe call. */
  commercePayments: "/companies/:companyId/website/sites/:siteId/commerce/payments",
  /**
   * POST → 201 `{ approval, request }` (website:commerce; agents may). `WebsiteCommerceRefundRequestInput`. Records a
   * refund request on the site with the refund_request key and opens a `commerce_refund_request` approval. Moves no
   * money. 409 `capability_not_configured` when the site has no refund key.
   */
  commerceRefundRequests: "/companies/:companyId/website/sites/:siteId/commerce/refund-requests",
  /**
   * POST `WebsiteCommercePublishRequestInput` → 201 `{ approval }` (website:commerce; agents may; GRE-4089). Asks a
   * person to publish or archive one catalogue record: opens a `commerce_publish_request` approval with the record as
   * it is now. Publishes nothing. A person's approval publishes it in their name; a change to the record first voids it.
   */
  commercePublishRequests: "/companies/:companyId/website/sites/:siteId/commerce/publish-requests",
  /**
   * POST `WebsiteCommerceChangeRequestInput` → 201 `{ approval }` (website:commerce; agents may; GRE-4783). Asks a
   * person to make one commerce settings change (`websiteCommerceSettingsOperation`): opens a `commerce_change_request`
   * approval and changes nothing. A person's approval makes the change in their name. A licence key or download link
   * in the body goes to the vault, never onto the card.
   */
  commerceChangeRequests: "/companies/:companyId/website/sites/:siteId/commerce/change-requests",
  /**
   * PUT `WebsiteVendorActivationStepsInput` → `{ item: WebsiteVendorActivationSteps }` (website:commerce; GRE-3982).
   * Sets or clears the licence activation steps a vendor's licences show, on the write key. The site refuses an agent
   * on a published vendor (403 website_bridge_denied) and any text with a full licence key (400
   * website_bridge_licence_key_in_text). Registered before `commerceWrite`.
   */
  commerceActivationSteps: "/companies/:companyId/website/sites/:siteId/commerce/vendors/:vendorId/activation-steps",
  /**
   * POST, PATCH or DELETE → the site's `{ item }` (website:commerce): one typed write, `*path` as in
   * `websiteCommerceWriteOperation`. Registered after `commerceRefundRequests`.
   */
  commerceWrite: "/companies/:companyId/website/sites/:siteId/commerce/*path",
  /** GET → `{ items, nextCursor }` (website:view). `?updatedSince=&cursor=&limit=` */
  commerceList: "/companies/:companyId/website/sites/:siteId/commerce/:resource",
  /** GET → `{ item }` (website:view). `imports/:id` adds `rows` and `nextCursor`, paged with `?cursor=&limit=`. */
  commerceItem: "/companies/:companyId/website/sites/:siteId/commerce/:resource/:itemId",
} as const;

/**
 * Commerce writes (GRE-2354 2c(b)): POST, PATCH or DELETE on `/companies/:companyId/website/sites/:siteId/commerce/<path>`,
 * where `<path>` is one of the operations below (as on the site's `/api/admin/v1/<path>`). website:commerce. The body
 * is the site's: it checks every field. An optional `Idempotency-Key` header (22 base64url characters) makes a
 * repeated call write once. 409 `capability_not_configured` when the site has no write key, with no call to the site.
 */
export const WEBSITE_COMMERCE_CATALOGUE_RESOURCES = ["vendors", "categories", "offerings", "pricing-rules"] as const;
export type WebsiteCommerceCatalogueResource = (typeof WEBSITE_COMMERCE_CATALOGUE_RESOURCES)[number];

export type WebsiteCommerceWriteMethod = "POST" | "PATCH" | "DELETE";

export interface WebsiteCommerceWriteOperation {
  /** e.g. `offerings.create`, `offerings.variants.edit`, `invoices.issue`. */
  name: string;
  /** Only a person may call it: GSAM refuses an agent with 403 before any call to the site, and the site refuses again. */
  peopleOnly: boolean;
}

const CATALOGUE_CHILDREN: Record<string, { sub: string; edit: boolean }[]> = {
  offerings: [{ sub: "variants", edit: true }, { sub: "specs", edit: false }, { sub: "media", edit: false }],
  "pricing-rules": [{ sub: "targets", edit: false }],
};
const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An enquiry as the reads name it: `si-<uuid>` (service enquiry) or `fd-<uuid>` (front door lead). */
const ENQUIRY_ID = /^(?:si|fd)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The commerce settings (GRE-4782 contract, "Commerce settings"): the records beside the catalogue. */
export const WEBSITE_COMMERCE_SETTINGS_RESOURCES = [
  "orders", "enquiries", "customers", "engagements", "licences", "customer-tiers", "portal-acceptances", "invite-requests",
] as const;

/** The files the bridge streams (admin parity round 2): which record kinds have which file. */
export const WEBSITE_DATA_FILES = { "po-document": ["quotes", "orders"], "agent-package": ["enquiries"] } as const;
export type WebsiteDataFile = keyof typeof WEBSITE_DATA_FILES;
export function isWebsiteDataFile(resource: string, file: string): file is WebsiteDataFile {
  return Object.prototype.hasOwnProperty.call(WEBSITE_DATA_FILES, file)
    && (WEBSITE_DATA_FILES[file as WebsiteDataFile] as readonly string[]).includes(resource);
}
/** Body fields that hold a licence key or its download link: they go to the vault, never onto a card or a log. */
export const WEBSITE_LICENCE_SECRET_FIELDS = ["licenceKey", "downloadUrl"] as const;

/**
 * The typed commerce write for a method and path parts (after `/commerce/`), or null: GSAM sends only these, the same
 * table as the site's `writeRoute` and `settingsRoute` (greatstone-website, lib/admin-bridge-write.mjs). Ids must be
 * uuids, but an enquiry's (`si-` or `fd-` and a uuid). `body` decides the settings that are people only by field:
 * a client's `tierId` (it sets their prices) and a licence's `licenceKey` or `downloadUrl`. Editing or deleting a
 * timeline item that is shared is people only too, but only the site knows it is shared: it answers 403 denied.
 */
export function websiteCommerceWriteOperation(method: string, parts: readonly string[],
  body?: Record<string, unknown>): WebsiteCommerceWriteOperation | null {
  const [res, id, sub, childId, extra] = parts;
  if (extra !== undefined || !res) return null;
  const op = (name: string, peopleOnly = false) => ({ name, peopleOnly });
  if (res === "enquiries") {
    if (id === undefined || sub !== undefined || !ENQUIRY_ID.test(id)) return null;
    if (method === "PATCH") return op("enquiries.edit");
    // only a front door lead is deleted (personal data, for good); a service enquiry is not
    return method === "DELETE" && id.toLowerCase().startsWith("fd-") ? op("enquiries.delete", true) : null;
  }
  if (id !== undefined && !ROW_ID.test(id)) return null;
  if (childId !== undefined && !ROW_ID.test(childId)) return null;
  if ((WEBSITE_COMMERCE_CATALOGUE_RESOURCES as readonly string[]).includes(res)) {
    if (id === undefined) return method === "POST" ? op(`${res}.create`) : null;
    if (sub === undefined) return method === "PATCH" ? op(`${res}.edit`) : method === "DELETE" ? op(`${res}.delete`) : null;
    if ((sub === "publish" || sub === "archive") && childId === undefined) return method === "POST" ? op(`${res}.${sub}`, true) : null;
    const child = CATALOGUE_CHILDREN[res]?.find((c) => c.sub === sub);
    if (!child) return null;
    if (childId === undefined) return method === "POST" ? op(`${res}.${sub}.create`) : null;
    if (method === "PATCH" && child.edit) return op(`${res}.${sub}.edit`);
    return method === "DELETE" ? op(`${res}.${sub}.delete`) : null;
  }
  if (sub !== undefined && childId !== undefined) return null;
  if (res === "fx") return id === undefined && method === "PATCH" ? op("fx.edit", true) : null;
  if (res === "imports") {
    if (id === undefined) return method === "POST" ? op("imports.dry_run") : null;
    return sub === "apply" && method === "POST" ? op("imports.apply", true) : null;
  }
  if (res === "quotes" && id !== undefined) {
    if (sub === undefined) return method === "PATCH" ? op("quotes.edit") : null;
    return sub === "convert" && method === "POST" ? op("quotes.convert") : null;
  }
  if (res === "invoices" && id !== undefined) {
    if (sub === undefined) return method === "PATCH" ? op("invoices.edit") : null;
    return sub === "issue" && method === "POST" ? op("invoices.issue", true) : null;
  }
  // ---- commerce settings (GRE-4782): people only where it emails a client, sets prices or touches a licence key ----
  const has = (field: string) => body !== undefined && Object.prototype.hasOwnProperty.call(body, field);
  if (res === "orders" && id !== undefined) {
    if (sub === undefined) return method === "PATCH" ? op("orders.edit") : null;
    return sub === "notify-licence" && method === "POST" ? op("orders.notify_licence", true) : null;
  }
  if (res === "customers") {
    if (id === undefined) return method === "POST" ? op("customers.create", has("tierId")) : null;
    if (sub === undefined) return method === "PATCH" ? op("customers.edit", has("tierId")) : null;
    if (method !== "POST") return null;
    return sub === "engagements" ? op("engagements.create") : sub === "licences" ? op("licences.issue", true) : null;
  }
  if (res === "engagements" && id !== undefined) {
    if (sub === undefined) return method === "PATCH" ? op("engagements.edit") : method === "DELETE" ? op("engagements.delete") : null;
    return (sub === "share" || sub === "unshare") && method === "POST" ? op(`engagements.${sub}`, true) : null;
  }
  if (res === "licences" && id !== undefined) {
    if (sub === undefined) {
      return method === "PATCH" ? op("licences.edit", WEBSITE_LICENCE_SECRET_FIELDS.some(has)) : null;
    }
    return (sub === "revoke" || sub === "reissue") && method === "POST" ? op(`licences.${sub}`, true) : null;
  }
  if (res === "customer-tiers") {
    if (id === undefined) return method === "POST" ? op("customer-tiers.create") : null;
    return sub === undefined && method === "PATCH" ? op("customer-tiers.edit") : null;
  }
  if (res === "portal-acceptances" && id !== undefined) {
    return sub === "resend" && method === "POST" ? op("portal-acceptances.resend", true) : null;
  }
  // a client's seat request: approve adds the person to the client's portal, so a person decides it
  if (res === "invite-requests" && id !== undefined) {
    return sub === "decision" && method === "POST" ? op("invite-requests.decide", true) : null;
  }
  return null;
}

/** A commerce settings change (GRE-4782 table), or null: the only changes a `commerce_change_request` card may carry. */
export function websiteCommerceSettingsOperation(method: string, parts: readonly string[], body?: Record<string, unknown>) {
  if (!(WEBSITE_COMMERCE_SETTINGS_RESOURCES as readonly string[]).includes(parts[0] ?? "")) return null;
  return websiteCommerceWriteOperation(method, parts, body);
}

/**
 * An ask for one commerce settings change (GRE-4783; John, 5 Nov: anything that emails a client, changes money, or
 * issues or revokes a licence key goes through a person's approval card). `path` is after `/commerce/`, as for a
 * direct write; `body` is the site's. `issueId` links the card to the asker's task.
 */
export const websiteCommerceChangeRequestSchema = z.object({
  method: z.enum(["POST", "PATCH", "DELETE"]),
  path: z.string().min(1).max(200).regex(/^[A-Za-z0-9-]+(?:\/[A-Za-z0-9-]+){0,3}$/, "segments of letters, digits and dashes"),
  body: z.record(z.string(), z.unknown()).optional(),
  note: z.string().trim().min(1).max(2000).optional(),
  issueId: z.string().uuid().optional(),
}).strict();
export type WebsiteCommerceChangeRequestInput = z.infer<typeof websiteCommerceChangeRequestSchema>;

export const COMMERCE_CHANGE_REQUEST_APPROVAL_TYPE = "commerce_change_request";

/** The card a person decides. The server builds it; callers cannot set it. */
export interface CommerceChangeRequestApprovalPayload {
  siteId: string;
  siteName: string;
  title: string;
  summary: string;
  /** e.g. `licences.issue`, `orders.notify_licence`. */
  operation: string;
  method: WebsiteCommerceWriteMethod;
  path: string;
  /** The body as asked, without a licence key or download link: those are in the vault (`vaultRef`). */
  body: Record<string, unknown> | null;
  /** The fields kept in the vault, and the last four characters of a licence key, for the person to check. */
  vaultedFields: string[];
  licenceKeyLast4: string | null;
  vaultRef: string | null;
  /** The same open ask (same change) returns this card. */
  changeKey: string;
  requestedBy: string;
  note: string | null;
  /** Set when GSAM first sent the change: a retry replays the same site key. */
  sentAt?: string;
  /** The site's answer once made. */
  result?: Record<string, unknown>;
}

export const websiteCommerceRefundRequestSchema = z.object({
  orderId: z.string().uuid(),
  /** In the order's currency, minor units. */
  amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  reason: z.string().trim().min(1).max(2000),
}).strict();
export type WebsiteCommerceRefundRequestInput = z.infer<typeof websiteCommerceRefundRequestSchema>;

/** The longest activation steps the site takes (GRE-3981 contract). */
export const WEBSITE_ACTIVATION_STEPS_MAX = 20_000;

/**
 * Licence activation steps for one vendor (GRE-3981 contract): the text, or null to clear it, and the vendor's
 * `rowVersion` as last read. The text must never hold a licence key; the site checks and refuses it.
 */
export const websiteVendorActivationStepsSchema = z.object({
  activationSteps: z.string().trim().min(1).max(WEBSITE_ACTIVATION_STEPS_MAX).nullable(),
  expectedRowVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type WebsiteVendorActivationStepsInput = z.infer<typeof websiteVendorActivationStepsSchema>;

/** The site's answer. No licence key and no last 4: the steps are per vendor, not per licence. */
export interface WebsiteVendorActivationSteps {
  vendorId: string;
  vendorName: string;
  status: string;
  activationSteps: string | null;
  rowVersion: number;
  updatedAt: string;
  /** Live licences the steps show beside, matched as the site's account page matches them. */
  licencesInRange: number;
}

export const COMMERCE_REFUND_REQUEST_APPROVAL_TYPE = "commerce_refund_request";

/** The card a person decides. The server builds it; callers cannot set it. */
export interface CommerceRefundRequestApprovalPayload {
  siteId: string;
  siteName: string;
  title: string;
  summary: string;
  orderId: string;
  amountMinor: number;
  /** From the site's request row, when it said. */
  currency: string | null;
  reason: string;
  requestedBy: string;
  /** The site's refund_requests id. Null only while GSAM has not heard back from the site. */
  requestId: string | null;
  /** The site's status of the request as GSAM last saw it: requested, approved, rejected, done, cancelled. */
  requestStatus: string | null;
  /** The caller's Idempotency-Key, when it sent one: the same key returns this card. */
  clientKey?: string;
  /** The order's reference and what it bought, by name, read when the card opened. Absent on older cards. */
  orderReference?: string | null;
  orderSummary?: string | null;
}

/**
 * An ask to publish or archive one catalogue record (GRE-4089, John 5 Nov: "agents can publish anything but request
 * approval to do so"). `issueId` links the card to the asker's task.
 */
export const websiteCommercePublishRequestSchema = z.object({
  resource: z.enum(WEBSITE_COMMERCE_CATALOGUE_RESOURCES),
  id: z.string().uuid(),
  action: z.enum(["publish", "archive"]),
  note: z.string().trim().min(1).max(2000).optional(),
  issueId: z.string().uuid().optional(),
}).strict();
export type WebsiteCommercePublishRequestInput = z.infer<typeof websiteCommercePublishRequestSchema>;

export const COMMERCE_PUBLISH_REQUEST_APPROVAL_TYPE = "commerce_publish_request";

/** The card a person decides. The server builds it from the record as the site gave it; callers cannot set it. */
export interface CommercePublishRequestApprovalPayload {
  siteId: string;
  siteName: string;
  title: string;
  summary: string;
  resource: WebsiteCommerceCatalogueResource;
  itemId: string;
  itemName: string | null;
  action: "publish" | "archive";
  /** The record when asked. A different row version or content at approval voids the card. */
  before: { status: string | null; rowVersion: number };
  after: { status: "published" | "archived" };
  /** The record's fields when asked, for the person to read; cut when large. */
  item: Record<string, unknown>;
  itemSha256: string;
  requestedBy: string;
  note: string | null;
  /** Set when GSAM first sent the publish: a retry replays the same site key and skips the record check. */
  publishSentAt?: string;
  /** The site's answer once published: its status and row version. */
  result?: { status: string | null; rowVersion: number | null };
}

export type WebsiteDataBridgeState ="not_set_up" | "connected" | "failing";

export interface WebsiteDataBridgeStatus {
  state: WebsiteDataBridgeState;
  /** The read key's id, as it must appear in the site's GSAM_BRIDGE_KEYS. Never the key. */
  keyId: string | null;
  url: string;
  checkedAt: string | null;
  message: string | null;
  /** The site's clock minus GSAM's, when the site answered. */
  clockSkewSeconds: number | null;
  /** The write and refund_request key ids (GRE-2354 2c(b)); null means that capability is off. Never the keys. */
  writeKeyId?: string | null;
  refundKeyId?: string | null;
}

export const createWebsiteDataBridgeKeySchema = z.object({
  /** `stg` for the staging site, `live` for the live site: the two never share a key. */
  environment: z.enum(["stg", "live"]),
  /**
   * `read` (the default) for GSAM's reads; `write` for the Deep Dive sync (GRE-2439) and the commerce writes;
   * `refund_request` to record refund requests (GRE-2354 2c(b)). Each has its own key.
   */
  capability: z.enum(["read", "write", "refund_request"]).optional(),
  /** The bridge address, when it is not `https://<domain>`. Null goes back to the domain. */
  url: z.string().url().refine((u) => u.startsWith("https://"), "must be an https:// address").nullable().optional(),
}).strict();
export type CreateWebsiteDataBridgeKey = z.infer<typeof createWebsiteDataBridgeKeySchema>;

export type WebsiteDataBridgeCapability = "read" | "write" | "refund_request";

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
export const websiteActivityEventsQuerySchema = z.object({
  cursor: z.string().regex(/^(0|[1-9]\d{0,18})$/)
    .refine((value) => /^(0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n),
  limit: z.string().regex(/^(?:[1-9]|[1-9]\d|100)$/).transform(Number),
}).strict();
export type WebsiteDataListQuery = z.infer<typeof websiteDataListQuerySchema>;

/** Catalogue commerce lists have no customer filter; billing-lines uses websiteDataListQuerySchema. */
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

// Findings, opportunities and KPIs (GRE-2632). Each has its own array, not an item `type`: their shapes are
// fixed and typed, unlike an item's free `fields`. Only Shared records of this tenant are sent. A link to another
// record (a stream, a finding, an opportunity) is sent only when that record is in the same payload, so an
// Internal record's id never leaves GSAM. No authors, owners or internal notes.

/** A Shared Deep Dive finding on one of this tenant's Investigation Streams. */
export interface DeepDiveSyncFinding {
  id: string;
  /** The `deep_dive_stream` item it belongs to, only when that item is also Shared; otherwise null. */
  streamItemId: string | null;
  statement: string;
  status: "proposed" | "validated" | "rejected" | "superseded";
  /** How many pieces of evidence back it. */
  evidenceCount: number;
  /** The finding this one replaces, only when that finding is also Shared; otherwise null. */
  supersedesId: string | null;
  updatedAt: string;
}

/** A Shared opportunity whose linked findings are all on this tenant's streams. */
export interface DeepDiveSyncOpportunity {
  id: string;
  /** The opportunity's short reference, for example `OP-3`; empty when none was given. */
  ref: string;
  title: string;
  statement: string;
  desiredOutcome: string;
  status: "draft" | "refined" | "validated";
  /** Its Shared findings in this payload. */
  findingIds: string[];
  /** The Shared `deep_dive_stream` items of those findings. */
  streamItemIds: string[];
  updatedAt: string;
}

/** A Shared KPI that moves only through this tenant's opportunities (roadmap → commercial → build → opportunity). */
export interface DeepDiveSyncKpi {
  id: string;
  title: string;
  /** How the number is calculated. */
  definition: string;
  scope: "company" | "division" | "department" | "team" | "individual";
  unit: string;
  direction: "up" | "down" | "steady";
  baseline: number;
  /** The period the baseline covers. */
  baselinePeriod: string;
  target: number;
  /** Its Shared opportunities in this payload. */
  opportunityIds: string[];
  updatedAt: string;
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
  /** Added in GRE-2632; a site that does not know them can ignore them. */
  findings: DeepDiveSyncFinding[];
  opportunities: DeepDiveSyncOpportunity[];
  kpis: DeepDiveSyncKpi[];
}

export interface DeepDiveSyncResult {
  tenantId: string;
  syncedAt: string;
  counts: {
    items: number;
    files: number;
    documentRequests: number;
    deliverables: number;
    findings: number;
    opportunities: number;
    kpis: number;
  };
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

/** One line of a quote or order: the product's name first, its edition, then how many. */
export function purchaseLineName(line: Record<string, unknown>): string | null {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const name = [str(line.offering_name), str(line.variant_name)].filter(Boolean).join(", ");
  if (!name) return null;
  const qty = Number(line.qty);
  return Number.isFinite(qty) && qty > 1 ? `${name} × ${qty}` : name;
}

/** "Aspose.Total for .NET, Developer × 2 and 1 more": what a quote or order is for. Null when no line has a name. */
export function purchaseSummary(items: unknown): string | null {
  const names = (Array.isArray(items) ? items : []).map((line) => purchaseLineName(line as Record<string, unknown>));
  const named = names.filter((name): name is string => name !== null);
  if (!named.length) return null;
  const more = names.length - 1;
  return more > 0 ? `${named[0]} and ${more} more` : named[0]!;
}
