// The website admin bridge client (GRE-2323): GSAM reads the site's customer
// and commerce records (GRE-2354) by calling `<site>/api/admin/v1/*` (and, GRE-2439, pushes one
// client's Deep Dive snapshot there), signed with an Ed25519 key it
// keeps in the vault. The signing contract is contracts/gs-bridge-v1, the same
// file in greatstone-website; both test suites check against its vectors.
// Commerce writes and refund requests (GRE-2354 2c(b)) sign gs-bridge-v2: the
// same string with the idempotency key as a last line.
import { createHash, createPrivateKey, randomBytes, sign, type KeyObject } from "node:crypto";
import { z } from "zod";
import {
  WEBSITE_CLIENT_MEMBER_ROLES,
  WEBSITE_STAFF_ROLES,
  deepDiveSyncSitePath,
  websiteAccessChangeCall,
  websiteActivityBatchSchema,
  type DeepDiveSyncPayload,
  type WebsiteAccessChange,
  type WebsiteCommerceResource,
  type WebsiteDataResource,
} from "@greatstone/shared";
import { HttpError } from "../../errors.js";

export const BRIDGE_SCHEME = "gs-bridge-v1";
export const BRIDGE_SCHEME_V2 = "gs-bridge-v2";

/** Who a read is for: the site's audit row names it. `system` is GSAM's own scheduled reads. */
export type WebsiteBridgeActor = { type: "agent" | "user" | "system"; id: string; runId?: string | null };

export type WebsiteBridgeErrorCode =
  | "not_configured" | "unreachable" | "timeout" | "unauthorized" | "clock_skew" | "replay"
  | "forbidden" | "not_found" | "bad_request" | "bad_response" | "server_error"
  // writes and refund requests (GRE-2354 2c(b))
  | "conflict" | "denied" | "idempotency_mismatch" | "over_refundable"
  // activation steps (GRE-3982)
  | "licence_key_in_text";

const MESSAGES: Record<WebsiteBridgeErrorCode, string> = {
  not_configured: "The website data bridge is not set up for this site. A person with Publish rights makes a read key under Website > Releases > Site connection.",
  unreachable: "GSAM could not reach the website's data bridge. Check the bridge address and that the site is up.",
  timeout: "The website's data bridge did not answer in time. Try again.",
  unauthorized: "The website refused GSAM's read key. Check that the key id shown in GSAM is in the site's GSAM_BRIDGE_KEYS.",
  clock_skew: "The website refused the request time. GSAM's clock and the site's clock differ by more than a minute.",
  replay: "The website saw this request before and refused it. Try again.",
  forbidden: "The website does not allow this read key to do that.",
  not_found: "The website has no such record.",
  bad_request: "The website did not accept the read's filters.",
  bad_response: "The website's data bridge answered in a form GSAM does not understand.",
  server_error: "The website's data bridge had an error. Try again later.",
  conflict: "The record changed on the website since it was read. Read it again and redo the change.",
  denied: "The website refused this change: only a person can do it.",
  idempotency_mismatch: "The website already has a different change under this request's key. Nothing was written.",
  over_refundable: "The refund is more than is left to refund on this order.",
  licence_key_in_text: "The website refused the text: it holds a full licence key. Take the key out; customers see their own key beside the steps.",
};

const RETRY_STATUSES = new Set([502, 503, 504]);
/** What GSAM answers its own caller. Anything not listed is the site's problem: 502. */
const GSAM_STATUS: Partial<Record<WebsiteBridgeErrorCode, number>> = {
  not_configured: 409, not_found: 404, bad_request: 400, licence_key_in_text: 400,
  conflict: 409, denied: 403, idempotency_mismatch: 409, over_refundable: 409,
};

