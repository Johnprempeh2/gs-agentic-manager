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

  it("refuses a caller without website:view, and a site in another company is not found", async () => {
    const { base, companyId } = await seedSite();
    const { actor } = await seedAgent(companyId, []);
    await request(app(actor)).get(`${base}/data-bridge/status`).expect(403);
    await request(app(actor)).get(`${base}/data/orders`).expect(403);
    await request(app()).get(`/api/companies/${companyId}/website/sites/${randomUUID()}/data-bridge/status`).expect(404);
  });
});
