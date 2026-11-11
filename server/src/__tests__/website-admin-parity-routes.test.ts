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

const QUOTE = "0a000000-0000-4000-8000-000000000001";
const ORDER = "0d000000-0000-4000-8000-000000000001";
const CLIENT = "c0000000-0000-4000-8000-000000000001";
const REQUEST = "e0000000-0000-4000-8000-000000000001";
const LEAD = "fd-f0000000-0000-4000-8000-000000000001";
const PO = "%PDF-1.4 the buyer's purchase order";

// Admin parity round 2: a seat request decision, a buyer's PO file and a lead's agent package through the bridge.
// The fake site checks each signature with the public key the key route gave out and refuses an agent the decision
// (403 denied), as greatstone-website does. Every new route refuses a caller without access before any call to the site.
describeEmbeddedPostgres("website admin parity routes", () => {
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
    licence = {};
    item = { id: REQUEST, customer_id: CLIENT, email: "nia@example.test", role: "member", status: "pending" };
  }

  function siteAnswer(method: string, p: string, body: Record<string, unknown> | undefined, actor: string): { status: number; body: unknown } {
    if (method === "GET" && p === "invite-requests") return { status: 200, body: { items: [item], nextCursor: null } };
    if (method === "POST" && p === `invite-requests/${REQUEST}/decision`) {
      if (!actor.startsWith("user:")) return { status: 403, body: { error: { code: "denied" } } };
      if (item.status !== "pending") return { status: 409, body: { error: { code: "conflict" } } };
      item.status = body!.decision === "approve" ? "provisioned" : "declined";
      return { status: 200, body: { item, member: body!.decision === "approve" ? { email: item.email } : null } };
    }
    return { status: 404, body: { error: { code: "not_found" } } };
  }

  /** The file routes answer bytes, as the site streams them. */
  function siteFile(p: string): Response | null {
    if (p === `quotes/${QUOTE}/po-document` || p === `orders/${ORDER}/po-document`) {
      return new Response(PO, { headers: { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="../Buyer PO;.pdf"' } });
    }
    if (p === `enquiries/${LEAD}/agent-package`) {
      return new Response(Buffer.from("PK\u0003\u0004zip"), { headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="lead-co-team.zip"' } });
    }
    return null;
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
    const file = String(init.method) === "GET" ? siteFile(pathName) : null;
    if (file) return file;
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

  it("a person downloads the buyer's PO from a quote or an order, signed in their name, never cached, and it is logged", async () => {
    const world = await seedWorld();
    const http = request(app(world.owner.actor));
    for (const p of [`quotes/${QUOTE}/po-document`, `orders/${ORDER}/po-document`]) {
      const res = await http.get(`${world.base}/data/${p}`).buffer(true).parse((r, done) => {
        const chunks: Buffer[] = []; r.on("data", (c: Buffer) => chunks.push(c)); r.on("end", () => done(null, Buffer.concat(chunks)));
      }).expect(200);
      expect((res.body as Buffer).toString()).toBe(PO);
      expect(res.headers["content-type"]).toBe("application/octet-stream");
      expect(res.headers["content-disposition"]).toBe('attachment; filename="_Buyer_PO_.pdf"');
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    expect(seen.map((s) => [s.method, s.path, s.verified, s.headers["x-gs-bridge-actor"]])).toEqual([
      ["GET", `quotes/${QUOTE}/po-document`, true, `user:${world.owner.userId}`],
      ["GET", `orders/${ORDER}/po-document`, true, `user:${world.owner.userId}`],
    ]);
    expect(seen.every((s) => s.headers["x-gs-bridge-key"]!.startsWith("stg-read-"))).toBe(true);
    const logged = (await db.select().from(activityLog)).filter((e) => e.action === "website.file_downloaded");
    expect(logged.map((e) => e.details)).toEqual([
      expect.objectContaining({ resource: "quotes", rowId: QUOTE, file: "po-document", bytes: PO.length }),
      expect.objectContaining({ resource: "orders", rowId: ORDER, file: "po-document" }),
    ]);
  });

  it("a lead's agent package downloads as a .zip; a file a record does not have is 404 with no call to the site", async () => {
    const world = await seedWorld();
    const http = request(app(world.owner.actor));
    const zip = await http.get(`${world.base}/data/enquiries/${LEAD}/agent-package`).expect(200);
    expect(zip.headers["content-type"]).toBe("application/zip");
    expect(zip.headers["content-disposition"]).toBe('attachment; filename="lead-co-team.zip"');
    seen = [];
    for (const p of [`customers/${CLIENT}/po-document`, `quotes/${QUOTE}/agent-package`, `quotes/${QUOTE}/licence-key`]) {
      await http.get(`${world.base}/data/${p}`).expect(404);
    }
    expect(seen).toHaveLength(0);
    // the site's not_found comes back as a 404 too
    await http.get(`${world.base}/data/quotes/${ORDER}/po-document`).expect(404);
  });

  it("refuses a caller with no access to the company or no website rights, before any call to the site", async () => {
    const world = await seedWorld();
    const stranger = { type: "board", userId: "stranger", source: "session", isInstanceAdmin: false, companyIds: [], memberships: [] } as unknown as Actor;
    const [bare] = await db.insert(agents).values({ companyId: world.companyId, name: "Bare", role: "engineer", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: {}, permissions: {} }).returning();
    const noRights = { type: "agent", agentId: bare!.id, companyId: world.companyId, source: "agent_key" } as Actor;
    for (const actor of [stranger, noRights]) {
      for (const p of [`data/quotes/${QUOTE}/po-document`, `data/orders/${ORDER}/po-document`, `data/enquiries/${LEAD}/agent-package`,
        `data/invite-requests?customer=${CLIENT}`]) {
        await request(app(actor)).get(`${world.base}/${p}`).expect(403);
      }
      await request(app(actor)).post(`${world.base}/commerce/invite-requests/${REQUEST}/decision`).send({ decision: "approve" }).expect(403);
    }
    expect(seen).toHaveLength(0);
  });

  it("an agent reads seat requests but cannot decide one: 403 people only, before any call to the site", async () => {
    const world = await seedWorld();
    const listed = await request(app(world.agent.actor)).get(`${world.base}/data/invite-requests?customer=${CLIENT}`).expect(200);
    expect(listed.body.items).toEqual([expect.objectContaining({ id: REQUEST, status: "pending" })]);
    const refused = await request(app(world.agent.actor)).post(`${world.base}/commerce/invite-requests/${REQUEST}/decision`)
      .send({ decision: "approve" }).expect(403);
    expect(refused.body.code).toBe("website_commerce_people_only");
    expect(writes()).toHaveLength(0);
  });

  it("a person approves a seat request on the write key in their name; deciding it again is a conflict", async () => {
    const world = await seedWorld();
    const http = request(app(world.owner.actor));
    const done = await http.post(`${world.base}/commerce/invite-requests/${REQUEST}/decision`).send({ decision: "approve" }).expect(200);
    expect(done.body.item).toMatchObject({ id: REQUEST, status: "provisioned" });
    expect(writes().map((s) => [s.path, s.verified, s.headers["x-gs-bridge-actor"]])).toEqual([
      [`invite-requests/${REQUEST}/decision`, true, `user:${world.owner.userId}`]]);
    expect(writes()[0]!.headers["x-gs-bridge-key"]).toMatch(/^stg-write-/);
    const again = await http.post(`${world.base}/commerce/invite-requests/${REQUEST}/decision`).send({ decision: "decline" }).expect(409);
    expect(again.body.code).toBe("website_bridge_conflict");
    const logged = (await db.select().from(activityLog)).filter((e) => e.action === "website.commerce_changed");
    expect(logged.map((e) => (e.details as { operation: string }).operation)).toEqual(["invite-requests.decide"]);
  });
});
