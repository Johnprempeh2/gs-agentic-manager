// The website admin bridge client (GRE-2323): GSAM reads the site's customer
// records by calling `<site>/api/admin/v1/*`, signed with an Ed25519 key it
// keeps in the vault. The signing contract is contracts/gs-bridge-v1, the same
// file in greatstone-website; both test suites check against its vectors.
import { createHash, createPrivateKey, randomBytes, sign, type KeyObject } from "node:crypto";
import { z } from "zod";
import type { WebsiteDataResource } from "@greatstone/shared";
import { HttpError } from "../../errors.js";

export const BRIDGE_SCHEME = "gs-bridge-v1";

/** Who a read is for: the site's audit row names it. `system` is GSAM's own scheduled reads. */
export type WebsiteBridgeActor = { type: "agent" | "user" | "system"; id: string; runId?: string | null };

export type WebsiteBridgeErrorCode =
  | "not_configured" | "unreachable" | "timeout" | "unauthorized" | "clock_skew" | "replay"
  | "forbidden" | "not_found" | "bad_request" | "bad_response" | "server_error";

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
};

const RETRY_STATUSES = new Set([502, 503, 504]);
/** What GSAM answers its own caller. Anything not listed is the site's problem: 502. */
const GSAM_STATUS: Partial<Record<WebsiteBridgeErrorCode, number>> = { not_configured: 409, not_found: 404, bad_request: 400 };

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
  ) {
    const retryable = code === "unreachable" || code === "timeout" || (siteStatus !== null && RETRY_STATUSES.has(siteStatus));
    super(GSAM_STATUS[code] ?? 502, detail ? `${MESSAGES[code]} (${detail})` : MESSAGES[code], { code: `website_bridge_${code}`, retryable });
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

export function bridgeCanonicalString(input: {
  method: string; host: string; path: string; query: string; time: number; nonce: string; actor: string;
  run: string | null; bodySha256: string;
}) {
  return [BRIDGE_SCHEME, input.method.toUpperCase(), input.host.toLowerCase(),
    input.query ? `${input.path}?${input.query}` : input.path, String(input.time), input.nonce, input.actor,
    input.run || "-", input.bodySha256].join("\n");
}

export function bridgeActorHeader(actor: WebsiteBridgeActor) {
  const id = actor.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  if (!id) throw new Error("A bridge actor needs an id");
  return `${actor.type}:${id}`;
}

/** The headers for one signed request. A new time and nonce each call, so a retry is never a replay. */
export function signBridgeRequest(input: {
  method: string; url: URL; body?: string; kid: string; privateKey: KeyObject; actor: WebsiteBridgeActor;
  nowSeconds: number; nonce?: string;
}) {
  const nonce = input.nonce ?? randomBytes(16).toString("base64url");
  const actor = bridgeActorHeader(input.actor);
  const run = input.actor.runId && /^[0-9a-f-]{36}$/.test(input.actor.runId) ? input.actor.runId : null;
  const canonical = bridgeCanonicalString({
    method: input.method, host: input.url.host, path: input.url.pathname, query: bridgeCanonicalQuery(input.url.searchParams),
    time: input.nowSeconds, nonce, actor, run, bodySha256: createHash("sha256").update(input.body ?? "", "utf8").digest("hex"),
  });
  return {
    "x-gs-bridge-key": input.kid,
    "x-gs-bridge-time": String(input.nowSeconds),
    "x-gs-bridge-nonce": nonce,
    "x-gs-bridge-actor": actor,
    ...(run ? { "x-gs-bridge-run": run } : {}),
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

const ATTEMPT_TIMEOUT_MS = 10_000;
const CALL_DEADLINE_MS = 25_000;
const BACKOFF_MS = [300, 1_000];
const MAX_RETRY_AFTER_MS = 5_000;

const errorBody = z.object({ error: z.object({ code: z.string() }) });
export const bridgeHealthSchema = z.object({
  ok: z.literal(true), kid: z.string(), capability: z.string(), serverTime: z.string(), schema: z.literal(BRIDGE_SCHEME),
});
export const bridgeListSchema = z.object({ items: z.array(z.record(z.string(), z.unknown())), nextCursor: z.string().nullable() });
export const bridgeItemSchema = z.object({ item: z.record(z.string(), z.unknown()) });

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
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 400) return "bad_request";
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

  async function attempt(url: URL, actor: WebsiteBridgeActor, deadline: number): Promise<unknown> {
    const headers = signBridgeRequest({ method: "GET", url, kid: options.credential.kid, privateKey: options.credential.privateKey,
      actor, nowSeconds: Math.floor(now() / 1000) });
    let res: Response;
    try {
      res = await fetchImpl(url, { method: "GET", headers, redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, Math.min(ATTEMPT_TIMEOUT_MS, deadline - now()))) });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      throw new WebsiteBridgeError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable");
    }
    if (res.ok) {
      try { return await res.json(); } catch { throw new WebsiteBridgeError("bad_response", res.status, "not JSON"); }
    }
    const body = errorBody.safeParse(await res.json().catch(() => null));
    throw new WebsiteBridgeError(codeFor(res.status, body.success ? body.data.error.code : undefined), res.status,
      body.success ? body.data.error.code : `HTTP ${res.status}`, retryAfterMs(res));
  }

  /** One GET: at most two retries, only after a network error, a timeout or a 502/503/504. 4xx is never retried. */
  async function get<T>(path: string, query: Record<string, string | undefined>, actor: WebsiteBridgeActor, schema: z.ZodType<T>): Promise<T> {
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, v);
    const deadline = now() + CALL_DEADLINE_MS;
    for (let tries = 0; ; tries += 1) {
      try {
        const parsed = schema.safeParse(await attempt(url, actor, deadline));
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

  return {
    health: (actor: WebsiteBridgeActor) => get("/api/admin/v1/health", {}, actor, bridgeHealthSchema),
    list: (resource: WebsiteDataResource, filters: { customer?: string; updatedSince?: string; cursor?: string; limit?: number }, actor: WebsiteBridgeActor) =>
      get(`/api/admin/v1/${resource}`, { customer: filters.customer, updatedSince: filters.updatedSince, cursor: filters.cursor,
        limit: filters.limit === undefined ? undefined : String(filters.limit) }, actor, bridgeListSchema),
    get: (resource: WebsiteDataResource, id: string, actor: WebsiteBridgeActor) =>
      get(`/api/admin/v1/${resource}/${encodeURIComponent(id)}`, {}, actor, bridgeItemSchema),
  };
}
export type WebsiteBridgeClient = ReturnType<typeof createWebsiteBridgeClient>;
