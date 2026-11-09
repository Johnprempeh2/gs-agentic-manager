import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  issueComments,
  issues,
  principalPermissionGrants,
  secretAccessEvents,
  websiteSite,
} from "@greatstone/db";
import type { WebsiteDataBridgeKey } from "@greatstone/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { approvalRoutes } from "../routes/approvals.js";
import { websiteModuleRoutes } from "../routes/website-module.js";
import { websiteDataBridgeRoutes } from "../routes/website-data-bridge.js";
import { instanceSettingsService } from "../services/index.js";
import { createWebsiteBridgeClient, parseBridgeCredential, bridgeCanonicalQuery, bridgeCanonicalString } from "../services/website/data-bridge-client.js";
import { bridgeUrlOf, type WebsiteDataBridgeOptions } from "../services/website/data-bridge.js";

const wakeups = vi.hoisted(() => [] as Array<{ agentId: string; opts: Record<string, unknown> }>);
vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => ({
      ...actual.heartbeatService(...args),
      wakeup: async (agentId: string, opts: Record<string, unknown>) => { wakeups.push({ agentId, opts }); return null; },
    }),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres commerce settings tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

type Actor = Express.Request["actor"];
type Seen = { method: string; path: string; body: string; headers: Record<string, string>; verified: boolean; replayed: boolean };

const ORDER = "0d000000-0000-4000-8000-000000000001";
const CLIENT = "c0000000-0000-4000-8000-000000000001";
const LICENCE = "1c000000-0000-4000-8000-000000000001";
const ITEM = "e0000000-0000-4000-8000-000000000001";
const TIER = "70000000-0000-4000-8000-000000000001";
const RECEIPT = "a0000000-0000-4000-8000-000000000009";
const LEAD = "fd-f0000000-0000-4000-8000-000000000001";
const KEY = "ABCD-EFGH-IJKL-9876";

