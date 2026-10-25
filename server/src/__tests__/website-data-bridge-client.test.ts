import { createPrivateKey, verify, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  WebsiteBridgeError,
  bridgeCanonicalQuery,
  bridgeCanonicalString,
  createWebsiteBridgeClient,
  parseBridgeCredential,
  signBridgeRequest,
} from "../services/website/data-bridge-client.js";

// The signing contract (GRE-2323): the same file as greatstone-website's contracts/gs-bridge-v1/vectors.json.
const CONTRACT = JSON.parse(readFileSync(new URL("../../../contracts/gs-bridge-v1/vectors.json", import.meta.url), "utf8")) as {
  key: { kid: string; seedHex: string; publicKey: string };
  vectors: Array<{ name: string; method: string; url: string; time: number; nonce: string; actor: string; run: string | null; body: string;
    expected: { canonicalQuery: string; bodySha256: string; canonical: string; signature: string } }>;
  /** gs-bridge-v2 (GRE-2354): writes and refund requests. Same seed; kid and capability per vector. */
  vectorsV2: Array<{ name: string; kid: string; capability: string; method: string; url: string; time: number; nonce: string;
    idempotencyKey: string; actor: string; run: string | null; body: string;
    expected: { canonicalQuery: string; bodySha256: string; canonical: string; signature: string } }>;
};
const PRIVATE = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(CONTRACT.key.seedHex, "hex")]),
  format: "der", type: "pkcs8",
});
const CREDENTIAL = { kid: CONTRACT.key.kid, privateKey: PRIVATE };
const ACTOR = { type: "agent" as const, id: "d5651a41-e5e0-4512-8fb0-069815ff4278", runId: "9ef9feeb-d13b-450d-b404-89a39e406161" };
const HEALTH = { ok: true, kid: CONTRACT.key.kid, capability: "read", serverTime: "2026-10-24T22:00:00.000Z", schema: "gs-bridge-v1" };

function parseActor(actor: string) {
  const [type, id] = actor.split(":") as ["agent" | "user", string];
  return { type, id };
}

describe("gs-bridge-v1 signing", () => {
  it("matches the shared vectors byte for byte", () => {
    for (const v of CONTRACT.vectors) {
      const url = new URL(v.url);
      expect(bridgeCanonicalQuery(url.searchParams), v.name).toBe(v.expected.canonicalQuery);
      expect(bridgeCanonicalString({ method: v.method, host: url.host, path: url.pathname, query: v.expected.canonicalQuery,
        time: v.time, nonce: v.nonce, actor: v.actor, run: v.run, bodySha256: v.expected.bodySha256 }), v.name).toBe(v.expected.canonical);
      const headers = signBridgeRequest({ method: v.method, url, body: v.body, kid: CONTRACT.key.kid, privateKey: PRIVATE,
        actor: { ...parseActor(v.actor), runId: v.run }, nowSeconds: v.time, nonce: v.nonce });
      expect(headers["x-gs-bridge-signature"], v.name).toBe(v.expected.signature);
      expect(headers["x-gs-bridge-actor"]).toBe(v.actor);
    }
  });

  it("signs gs-bridge-v2 with the idempotency key to match the shared vectors (GRE-2354 2c(b))", () => {
    expect(CONTRACT.vectorsV2.length).toBeGreaterThanOrEqual(4);
    for (const v of CONTRACT.vectorsV2) {
      const url = new URL(v.url);
      expect(bridgeCanonicalString({ method: v.method, host: url.host, path: url.pathname, query: v.expected.canonicalQuery,
        time: v.time, nonce: v.nonce, actor: v.actor, run: v.run, bodySha256: v.expected.bodySha256, idempotencyKey: v.idempotencyKey }),
      v.name).toBe(v.expected.canonical);
      const headers = signBridgeRequest({ method: v.method, url, body: v.body, kid: v.kid, privateKey: PRIVATE,
        actor: { ...parseActor(v.actor), runId: v.run }, nowSeconds: v.time, nonce: v.nonce, idempotencyKey: v.idempotencyKey });
      expect(headers["x-gs-bridge-signature"], v.name).toBe(v.expected.signature);
      expect(headers["x-gs-bridge-idempotency-key"], v.name).toBe(v.idempotencyKey);
    }
    // a read never carries the header, and a malformed key is refused before signing
    const read = CONTRACT.vectors[0]!;
    expect(signBridgeRequest({ method: read.method, url: new URL(read.url), kid: "k", privateKey: PRIVATE, actor: ACTOR, nowSeconds: 1 }))
      .not.toHaveProperty("x-gs-bridge-idempotency-key");
    expect(() => signBridgeRequest({ method: "POST", url: new URL(read.url), kid: "k", privateKey: PRIVATE, actor: ACTOR, nowSeconds: 1,
      idempotencyKey: "short" })).toThrow(/22 base64url/);
  });

  it("signs with a key the shared public key verifies", () => {
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: CONTRACT.key.publicKey }, format: "jwk" });
    const v = CONTRACT.vectors[0]!;
    expect(verify(null, Buffer.from(v.expected.canonical), pub, Buffer.from(v.expected.signature, "base64url"))).toBe(true);
  });

  it("reads the vault value only when it is a kid and an Ed25519 key", () => {
    const pem = PRIVATE.export({ format: "pem", type: "pkcs8" }).toString();
    expect(parseBridgeCredential(JSON.stringify({ kid: "stg-read-2026-10-abc123", privateKey: pem })).kid).toBe("stg-read-2026-10-abc123");
    expect(() => parseBridgeCredential("not json")).toThrow(WebsiteBridgeError);
    expect(() => parseBridgeCredential(JSON.stringify({ kid: "Bad Kid", privateKey: pem }))).toThrow(/not readable/);
  });
});

