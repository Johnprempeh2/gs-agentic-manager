import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPublicKey, randomUUID, verify } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  companySecretVersions,
  companySecrets,
  createDb,
  heartbeatRuns,
  instanceSettings,
  principalPermissionGrants,
  secretAccessEvents,
  websiteSite,
} from "@greatstone/db";
import type { WebsiteDataBridgeKey, WebsiteDataBridgeStatus } from "@greatstone/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { websiteModuleRoutes } from "../routes/website-module.js";
import { websiteDataBridgeRoutes } from "../routes/website-data-bridge.js";
import { instanceSettingsService, secretService } from "../services/index.js";
import { createWebsiteBridgeClient, parseBridgeCredential, bridgeCanonicalQuery, bridgeCanonicalString } from "../services/website/data-bridge-client.js";
import { bridgeUrlOf, type WebsiteDataBridgeOptions } from "../services/website/data-bridge.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres website data bridge tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

type Actor = Express.Request["actor"];
type Seen = { url: string; headers: Record<string, string>; verified: boolean };

// GRE-2323: the read key's setup (people only; the private key never in a response), the "Website data" status, and
// signed reads that name the caller. The site is a fake fetch that checks each signature with the public key the
// key route returned, so the vault value, the public key and the signing are proved to fit together.
describeEmbeddedPostgres("website data bridge routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const keyFolder = mkdtempSync(path.join(os.tmpdir(), "paperclip-website-bridge-key-"));
  const previousKeyFile = process.env.GSAM_SECRETS_MASTER_KEY_FILE;
  let publicKeys = new Map<string, string>();
  let seen: Seen[] = [];
  let answer: (url: URL) => Response = () => new Response("{}", { status: 500 });

  // The fake site: verifies the signature with the public key the key route gave out, then answers.
  const fakeSite = (async (input: URL, init: RequestInit) => {
    const url = new URL(String(input));
    const headers = init.headers as Record<string, string>;
    const pub = publicKeys.get(headers["x-gs-bridge-key"]!);
    const canonical = bridgeCanonicalString({ method: "GET", host: url.host, path: url.pathname, query: bridgeCanonicalQuery(url.searchParams),
      time: Number(headers["x-gs-bridge-time"]), nonce: headers["x-gs-bridge-nonce"]!, actor: headers["x-gs-bridge-actor"]!,
      run: headers["x-gs-bridge-run"] ?? null, bodySha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" });
    const verified = Boolean(pub) && verify(null, Buffer.from(canonical), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pub! }, format: "jwk" }),
      Buffer.from(headers["x-gs-bridge-signature"]!, "base64url"));
    seen.push({ url: url.toString(), headers, verified });
    if (!verified) return new Response(JSON.stringify({ error: { code: "bad_signature" } }), { status: 401 });
    return answer(url);
  }) as unknown as typeof fetch;
  const bridgeOptions: WebsiteDataBridgeOptions = {
    clientFor: (site, value) => createWebsiteBridgeClient({ baseUrl: bridgeUrlOf(site), credential: parseBridgeCredential(value), fetchImpl: fakeSite }),
  };

  beforeAll(async () => {
    process.env.GSAM_SECRETS_MASTER_KEY_FILE = path.join(keyFolder, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-website-bridge-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    publicKeys = new Map();
    seen = [];
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(websiteSite);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) delete process.env.GSAM_SECRETS_MASTER_KEY_FILE;
    else process.env.GSAM_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(keyFolder, { recursive: true, force: true });
  });

  const board: Actor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };

  function app(actor: Actor = board) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", websiteModuleRoutes(db));
    instance.use("/api", websiteDataBridgeRoutes(db, bridgeOptions));
    instance.use(errorHandler);
    return instance;
  }

  async function seedSite() {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const [company] = await db.insert(companies).values({ name: "Greatstone", issuePrefix: `B${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}` }).returning();
    const site = (await request(app()).post(`/api/companies/${company!.id}/website/sites`)
      .send({ name: "Greatstone", domain: "www.greatstone.test", netlifySiteId: "n" }).expect(201)).body;
    return { companyId: company!.id as string, siteId: site.id as string, base: `/api/companies/${company!.id}/website/sites/${site.id}` };
  }

  async function seedAgent(companyId: string, keys: string[]) {
    const [agent] = await db.insert(agents)
      .values({ companyId, name: "Lintel", role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
      .returning();
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agent!.id, status: "active", membershipRole: "member" });
    for (const key of keys) {
      await db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: agent!.id, permissionKey: key, scope: null });
    }
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id }).returning();
    return { actor: { type: "agent", agentId: agent!.id, companyId, runId: run!.id, source: "agent_key" } as Actor, agentId: agent!.id as string, runId: run!.id as string };
  }

  async function makeKey(base: string, body: Record<string, unknown> = { environment: "stg" }) {
    const key = (await request(app()).post(`${base}/data-bridge/key`).send(body).expect(201)).body as WebsiteDataBridgeKey;
    publicKeys.set(key.keyId, key.publicKey);
    return key;
  }

  it("makes a read key for people only and never returns the private key", async () => {
    const { base, companyId, siteId } = await seedSite();
    const { actor } = await seedAgent(companyId, ["website:view", "website:edit", "website:publish"]);
    const refused = await request(app(actor)).post(`${base}/data-bridge/key`).send({ environment: "stg" }).expect(403);
    expect(refused.body.details?.code ?? refused.body.code).toBe("website_publish_agent_refused");
    expect(await db.select().from(companySecrets)).toHaveLength(0);

    const res = await request(app()).post(`${base}/data-bridge/key`).send({ environment: "stg" }).expect(201);
    const key = res.body as WebsiteDataBridgeKey;
    expect(key.keyId).toMatch(/^stg-read-\d{4}-\d{2}-[0-9a-f]{6}$/);
    expect(key.keysEntry).toEqual({ kid: key.keyId, capability: "read", publicKey: key.publicKey });
    expect(Buffer.from(key.publicKey, "base64url")).toHaveLength(32);
    expect(JSON.stringify(res.body)).not.toMatch(/PRIVATE KEY|privateKey/);

    const [site] = await db.select().from(websiteSite).where(eq(websiteSite.id, siteId));
    expect(site!.dataBridgeReadKeyId).toBe(key.keyId);
    const stored = parseBridgeCredential(await secretService(db).resolveSecretValue(companyId, site!.dataBridgeReadSecretId!, "latest", {
      accessContext: { consumerType: "system", consumerId: "test", actorType: "system" },
    }));
    expect(stored.kid).toBe(key.keyId);
    expect(createPublicKey(stored.privateKey).export({ format: "jwk" }).x).toBe(key.publicKey);
    const events = (await db.select().from(activityLog)).filter((e) => e.action === "website.data_bridge_key_created");
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0]!.details)).not.toMatch(/PRIVATE KEY/);

    // A second key replaces the first in the same vault secret, as a new version.
    const again = await makeKey(base, { environment: "live", url: "https://bridge.greatstone.test" });
    expect(again.keyId).toMatch(/^live-read-/);
    const secrets = await db.select().from(companySecrets);
    expect(secrets).toHaveLength(1);
    expect(await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secrets[0]!.id))).toHaveLength(2);
    await request(app()).post(`${base}/data-bridge/key`).send({ environment: "prod" }).expect(400);
    await request(app()).post(`${base}/data-bridge/key`).send({ environment: "stg", url: "http://plain.test" }).expect(400);
  });

  it("shows Website data as not set up, connected, then failing, and records each key use as a system access", async () => {
    const { base, siteId } = await seedSite();
    const http = request(app());
    expect((await http.get(`${base}/data-bridge/status`).expect(200)).body).toMatchObject({ state: "not_set_up", keyId: null, url: "https://www.greatstone.test" });

    const key = await makeKey(base);
    answer = () => Response.json({ ok: true, kid: key.keyId, capability: "read", serverTime: new Date(Date.now() + 3_000).toISOString(), schema: "gs-bridge-v1" });
    const ok = (await http.get(`${base}/data-bridge/status`).expect(200)).body as WebsiteDataBridgeStatus;
    expect(ok).toMatchObject({ state: "connected", keyId: key.keyId, message: null });
    expect(ok.clockSkewSeconds).toBeGreaterThanOrEqual(2);
    expect(seen[0]).toMatchObject({ verified: true, url: "https://www.greatstone.test/api/admin/v1/health" });
    expect(seen[0]!.headers["x-gs-bridge-actor"]).toBe("system:website-data-status");
    const [access] = await db.select().from(secretAccessEvents).where(eq(secretAccessEvents.consumerId, `website-data-bridge:${siteId}`));
    expect(access).toMatchObject({ consumerType: "system", actorType: "system", configPath: "dataBridge.readKey", outcome: "success" });

    // A new key on GSAM's side, not yet on the site: the site refuses it and the row says what to check.
    const second = (await http.post(`${base}/data-bridge/key`).send({ environment: "stg" }).expect(201)).body as WebsiteDataBridgeKey;
    const failing = (await http.get(`${base}/data-bridge/status`).expect(200)).body as WebsiteDataBridgeStatus;
    expect(failing).toMatchObject({ state: "failing", keyId: second.keyId });
    expect(failing.message).toMatch(/GSAM_BRIDGE_KEYS/);
  });

  it("reads through the bridge as the calling agent and run, read only", async () => {
    const { base, companyId } = await seedSite();
    const { actor, agentId, runId } = await seedAgent(companyId, ["website:view"]);
    const http = request(app(actor));
    const notSetUp = await http.get(`${base}/data/orders`).expect(409);
    expect(notSetUp.body.details?.code ?? notSetUp.body.code).toBe("website_bridge_not_configured");

    await makeKey(base);
    answer = (url) => url.pathname.endsWith("/orders")
      ? Response.json({ items: [{ id: "o1", reference: "O-1" }], nextCursor: "abc" })
      : url.pathname.endsWith("/orders/o1") ? Response.json({ item: { id: "o1" } })
        : new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
    const list = (await http.get(`${base}/data/orders?limit=1&customer=${randomUUID()}`).expect(200)).body;
    expect(list).toEqual({ items: [{ id: "o1", reference: "O-1" }], nextCursor: "abc" });
    expect(seen.at(-1)!.headers["x-gs-bridge-actor"]).toBe(`agent:${agentId}`);
    expect(seen.at(-1)!.headers["x-gs-bridge-run"]).toBe(runId);
    expect((await http.get(`${base}/data/orders/o1`).expect(200)).body).toEqual({ item: { id: "o1" } });
    await http.get(`${base}/data/quotes/q9`).expect(404);

    await http.get(`${base}/data/users`).expect(422);
    await http.get(`${base}/data/orders?limit=500`).expect(422);
    await http.get(`${base}/data/enquiries?customer=${randomUUID()}`).expect(422);
    await http.get(`${base}/data/orders/${"x".repeat(81)}`).expect(404);
    await http.post(`${base}/data/orders`).send({}).expect(404);
    // Each read was signed and the site saw a GET: there is no write route.
    expect(seen.every((s) => s.verified)).toBe(true);
  });

  it("reads commerce records, FX and the payment report on the read key, as the calling agent (GRE-2354 2c(a))", async () => {
    const { base, companyId } = await seedSite();
    const { actor, agentId } = await seedAgent(companyId, ["website:view"]);
    const http = request(app(actor));
    await http.get(`${base}/commerce/offerings`).expect(409);
    await http.get(`${base}/commerce/payments`).expect(409);

    const key = await makeKey(base);
    // the site's own shape (greatstone-website bridgePayments); GSAM adds from and to under `report`
    const siteReport = { stripeMode: "test", totals: [{ currency: "GBP", orders: 1, total_minor: "9000", refunded_minor: "500" }],
      refundRequests: [{ status: "requested", requests: 1, amount_minor: "500" }], items: [], nextCursor: null };
    const report = { from: "2026-10-01", to: "2026-10-31", ...siteReport };
    answer = (url) => {
      const path = url.pathname.replace("/api/admin/v1/", "");
      if (path === "offerings") return Response.json({ items: [{ id: "of1", status: "draft", variants: [] }], nextCursor: null });
      if (path === "vendors/v1") return Response.json({ item: { id: "v1", activation_instructions: "Sign in, then…" } });
      if (path === "imports/j1") return Response.json({ item: { id: "j1", status: "validated" }, rows: [{ row_no: 1 }], nextCursor: "c2" });
      if (path === "fx") return Response.json({ item: { usd_to_gbp_display_rate: "0.7900", row_version: 4, history: [] } });
      if (path === "payments") return Response.json(siteReport);
      return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
    };
    expect((await http.get(`${base}/commerce/offerings?limit=10`).expect(200)).body.items).toHaveLength(1);
    expect(seen.at(-1)!.url).toBe("https://www.greatstone.test/api/admin/v1/offerings?limit=10");
    expect(seen.at(-1)!.headers["x-gs-bridge-key"]).toBe(key.keyId);
    expect(seen.at(-1)!.headers["x-gs-bridge-actor"]).toBe(`agent:${agentId}`);
    expect((await http.get(`${base}/commerce/vendors/v1`).expect(200)).body.item.activation_instructions).toMatch(/Sign in/);
    expect((await http.get(`${base}/commerce/imports/j1?cursor=c1&limit=50`).expect(200)).body).toMatchObject({ rows: [{ row_no: 1 }], nextCursor: "c2" });
    expect(seen.at(-1)!.url).toBe("https://www.greatstone.test/api/admin/v1/imports/j1?cursor=c1&limit=50");
    expect((await http.get(`${base}/commerce/fx`).expect(200)).body.item.row_version).toBe(4);
    expect((await http.get(`${base}/commerce/payments?from=2026-10-01&to=2026-10-31`).expect(200)).body).toEqual({ report });
    expect(seen.at(-1)!.url).toBe("https://www.greatstone.test/api/admin/v1/payments?from=2026-10-01&to=2026-10-31");
    await http.get(`${base}/commerce/categories/missing`).expect(404);

    // Bad filters stop in GSAM, before any call to the site.
    const calls = seen.length;
    await http.get(`${base}/commerce/orders`).expect(422);
    await http.get(`${base}/commerce/offerings?customer=${randomUUID()}`).expect(422);
    await http.get(`${base}/commerce/vendors/v1?cursor=x`).expect(422);
    await http.get(`${base}/commerce/fx?x=1`).expect(422);
    await http.get(`${base}/commerce/payments?from=2026-11-01&to=2026-10-01`).expect(422);
    await http.get(`${base}/commerce/payments?from=yesterday`).expect(422);
    // writes are 2c(b)'s, behind website:commerce, which this agent does not hold
    await http.post(`${base}/commerce/offerings`).send({}).expect(403);
    expect(seen).toHaveLength(calls);

    // A report that carries a Stripe id never reaches the caller.
    answer = () => Response.json({ ...siteReport, lastIntent: "pi_3PqRsTuVwXyZ12345678" });
    const leaked = await http.get(`${base}/commerce/payments`).expect(502);
    expect(leaked.body.details?.code ?? leaked.body.code).toBe("website_bridge_bad_response");
    expect(JSON.stringify(leaked.body)).not.toMatch(/pi_3P/);
    expect(seen.every((s) => s.verified)).toBe(true);
  });

  it("reads billing lines for one customer through either read path with website:view", async () => {
    const { base, companyId } = await seedSite();
    const customer = randomUUID();
    const otherCustomer = randomUUID();
    const line = { id: randomUUID(), customer_id: customer, description: "Monthly service", qty: 2,
      unit_price_minor: "1250", currency: "GBP", billing_period: "monthly", next_bill_on: "2026-12-01", status: "active" };
    await makeKey(base);
    answer = (url) => Response.json({ items: url.searchParams.get("customer") === customer ? [line] : [], nextCursor: null });
    const { actor } = await seedAgent(companyId, ["website:view"]);

    for (const route of ["data", "commerce"]) {
      const path = `${base}/${route}/billing-lines`;
      expect((await request(app(actor)).get(`${path}?customer=${customer}`).expect(200)).body.items).toEqual([line]);
      expect(seen.at(-1)?.url).toBe(`https://www.greatstone.test/api/admin/v1/billing-lines?customer=${customer}`);
      expect((await request(app(actor)).get(`${path}?customer=${otherCustomer}`).expect(200)).body.items).toEqual([]);
      const calls = seen.length;
      await request(app(actor)).get(path).expect(422);
      await request(app(actor)).get(`${path}?customer=bad`).expect(422);
      expect(seen).toHaveLength(calls);
      await request(app(actor)).post(path).send({}).expect(route === "data" ? 404 : 403);
    }
    const { actor: denied } = await seedAgent(companyId, []);
    await request(app(denied)).get(`${base}/data/billing-lines?customer=${customer}`).expect(403);
    await request(app(denied)).get(`${base}/commerce/billing-lines?customer=${customer}`).expect(403);
    await request(app(actor)).get(`${base}/data/unknown-resource?customer=${customer}`).expect(422);
    await request(app(actor)).get(`${base}/commerce/unknown-resource?customer=${customer}`).expect(422);
  });

  it("refuses a caller without website:view, and a site in another company is not found", async () => {
    const { base, companyId } = await seedSite();
    const { actor } = await seedAgent(companyId, []);
    await request(app(actor)).get(`${base}/data-bridge/status`).expect(403);
    await request(app(actor)).get(`${base}/data/orders`).expect(403);
    await request(app(actor)).get(`${base}/commerce/offerings`).expect(403);
    await request(app(actor)).get(`${base}/commerce/payments`).expect(403);
    await request(app()).get(`/api/companies/${companyId}/website/sites/${randomUUID()}/data-bridge/status`).expect(404);
  });
});