/** An HttpError, so a route that lets it through answers with the plain message and `website_bridge_<code>`. */
export class WebsiteBridgeError extends HttpError {
  /** A network error, a timeout or a 502/503/504: worth one more try. */
  readonly retryable: boolean;
  constructor(
    readonly code: WebsiteBridgeErrorCode,
    /** The site's HTTP status, when it answered. */
    readonly siteStatus: number | null = null,
    detail?: string,
    readonly retryAfterMs: number | null = null,
    /** A write conflict: the row as it is now on the site. */
    readonly current: Record<string, unknown> | null = null,
  ) {
    const retryable = code === "unreachable" || code === "timeout" || (siteStatus !== null && RETRY_STATUSES.has(siteStatus));
    super(GSAM_STATUS[code] ?? 502, detail ? `${MESSAGES[code]} (${detail})` : MESSAGES[code],
      { code: `website_bridge_${code}`, retryable, ...(current ? { current } : {}) });
    this.name = "WebsiteBridgeError";
    this.retryable = retryable;
  }
}

// ---- signing (contracts/gs-bridge-v1) ----

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The query, sorted by name then value, each part percent-encoded. Empty when there is none. */
export function bridgeCanonicalQuery(params: URLSearchParams) {
  const pairs = [...params].sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  return pairs.map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");
}

/** v1 for reads (and the Deep Dive PUT); v2, with the idempotency key as a tenth line, for writes and refund requests. */
export function bridgeCanonicalString(input: {
  method: string; host: string; path: string; query: string; time: number; nonce: string; actor: string;
  run: string | null; bodySha256: string; idempotencyKey?: string | null;
}) {
  const v2 = typeof input.idempotencyKey === "string";
  const lines = [v2 ? BRIDGE_SCHEME_V2 : BRIDGE_SCHEME, input.method.toUpperCase(), input.host.toLowerCase(),
    input.query ? `${input.path}?${input.query}` : input.path, String(input.time), input.nonce, input.actor,
    input.run || "-", input.bodySha256];
  return (v2 ? [...lines, input.idempotencyKey] : lines).join("\n");
}

/** 128 bits, base64url, no padding: the form the site takes for a nonce and an idempotency key. */
export const newBridgeIdempotencyKey = () => randomBytes(16).toString("base64url");
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{22}$/;

export function bridgeActorHeader(actor: WebsiteBridgeActor) {
  const id = actor.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  if (!id) throw new Error("A bridge actor needs an id");
  return `${actor.type}:${id}`;
}

/**
 * The headers for one signed request. A new time and nonce each call, so a retry is never a replay. With an
 * idempotency key the request is signed gs-bridge-v2 and carries the key, so the site writes it at most once.
 */
export function signBridgeRequest(input: {
  method: string; url: URL; body?: string; kid: string; privateKey: KeyObject; actor: WebsiteBridgeActor;
  nowSeconds: number; nonce?: string; idempotencyKey?: string;
}) {
  if (input.idempotencyKey !== undefined && !IDEMPOTENCY_KEY_RE.test(input.idempotencyKey)) {
    throw new Error("A bridge idempotency key is 22 base64url characters");
  }
  const nonce = input.nonce ?? randomBytes(16).toString("base64url");
  const actor = bridgeActorHeader(input.actor);
  const run = input.actor.runId && /^[0-9a-f-]{36}$/.test(input.actor.runId) ? input.actor.runId : null;
  const canonical = bridgeCanonicalString({
    method: input.method, host: input.url.host, path: input.url.pathname, query: bridgeCanonicalQuery(input.url.searchParams),
    time: input.nowSeconds, nonce, actor, run, bodySha256: createHash("sha256").update(input.body ?? "", "utf8").digest("hex"),
    idempotencyKey: input.idempotencyKey,
  });
  return {
    "x-gs-bridge-key": input.kid,
    "x-gs-bridge-time": String(input.nowSeconds),
    "x-gs-bridge-nonce": nonce,
    "x-gs-bridge-actor": actor,
    ...(run ? { "x-gs-bridge-run": run } : {}),
    ...(input.idempotencyKey !== undefined ? { "x-gs-bridge-idempotency-key": input.idempotencyKey } : {}),
    "x-gs-bridge-signature": sign(null, Buffer.from(canonical, "utf8"), input.privateKey).toString("base64url"),
  };
}