// GRE-4783: commerce settings through the bridge (contract "Commerce settings", GRE-4782). The fake site checks each
// signature with the public key the key route gave out, keeps answers by idempotency key, and refuses an agent or
// system actor every people-only change (403 denied), as greatstone-website's settingsRoute does.
describeEmbeddedPostgres("website commerce settings routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const keyFolder = mkdtempSync(path.join(os.tmpdir(), "paperclip-website-settings-key-"));
  const previousKeyFile = process.env.GSAM_SECRETS_MASTER_KEY_FILE;
  let publicKeys = new Map<string, string>();
  let seen: Seen[] = [];
  let stored = new Map<string, { bodySha: string; answer: { status: number; body: unknown } }>();
  let lose = 0;
  let order: Record<string, unknown>;
  let licence: Record<string, unknown>;
  let item: Record<string, unknown>;

  function resetSite() {
    order = { id: ORDER, reference: "GS-1001", status: "confirmed", row_version: 1 };
    licence = { id: LICENCE, customer_id: CLIENT, offering_name: "Aspose.Total", licence_key_last4: "1111", status: "issued", row_version: 1 };
    item = { id: ITEM, customer_id: CLIENT, title: "Kick-off", status: "shared", row_version: 1 };
  }

  const PEOPLE = [/^orders\/[^/]+\/notify-licence$/, /^customers\/[^/]+\/licences$/, /^licences\/[^/]+\/(?:revoke|reissue)$/,
    /^engagements\/[^/]+\/(?:share|unshare)$/, /^portal-acceptances\/[^/]+\/resend$/];

  function siteAnswer(method: string, p: string, body: Record<string, unknown> | undefined, actor: string): { status: number; body: unknown } {
    const person = actor.startsWith("user:");
    const denied = { status: 403, body: { error: { code: "denied" } } };
    const stale = (row: Record<string, unknown>) => body?.expectedRowVersion !== undefined && body.expectedRowVersion !== row.row_version;
    if (method === "GET") {
      if (p === `orders/${ORDER}`) return { status: 200, body: { item: order } };
      if (p === `licences/${LICENCE}`) return { status: 200, body: { item: licence } };
      if (p === `engagements/${ITEM}`) return { status: 200, body: { item } };
      if (p === `customers/${CLIENT}`) return { status: 200, body: { item: { id: CLIENT, name: "Acme Ltd", row_version: 1 } } };
      return { status: 404, body: { error: { code: "not_found" } } };
    }
    if (!person && (PEOPLE.some((re) => re.test(p)) || (p === `enquiries/${LEAD}` && method === "DELETE")
      || (body && "tierId" in body) || (body && ("licenceKey" in body || "downloadUrl" in body))
      || (p === `engagements/${ITEM}` && item.status === "shared"))) return denied;
    if (p === `orders/${ORDER}` && method === "PATCH") {
      if (stale(order)) return { status: 409, body: { error: { code: "conflict" }, current: order } };
      Object.assign(order, { status: body!.status, row_version: Number(order.row_version) + 1 });
      return { status: 200, body: { item: order } };
    }
    if (p === `orders/${ORDER}/notify-licence`) return { status: 200, body: { item: order, email: "sent" } };
    if (p === `enquiries/${LEAD}` && method === "DELETE") return { status: 200, body: { id: LEAD, deleted: true } };
    if (p === "customers" && method === "POST") return { status: 201, body: { item: { id: CLIENT, name: body!.name, tier_id: body!.tierId ?? null, row_version: 1 } } };
    if (p === `customers/${CLIENT}/licences`) {
      return { status: 201, body: { item: { ...licence, id: randomUUID(), licence_key_last4: String(body!.licenceKey ?? "").slice(-4) } } };
    }
    if (p === `licences/${LICENCE}/revoke`) {
      if (licence.status === "revoked") return { status: 409, body: { error: { code: "conflict" } } };
      if (stale(licence)) return { status: 409, body: { error: { code: "conflict" } } };
      Object.assign(licence, { status: "revoked", row_version: Number(licence.row_version) + 1 });
      return { status: 200, body: { item: licence } };
    }
    if (p === `licences/${LICENCE}` && method === "PATCH") {
      const { licenceKey, expectedRowVersion: _v, ...rest } = body!;
      Object.assign(licence, rest, licenceKey ? { licence_key_last4: String(licenceKey).slice(-4) } : {}, { row_version: Number(licence.row_version) + 1 });
      return { status: 200, body: { item: licence } };
    }
    if (p === `engagements/${ITEM}/unshare`) {
      Object.assign(item, { status: "draft", row_version: Number(item.row_version) + 1 });
      return { status: 200, body: { item } };
    }
    if (p === "customer-tiers" && method === "POST") return { status: 201, body: { item: { id: TIER, ...body } } };
    if (p === `portal-acceptances/${RECEIPT}/resend`) return { status: 200, body: { item: { acceptanceId: RECEIPT, status: "queued", attempts: 0 } } };
    return { status: 404, body: { error: { code: "not_found" } } };
  }

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
    const verified = Boolean(pub) && (idempotencyKey ? canonical.startsWith("gs-bridge-v2\n") : String(init.method) === "GET")
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
    const out = siteAnswer(String(init.method), pathName, body ? JSON.parse(body) : undefined, headers["x-gs-bridge-actor"]!);
    if (idempotencyKey) stored.set(`${headers["x-gs-bridge-key"]}:${idempotencyKey}`, { bodySha, answer: out });
    if (idempotencyKey && lose > 0 && out.status < 300) { lose -= 1; throw new TypeError("fetch failed"); }
    return Response.json(out.body, { status: out.status });
  }) as unknown as typeof fetch;
  const bridgeOptions: WebsiteDataBridgeOptions = {
    clientFor: (site, value) => createWebsiteBridgeClient({ baseUrl: bridgeUrlOf(site), credential: parseBridgeCredential(value),
      fetchImpl: fakeSite, sleep: async () => {} }),
  };

  beforeAll(async () => {
    process.env.GSAM_SECRETS_MASTER_KEY_FILE = path.join(keyFolder, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-website-settings-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    publicKeys = new Map();
    seen = [];
    stored = new Map();
    lose = 0;
    wakeups.length = 0;
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(issueApprovals);
    await db.delete(issueComments);
    await db.delete(issues);
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

  async function makeKey(base: string, capability: "read" | "write") {
    const key = (await request(app()).post(`${base}/data-bridge/key`).send({ environment: "stg", capability }).expect(201)).body as WebsiteDataBridgeKey;
    publicKeys.set(key.keyId, key.publicKey);
    return key;
  }

  async function seedWorld({ write = true } = {}) {
    resetSite();
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const [company] = await db.insert(companies).values({ name: "Greatstone", issuePrefix: `C${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}` }).returning();
    const companyId = company!.id;
    const site = (await request(app()).post(`/api/companies/${companyId}/website/sites`)
      .send({ name: "Greatstone", domain: "www.greatstone.test", netlifySiteId: "n" }).expect(201)).body;
    const base = `/api/companies/${companyId}/website/sites/${site.id}`;
    await makeKey(base, "read");
    if (write) await makeKey(base, "write");

    const [agent] = await db.insert(agents)
      .values({ companyId, name: "Lintel", role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
      .returning();
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agent!.id, status: "active", membershipRole: "member" });
    for (const permissionKey of ["website:view", "website:commerce"]) {
      await db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: agent!.id, permissionKey, scope: null });
    }
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id }).returning();
    const agentActor = { type: "agent", agentId: agent!.id, companyId, runId: run!.id, source: "agent_key" } as Actor;

    const person = async (role: "owner" | "admin" | "operator", source: "session" | "board_key" = "session") => {
      const userId = `user${randomUUID().replace(/-/g, "").slice(0, 10)}`;
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: role });
      return { userId, actor: { type: "board", userId, source, isInstanceAdmin: false, companyIds: [companyId],
        memberships: [{ companyId, membershipRole: role, status: "active" }] } as Actor };
    };
    const owner = await person("owner");
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, identifier: "C-1", title: "Licence for Acme",
      status: "in_progress", priority: "medium", assigneeAgentId: agent!.id });
    return { companyId, siteId: site.id as string, base, agent: { actor: agentActor, agentId: agent!.id }, owner, person, issueId };
  }

  const writes = () => seen.filter((s) => s.method !== "GET");

  it("an agent makes plain status and record edits at once, on the write key in its own name", async () => {
    const world = await seedWorld();
    const http = request(app(world.agent.actor));
    const done = await http.patch(`${world.base}/commerce/orders/${ORDER}`).send({ status: "fulfilled", expectedRowVersion: 1 }).expect(200);
    expect(done.body.item).toMatchObject({ status: "fulfilled", row_version: 2 });
    await http.post(`${world.base}/commerce/customers`).send({ name: "Acme Ltd" }).expect(201);
    await http.post(`${world.base}/commerce/customer-tiers`).send({ slug: "gold", name: "Gold" }).expect(201);
    item.status = "draft";
    await http.post(`${world.base}/commerce/engagements/${ITEM}/share`).send({}).expect(403);
    expect(writes().map((s) => `${s.method} ${s.path}`)).toEqual([`PATCH orders/${ORDER}`, "POST customers", "POST customer-tiers"]);
    for (const s of writes()) {
      expect(s.verified).toBe(true);
      expect(s.headers["x-gs-bridge-key"]).toMatch(/^stg-write-/);
      expect(s.headers["x-gs-bridge-actor"]).toBe(`agent:${world.agent.agentId}`);
    }
    const logged = (await db.select().from(activityLog)).filter((e) => e.action === "website.commerce_changed");
    expect(logged.map((e) => (e.details as { operation: string }).operation)).toEqual(["orders.edit", "customers.create", "customer-tiers.create"]);
    // a stale row version comes back as 409 with the row as it is now
    const stale = await http.patch(`${world.base}/commerce/orders/${ORDER}`).send({ status: "confirmed", expectedRowVersion: 1 }).expect(409);
    expect(stale.body.code).toBe("website_bridge_conflict");
  });

  it("refuses an agent every people-only change with 403 before any call to the site", async () => {
    const world = await seedWorld();
    const people = [
      ["post", `orders/${ORDER}/notify-licence`, {}],
      ["delete", `enquiries/${LEAD}`, {}],
      ["post", "customers", { name: "Acme", tierId: TIER }],
      ["patch", `customers/${CLIENT}`, { tierId: null }],
      ["post", `customers/${CLIENT}/licences`, { offeringName: "Aspose.Total", licenceKey: KEY }],
      ["patch", `licences/${LICENCE}`, { downloadUrl: "https://x.test/f" }],
      ["post", `licences/${LICENCE}/revoke`, {}],
      ["post", `licences/${LICENCE}/reissue`, {}],
      ["post", `engagements/${ITEM}/share`, {}],
      ["post", `engagements/${ITEM}/unshare`, {}],
      ["post", `portal-acceptances/${RECEIPT}/resend`, {}],
    ] as const;
    for (const [method, p, body] of people) {
      const refused = await request(app(world.agent.actor))[method](`${world.base}/commerce/${p}`).send(body).expect(403);
      expect(refused.body.code, `${method} ${p}`).toBe("website_commerce_people_only");
    }
    // a service enquiry is never deleted
    await request(app(world.owner.actor)).delete(`${world.base}/commerce/enquiries/si-${ORDER}`).expect(404);
    expect(seen).toHaveLength(0);
  });

  it("a person makes a people-only change directly: the licence email answers its outcome, a lead delete its id", async () => {
    const world = await seedWorld();
    const http = request(app(world.owner.actor));
    expect((await http.post(`${world.base}/commerce/orders/${ORDER}/notify-licence`).send({}).expect(200)).body).toMatchObject({ email: "sent" });
    await http.delete(`${world.base}/commerce/enquiries/${LEAD}`).expect(200, { id: LEAD, deleted: true });
    const issued = await http.post(`${world.base}/commerce/customers/${CLIENT}/licences`).send({ offeringName: "Aspose.Total", licenceKey: KEY }).expect(201);
    expect(issued.body.item.licence_key_last4).toBe("9876");
    expect(writes().every((s) => s.headers["x-gs-bridge-actor"] === `user:${world.owner.userId}`)).toBe(true);
    const logged = (await db.select().from(activityLog)).filter((e) => e.action === "website.commerce_changed");
    expect(logged.map((e) => e.details)).toEqual([
      expect.objectContaining({ operation: "orders.notify_licence", rowId: ORDER, email: "sent" }),
      expect.objectContaining({ operation: "enquiries.delete", rowId: LEAD }),
      expect.objectContaining({ operation: "licences.issue" }),
    ]);
    expect(JSON.stringify(logged)).not.toContain(KEY);
  });

  describe("an agent's ask (commerce_change_request)", () => {
    const ask = (world: Awaited<ReturnType<typeof seedWorld>>, change: Record<string, unknown>) =>
      request(app(world.agent.actor)).post(`${world.base}/commerce/change-requests`).send({ ...change, note: "Paid in full", issueId: world.issueId });
    const issue = { method: "POST", path: `customers/${CLIENT}/licences`, body: { offeringName: "Aspose.Total", licenceKey: KEY, seats: 2 } };

    it("opens one card on the agent's task, keeps the licence key in the vault, and changes nothing", async () => {
      const world = await seedWorld();
      const res = await ask(world, issue).expect(201);
      expect(writes()).toHaveLength(0);
      const cards = await db.select().from(approvals);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ id: res.body.approval.id, type: "commerce_change_request", status: "pending", requestedByAgentId: world.agent.agentId });
      expect(cards[0]!.payload).toMatchObject({
        siteId: world.siteId, operation: "licences.issue", method: "POST", path: issue.path, title: "Issue a licence: Acme Ltd",
        body: { offeringName: "Aspose.Total", seats: 2 }, vaultedFields: ["licenceKey"], licenceKeyLast4: "9876", requestedBy: "Lintel", note: "Paid in full",
      });
      expect(JSON.stringify(cards[0])).not.toContain(KEY);
      expect(JSON.stringify(res.body)).not.toContain(KEY);
      expect(JSON.stringify(await db.select().from(activityLog))).not.toContain(KEY);
      expect(await db.select().from(companySecrets)).toHaveLength(3); // read key, write key, this card's licence
      expect((await db.select().from(issueApprovals)).map((l) => [l.issueId, l.approvalId])).toEqual([[world.issueId, cards[0]!.id]]);

      // the same ask again is the same card; a catalogue change, a bad path and a hand-made card are refused
      expect((await ask(world, issue).expect(200)).body.approval.id).toBe(cards[0]!.id);
      await ask(world, { method: "POST", path: `offerings/${ORDER}/publish` }).expect(422);
      await ask(world, { method: "POST", path: `orders/${ORDER}/../x` }).expect(422);
      await request(app(world.agent.actor)).post(`${world.base}/commerce/change-requests`)
        .send({ method: "PATCH", path: `orders/${ORDER}`, body: { status: "fulfilled" }, issueId: randomUUID() }).expect(422);
      await request(app(world.owner.actor)).post(`/api/companies/${world.companyId}/approvals`)
        .send({ type: "commerce_change_request", payload: { siteId: world.siteId } }).expect(422);
      await request(app(world.agent.actor)).post(`/api/approvals/${cards[0]!.id}/resubmit`).send({}).expect(422);
      expect(await db.select().from(approvals)).toHaveLength(1);
      expect(writes()).toHaveLength(0);
    });

    it("only a signed-in person with Commerce rights decides", async () => {
      const world = await seedWorld();
      const card = (await ask(world, { method: "POST", path: `orders/${ORDER}/notify-licence` }).expect(201)).body.approval;
      const approveAs = (actor: Actor) => request(app(actor)).post(`/api/approvals/${card.id}/approve`).send({});
      await approveAs(world.agent.actor).expect(403);
      await approveAs((await world.person("owner", "board_key")).actor).expect(403);
      expect((await approveAs((await world.person("operator")).actor).expect(403)).body.code).toBe("commerce_change_decider_missing");
      await request(app(world.owner.actor)).post(`/api/approvals/${card.id}/request-revision`).send({ decisionNote: "x" }).expect(422);
      expect(writes()).toHaveLength(0);
      expect((await db.select().from(approvals))[0]).toMatchObject({ status: "pending" });
    });

    it("approving makes the change once, in the approver's name, with the key from the vault, then forgets the key", async () => {
      const world = await seedWorld();
      const card = (await ask(world, issue).expect(201)).body.approval;
      const approved = await request(app(world.owner.actor)).post(`/api/approvals/${card.id}/approve`).send({}).expect(200);
      expect(approved.body).toMatchObject({ status: "approved", decidedByUserId: world.owner.userId,
        payload: { vaultRef: null, result: { item: { licence_key_last4: "9876" } } } });
      expect(writes()).toHaveLength(1);
      expect(writes()[0]).toMatchObject({ method: "POST", path: issue.path, verified: true });
      expect(JSON.parse(writes()[0]!.body)).toEqual(issue.body);
      expect(writes()[0]!.headers["x-gs-bridge-actor"]).toBe(`user:${world.owner.userId}`);
      expect(await db.select().from(companySecrets)).toHaveLength(2);
      const changed = (await db.select().from(activityLog)).filter((e) => e.action === "website.commerce_changed");
      expect(changed).toEqual([expect.objectContaining({ actorType: "user", actorId: world.owner.userId,
        details: expect.objectContaining({ operation: "licences.issue", approvalId: card.id, requestedByAgentId: world.agent.agentId }) })]);

      // a second click changes nothing on the site
      const calls = seen.length;
      await request(app(world.owner.actor)).post(`/api/approvals/${card.id}/approve`).send({}).expect(200);
      expect(seen).toHaveLength(calls);
    });

    it("a lost answer keeps the card open; the next click replays the same key and sends the email once", async () => {
      const world = await seedWorld();
      const card = (await ask(world, { method: "POST", path: `portal-acceptances/${RECEIPT}/resend` }).expect(201)).body.approval;
      expect(card.payload.summary).toMatch(/sends an email to the client/);
      lose = 3;
      await request(app(world.owner.actor)).post(`/api/approvals/${card.id}/approve`).send({}).expect(502);
      expect((await db.select().from(approvals))[0]).toMatchObject({ status: "pending", decidedByUserId: null });
      await request(app(world.owner.actor)).post(`/api/approvals/${card.id}/approve`).send({}).expect(200);
      expect(new Set(writes().map((s) => s.headers["x-gs-bridge-idempotency-key"])).size).toBe(1);
      expect(writes().filter((s) => !s.replayed)).toHaveLength(1);
    });

    it("rejecting changes nothing, forgets the key, and the agent hears why on its task", async () => {
      const world = await seedWorld();
      const card = (await ask(world, issue).expect(201)).body.approval;
      await request(app(world.owner.actor)).post(`/api/approvals/${card.id}/reject`).send({ decisionNote: "Not paid yet" }).expect(200);
      expect(writes()).toHaveLength(0);
      expect(await db.select().from(companySecrets)).toHaveLength(2);
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, world.issueId));
      expect(comments.map((c) => c.body)).toEqual([expect.stringMatching(/Not approved: Issue a licence: Acme Ltd\. Nothing was changed\. Reason: Not paid yet/)]);
      expect(wakeups).toEqual([expect.objectContaining({ agentId: world.agent.agentId,
        opts: expect.objectContaining({ reason: "approval_rejected", idempotencyKey: `commerce-change-request:${card.id}:rejected` }) })]);
    });

    it("the site's refusal at approval closes the card and changes nothing", async () => {
      const world = await seedWorld();
      const card = (await ask(world, { method: "POST", path: `licences/${LICENCE}/revoke`, body: { expectedRowVersion: 1 } }).expect(201)).body.approval;
      licence.row_version = 5;
      const refused = await request(app(world.owner.actor)).post(`/api/approvals/${card.id}/approve`).send({}).expect(409);
      expect(refused.body.code).toBe("website_bridge_conflict");
      expect((await db.select().from(approvals))[0]).toMatchObject({ status: "cancelled" });
      expect(licence.status).toBe("issued");
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, world.issueId));
      expect(comments[0]!.body).toMatch(/Nothing was changed/);
    });

    it("fails closed with no write key: 409, no call and no card", async () => {
      const world = await seedWorld({ write: false });
      await ask(world, { method: "POST", path: `orders/${ORDER}/notify-licence` }).expect(409);
      expect(seen).toHaveLength(0);
      expect(await db.select().from(approvals)).toHaveLength(0);
    });
  });
});
