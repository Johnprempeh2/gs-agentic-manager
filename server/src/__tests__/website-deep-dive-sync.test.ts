import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  cases,
  clientDeliverablePublications,
  companies,
  companyMemberships,
  createDb,
  deepDiveItemFiles,
  instanceSettings,
  issueWorkProducts,
  issues,
  pipelineCaseDocumentRequests,
  pipelineCases,
  pipelineStages,
  pipelines,
  principalPermissionGrants,
} from "@greatstone/db";
import type { DeepDiveSyncPayload, WebsiteDataBridgeKey } from "@greatstone/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { websiteModuleRoutes } from "../routes/website-module.js";
import { websiteDataBridgeRoutes } from "../routes/website-data-bridge.js";
import { websiteBridgeInboundRoutes, websiteDeepDiveSyncRoutes } from "../routes/website-deep-dive-sync.js";
import { instanceSettingsService } from "../services/index.js";
import { pipelineCaseDocumentRequestsService } from "../services/pipeline-case-document-requests.js";
import { bridgeCanonicalString, createWebsiteBridgeClient, parseBridgeCredential } from "../services/website/data-bridge-client.js";
import { bridgeUrlOf, type WebsiteDataBridgeOptions } from "../services/website/data-bridge.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres Deep Dive sync tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

type Actor = Express.Request["actor"];
type Pushed = { url: string; method: string; verified: boolean; body: DeepDiveSyncPayload };

const GSAM_HOST = "gsam.test";