/** The vault value: the key id and the PKCS#8 private key, together, so they cannot drift apart. */
export const bridgeCredentialSchema = z.object({ kid: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/), privateKey: z.string().min(1) }).strict();
export type WebsiteBridgeCredential = { kid: string; privateKey: KeyObject };

export function parseBridgeCredential(value: string): WebsiteBridgeCredential {
  let parsed;
  try {
    parsed = bridgeCredentialSchema.parse(JSON.parse(value));
  } catch {
    throw new WebsiteBridgeError("not_configured", null, "the stored read key is not readable");
  }
  const privateKey = createPrivateKey(parsed.privateKey);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new WebsiteBridgeError("not_configured", null, "the stored read key is not Ed25519");
  return { kid: parsed.kid, privateKey };
}

// ---- the client ----

type WriteMethod = "POST" | "PATCH" | "DELETE";
type BridgeMethod = "GET" | "PUT" | WriteMethod;

const ATTEMPT_TIMEOUT_MS = 10_000;
/** The site takes a PO of at most 10 MB (request-quote); a little room above it. */
const MAX_FILE_BYTES = 12 * 1024 * 1024;

export type WebsiteBridgeFile = { bytes: Buffer; contentType: "application/zip" | "application/octet-stream"; fileName: string };
/** Letters, digits, dot, dash and underscore only, never a leading dot: safe in a content-disposition header. */
export function safeFileName(name: string | undefined) {
  const safe = String(name ?? "").replace(/[^\w.-]+/g, "_").replace(/^\.+/, "").slice(-120);
  return safe || "download";
}
const CALL_DEADLINE_MS = 25_000;
const BACKOFF_MS = [300, 1_000];
const MAX_RETRY_AFTER_MS = 5_000;

const errorBody = z.object({ error: z.object({ code: z.string() }), current: z.record(z.string(), z.unknown()).optional() });
export const bridgeHealthSchema = z.object({
  ok: z.literal(true), kid: z.string(), capability: z.string(), serverTime: z.string(), schema: z.literal(BRIDGE_SCHEME),
  /** The GSAM and website contract the site speaks (GRE-2633); a site from before it leaves it out. */
  siteContract: z.number().int().positive().optional().catch(undefined),
});
export const bridgeReleaseHealthSchema = bridgeHealthSchema.extend({
  capability: z.literal("read"), siteContract: z.number().int().positive(),
});
export const bridgeActivityEventsSchema = z.object({
  items: z.array(z.object({
    sequence: z.string().max(19).regex(/^(0|[1-9]\d*)$/), id: z.string(), organisationId: z.string(),
    kind: z.string(), subjectId: z.string().nullable(), label: z.string(), occurredAt: z.string(),
  })).max(100),
  nextCursor: z.string().max(19).regex(/^(0|[1-9]\d*)$/),
});
export const bridgeSchemaProbeSchema = z.object({
  tables: z.object({ billing_lines: z.boolean(), client_activity_outbox: z.boolean() }).strict(),
}).strict();
export const bridgeListSchema = z.object({ items: z.array(z.record(z.string(), z.unknown())), nextCursor: z.string().nullable() });
export const bridgeItemSchema = z.object({ item: z.record(z.string(), z.unknown()) });
/** `imports/:id`: the job, and a page of its rows. */
export const bridgeImportItemSchema = bridgeItemSchema.extend({ rows: z.array(z.record(z.string(), z.unknown())), nextCursor: z.string().nullable() });
/**
 * A Stripe object id (`pi_…`, `ch_…`: a prefix, then 14+ letters and digits with at least one digit; or a prefix, a
 * mode and 8+ with a digit, as a Checkout Session's `cs_test_…`) or a Stripe key (`sk_test_…`, `rk_live_…`, `whsec_…`).
 * The payment report must never carry one (GRE-2354 section 7, GRE-2580). Snake-case values such as `in_progress` or
 * `cs_test_pending` do not match: they have no digit.
 */