type Call = { url: string; method: string; body: unknown; headers: Record<string, string> };
function fakeFetch(answers: Array<Response | Error>) {
  const calls: Call[] = [];
  const impl = (async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), method: String(init.method), body: init.body, headers: init.headers as Record<string, string> });
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function client(answers: Array<Response | Error>) {
  const fake = fakeFetch(answers);
  const sleeps: number[] = [];
  let clock = 1_793_000_000_000;
  const c = createWebsiteBridgeClient({
    baseUrl: "https://staging.example.test", credential: CREDENTIAL, fetchImpl: fake.impl,
    now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; }, random: () => 0,
  });
  return { c, calls: fake.calls, sleeps };
}

describe("website bridge client", () => {
  it("signs each attempt afresh, so a retry is never a replay", async () => {
    const { c, calls, sleeps } = client([json(503, { error: { code: "unavailable" } }), new TypeError("fetch failed"), json(200, HEALTH)]);
    await expect(c.health(ACTOR)).resolves.toMatchObject({ ok: true });
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((x) => x.headers["x-gs-bridge-nonce"])).size).toBe(3);
    expect(new Set(calls.map((x) => x.headers["x-gs-bridge-signature"])).size).toBe(3);
    expect(sleeps).toEqual([300, 1_000]);
    expect(calls[0]!.headers["x-gs-bridge-run"]).toBe(ACTOR.runId);
  });

  it("stops after two retries", async () => {
    const { c, calls } = client([json(502, {}), json(504, {}), json(503, { error: { code: "unavailable" } }), json(200, HEALTH)]);
    await expect(c.health(ACTOR)).rejects.toMatchObject({ code: "server_error", siteStatus: 503, status: 502 });
    expect(calls).toHaveLength(3);
  });

  it("never retries a refusal or a plain 500", async () => {
    for (const [status, siteCode, code, gsamStatus] of [
      [401, "bad_signature", "unauthorized", 502], [401, "bad_key", "unauthorized", 502], [401, "expired", "clock_skew", 502],
      [401, "replay", "replay", 502], [403, "capability_denied", "forbidden", 502], [404, "not_found", "not_found", 404],
      [400, "bad_request", "bad_request", 400], [500, "x", "server_error", 502],
    ] as const) {
      const { c, calls } = client([json(status, { error: { code: siteCode } }), json(200, HEALTH)]);
      const error = await c.health(ACTOR).catch((e: unknown) => e);
      expect(error, `${status} ${siteCode}`).toBeInstanceOf(WebsiteBridgeError);
      expect(error).toMatchObject({ code, retryable: false, status: gsamStatus, details: { code: `website_bridge_${code}` } });
      expect(calls).toHaveLength(1);
    }
  });

  it("honours a short Retry-After and names timeouts", async () => {
    const { c, sleeps } = client([json(503, {}, { "retry-after": "2" }), json(200, HEALTH)]);
    await c.health(ACTOR);
    expect(sleeps).toEqual([2_000]);
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const slow = client([timeout, timeout, timeout]);
    await expect(slow.c.health(ACTOR)).rejects.toMatchObject({ code: "timeout" });
    expect(slow.calls).toHaveLength(3);
  });

  it("checks every answer's shape", async () => {
    const { c } = client([json(200, { items: "nope" })]);
    await expect(c.list("orders", {}, ACTOR)).rejects.toMatchObject({ code: "bad_response" });
    const ok = client([json(200, { items: [{ id: "a" }], nextCursor: null })]);
    await expect(ok.c.list("orders", { limit: 2, customer: "c1" }, ACTOR)).resolves.toEqual({ items: [{ id: "a" }], nextCursor: null });
    expect(ok.calls[0]!.url).toBe("https://staging.example.test/api/admin/v1/orders?customer=c1&limit=2");
  });

  it("reads the commerce resources on the same signed GET (GRE-2354 2c(a))", async () => {
    const { c, calls } = client([
      json(200, { items: [], nextCursor: null }),
      json(200, { item: { id: "j1" }, rows: [{ line: 1 }], nextCursor: "r2" }),
      json(200, { item: { usdToGbpDisplayRate: "0.79", rowVersion: 3, history: [] } }),
      json(200, { report: { from: "2026-10-01", to: "2026-10-31", stripeMode: "test", paidOrders: 2 } }),
    ]);
    await c.list("pricing-rules", { updatedSince: "2026-10-01T00:00:00Z" }, ACTOR);
    await expect(c.importJob("j1", { cursor: "r1", limit: 20 }, ACTOR)).resolves.toMatchObject({ rows: [{ line: 1 }], nextCursor: "r2" });
    await c.fx(ACTOR);
    await expect(c.payments({ from: "2026-10-01", to: "2026-10-31" }, ACTOR)).resolves.toMatchObject({ report: { stripeMode: "test", paidOrders: 2 } });
    expect(calls.map((x) => x.url)).toEqual([
      "https://staging.example.test/api/admin/v1/pricing-rules?updatedSince=2026-10-01T00%3A00%3A00Z",
      "https://staging.example.test/api/admin/v1/imports/j1?cursor=r1&limit=20",
      "https://staging.example.test/api/admin/v1/fx",
      "https://staging.example.test/api/admin/v1/payments?from=2026-10-01&to=2026-10-31",
    ]);
    expect(calls.every((x) => x.headers["x-gs-bridge-key"] === CONTRACT.key.kid)).toBe(true);
  });

  it("refuses a payment report that carries a Stripe id or key, or no Stripe mode", async () => {
    for (const leak of ["pi_3PqRsTuVwXyZ1234", "sk_test_51AbCdEfGhIjKl", "ch_1AbCdEfGhIjKlMn"]) {
      const { c } = client([json(200, { report: { from: null, to: null, stripeMode: "test", orders: [{ id: "o1", note: leak }] } })]);
      await expect(c.payments({}, ACTOR), leak).rejects.toMatchObject({ code: "bad_response", status: 502 });
    }
    const unset = client([json(200, { report: { from: null, to: null } })]);
    await expect(unset.c.payments({}, ACTOR)).rejects.toMatchObject({ code: "bad_response" });
    const boolean = client([json(200, { report: { from: null, to: null, stripeMode: "unset",
      orders: [{ id: "8c1d7c2e-4f0a-4a51-9f4e-0d9c2b7a1e33", paidByStripe: true, refundStatus: "in_progress_with_stripe" }] } })]);
    await expect(boolean.c.payments({}, ACTOR)).resolves.toMatchObject({ report: { stripeMode: "unset" } });
  });

  describe("writes and refund requests (GRE-2354 2c(b))", () => {
    const ROW = { item: { id: "c0ffee00-0000-4000-8000-000000000001", row_version: 4 } };

    it("retries a write at most twice with the same idempotency key and a new nonce each time", async () => {
      const { c, calls, sleeps } = client([new TypeError("fetch failed"), json(503, { error: { code: "unavailable" } }), json(200, ROW)]);
      await expect(c.write("PATCH", "offerings/c0ffee00-0000-4000-8000-000000000001", { expectedRowVersion: 3, name: "X" }, ACTOR))
        .resolves.toEqual(ROW);
      expect(calls).toHaveLength(3);
      const keys = new Set(calls.map((x) => x.headers["x-gs-bridge-idempotency-key"]));
      expect(keys.size).toBe(1);
      expect([...keys][0]).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(new Set(calls.map((x) => x.headers["x-gs-bridge-nonce"])).size).toBe(3);
      expect(sleeps).toEqual([300, 1_000]);
      expect(calls.every((x) => x.method === "PATCH" && x.body === JSON.stringify({ expectedRowVersion: 3, name: "X" }))).toBe(true);

      const stuck = client([json(503, {}), json(504, {}), json(502, {}), json(200, ROW)]);
      await expect(stuck.c.write("POST", "vendors", { slug: "a", name: "A" }, ACTOR)).rejects.toMatchObject({ code: "server_error" });
      expect(stuck.calls).toHaveLength(3);
    });

    it("never retries a 4xx, and a conflict carries the site's current row", async () => {
      for (const [status, siteCode, code, gsamStatus] of [
        [409, "conflict", "conflict", 409], [409, "idempotency_mismatch", "idempotency_mismatch", 409],
        [409, "over_refundable", "over_refundable", 409], [403, "denied", "denied", 403],
        [403, "capability_denied", "forbidden", 502], [400, "bad_request", "bad_request", 400], [404, "not_found", "not_found", 404],
      ] as const) {
        const { c, calls } = client([json(status, { error: { code: siteCode }, current: { id: "r1", row_version: 9 } }), json(200, ROW)]);
        const error = await c.write("PATCH", "vendors/r1", { expectedRowVersion: 1 }, ACTOR).catch((e: unknown) => e);
        expect(error, siteCode).toMatchObject({ code, status: gsamStatus, retryable: false });
        expect(calls, siteCode).toHaveLength(1);
        if (status === 409) expect((error as WebsiteBridgeError).current).toEqual({ id: "r1", row_version: 9 });
      }
    });

    it("a new logical call gets a new key; a caller's key is sent as given", async () => {
      const { c, calls } = client([json(201, ROW), json(201, ROW), json(201, ROW)]);
      await c.write("POST", "quotes/q1/convert", undefined, ACTOR);
      await c.write("POST", "quotes/q1/convert", undefined, ACTOR);
      await c.write("POST", "quotes/q1/convert", undefined, ACTOR, "UFFSU1RVVldYWVpbXF1eXw");
      expect(calls[0]!.headers["x-gs-bridge-idempotency-key"]).not.toBe(calls[1]!.headers["x-gs-bridge-idempotency-key"]);
      expect(calls[2]!.headers["x-gs-bridge-idempotency-key"]).toBe("UFFSU1RVVldYWVpbXF1eXw");
      // an operation with no body signs the empty body, as the shared vector does
      expect(calls[0]!.body).toBe("");
      expect(calls[0]!.url).toBe("https://staging.example.test/api/admin/v1/quotes/q1/convert");
    });

    it("records a refund request and a decision, and checks their shape", async () => {
      const request = { item: { id: "rr1", status: "requested", amount_minor: 100 } };
      const { c, calls } = client([json(201, request), json(200, { item: { id: "rr1", status: "approved" } }), json(201, { item: {} })]);
      await expect(c.requestRefund({ orderId: "o1", amountMinor: 100, reason: "Customer asked" }, ACTOR)).resolves.toEqual(request);
      await c.decideRefund("rr1", { decision: "approved", approvalRef: "a1" }, { type: "user", id: "u1" });
      expect(calls.map((x) => [x.method, x.url, x.body])).toEqual([
        ["POST", "https://staging.example.test/api/admin/v1/refund-requests", JSON.stringify({ orderId: "o1", amountMinor: 100, reason: "Customer asked" })],
        ["POST", "https://staging.example.test/api/admin/v1/refund-requests/rr1/decision", JSON.stringify({ decision: "approved", approvalRef: "a1" })],
      ]);
      await expect(c.requestRefund({ orderId: "o1", amountMinor: 1, reason: "r" }, ACTOR)).rejects.toMatchObject({ code: "bad_response" });
    });
  });

  it("refuses a bridge address that is not https", () => {
    expect(() => createWebsiteBridgeClient({ baseUrl: "http://greatstoneint.com", credential: CREDENTIAL })).toThrow(/must be https/);
  });
});