// GRE-2439: GSAM pushes one client's Shared Deep Dive items to the site (Internal items and other clients never go),
// and the site's signed call back marks a document request received. The fake site checks each push with the write
// key's public half, and the test signs each call back with a key pair it holds, as the site would.
describeEmbeddedPostgres("website Deep Dive sync (GRE-2439)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const keyFolder = mkdtempSync(path.join(os.tmpdir(), "paperclip-deep-dive-sync-key-"));
  const previousKeyFile = process.env.GSAM_SECRETS_MASTER_KEY_FILE;
  const publicKeys = new Map<string, string>();
  let pushed: Pushed[] = [];

  const fakeSite = (async (input: URL, init: RequestInit) => {
    const url = new URL(String(input));
    const headers = init.headers as Record<string, string>;
    const body = String(init.body ?? "");
    const pub = publicKeys.get(headers["x-gs-bridge-key"]!);
    const canonical = bridgeCanonicalString({ method: init.method!, host: url.host, path: url.pathname, query: "",
      time: Number(headers["x-gs-bridge-time"]), nonce: headers["x-gs-bridge-nonce"]!, actor: headers["x-gs-bridge-actor"]!,
      run: headers["x-gs-bridge-run"] ?? null, bodySha256: createHash("sha256").update(body).digest("hex") });
    const verified = Boolean(pub) && verify(null, Buffer.from(canonical), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pub! }, format: "jwk" }),
      Buffer.from(headers["x-gs-bridge-signature"]!, "base64url"));
    const payload = JSON.parse(body) as DeepDiveSyncPayload;
    pushed.push({ url: url.toString(), method: init.method!, verified, body: payload });
    if (!verified) return new Response(JSON.stringify({ error: { code: "bad_signature" } }), { status: 401 });
    return Response.json({ ok: true, tenantId: payload.tenantId });
  }) as unknown as typeof fetch;
  const options: WebsiteDataBridgeOptions = {
    clientFor: (site, value) => createWebsiteBridgeClient({ baseUrl: bridgeUrlOf(site), credential: parseBridgeCredential(value), fetchImpl: fakeSite }),
  };

  beforeAll(async () => {
    process.env.GSAM_SECRETS_MASTER_KEY_FILE = path.join(keyFolder, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-deep-dive-sync-");
    db = createDb(tempDb.connectionString);
  });

  beforeEach(() => {
    pushed = [];
  });

  afterAll(async () => {
    await db.delete(instanceSettings);
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) delete process.env.GSAM_SECRETS_MASTER_KEY_FILE;
    else process.env.GSAM_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(keyFolder, { recursive: true, force: true });
  });

  const board: Actor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };

  function app(actor: Actor = board) {
    const instance = express();
    instance.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", websiteModuleRoutes(db));
    instance.use("/api", websiteDataBridgeRoutes(db, options));
    instance.use("/api", websiteDeepDiveSyncRoutes(db, options));
    instance.use("/api", websiteBridgeInboundRoutes(db, options));
    instance.use(errorHandler);
    return instance;
  }

  async function seedCompany(name: string) {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true, enableDeepDive: true });
    const [company] = await db.insert(companies).values({ name, issuePrefix: `S${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}` }).returning();
    return company!.id as string;
  }

  async function seedSite(companyId: string) {
    const site = (await request(app()).post(`/api/companies/${companyId}/website/sites`)
      .send({ name: "Greatstone", domain: "www.greatstone.test", netlifySiteId: "n" }).expect(201)).body;
    const base = `/api/companies/${companyId}/website/sites/${site.id}`;
    const key = (await request(app()).post(`${base}/data-bridge/key`).send({ environment: "stg", capability: "write" }).expect(201)).body as WebsiteDataBridgeKey;
    publicKeys.set(key.keyId, key.publicKey);
    // The site's own key for its calls back.
    const pair = generateKeyPairSync("ed25519");
    const siteKeyId = `stg-site-${randomBytes(4).toString("hex")}`;
    await request(app()).put(`${base}/data-bridge/site-key`)
      .send({ keyId: siteKeyId, publicKey: pair.publicKey.export({ format: "jwk" }).x }).expect(200);
    return { siteId: site.id as string, base, writeKey: key, siteKeyId, sitePrivateKey: pair.privateKey };
  }

  async function seedClient(companyId: string, title: string) {
    const [pipeline] = await db.insert(pipelines).values({ companyId, key: `journey-${randomUUID().slice(0, 8)}`, name: "Client journey" }).returning();
    const [stage] = await db.insert(pipelineStages).values({ pipelineId: pipeline!.id, key: "deep-dive", name: "Deep dive", kind: "working", position: 0 }).returning();
    const [client] = await db.insert(pipelineCases).values({ companyId, pipelineId: pipeline!.id, stageId: stage!.id, caseKey: randomUUID(), title }).returning();
    return client!;
  }

  async function seedItem(companyId: string, clientCaseId: string, key: string, visibility: "internal" | "shared", parentCaseId: string | null = null) {
    const [row] = await db.insert(cases).values({
      companyId, caseNumber: Math.floor(Math.random() * 1_000_000), identifier: `DD-${randomUUID()}`, caseType: "deep_dive_stream",
      key: `${key}-${clientCaseId.slice(0, 8)}`, title: `Stream ${key}`, fields: { note: `${key} note` }, clientCaseId, visibility, parentCaseId,
    }).returning();
    return row!;
  }

  async function seedRequest(client: { id: string; companyId: string; stageId: string }, title: string) {
    const [row] = await db.insert(pipelineCaseDocumentRequests).values({ companyId: client.companyId, caseId: client.id, stageId: client.stageId, title }).returning();
    return row!;
  }

  async function link(companyId: string, caseId: string, documentRequestId: string, visibility: "internal" | "shared") {
    await db.insert(deepDiveItemFiles).values({ companyId, caseId, documentRequestId, visibility });
  }

  async function seedPublication(companyId: string, caseId: string, key: string, status: "published" | "withdrawn") {
    const [issue] = await db.insert(issues).values({ companyId, title: `Deliverable ${key}` }).returning();
    const [product] = await db.insert(issueWorkProducts).values({ companyId, issueId: issue!.id, type: "document", provider: "gsam", title: key, status: "ready" }).returning();
    const [row] = await db.insert(clientDeliverablePublications).values({
      companyId, caseId, deliverableIssueId: issue!.id, deliverableKey: key, title: `Report ${key}`, version: 1, status,
      ...(status === "published"
        ? { workProductId: product!.id, fingerprint: "f1", approverUserId: "u1", approvedByUserId: "u1", approvedFingerprint: "f1",
          approvedAt: new Date(), publishedAt: new Date(), publishedFingerprint: "f1" }
        : { withdrawnAt: new Date() }),
    }).returning();
    return row!;
  }

  /** One client with a Shared and an Internal item, each with a linked request, and two deliverables. */
  async function seedEngagement(companyId: string, title: string) {
    const client = await seedClient(companyId, title);
    const shared = await seedItem(companyId, client.id, "data", "shared");
    const internal = await seedItem(companyId, client.id, "people", "internal");
    const sharedChild = await seedItem(companyId, client.id, "data-sub", "shared", shared.id);
    const internalParentChild = await seedItem(companyId, client.id, "people-sub", "shared", internal.id);
    const sharedRequest = await seedRequest(client, `${title}: org chart`);
    const internalRequest = await seedRequest(client, `${title}: payroll`);
    const internalLinkRequest = await seedRequest(client, `${title}: board minutes`);
    await link(companyId, shared.id, sharedRequest.id, "shared");
    await link(companyId, internal.id, internalRequest.id, "shared");
    await link(companyId, shared.id, internalLinkRequest.id, "internal");
    const published = await seedPublication(companyId, client.id, `${title}-report`, "published");
    const withdrawn = await seedPublication(companyId, client.id, `${title}-draft`, "withdrawn");
    return { client, shared, internal, sharedChild, internalParentChild, sharedRequest, internalRequest, internalLinkRequest, published, withdrawn };
  }

  function signedAnswer(site: { siteKeyId: string; sitePrivateKey: KeyObject }, tenantId: string, requestId: string,
    body: Record<string, unknown>, opts: { time?: number; nonce?: string; actor?: string; key?: KeyObject; kid?: string; sendBody?: Record<string, unknown> } = {}) {
    const json = JSON.stringify(body);
    const urlPath = `/api/website-bridge/v1/tenants/${tenantId}/document-requests/${requestId}/answer`;
    const time = opts.time ?? Math.floor(Date.now() / 1000);
    const nonce = opts.nonce ?? randomBytes(16).toString("base64url");
    const actor = opts.actor ?? `client:${(body.answeredBy as { customerId: string }).customerId}`;
    const canonical = bridgeCanonicalString({ method: "POST", host: GSAM_HOST, path: urlPath, query: "", time, nonce, actor, run: null,
      bodySha256: createHash("sha256").update(json).digest("hex") });
    return request(app({ type: "none", source: "none" } as Actor)).post(urlPath)
      .set("Host", GSAM_HOST)
      .set("Content-Type", "application/json")
      .set("X-GS-Bridge-Key", opts.kid ?? site.siteKeyId)
      .set("X-GS-Bridge-Time", String(time))
      .set("X-GS-Bridge-Nonce", nonce)
      .set("X-GS-Bridge-Actor", actor)
      .set("X-GS-Bridge-Signature", sign(null, Buffer.from(canonical), opts.key ?? site.sitePrivateKey).toString("base64url"))
      .send(opts.sendBody ? JSON.stringify(opts.sendBody) : json);
  }

  const answerBody = (answerId = "ans-1") => ({
    answerId, answeredBy: { customerId: "cust-42", name: "Test Client", email: "client@example.test" }, note: "Attached", fileName: "org-chart.pdf",
  });

  it("never puts an Internal item, an Internal link or its request in the outbound payload", async () => {
    const companyId = await seedCompany("Greatstone A");
    const site = await seedSite(companyId);
    const a = await seedEngagement(companyId, "Client A");

    const preview = (await request(app()).get(`${site.base}/deep-dive-sync/${a.client.id}/preview`).expect(200)).body as DeepDiveSyncPayload;
    expect(preview.tenantId).toBe(a.client.id);
    expect(preview.items.map((item) => item.id).sort()).toEqual([a.shared.id, a.sharedChild.id, a.internalParentChild.id].sort());
    // A Shared child of an Internal parent is sent without its parent's id.
    expect(preview.items.find((item) => item.id === a.internalParentChild.id)!.parentId).toBeNull();
    expect(preview.items.find((item) => item.id === a.sharedChild.id)!.parentId).toBe(a.shared.id);
    expect(preview.documentRequests.map((req) => req.id)).toEqual([a.sharedRequest.id]);
    expect(preview.documentRequests[0]).toMatchObject({ status: "open", itemIds: [a.shared.id] });
    expect(preview.deliverables.map((d) => d.id)).toEqual([a.published.id]);

    const res = await request(app()).post(`${site.base}/deep-dive-sync/${a.client.id}`).expect(200);
    expect(res.body.counts).toEqual({ items: 3, files: 1, documentRequests: 1, deliverables: 1 });
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ method: "PUT", verified: true, url: `https://www.greatstone.test/api/admin/v1/deep-dive/tenants/${a.client.id}` });
    const wire = JSON.stringify(pushed[0]!.body);
    for (const hidden of [a.internal.id, a.internalRequest.id, a.internalLinkRequest.id, a.withdrawn.id, "payroll", "board minutes"]) {
      expect(wire).not.toContain(hidden);
    }
    const [event] = (await db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).filter((e) => e.action === "website.deep_dive_synced");
    expect(event).toMatchObject({ entityId: a.client.id });
  });

  it("never puts client B's items in client A's sync, and refuses another company's client", async () => {
    const companyId = await seedCompany("Greatstone B");
    const site = await seedSite(companyId);
    const a = await seedEngagement(companyId, "Client A");
    const b = await seedEngagement(companyId, "Client B");
    const otherCompany = await seedCompany("Other Co");
    const c = await seedEngagement(otherCompany, "Client C");

    await request(app()).post(`${site.base}/deep-dive-sync/${a.client.id}`).expect(200);
    const wire = JSON.stringify(pushed[0]!.body);
    expect(pushed[0]!.body.tenantId).toBe(a.client.id);
    for (const other of [b.client.id, b.shared.id, b.sharedChild.id, b.sharedRequest.id, b.published.id, "Client B", c.shared.id]) {
      expect(wire).not.toContain(other);
    }
    // Another company's client is not found through this company's site, and nothing is sent.
    await request(app()).get(`${site.base}/deep-dive-sync/${c.client.id}/preview`).expect(404);
    await request(app()).post(`${site.base}/deep-dive-sync/${c.client.id}`).expect(404);
    expect(pushed).toHaveLength(1);
  });

  it("drops an unshared item and a withdrawn deliverable on the next sync", async () => {
    const companyId = await seedCompany("Greatstone C");
    const site = await seedSite(companyId);
    const a = await seedEngagement(companyId, "Client A");
    await request(app()).post(`${site.base}/deep-dive-sync/${a.client.id}`).expect(200);
    expect(pushed[0]!.body.items.map((i) => i.id)).toContain(a.sharedChild.id);

    await db.update(cases).set({ visibility: "internal" }).where(eq(cases.id, a.sharedChild.id));
    await db.update(clientDeliverablePublications).set({ status: "withdrawn", withdrawnAt: new Date() }).where(eq(clientDeliverablePublications.id, a.published.id));
    await request(app()).post(`${site.base}/deep-dive-sync/${a.client.id}`).expect(200);
    expect(pushed[1]!.body.items.map((i) => i.id)).not.toContain(a.sharedChild.id);
    expect(pushed[1]!.body.deliverables).toEqual([]);
  });

  it("lets only people with website:publish send, and says when the write key is missing", async () => {
    const companyId = await seedCompany("Greatstone D");
    const site = await seedSite(companyId);
    const a = await seedEngagement(companyId, "Client A");
    const [agent] = await db.insert(agents)
      .values({ companyId, name: "Lintel", role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }).returning();
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agent!.id, status: "active", membershipRole: "member" });
    for (const key of ["website:view", "website:publish"]) {
      await db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: agent!.id, permissionKey: key, scope: null });
    }
    const agentActor = { type: "agent", agentId: agent!.id, companyId, source: "agent_key" } as Actor;
    await request(app(agentActor)).post(`${site.base}/deep-dive-sync/${a.client.id}`).expect(403);
    await request(app(agentActor)).put(`${site.base}/data-bridge/site-key`).send({ keyId: "stg-site-x1", publicKey: "A".repeat(43) }).expect(403);
    await request(app(agentActor)).get(`${site.base}/deep-dive-sync/${a.client.id}/preview`).expect(200);

    // A site with no write key: a clear 409, nothing sent.
    const bare = (await request(app()).post(`/api/companies/${companyId}/website/sites`)
      .send({ name: "Second", domain: "two.greatstone.test", netlifySiteId: "n2" }).expect(201)).body;
    const refused = await request(app()).post(`/api/companies/${companyId}/website/sites/${bare.id}/deep-dive-sync/${a.client.id}`).expect(409);
    expect(JSON.stringify(refused.body)).toMatch(/no write key/);
    expect(pushed).toHaveLength(0);
    // Two sites cannot share one call-back key id.
    await request(app()).put(`/api/companies/${companyId}/website/sites/${bare.id}/data-bridge/site-key`)
      .send({ keyId: site.siteKeyId, publicKey: "A".repeat(43) }).expect(409);
  });

  it("marks a document request received when the site's signed answer arrives, shown on the Deep Dive screen", async () => {
    const companyId = await seedCompany("Greatstone E");
    const site = await seedSite(companyId);
    const a = await seedEngagement(companyId, "Client A");

    const ok = await signedAnswer(site, a.client.id, a.sharedRequest.id, answerBody()).expect(200);
    expect(ok.body).toMatchObject({ ok: true, requestId: a.sharedRequest.id });
    const [row] = await db.select().from(pipelineCaseDocumentRequests).where(eq(pipelineCaseDocumentRequests.id, a.sharedRequest.id));
    expect(row!.websiteAnsweredAt).not.toBeNull();
    expect(row!.websiteAnsweredBy).toEqual({ customerId: "cust-42", name: "Test Client", email: "client@example.test" });
    const listed = (await pipelineCaseDocumentRequestsService(db).list(companyId, a.client.id)).find((r) => r.id === a.sharedRequest.id)!;
    expect(listed.websiteAnswer).toMatchObject({ answeredBy: { customerId: "cust-42", name: "Test Client" }, fileName: "org-chart.pdf" });

    // The same answer again changes nothing; the next sync says received.
    const again = await signedAnswer(site, a.client.id, a.sharedRequest.id, answerBody()).expect(200);
    expect(again.body.receivedAt).toBe(ok.body.receivedAt);
    await request(app()).post(`${site.base}/deep-dive-sync/${a.client.id}`).expect(200);
    expect(pushed[0]!.body.documentRequests[0]).toMatchObject({ id: a.sharedRequest.id, status: "received" });
    const answered = (await db.select().from(activityLog).where(eq(activityLog.companyId, companyId)))
      .filter((e) => e.action === "deep_dive.document_request_answered_on_website");
    expect(answered).toHaveLength(1);
  });

  it("rejects a bad signature, a wrong tenant, a replay, an old time and a request GSAM did not send", async () => {
    const companyId = await seedCompany("Greatstone F");
    const site = await seedSite(companyId);
    const a = await seedEngagement(companyId, "Client A");
    const b = await seedEngagement(companyId, "Client B");
    const otherCompany = await seedCompany("Other Co F");
    const otherSite = await seedSite(otherCompany);
    const c = await seedEngagement(otherCompany, "Client C");
    const code = (res: request.Response) => res.body.error?.code;

    // Signed with a key the site did not register.
    const stranger = generateKeyPairSync("ed25519").privateKey;
    expect(code(await signedAnswer(site, a.client.id, a.sharedRequest.id, answerBody(), { key: stranger }).expect(401))).toBe("bad_signature");
    expect(code(await signedAnswer(site, a.client.id, a.sharedRequest.id, answerBody(), { kid: "stg-unknown-key" }).expect(401))).toBe("bad_key");
    // Body changed after signing.
    expect(code(await signedAnswer(site, a.client.id, a.sharedRequest.id, answerBody(), { sendBody: { ...answerBody(), note: "changed" } })
      .expect(401))).toBe("bad_signature");
    // Wrong tenant: client B's id with client A's request; another company's client; this site, the other company's request.
    expect(code(await signedAnswer(site, b.client.id, a.sharedRequest.id, answerBody()).expect(404))).toBe("not_found");
    expect(code(await signedAnswer(site, c.client.id, c.sharedRequest.id, answerBody()).expect(404))).toBe("not_found");
    expect(code(await signedAnswer(otherSite, a.client.id, a.sharedRequest.id, answerBody()).expect(404))).toBe("not_found");
    // A request linked only to an Internal item, or by an Internal link, was never sent.
    expect(code(await signedAnswer(site, a.client.id, a.internalRequest.id, answerBody()).expect(404))).toBe("not_found");
    expect(code(await signedAnswer(site, a.client.id, a.internalLinkRequest.id, answerBody()).expect(404))).toBe("not_found");
    // Time outside the window, and the same nonce twice.
    expect(code(await signedAnswer(site, a.client.id, a.sharedRequest.id, answerBody(), { time: Math.floor(Date.now() / 1000) - 120 }).expect(401))).toBe("expired");
    const nonce = randomBytes(16).toString("base64url");
    await signedAnswer(site, a.client.id, a.sharedRequest.id, answerBody(), { nonce }).expect(200);
    expect(code(await signedAnswer(site, a.client.id, a.sharedRequest.id, answerBody("ans-2"), { nonce }).expect(401))).toBe("replay");
    // The signed actor must be the answering client.
    expect(code(await signedAnswer(site, a.client.id, a.sharedRequest.id, answerBody("ans-3"), { actor: "client:someone-else" }).expect(400))).toBe("bad_request");

    // None of the refused calls touched another request.
    const rows = await db.select().from(pipelineCaseDocumentRequests).where(eq(pipelineCaseDocumentRequests.companyId, companyId));
    const answered = rows.filter((r) => r.websiteAnsweredAt).map((r) => r.id);
    expect(answered).toEqual([a.sharedRequest.id]);
  });
});