const STRIPE_ID_RE = /\b(?:(?:pi|ch|re|py|in|ii|cus|sub|txn|po|pm|acct|evt|cs|seti|src|tok|card|ba)_(?:(?:test|live)_(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{8,}|(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{14,})|(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{16,})\b/;
/** The site's own answer (greatstone-website `bridgePayments`): no envelope, no `from`/`to`. GSAM wraps it. */
export const bridgePaymentReportSchema = z.object({
  stripeMode: z.enum(["test", "live", "unset"]),
  items: z.array(z.record(z.string(), z.unknown())),
  nextCursor: z.string().nullable(),
}).passthrough().refine((value) => !STRIPE_ID_RE.test(JSON.stringify(value)), "the payment report carried a Stripe id or key");
export const bridgeSyncAckSchema = z.object({ ok: z.literal(true), tenantId: z.string() });
/** A write's answer: the row as it is after the change (`imports/:id/apply` adds the apply result). */
export const bridgeWriteSchema = z.object({ item: z.record(z.string(), z.unknown()), result: z.unknown().optional() });
/**
 * A commerce settings change's answer (GRE-4782 contract): the row after it, the licence-issued email's outcome
 * (`sent`, `not_sent`, `not_configured`, or `sending` on a replay), or a deleted lead's id (no row is left).
 */
export const bridgeSettingsWriteSchema = z.union([
  z.object({ item: z.record(z.string(), z.unknown()), email: z.string().optional() }),
  z.object({ id: z.string().min(1), deleted: z.literal(true) }),
]);
/**
 * A vendor's activation steps (GRE-3981 contract). Only these fields come through: anything else the site might add
 * (a key, a last 4) is dropped, so GSAM never passes it on.
 */
export const bridgeActivationStepsSchema = z.object({
  item: z.object({
    vendorId: z.string().min(1), vendorName: z.string(), status: z.string(), activationSteps: z.string().nullable(),
    rowVersion: z.number().int(), updatedAt: z.string(), licencesInRange: z.number().int().nonnegative(),
  }),
});
/**
 * A portal document (GRE-4081 contract, "Portal documents"). Only these fields come through: anything else the site
 * might add (a PDF path, a website user id) is dropped, so GSAM never passes it on.
 */
export const bridgePortalDocumentSchema = z.object({
  id: z.string().min(1), customer_id: z.string(), kind: z.string(), series: z.string().nullable(), version: z.number().int(),
  title: z.string(), summary: z.string().nullable(), body: z.unknown(), demos: z.unknown(), pdf_sha256: z.string().nullable(),
  has_pdf: z.boolean(), action: z.string().nullable(), confirmation_text: z.string().nullable(), signatory_email: z.string().nullable(),
  status: z.string(), content_sha256: z.string().nullable(), approval_id: z.string().nullable(), created_by_kind: z.string(),
  created_run_id: z.string().nullable(), published_at: z.string().nullable(), withdrawn_at: z.string().nullable(),
  created_at: z.string(), updated_at: z.string(), row_version: z.number().int(),
});
export const bridgePortalDocumentAnswerSchema = z.object({ item: bridgePortalDocumentSchema, approvalId: z.string().min(1).optional() });
/** A refund request row, as `bridge_request_refund` and `bridge_refund_decision` return it. */
export const bridgeRefundRequestSchema = z.object({
  item: z.object({ id: z.string().min(1), status: z.string() }).passthrough(),
});

/**
 * People and access (GRE-4085, contract "People and access"). Only these fields come through: anything else the site
 * might add is dropped. Each list is one page.
 */
export const bridgeStaffSchema = z.object({
  id: z.string().min(1), email: z.string(), name: z.string().nullable(), role: z.enum(WEBSITE_STAFF_ROLES), isActive: z.boolean(),
  canSignIn: z.boolean(), portalApprover: z.boolean(), lastLoginAt: z.string().nullable(), updatedAt: z.string(),
});
export const bridgeApproverSchema = z.object({
  staffId: z.string().min(1), email: z.string(), name: z.string().nullable(), label: z.string(), staffActive: z.boolean(), addedAt: z.string(),
});
export const bridgeMemberSchema = z.object({
  membershipId: z.string().min(1), organisationId: z.string().min(1), userId: z.string().nullable(), email: z.string(),
  name: z.string().nullable(), role: z.enum(WEBSITE_CLIENT_MEMBER_ROLES), isPrimary: z.boolean(), createdAt: z.string(), updatedAt: z.string(),
});
const accessListOf = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item), nextCursor: z.null() });
export const bridgeAccessAnswerSchemas = {
  staff_role: z.object({ item: bridgeStaffSchema }),
  approver_set: z.object({ item: bridgeApproverSchema }),
  approver_remove: z.object({ staffId: z.string().min(1), removed: z.literal(true) }),
  member_add: z.object({ item: bridgeMemberSchema }),
  member_role: z.object({ item: bridgeMemberSchema }),
  member_remove: z.object({ membershipId: z.string().min(1), organisationId: z.string().min(1), removed: z.literal(true) }),
} as const;

