import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
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
import type { WebsiteDataBridgeKey } from "@greatstone/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { websiteModuleRoutes } from "../routes/website-module.js";
import { websiteDataBridgeRoutes } from "../routes/website-data-bridge.js";
import { instanceSettingsService } from "../services/index.js";
import { createWebsiteBridgeClient, parseBridgeCredential, bridgeCanonicalQuery, bridgeCanonicalString } from "../services/website/data-bridge-client.js";
import { bridgeUrlOf, type WebsiteDataBridgeOptions } from "../services/website/data-bridge.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres website portal document tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

type Actor = Express.Request["actor"];
type Seen = { method: string; path: string; body: unknown; headers: Record<string, string>; verified: boolean };

// GRE-4083: portal document writes on the write key (contract "Portal documents", GRE-4081). The fake site checks
// every gs-bridge-v2 signature with the public key the key route gave out.
describeEmbeddedPostgres("website portal document routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const keyFolder = mkdtempSync(path.join(os.tmpdir(), "paperclip-website-portal-key-"));
  const previousKeyFile = process.env.GSAM_SECRETS_MASTER_KEY_FILE;
  let publicKeys = new Map<string, string>();
  let seen: Seen[] = [];
  let answer: (method: string, path: string, body: Record<string, unknown>, actor: string) => { status: number; body: unknown } =
    () => ({ status: 500, body: {} });

  const fakeSite = (async (input: URL, init: RequestInit) => {
    const url = new URL(String(input));
    const headers = init.headers as Record<string, string>;
    const body = typeof init.body === "string" ? init.body : "";
    const pub = publicKeys.get(headers["x-gs-bridge-key"]!);
    const idempotencyKey = headers["x-gs-bridge-idempotency-key"];
    const canonical = bridgeCanonicalString({ method: String(init.method), host: url.host, path: url.pathname,
      query: bridgeCanonicalQuery(url.searchParams), time: Number(headers["x-gs-bridge-time"]), nonce: headers["x-gs-bridge-nonce"]!,
      actor: headers["x-gs-bridge-actor"]!, run: headers["x-gs-bridge-run"] ?? null,
      bodySha256: createHash("sha256").update(body).digest("hex"), idempotencyKey });
    const verified = Boolean(pub) && Boolean(idempotencyKey) && canonical.startsWith("gs-bridge-v2\n")
      && verify(null, Buffer.from(canonical), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pub! }, format: "jwk" }),
        Buffer.from(headers["x-gs-bridge-signature"]!, "base64url"));
    const pathName = url.pathname.replace("/api/admin/v1/", "");
    const parsed = body ? JSON.parse(body) as Record<string, unknown> : {};
    seen.push({ method: String(init.method), path: pathName, body: parsed, headers, verified });
    if (!verified) return Response.json({ error: { code: "bad_signature" } }, { status: 401 });
    const out = answer(String(init.method), pathName, parsed, headers["x-gs-bridge-actor"]!);
    return Response.json(out.body, { status: out.status });
  }) as unknown as typeof fetch;
  const bridgeOptions: WebsiteDataBridgeOptions = {
    clientFor: (site, value) => createWebsiteBridgeClient({ baseUrl: bridgeUrlOf(site), credential: parseBridgeCredential(value),
      fetchImpl: fakeSite, sleep: async () => {} }),
  };

  beforeAll(async () => {
    process.env.GSAM_SECRETS_MASTER_KEY_FILE = path.join(keyFolder, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-website-portal-");
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
    instance.use(express.json({ limit: "10mb" }));
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", websiteModuleRoutes(db));
    instance.use("/api", websiteDataBridgeRoutes(db, bridgeOptions));
    instance.use(errorHandler);
    return instance;
  }

  async function seedSite(write = true) {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const [company] = await db.insert(companies).values({ name: "Greatstone", issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}` }).returning();
    const site = (await request(app()).post(`/api/companies/${company!.id}/website/sites`)
      .send({ name: "Greatstone", domain: "www.greatstone.test", netlifySiteId: "n" }).expect(201)).body;
    const base = `/api/companies/${company!.id}/website/sites/${site.id}`;
    for (const capability of write ? ["read", "write"] : ["read"]) {
      const key = (await request(app()).post(`${base}/data-bridge/key`).send({ environment: "stg", capability }).expect(201)).body as WebsiteDataBridgeKey;
      publicKeys.set(key.keyId, key.publicKey);
    }
    return { companyId: company!.id as string, siteId: site.id as string, base };
  }

  async function seedAgent(companyId: string, keys: string[]) {
    const [agent] = await db.insert(agents)
      .values({ companyId, name: "Quill", role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
      .returning();
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agent!.id, status: "active", membershipRole: "member" });
    for (const key of keys) {
      await db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: agent!.id, permissionKey: key, scope: null });
    }
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id }).returning();
    return { actor: { type: "agent", agentId: agent!.id, companyId, runId: run!.id, source: "agent_key" } as Actor,
      agentId: agent!.id as string, runId: run!.id as string };
  }

  async function seedUser(companyId: string, role: "owner" | "admin" | "operator", source: "session" | "board_key" = "session") {
    const userId = `user${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: role });
    return { userId, actor: { type: "board", userId, source, isInstanceAdmin: false, companyIds: [companyId],
      memberships: [{ companyId, membershipRole: role, status: "active" }] } as Actor };
  }

  const CLIENT = "c0000000-0000-4000-8000-000000000001";
  const DOC = "d0c00000-0000-4000-8000-000000000001";
  const SHA = "a".repeat(64);
  const doc = (over: Record<string, unknown> = {}) => ({
    id: DOC, customer_id: CLIENT, kind: "engagement_pack", series: "5e000000-0000-4000-8000-000000000001", version: 1, title: "Pack",
    summary: null, body: { sections: [] }, demos: [], pdf_sha256: null, has_pdf: false, action: "none", confirmation_text: null,
    signatory_email: null, status: "draft", content_sha256: null, approval_id: null, created_by_kind: "agent", created_run_id: null,
    published_at: null, withdrawn_at: null, created_at: "2026-11-06T10:00:00Z", updated_at: "2026-11-06T10:00:00Z", row_version: 1,
    // fields the site must never pass on; GSAM drops them even if it did
    pdf_path: "portal/secret.pdf", website_user_id: "u-1", ...over,
  });
  const siteAnswers = (method: string, p: string, body: Record<string, unknown>, actor: string) => {
    if (p === "portal-documents") return { status: 201, body: { item: doc({ title: body.title }) } };
    if (p.endsWith("/submit")) return { status: 200, body: { item: doc({ status: "pending_approval", content_sha256: SHA, row_version: 3 }) } };
    if (p.endsWith("/return-to-draft")) return { status: 200, body: { item: doc({ row_version: 4 }) } };
    if (p.endsWith("/approve-and-publish")) {
      if (!actor.startsWith("user:")) return { status: 403, body: { error: { code: "denied" } } };
      return { status: 200, body: { item: doc({ status: "published", content_sha256: SHA, approval_id: "ap-1" }), approvalId: "ap-1" } };
    }
    if (p.endsWith("/withdraw")) return { status: 200, body: { item: doc({ status: "withdrawn", row_version: 6 }) } };
    return method === "PATCH" ? { status: 200, body: { item: doc({ title: body.title, row_version: 2 }) } } : { status: 404, body: { error: { code: "not_found" } } };
  };

  it("lets an agent with website:edit create, edit, submit and return a draft, in its own name, logging no content", async () => {
    const { base, companyId, siteId } = await seedSite();
    const { actor, agentId, runId } = await seedAgent(companyId, ["website:view", "website:edit"]);
    answer = siteAnswers;
    const http = request(app(actor));
    const body = { sections: [{ id: "intro", title: "Intro", html: "<p>For <strong>you</strong></p>" }] };

    const made = await http.post(`${base}/portal-documents`)
      .send({ customerId: CLIENT, kind: "engagement_pack", title: "Pack", body, action: "accept", confirmationText: "I accept" }).expect(201);
    expect(made.body.item).toMatchObject({ id: DOC, status: "draft", row_version: 1 });
    expect(made.body.item).not.toHaveProperty("pdf_path");
    expect(made.body.item).not.toHaveProperty("website_user_id");
    expect(seen.at(-1)).toMatchObject({ method: "POST", path: "portal-documents", verified: true,
      body: { customerId: CLIENT, kind: "engagement_pack", title: "Pack", body, action: "accept", confirmationText: "I accept" } });
    expect(seen.at(-1)!.headers["x-gs-bridge-actor"]).toBe(`agent:${agentId}`);
    expect(seen.at(-1)!.headers["x-gs-bridge-run"]).toBe(runId);

    await http.patch(`${base}/portal-documents/${DOC}`).send({ expectedRowVersion: 1, title: "Pack 2", summary: null }).expect(200);
    expect(seen.at(-1)).toMatchObject({ method: "PATCH", path: `portal-documents/${DOC}`, body: { expectedRowVersion: 1, title: "Pack 2", summary: null } });
    const submitted = await http.post(`${base}/portal-documents/${DOC}/submit`).send({ expectedRowVersion: 2 }).expect(200);
    expect(submitted.body.item).toMatchObject({ status: "pending_approval", content_sha256: SHA });
    await http.post(`${base}/portal-documents/${DOC}/return-to-draft`).send({ expectedRowVersion: 3 }).expect(200);
    expect(seen.map((s) => s.path)).toEqual(["portal-documents", `portal-documents/${DOC}`, `portal-documents/${DOC}/submit`, `portal-documents/${DOC}/return-to-draft`]);
    expect(seen.every((s) => s.verified)).toBe(true);

    const logged = (await db.select().from(activityLog)).filter((e) => e.action === "website.portal_document_changed");
    expect(logged.map((e) => (e.details as { operation: string }).operation)).toEqual(["create", "edit", "submit", "return-to-draft"]);
    expect(logged[0]).toMatchObject({ actorType: "agent", agentId, runId, entityType: "website_site", entityId: siteId });
    expect(logged[2]!.details).toMatchObject({ documentId: DOC, customerId: CLIENT, kind: "engagement_pack", status: "pending_approval", rowVersion: 3 });
    expect(JSON.stringify(logged)).not.toMatch(/For <strong>|I accept|Pack 2/);
  });

  it("refuses an agent approve and publish, and withdraw, with website_publish_agent_refused before any call", async () => {
    const { base, companyId } = await seedSite();
    // even an agent granted everything it can hold
    const { actor } = await seedAgent(companyId, ["website:view", "website:edit", "website:commerce"]);
    answer = siteAnswers;
    const http = request(app(actor));
    const approve = await http.post(`${base}/portal-documents/${DOC}/approve-and-publish`).send({ expectedContentSha256: SHA }).expect(403);
    expect(approve.body.code).toBe("website_publish_agent_refused");
    const withdraw = await http.post(`${base}/portal-documents/${DOC}/withdraw`).send({ expectedRowVersion: 5 }).expect(403);
    expect(withdraw.body.code).toBe("website_publish_agent_refused");
    // a board API key is a script, not a click
    const { actor: script } = await seedUser(companyId, "owner", "board_key");
    const scripted = await request(app(script)).post(`${base}/portal-documents/${DOC}/approve-and-publish`).send({ expectedContentSha256: SHA }).expect(403);
    expect(scripted.body.code).toBe("website_portal_people_only");
    await request(app(script)).post(`${base}/portal-documents/${DOC}/withdraw`).send({ expectedRowVersion: 5 }).expect(403);
    expect(seen).toHaveLength(0);
    expect((await db.select().from(activityLog)).filter((e) => e.action === "website.portal_document_changed")).toHaveLength(0);
  });

  it("lets a signed-in person approve and publish, then withdraw, in their own name", async () => {
    const { base, companyId } = await seedSite();
    const { actor, userId } = await seedUser(companyId, "owner");
    answer = siteAnswers;
    const http = request(app(actor));
    const published = await http.post(`${base}/portal-documents/${DOC}/approve-and-publish`)
      .send({ expectedContentSha256: SHA, gsamApprovalRef: "GRE-4083" }).expect(200);
    expect(published.body).toMatchObject({ item: { status: "published", approval_id: "ap-1" }, approvalId: "ap-1" });
    expect(seen.at(-1)).toMatchObject({ path: `portal-documents/${DOC}/approve-and-publish`, verified: true,
      body: { expectedContentSha256: SHA, gsamApprovalRef: "GRE-4083" } });
    expect(seen.at(-1)!.headers["x-gs-bridge-actor"]).toBe(`user:${userId}`);
    const withdrawn = await http.post(`${base}/portal-documents/${DOC}/withdraw`).send({ expectedRowVersion: 5 }).expect(200);
    expect(withdrawn.body.item.status).toBe("withdrawn");
    const logged = (await db.select().from(activityLog)).filter((e) => e.action === "website.portal_document_changed");
    expect(logged.map((e) => [e.actorType, e.actorId, (e.details as { operation: string }).operation, (e.details as { approvalId: unknown }).approvalId]))
      .toEqual([["user", userId, "approve-and-publish", "ap-1"], ["user", userId, "withdraw", null]]);
  });

  it("passes the site's refusals back: a person who is not a portal approver, and a stale or wrong-status document", async () => {
    const { base, companyId } = await seedSite();
    const { actor } = await seedUser(companyId, "admin");
    const http = request(app(actor));
    answer = () => ({ status: 403, body: { error: { code: "denied" } } });
    const denied = await http.post(`${base}/portal-documents/${DOC}/approve-and-publish`).send({ expectedContentSha256: SHA }).expect(403);
    expect(denied.body.code).toBe("website_bridge_denied");
    answer = () => ({ status: 409, body: { error: { code: "conflict" }, current: doc({ status: "published", row_version: 7, pdf_path: "x" }) } });
    const stale = await http.post(`${base}/portal-documents/${DOC}/submit`).send({ expectedRowVersion: 1 }).expect(409);
    expect(stale.body).toMatchObject({ code: "website_bridge_conflict", details: { current: { id: DOC, row_version: 7 } } });
    expect((await db.select().from(activityLog)).filter((e) => e.action === "website.portal_document_changed")).toHaveLength(0);
  });

  it("checks permission, fields, ids and size before any call, and fails closed with no write key", async () => {
    const { base, companyId } = await seedSite();
    answer = siteAnswers;
    const { actor: viewer } = await seedAgent(companyId, ["website:view"]);
    const refused = await request(app(viewer)).post(`${base}/portal-documents`).send({ customerId: CLIENT, kind: "nda", title: "NDA" }).expect(403);
    expect(refused.body.code).toBe("website_permission_missing");
    const http = request(app());
    for (const bad of [
      { customerId: CLIENT, kind: "contract", title: "NDA" },
      { customerId: CLIENT, kind: "nda", title: "NDA", status: "published" },
      { customerId: "not-a-uuid", kind: "nda", title: "NDA" },
      { customerId: CLIENT, kind: "nda", title: "NDA", body: { sections: [{ id: "a", title: "A", html: "<img src=x>" }] } },
      { customerId: CLIENT, kind: "nda", title: "NDA", body: { sections: [{ id: "a", title: "A", html: "<p onclick=\"x\">a</p>" }] } },
      { customerId: CLIENT, kind: "nda", title: "NDA", body: { sections: [{ id: "a", title: "A", html: "" }, { id: "a", title: "B", html: "" }] } },
    ]) {
      const res = await http.post(`${base}/portal-documents`).send(bad).expect(422);
      expect(res.body.code, JSON.stringify(bad)).toBe("website_portal_document_invalid");
    }
    expect((await http.post(`${base}/portal-documents`).send({ customerId: CLIENT, kind: "nda", title: "NDA",
      body: { sections: [{ id: "a", title: "A", html: "<script>x</script>" }] } }).expect(422)).body.error).toMatch(/<script> is not allowed/);
    await http.patch(`${base}/portal-documents/${DOC}`).send({ expectedRowVersion: 1 }).expect(422);
    await http.post(`${base}/portal-documents/${DOC}/approve-and-publish`).send({ expectedContentSha256: "short" }).expect(422);
    await http.post(`${base}/portal-documents/not-a-uuid/submit`).send({ expectedRowVersion: 1 }).expect(404);
    const huge = "x".repeat(1024 * 1024);
    const tooLarge = await http.post(`${base}/portal-documents`).send({ customerId: CLIENT, kind: "nda", title: "NDA", summary: huge }).expect(413);
    expect(tooLarge.body.code).toBe("website_portal_document_too_large");
    expect(seen).toHaveLength(0);

    const { base: readOnly } = await seedSite(false);
    const off = await http.post(`${readOnly}/portal-documents`).send({ customerId: CLIENT, kind: "nda", title: "NDA" }).expect(409);
    expect(off.body).toMatchObject({ code: "capability_not_configured", error: "Portal document changes are off for this site: no write key is set up" });
    expect(seen).toHaveLength(0);
  });
});
