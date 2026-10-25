import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvalComments,
  approvals,
  companies,
  companyMemberships,
  companySecretVersions,
  companySecrets,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issueApprovals,
  principalPermissionGrants,
  secretAccessEvents,
  websiteSite,
} from "@greatstone/db";
import type { WebsiteDataBridgeKey, WebsiteDataBridgeStatus } from "@greatstone/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { approvalRoutes } from "../routes/approvals.js";
import { websiteModuleRoutes } from "../routes/website-module.js";
import { websiteDataBridgeRoutes } from "../routes/website-data-bridge.js";
import { instanceSettingsService } from "../services/index.js";
import { createWebsiteBridgeClient, parseBridgeCredential, bridgeCanonicalQuery, bridgeCanonicalString } from "../services/website/data-bridge-client.js";
import { bridgeUrlOf, type WebsiteDataBridgeOptions } from "../services/website/data-bridge.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres website commerce write tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

type Actor = Express.Request["actor"];
type Seen = { method: string; path: string; body: string; headers: Record<string, string>; verified: boolean; replayed: boolean };
type SiteAnswer = { status: number; body: unknown } | "network";

// GRE-2354 2c(b): commerce writes on the write key and refund requests on the refund_request key. The fake site
// checks every gs-bridge-v2 signature with the public key the key route gave out, and keeps answers by idempotency
// key the way the site's admin_bridge_idempotency does: same key and body replays, another body is a 409.
describeEmbeddedPostgres("website commerce write and refund routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const keyFolder = mkdtempSync(path.join(os.tmpdir(), "paperclip-website-commerce-key-"));
  const previousKeyFile = process.env.GSAM_SECRETS_MASTER_KEY_FILE;
  let publicKeys = new Map<string, string>();
  let seen: Seen[] = [];
  let stored = new Map<string, { bodySha: string; answer: { status: number; body: unknown } }>();
  /** The site's answer to a fresh (not replayed) call. "network": the call lands, but the answer is lost. */
  let answer: (method: string, path: string, body: unknown) => SiteAnswer = () => ({ status: 500, body: {} });
  /** How many more answers (fresh or replayed) the network loses after the site has acted. */
  let lose = 0;

  const fakeSite = (async (input: URL, init: RequestInit) => {
    const url = new URL(String(input));
    const headers = init.headers as Record<string, string>;
    const body = typeof init.body === "string" ? init.body : "";
    const bodySha = createHash("sha256").update(body).digest("hex");
    const pub = publicKeys.get(headers["x-gs-bridge-key"]!);
    const idempotencyKey = headers["x-gs-bridge-idempotency-key"];
    const canonical = bridgeCanonicalString({ method: String(init.method), host: url.host, path: url.pathname,
      query: bridgeCanonicalQuery(url.searchParams), time: Number(headers["x-gs-bridge-time"]), nonce: headers["x-gs-bridge-nonce"]!,
      actor: headers["x-gs-bridge-actor"]!, run: headers["x-gs-bridge-run"] ?? null, bodySha256: bodySha, idempotencyKey });
    const verified = Boolean(pub) && Boolean(idempotencyKey) && canonical.startsWith("gs-bridge-v2\n")
      && verify(null, Buffer.from(canonical), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pub! }, format: "jwk" }),
        Buffer.from(headers["x-gs-bridge-signature"]!, "base64url"));
    const pathName = url.pathname.replace("/api/admin/v1/", "");
    const prior = idempotencyKey ? stored.get(`${headers["x-gs-bridge-key"]}:${idempotencyKey}`) : undefined;
    seen.push({ method: String(init.method), path: pathName, body, headers, verified, replayed: Boolean(prior && prior.bodySha === bodySha) });
    if (!verified) return Response.json({ error: { code: "bad_signature" } }, { status: 401 });
    if (prior) {
      if (prior.bodySha !== bodySha) return Response.json({ error: { code: "idempotency_mismatch" } }, { status: 409 });
      if (lose > 0) { lose -= 1; throw new TypeError("fetch failed"); }
      return Response.json(prior.answer.body, { status: prior.answer.status });
    }
    const out = answer(String(init.method), pathName, body ? JSON.parse(body) : undefined);
    const landed = out === "network" ? { status: 200, body: { item: { id: "lost" } } } : out;
    // a 5xx rolls the site's transaction back, so its key is not claimed
    if (landed.status < 500) stored.set(`${headers["x-gs-bridge-key"]}:${idempotencyKey}`, { bodySha, answer: landed });
    if (out === "network" || (lose > 0 && out.status < 300)) { if (out !== "network") lose -= 1; throw new TypeError("fetch failed"); }
    return Response.json(out.body, { status: out.status });
  }) as unknown as typeof fetch;
  const bridgeOptions: WebsiteDataBridgeOptions = {
    clientFor: (site, value) => createWebsiteBridgeClient({ baseUrl: bridgeUrlOf(site), credential: parseBridgeCredential(value),
      fetchImpl: fakeSite, sleep: async () => {} }),
  };

  beforeAll(async () => {
    process.env.GSAM_SECRETS_MASTER_KEY_FILE = path.join(keyFolder, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-website-commerce-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    publicKeys = new Map();
    seen = [];
    stored = new Map();
    lose = 0;
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(issueApprovals);
    await db.delete(approvalComments);
    await db.delete(approvals);
    await db.delete(websiteSite);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agentWakeupRequests);
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
    instance.use("/api", approvalRoutes(db, { websiteDataBridge: bridgeOptions }));
    instance.use(errorHandler);
    return instance;
  }

  async function seedSite() {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const [company] = await db.insert(companies).values({ name: "Greatstone", issuePrefix: `C${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}` }).returning();
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
    return { actor: { type: "agent", agentId: agent!.id, companyId, runId: run!.id, source: "agent_key" } as Actor, agentId: agent!.id as string };
  }

  async function seedUser(companyId: string, role: "owner" | "admin" | "operator", source: "session" | "board_key" = "session") {
    const userId = `user${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: role });
    return { userId, actor: { type: "board", userId, source, isInstanceAdmin: false, companyIds: [companyId],
      memberships: [{ companyId, membershipRole: role, status: "active" }] } as Actor };
  }

  async function makeKey(base: string, capability: "read" | "write" | "refund_request") {
    const key = (await request(app()).post(`${base}/data-bridge/key`).send({ environment: "stg", capability }).expect(201)).body as WebsiteDataBridgeKey;
    publicKeys.set(key.keyId, key.publicKey);
    return key;
  }

  const ROW = "c0ffee00-0000-4000-8000-000000000001";
  const ORDER = "c3000000-0000-4000-8000-000000000001";

  it("makes write and refund keys for people only, shows their ids, and never returns a private key", async () => {
    const { base, companyId, siteId } = await seedSite();
    const { actor } = await seedAgent(companyId, ["website:view", "website:commerce"]);
    await request(app(actor)).post(`${base}/data-bridge/key`).send({ environment: "stg", capability: "refund_request" }).expect(403);
    const read = await makeKey(base, "read");
    const write = await makeKey(base, "write");
    const refundRes = await request(app()).post(`${base}/data-bridge/key`).send({ environment: "stg", capability: "refund_request" }).expect(201);
    const refund = refundRes.body as WebsiteDataBridgeKey;
    expect(write.keyId).toMatch(/^stg-write-\d{4}-\d{2}-[0-9a-f]{6}$/);
    expect(refund.keyId).toMatch(/^stg-refund-\d{4}-\d{2}-[0-9a-f]{6}$/);
    expect(refund.keysEntry).toEqual({ kid: refund.keyId, capability: "refund_request", publicKey: refund.publicKey });
    expect(JSON.stringify(refundRes.body)).not.toMatch(/PRIVATE KEY|privateKey/);
    const [site] = await db.select().from(websiteSite).where(eq(websiteSite.id, siteId));
    expect(site).toMatchObject({ dataBridgeReadKeyId: read.keyId, dataBridgeWriteKeyId: write.keyId, dataBridgeRefundKeyId: refund.keyId });
    expect(new Set([site!.dataBridgeReadSecretId, site!.dataBridgeWriteSecretId, site!.dataBridgeRefundSecretId]).size).toBe(3);
    expect(JSON.stringify(await db.select().from(activityLog))).not.toMatch(/PRIVATE KEY/);

    const status = (await request(app()).get(`${base}/data-bridge/status`).expect(200)).body as WebsiteDataBridgeStatus;
    expect(status).toMatchObject({ writeKeyId: write.keyId, refundKeyId: refund.keyId });
  });

  it("fails closed: no write or refund key is 409 capability_not_configured, with no call to the site and no card", async () => {
    const { base } = await seedSite();
    await makeKey(base, "read");
    const http = request(app());
    const write = await http.post(`${base}/commerce/vendors`).send({ slug: "a", name: "A" }).expect(409);
    expect(write.body).toMatchObject({ code: "capability_not_configured", error: "Commerce changes are off for this site: no write key is set up" });
    await http.patch(`${base}/commerce/fx`).send({ usdToGbpDisplayRate: "0.8", expectedRowVersion: 1 }).expect(409);
    const refund = await http.post(`${base}/commerce/refund-requests`).send({ orderId: ORDER, amountMinor: 100, reason: "r" }).expect(409);
    expect(refund.body).toMatchObject({ code: "capability_not_configured", error: "Commerce changes are off for this site: no refund key is set up" });
    expect(seen).toHaveLength(0);
    expect(await db.select().from(approvals)).toHaveLength(0);
  });

  it("lets an agent with website:commerce draft, and refuses it every people-only operation before any call", async () => {
    const { base, companyId } = await seedSite();
    await makeKey(base, "write");
    const { actor, agentId } = await seedAgent(companyId, ["website:view", "website:commerce"]);
    const http = request(app(actor));
    answer = (method, p, body) => ({ status: method === "POST" ? 201 : 200, body: { item: { id: ROW, path: p, ...(body as object) } } });

    const made = await http.post(`${base}/commerce/offerings`).send({ type: "product", slug: "words", name: "Words" }).expect(201);
    expect(made.body.item).toMatchObject({ id: ROW, path: "offerings", name: "Words" });
    expect(seen.at(-1)).toMatchObject({ method: "POST", path: "offerings", verified: true });
    expect(seen.at(-1)!.headers["x-gs-bridge-actor"]).toBe(`agent:${agentId}`);
    await http.patch(`${base}/commerce/offerings/${ROW}/variants/${ROW}`).send({ expectedRowVersion: 2, name: "V" }).expect(200);
    await http.delete(`${base}/commerce/offerings/${ROW}/specs/${ROW}`).expect(200);
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", path: `offerings/${ROW}/specs/${ROW}`, body: "" });
    await http.post(`${base}/commerce/quotes/${ROW}/convert`).expect(201);
    await http.post(`${base}/commerce/imports`).send({ filename: "f.csv", type: "offerings", rows: [] }).expect(201);
    const calls = seen.length;

    for (const [method, p] of [
      ["post", `offerings/${ROW}/publish`], ["post", `vendors/${ROW}/archive`], ["patch", "fx"],
      ["post", `imports/${ROW}/apply`], ["post", `invoices/${ROW}/issue`],
    ] as const) {
      const refused = await http[method](`${base}/commerce/${p}`).send({ expectedRowVersion: 1 }).expect(403);
      expect(refused.body.code, p).toBe("website_commerce_people_only");
    }
    // a board API key is a script, not a click
    const { actor: script } = await seedUser(companyId, "owner", "board_key");
    await request(app(script)).post(`${base}/commerce/offerings/${ROW}/publish`).send({ expectedRowVersion: 1 }).expect(403);
    // unknown operations and ids that are not uuids never reach the site
    await http.post(`${base}/commerce/orders`).send({}).expect(404);
    await http.post(`${base}/commerce/offerings/not-a-uuid/publish`).send({}).expect(404);
    await http.put(`${base}/commerce/offerings`).send({}).expect(404);
    await http.post(`${base}/commerce/refund-requests/${ROW}/decision`).send({ decision: "approved" }).expect(404);
    expect(seen).toHaveLength(calls);

    // a person does the people-only operations, in their own name
    const { actor: owner, userId } = await seedUser(companyId, "owner");
    await request(app(owner)).post(`${base}/commerce/offerings/${ROW}/publish`).send({ expectedRowVersion: 3 }).expect(200);
    expect(seen.at(-1)!.headers["x-gs-bridge-actor"]).toBe(`user:${userId}`);
    expect(seen.every((s) => s.verified)).toBe(true);
    const changed = (await db.select().from(activityLog)).filter((e) => e.action === "website.commerce_changed");
    expect(changed.map((e) => (e.details as { operation: string }).operation)).toContain("offerings.publish");
  });

  it("needs website:commerce: an agent with view and edit, and an operator, are refused; an admin is allowed", async () => {
    const { base, companyId } = await seedSite();
    await makeKey(base, "write");
    answer = () => ({ status: 201, body: { item: { id: ROW } } });
    const { actor } = await seedAgent(companyId, ["website:view", "website:edit"]);
    await request(app(actor)).post(`${base}/commerce/vendors`).send({ slug: "a", name: "A" }).expect(403);
    const { actor: operator } = await seedUser(companyId, "operator");
    await request(app(operator)).post(`${base}/commerce/vendors`).send({ slug: "a", name: "A" }).expect(403);
    expect(seen).toHaveLength(0);
    const { actor: admin } = await seedUser(companyId, "admin");
    await request(app(admin)).post(`${base}/commerce/vendors`).send({ slug: "a", name: "A" }).expect(201);
  });

  it("retries a lost write with the same idempotency key, writes once, and passes a conflict's current row back", async () => {
    const { base } = await seedSite();
    await makeKey(base, "write");
    let fresh = 0;
    answer = () => (fresh++ === 0 ? "network" : { status: 200, body: { item: { id: ROW } } });
    await request(app()).patch(`${base}/commerce/vendors/${ROW}`).send({ expectedRowVersion: 1, name: "B" }).expect(200);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.headers["x-gs-bridge-idempotency-key"]).toBe(seen[1]!.headers["x-gs-bridge-idempotency-key"]);
    expect(seen[0]!.headers["x-gs-bridge-nonce"]).not.toBe(seen[1]!.headers["x-gs-bridge-nonce"]);
    expect(seen[1]!.replayed).toBe(true);
    expect(fresh).toBe(1);

    // the caller's Idempotency-Key: a repeated call replays; another body under it is refused
    const key = "UFFSU1RVVldYWVpbXF1eXw";
    await request(app()).patch(`${base}/commerce/vendors/${ROW}`).set("Idempotency-Key", key).send({ expectedRowVersion: 2, name: "C" }).expect(200);
    await request(app()).patch(`${base}/commerce/vendors/${ROW}`).set("Idempotency-Key", key).send({ expectedRowVersion: 2, name: "C" }).expect(200);
    expect(seen.at(-1)!.replayed).toBe(true);
    const mismatch = await request(app()).patch(`${base}/commerce/vendors/${ROW}`).set("Idempotency-Key", key).send({ name: "D" }).expect(409);
    expect(mismatch.body.code).toBe("website_bridge_idempotency_mismatch");
    await request(app()).patch(`${base}/commerce/vendors/${ROW}`).set("Idempotency-Key", "short").send({ name: "D" }).expect(422);

    answer = () => ({ status: 409, body: { error: { code: "conflict" }, current: { id: ROW, row_version: 7 } } });
    const calls = seen.length;
    const stale = await request(app()).patch(`${base}/commerce/vendors/${ROW}`).send({ expectedRowVersion: 1, name: "E" }).expect(409);
    expect(stale.body).toMatchObject({ code: "website_bridge_conflict", details: { current: { id: ROW, row_version: 7 } } });
    expect(seen).toHaveLength(calls + 1);
  });

  describe("refund requests (commerce_refund_request)", () => {
    async function refundWorld() {
      const world = await seedSite();
      await makeKey(world.base, "refund_request");
      const agent = await seedAgent(world.companyId, ["website:view", "website:commerce"]);
      const owner = await seedUser(world.companyId, "owner");
      return { ...world, agent, owner };
    }
    const requested = (body: unknown) => ({ status: 201, body: { item: { id: "rr-1", status: "requested", currency: "GBP", ...(body as object) } } });

    it("records the request on the refund key, opens one card, and the person's approval goes to the site in their name", async () => {
      const { base, companyId, agent, owner } = await refundWorld();
      answer = (_m, p, body) => (p === "refund-requests" ? requested(body)
        : { status: 200, body: { item: { id: "rr-1", status: (body as { decision: string }).decision } } });
      const res = await request(app(agent.actor)).post(`${base}/commerce/refund-requests`)
        .send({ orderId: ORDER, amountMinor: 1250, reason: "Customer cancelled" }).expect(201);
      expect(res.body.request).toMatchObject({ id: "rr-1", status: "requested" });
      expect(seen[0]).toMatchObject({ method: "POST", path: "refund-requests", verified: true });
      expect(seen[0]!.headers["x-gs-bridge-key"]).toMatch(/^stg-refund-/);
      expect(seen[0]!.headers["x-gs-bridge-actor"]).toBe(`agent:${agent.agentId}`);
      const cards = await db.select().from(approvals);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ type: "commerce_refund_request", status: "pending", requestedByAgentId: agent.agentId });
      expect(cards[0]!.payload).toMatchObject({ orderId: ORDER, amountMinor: 1250, currency: "GBP", requestId: "rr-1", requestStatus: "requested" });

      // agents and board API keys cannot decide; nor can a person without website:commerce
      await request(app(agent.actor)).post(`/api/approvals/${cards[0]!.id}/approve`).send({}).expect(403);
      const { actor: script } = await seedUser(companyId, "owner", "board_key");
      await request(app(script)).post(`/api/approvals/${cards[0]!.id}/approve`).send({}).expect(403);
      const { actor: operator } = await seedUser(companyId, "operator");
      await request(app(operator)).post(`/api/approvals/${cards[0]!.id}/approve`).send({}).expect(403);
      await request(app(owner.actor)).post(`/api/approvals/${cards[0]!.id}/request-revision`).send({ decisionNote: "x" }).expect(422);
      expect(seen).toHaveLength(1);

      const approved = await request(app(owner.actor)).post(`/api/approvals/${cards[0]!.id}/approve`).send({}).expect(200);
      expect(approved.body).toMatchObject({ status: "approved", payload: { requestStatus: "approved" } });
      expect(seen[1]).toMatchObject({ method: "POST", path: "refund-requests/rr-1/decision", verified: true });
      expect(JSON.parse(seen[1]!.body)).toEqual({ decision: "approved", approvalRef: cards[0]!.id });
      expect(seen[1]!.headers["x-gs-bridge-actor"]).toBe(`user:${owner.userId}`);
    });

    it("a rejection goes to the site too; a refusal at request time cancels the card", async () => {
      const { base, agent, owner } = await refundWorld();
      answer = (_m, p, body) => (p === "refund-requests" ? requested(body) : { status: 200, body: { item: { id: "rr-1", status: "rejected" } } });
      const res = await request(app(agent.actor)).post(`${base}/commerce/refund-requests`).send({ orderId: ORDER, amountMinor: 5, reason: "r" }).expect(201);
      await request(app(owner.actor)).post(`/api/approvals/${res.body.approval.id}/reject`).send({}).expect(200);
      expect(JSON.parse(seen.at(-1)!.body)).toMatchObject({ decision: "rejected" });

      answer = () => ({ status: 409, body: { error: { code: "over_refundable" } } });
      const over = await request(app(agent.actor)).post(`${base}/commerce/refund-requests`).send({ orderId: ORDER, amountMinor: 999999, reason: "r" }).expect(409);
      expect(over.body.code).toBe("website_bridge_over_refundable");
      const [card] = await db.select().from(approvals).where(eq(approvals.id, over.body.details?.approvalId ?? "00000000-0000-4000-8000-000000000000"));
      expect(card).toBeUndefined();
      const cancelled = (await db.select().from(approvals)).filter((a) => a.status === "cancelled");
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0]!.decisionNote).toMatch(/did not record/);
      await request(app(agent.actor)).post(`${base}/commerce/refund-requests`).send({ orderId: "nope", amountMinor: 1, reason: "r" }).expect(422);
      await request(app(owner.actor)).post(`/api/companies/${owner.actor.type === "board" ? (await db.select().from(companies))[0]!.id : ""}/approvals`)
        .send({ type: "commerce_refund_request", payload: {} }).expect(422);
    });

    it("never strands a request: a lost answer keeps the card open, and deciding it records the request once first", async () => {
      const { base, agent, owner } = await refundWorld();
      answer = (_m, _p, body) => requested(body);
      // the site records the request, but every answer is lost: three tries, one key
      lose = 3;
      const res = await request(app(agent.actor)).post(`${base}/commerce/refund-requests`).send({ orderId: ORDER, amountMinor: 100, reason: "r" }).expect(202);
      expect(res.body).toMatchObject({ request: null, approval: { status: "pending", payload: { requestId: null } } });
      expect(seen).toHaveLength(3);
      expect(new Set(seen.map((s) => s.headers["x-gs-bridge-idempotency-key"])).size).toBe(1);
      expect(seen.filter((s) => !s.replayed)).toHaveLength(1);

      // deciding: the request is sent again under the same key (a replay, so still one row), then the decision,
      // which the site cannot take yet (503 three times: two retries): the card goes back to pending
      seen = [];
      lose = 0;
      answer = (_m, p, body) => (p === "refund-requests" ? requested(body) : { status: 503, body: { error: { code: "unavailable" } } });
      await request(app(owner.actor)).post(`/api/approvals/${res.body.approval.id}/approve`).send({}).expect(502);
      expect(seen.map((s) => [s.path, s.replayed])).toEqual([["refund-requests", true], ...Array(3).fill(["refund-requests/rr-1/decision", false])]);
      expect((await db.select().from(approvals))[0]).toMatchObject({ status: "pending", decidedByUserId: null, payload: { requestId: "rr-1" } });

      // the next click lands: same decision key, so even a decision that had landed would only replay
      seen = [];
      answer = () => ({ status: 200, body: { item: { id: "rr-1", status: "approved" } } });
      const approved = await request(app(owner.actor)).post(`/api/approvals/${res.body.approval.id}/approve`).send({}).expect(200);
      expect(seen.map((s) => s.path)).toEqual(["refund-requests/rr-1/decision"]);
      expect(approved.body).toMatchObject({ status: "approved", payload: { requestId: "rr-1", requestStatus: "approved" } });
    });

    it("the caller's Idempotency-Key returns the same card, and the site records one request", async () => {
      const { base, agent } = await refundWorld();
      answer = (_m, _p, body) => requested(body);
      const key = "UFFSU1RVVldYWVpbXF1eXw";
      const send = (amountMinor: number) => request(app(agent.actor)).post(`${base}/commerce/refund-requests`).set("Idempotency-Key", key)
        .send({ orderId: ORDER, amountMinor, reason: "r" });
      const first = await send(100).expect(201);
      const again = await send(100).expect(200);
      expect(again.body.approval.id).toBe(first.body.approval.id);
      expect(await db.select().from(approvals)).toHaveLength(1);
      expect(seen.filter((s) => !s.replayed)).toHaveLength(1);
      const other = await send(200).expect(409);
      expect(other.body.code).toBe("website_bridge_idempotency_mismatch");
    });

    it("keeps the card open when the site's answer to a request cannot be read", async () => {
      const { base, agent } = await refundWorld();
      answer = () => ({ status: 201, body: { item: { odd: true } } });
      await request(app(agent.actor)).post(`${base}/commerce/refund-requests`).send({ orderId: ORDER, amountMinor: 100, reason: "r" }).expect(202);
      expect((await db.select().from(approvals))[0]).toMatchObject({ status: "pending" });
    });

    it("cancels the card when the site says the request can no longer be decided", async () => {
      const { base, agent, owner } = await refundWorld();
      answer = (_m, p, body) => (p === "refund-requests" ? requested(body) : { status: 409, body: { error: { code: "conflict" } } });
      const res = await request(app(agent.actor)).post(`${base}/commerce/refund-requests`).send({ orderId: ORDER, amountMinor: 100, reason: "r" }).expect(201);
      await request(app(owner.actor)).post(`/api/approvals/${res.body.approval.id}/approve`).send({}).expect(409);
      const [card] = await db.select().from(approvals);
      expect(card).toMatchObject({ status: "cancelled" });
      expect(card!.decisionNote).toMatch(/could not take this decision/);
    });
  });
});