export interface WebsiteBridgeClientOptions {
  baseUrl: string;
  credential: WebsiteBridgeCredential;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

function codeFor(status: number, siteCode: string | undefined): WebsiteBridgeErrorCode {
  if (status === 401) return siteCode === "expired" ? "clock_skew" : siteCode === "replay" ? "replay" : "unauthorized";
  if (status === 403) return siteCode === "denied" ? "denied" : "forbidden";
  if (status === 409) {
    return siteCode === "idempotency_mismatch" || siteCode === "over_refundable" ? siteCode : "conflict";
  }
  if (status === 404) return "not_found";
  if (status === 400) return siteCode === "licence_key_in_text" ? siteCode : "bad_request";
  return status >= 500 ? "server_error" : "bad_response";
}

function retryAfterMs(res: Response) {
  const raw = res.headers.get("retry-after");
  const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : null;
  return seconds === null ? null : Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

export function createWebsiteBridgeClient(options: WebsiteBridgeClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const base = new URL(options.baseUrl);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname))) {
    throw new WebsiteBridgeError("not_configured", null, "the bridge address must be https");
  }

  async function attempt(method: BridgeMethod, url: URL, body: string | undefined, actor: WebsiteBridgeActor, deadline: number,
    idempotencyKey: string | undefined): Promise<unknown> {
    const headers: Record<string, string> = signBridgeRequest({ method, url, body, kid: options.credential.kid,
      privateKey: options.credential.privateKey, actor, nowSeconds: Math.floor(now() / 1000), idempotencyKey });
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await fetchImpl(url, { method, headers, body, redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, Math.min(ATTEMPT_TIMEOUT_MS, deadline - now()))) });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      throw new WebsiteBridgeError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable");
    }
    if (res.ok) {
      try { return await res.json(); } catch { throw new WebsiteBridgeError("bad_response", res.status, "not JSON"); }
    }
    const errBody = errorBody.safeParse(await res.json().catch(() => null));
    throw new WebsiteBridgeError(codeFor(res.status, errBody.success ? errBody.data.error.code : undefined), res.status,
      errBody.success ? errBody.data.error.code : `HTTP ${res.status}`, retryAfterMs(res),
      res.status === 409 && errBody.success ? errBody.data.current ?? null : null);
  }

  /**
   * A file the site streams (admin parity round 2): a buyer's PO or a lead's agent package. A signed read, one try (a
   * person clicks again); the bytes are capped, and the name comes from the site's content-disposition, made safe.
   */
  async function file(path: string, actor: WebsiteBridgeActor): Promise<WebsiteBridgeFile> {
    const url = new URL(`/api/admin/v1/${path.replace(/^\/+/, "")}`, base);
    const headers = signBridgeRequest({ method: "GET", url, kid: options.credential.kid, privateKey: options.credential.privateKey,
      actor, nowSeconds: Math.floor(now() / 1000) });
    let res: Response;
    try {
      res = await fetchImpl(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(CALL_DEADLINE_MS) });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      throw new WebsiteBridgeError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable");
    }
    if (!res.ok) {
      const errBody = errorBody.safeParse(await res.json().catch(() => null));
      throw new WebsiteBridgeError(codeFor(res.status, errBody.success ? errBody.data.error.code : undefined), res.status,
        errBody.success ? errBody.data.error.code : `HTTP ${res.status}`);
    }
    if (Number(res.headers.get("content-length")) > MAX_FILE_BYTES) throw new WebsiteBridgeError("bad_response", res.status, "file too large");
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_FILE_BYTES) throw new WebsiteBridgeError("bad_response", res.status, "file too large");
    const named = /filename="([^"]*)"/.exec(res.headers.get("content-disposition") ?? "")?.[1];
    return { bytes, contentType: res.headers.get("content-type") === "application/zip" ? "application/zip" : "application/octet-stream",
      fileName: safeFileName(named) };
  }

  /**
   * One call: at most two retries, only after a network error, a timeout or a 502/503/504. 4xx is never retried.
   * A PUT is retried too: it replaces the whole resource, so sending it twice is the same as once. A write keeps
   * one idempotency key for all its tries (each with a new nonce), so the site writes it at most once.
   */
  async function call<T>(method: BridgeMethod, path: string, query: Record<string, string | undefined>, body: string | undefined,
    actor: WebsiteBridgeActor, schema: z.ZodType<T>, idempotencyKey?: string): Promise<T> {
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, v);
    const deadline = now() + CALL_DEADLINE_MS;
    for (let tries = 0; ; tries += 1) {
      try {
        const parsed = schema.safeParse(await attempt(method, url, body, actor, deadline, idempotencyKey));
        if (!parsed.success) throw new WebsiteBridgeError("bad_response", 200, parsed.error.issues[0]?.message);
        return parsed.data;
      } catch (error) {
        const retry = error instanceof WebsiteBridgeError && error.retryable && tries < BACKOFF_MS.length;
        const wait = retry ? (error.retryAfterMs ?? BACKOFF_MS[tries]! + Math.floor(random() * 200)) : 0;
        if (!retry || now() + wait >= deadline) throw error;
        await sleep(wait);
      }
    }
  }

  const get = <T>(path: string, query: Record<string, string | undefined>, actor: WebsiteBridgeActor, schema: z.ZodType<T>) =>
    call("GET", path, query, undefined, actor, schema);
  /** A v2 write: one idempotency key per logical call (or the caller's, so a later call can replay it). No query. */
  const send = <T>(method: WriteMethod | "PUT", path: string, body: Record<string, unknown> | undefined, actor: WebsiteBridgeActor,
    schema: z.ZodType<T>, idempotencyKey = newBridgeIdempotencyKey()) =>
    call(method, `/api/admin/v1/${path.replace(/^\/+/, "")}`, {}, body === undefined ? "" : JSON.stringify(body), actor, schema,
      idempotencyKey);
  const limitOf = (limit: number | undefined) => (limit === undefined ? undefined : String(limit));

  return {
    health: (actor: WebsiteBridgeActor) => get("/api/admin/v1/health", {}, actor, bridgeHealthSchema),
    activity: (cursor: string, actor: WebsiteBridgeActor) =>
      get("/api/admin/v1/activity-events", { cursor, limit: "100" }, actor, websiteActivityBatchSchema),
    releaseHealth: (actor: WebsiteBridgeActor) => get("/api/admin/v1/health", {}, actor, bridgeReleaseHealthSchema),
    activityEvents: (cursor: string, limit: number, actor: WebsiteBridgeActor) =>
      get("/api/admin/v1/activity-events", { cursor, limit: String(limit) }, actor, bridgeActivityEventsSchema),
    schemaProbe: (actor: WebsiteBridgeActor) => get("/api/admin/v1/schema", {}, actor, bridgeSchemaProbeSchema),
    list: (resource: WebsiteDataResource | WebsiteCommerceResource,
      filters: { customer?: string; updatedSince?: string; cursor?: string; limit?: number }, actor: WebsiteBridgeActor) =>
      get(`/api/admin/v1/${resource}`, { customer: filters.customer, updatedSince: filters.updatedSince, cursor: filters.cursor,
        limit: limitOf(filters.limit) }, actor, bridgeListSchema),
    get: (resource: WebsiteDataResource | Exclude<WebsiteCommerceResource, "imports">, id: string, actor: WebsiteBridgeActor) =>
      get(`/api/admin/v1/${resource}/${encodeURIComponent(id)}`, {}, actor, bridgeItemSchema),
    /** One import job with a page of its rows. */
    importJob: (id: string, page: { cursor?: string; limit?: number }, actor: WebsiteBridgeActor) =>
      get(`/api/admin/v1/imports/${encodeURIComponent(id)}`, { cursor: page.cursor, limit: limitOf(page.limit) }, actor, bridgeImportItemSchema),
    fx: (actor: WebsiteBridgeActor) => get("/api/admin/v1/fx", {}, actor, bridgeItemSchema),
    /** A file the site streams: `quotes/<id>/po-document`, `orders/<id>/po-document` or `enquiries/fd-<id>/agent-package`. */
    file,
    payments: async (range: { from?: string; to?: string }, actor: WebsiteBridgeActor) => {
      const site = await get("/api/admin/v1/payments", { from: range.from, to: range.to }, actor, bridgePaymentReportSchema);
      return { report: { from: range.from ?? null, to: range.to ?? null, ...site } };
    },
    /** Deep Dive sync (GRE-2439): replace one tenant's snapshot on the site. Needs a `write` key. */
    putDeepDiveTenant: (tenantId: string, payload: DeepDiveSyncPayload, actor: WebsiteBridgeActor) =>
      call("PUT", deepDiveSyncSitePath(tenantId), {}, JSON.stringify(payload), actor, bridgeSyncAckSchema),
    /**
     * A commerce write (GRE-2354 2c(b)) on the `write` key: `path` is after `/api/admin/v1/`, e.g. `offerings/<id>`.
     * Needs a write key; the site refuses it on any other.
     */
    write: (method: WriteMethod, path: string, body: Record<string, unknown> | undefined, actor: WebsiteBridgeActor,
      idempotencyKey?: string) => send(method, path, body, actor, bridgeWriteSchema, idempotencyKey),
    /**
     * A commerce settings change (GRE-4782) on the `write` key: orders, enquiries, clients, the timeline, licences,
     * tiers and receipts. The site refuses an agent or system actor a people-only one (403 denied).
     */
    settingsWrite: (method: WriteMethod, path: string, body: Record<string, unknown> | undefined, actor: WebsiteBridgeActor,
      idempotencyKey?: string) => send(method, path, body, actor, bridgeSettingsWriteSchema, idempotencyKey),
    /**
     * Parallel Interview (gs-interview-v1, GRE-2665): `path` is after `/api/admin/v1/interview/`, keyed by the
     * website organisation id. The answer is parsed by the caller. Reads use the read key, writes the write key.
     */
    interviewRead: (path: string, query: Record<string, string | undefined>, actor: WebsiteBridgeActor) =>
      get(`/api/admin/v1/interview/${path.replace(/^\/+/, "")}`, query, actor, z.record(z.string(), z.unknown())),
    interviewWrite: (path: string, body: Record<string, unknown>, actor: WebsiteBridgeActor, idempotencyKey?: string) =>
      send("POST", `interview/${path.replace(/^\/+/, "")}`, body, actor, z.record(z.string(), z.unknown()), idempotencyKey),
    /**
     * Sets or clears one vendor's licence activation steps (GRE-3982) on the `write` key, signed v2. A PUT replaces
     * the steps, and one idempotency key covers every try, so the site writes it at most once.
     */
    putActivationSteps: (vendorId: string, input: { activationSteps: string | null; expectedRowVersion: number }, actor: WebsiteBridgeActor,
      idempotencyKey?: string) =>
      send("PUT", `vendors/${encodeURIComponent(vendorId)}/activation-steps`,
        { activationSteps: input.activationSteps, expectedRowVersion: input.expectedRowVersion }, actor, bridgeActivationStepsSchema,
        idempotencyKey),
    /** People and access reads (GRE-4085), on the read key. Open to any actor. */
    accessStaff: (actor: WebsiteBridgeActor) => get("/api/admin/v1/access/staff", {}, actor, accessListOf(bridgeStaffSchema)),
    accessPortalApprovers: (actor: WebsiteBridgeActor) =>
      get("/api/admin/v1/access/portal-approvers", {}, actor, accessListOf(bridgeApproverSchema)),
    accessClientMembers: (customerId: string, actor: WebsiteBridgeActor) =>
      get(`/api/admin/v1/access/clients/${encodeURIComponent(customerId)}/members`, {}, actor, accessListOf(bridgeMemberSchema)),
    /**
     * One access change on the `write` key, signed v2. People only: the site answers an agent or system actor with
     * 403 denied and changes nothing.
     */
    accessChange: <K extends WebsiteAccessChange["kind"]>(change: WebsiteAccessChange & { kind: K }, actor: WebsiteBridgeActor,
      idempotencyKey?: string) => {
      const { method, path, body } = websiteAccessChangeCall(change);
      const schema = bridgeAccessAnswerSchemas[change.kind] as unknown as z.ZodType<z.infer<(typeof bridgeAccessAnswerSchemas)[K]>>;
      return send(method, path, body, actor, schema, idempotencyKey);
    },
    /**
     * A portal document write (GRE-4083) on the `write` key, signed v2: `path` is after `/api/admin/v1/portal-documents`,
     * e.g. `/<id>/submit`. The site refuses approve-and-publish to anyone but a registered portal approver, and
     * withdraw to an agent.
     */
    portalDocumentWrite: (method: "POST" | "PATCH", path: string, body: Record<string, unknown>, actor: WebsiteBridgeActor,
      idempotencyKey?: string) => send(method, `portal-documents${path}`, body, actor, bridgePortalDocumentAnswerSchema, idempotencyKey),
    /** Records a refund request on the `refund_request` key. Moves no money. */
    requestRefund: (input: { orderId: string; amountMinor: number; reason: string }, actor: WebsiteBridgeActor, idempotencyKey?: string) =>
      send("POST", "refund-requests", { orderId: input.orderId, amountMinor: input.amountMinor, reason: input.reason }, actor,
        bridgeRefundRequestSchema, idempotencyKey),
    /** A person's decision on a refund request (the site refuses an agent). Same refund_request key. */
    decideRefund: (requestId: string, input: { decision: "approved" | "rejected"; approvalRef: string }, actor: WebsiteBridgeActor,
      idempotencyKey?: string) =>
      send("POST", `refund-requests/${encodeURIComponent(requestId)}/decision`, { decision: input.decision, approvalRef: input.approvalRef },
        actor, bridgeRefundRequestSchema, idempotencyKey),
  };
}
export type WebsiteBridgeClient = ReturnType<typeof createWebsiteBridgeClient>;
