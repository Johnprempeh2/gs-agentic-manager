import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPublicKey, randomUUID, verify } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  companySecrets,
  companySecretVersions,
  createDb,
  instanceSettings,
  principalPermissionGrants,
  websiteProperties,
  websiteSite,
} from "@greatstone/db";
import { PUBLIC_NETLIFY_SITE_ID, type WebsiteProductionStatus, type WebsiteSite } from "@greatstone/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { websiteModuleRoutes } from "../routes/website-module.js";
import type { productionClient } from "../services/website/production-deploy.js";
import { instanceSettingsService } from "../services/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

type Actor = Express.Request["actor"];
type Client = Awaited<ReturnType<typeof productionClient>>;
type Status = Awaited<ReturnType<Client["status"]>>;

const STAGED = "a".repeat(40);
const ROLLBACK_TO = "b".repeat(24);

// The lean Deploy (John, 11 Nov 2026): only a signed-in person with an explicit website:deploy grant starts the
// production workflow, and GSAM signs exactly what staging serves.
describeEmbeddedPostgres("website Deploy and Roll back routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const keyFolder = mkdtempSync(path.join(os.tmpdir(), "gsam-website-production-key-"));
  const previousKeyFile = process.env.GSAM_SECRETS_MASTER_KEY_FILE;

  beforeAll(async () => {
    process.env.GSAM_SECRETS_MASTER_KEY_FILE = path.join(keyFolder, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("gsam-website-production-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(websiteSite);
    await db.delete(websiteProperties);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
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

  const localBoard: Actor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };
  let status: Status;
  let dispatched: { action: string; request: string; ticket: string }[] = [];
  const fakeClient = (): Client => ({
    status: async () => status,
    stagingPointer: async () => ({ release: 9, sha256: "c".repeat(64) }),
    dispatch: async (action, request, ticket) => { dispatched.push({ action, request, ticket }); },
  });

  function app(actor: Actor = localBoard) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => { req.actor = actor; next(); });
    instance.use("/api", websiteModuleRoutes(db, {
      checkConnection: async () => ({ ok: true, engineVersion: "0.1.0", releaseSchemaVersion: 1 }),
      production: async () => fakeClient(),
    }));
    instance.use(errorHandler);
    return instance;
  }

  async function seedUser(companyId: string, role: "owner" | "admin", grants: string[] = [], source: "session" | "board_key" = "session") {
    const userId = `user-${randomUUID().slice(0, 8)}`;
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: role });
    for (const key of grants) await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: key, scope: null });
    return { type: "board", userId, source, isInstanceAdmin: false, companyIds: [companyId], memberships: [{ companyId, membershipRole: role, status: "active" }] } as Actor;
  }

  async function seedWorld() {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const [company] = await db.insert(companies).values({ name: "Greatstone", issuePrefix: `D${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}` }).returning();
    const site = (await request(app())
      .post(`/api/companies/${company!.id}/website/sites`)
      .send({ name: "Greatstone website", domain: "greatstoneint.test", netlifySiteId: PUBLIC_NETLIFY_SITE_ID, netlifyToken: "nfp_test_token_value_123" })
      .expect(201)).body as WebsiteSite;
    const john = await seedUser(company!.id, "owner", ["website:deploy"]);
    const ben = await seedUser(company!.id, "admin");
    return { company: company!, site, john, ben, base: `/api/companies/${company!.id}/website/sites/${site.id}/production` };
  }

  beforeEach(() => {
    dispatched = [];
    status = {
      staging: { commit: STAGED, release: 9 },
      live: { commit: "d".repeat(40), release: 8, deployId: "e".repeat(24), publishedAt: "2026-11-09T06:04:22.415Z" },
      commits: [{ sha: STAGED, title: "Voice guide" }],
      blockers: [],
      rollback: { deployId: ROLLBACK_TO, commit: null, publishedAt: "2026-11-08T10:00:00.000Z" },
      runs: [],
      workflowReady: true,
      problems: [],
    };
  });

  const deployBody = { stagingCommit: STAGED, stagingRelease: 9 };

  it("lets John Deploy with a ticket GSAM signs for exactly what staging serves", async () => {
    const { john, base } = await seedWorld();
    const view = (await request(app(john)).get(base).expect(200)).body as WebsiteProductionStatus;
    expect(view.canDeploy).toBe(true);
    expect(view.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const started = await request(app(john)).post(`${base}/deploy`).send(deployBody).expect(202);
    expect(dispatched).toHaveLength(1);
    const { action, request: id, ticket } = dispatched[0]!;
    expect([action, id]).toEqual(["deploy", started.body.request]);
    const [body, signature] = ticket.split(".");
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: view.publicKey! }, format: "jwk" });
    expect(verify(null, Buffer.from(body!), key, Buffer.from(signature!, "base64url"))).toBe(true);
    const payload = JSON.parse(Buffer.from(body!, "base64url").toString());
    expect(payload).toMatchObject({ v: 1, action: "deploy", site: "greatstone-home", sha: STAGED, release: 9, sha256: "c".repeat(64), id, by: john.userId });
    expect(payload.exp - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000);
    // The same key signs every ticket: a second view shows the same public half.
    expect((await request(app(john)).get(base).expect(200)).body.publicKey).toBe(view.publicKey);
  });

  it("refuses Deploy and Roll back to anyone else: an admin, an owner without the grant, an API key, an agent, the local board", async () => {
    const { company, john, ben, base } = await seedWorld();
    const ownerWithoutGrant = await seedUser(company.id, "owner");
    const johnByKey = { ...john, source: "board_key" } as Actor;
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Lintel", role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "agent", principalId: agent!.id, status: "active", membershipRole: "member" });
    await db.insert(principalPermissionGrants).values({ companyId: company.id, principalType: "agent", principalId: agent!.id, permissionKey: "website:deploy", scope: null });
    const agentActor = { type: "agent", agentId: agent!.id, companyId: company.id, source: "agent_key" } as Actor;
    for (const actor of [ben, ownerWithoutGrant, johnByKey, localBoard]) {
      await request(app(actor)).post(`${base}/deploy`).send(deployBody).expect(403);
      await request(app(actor)).post(`${base}/rollback`).send({ deployId: ROLLBACK_TO }).expect(403);
      const view = (await request(app(actor)).get(base).expect(200)).body as WebsiteProductionStatus;
      expect([view.canDeploy, view.publicKey]).toEqual([false, null]);
    }
    const agentDeploy = await request(app(agentActor)).post(`${base}/deploy`).send(deployBody);
    expect(agentDeploy.status).toBeGreaterThanOrEqual(403);
    expect(agentDeploy.status).toBeLessThan(500);
    const agentRollback = await request(app(agentActor)).post(`${base}/rollback`).send({ deployId: ROLLBACK_TO });
    expect(agentRollback.status).toBeGreaterThanOrEqual(403);
    expect(agentRollback.status).toBeLessThan(500);
    expect(dispatched).toEqual([]);
  });

  it("lets John Roll back only to the deploy the panel showed", async () => {
    const { john, base } = await seedWorld();
    await request(app(john)).post(`${base}/rollback`).send({ deployId: "f".repeat(24) }).expect(409);
    await request(app(john)).post(`${base}/rollback`).send({ deployId: ROLLBACK_TO }).expect(202);
    expect(dispatched.map((d) => d.action)).toEqual(["rollback"]);
    const payload = JSON.parse(Buffer.from(dispatched[0]!.ticket.split(".")[0]!, "base64url").toString());
    expect(payload).toMatchObject({ action: "rollback", deployId: ROLLBACK_TO, site: "greatstone-home" });
  });

  it("refuses Deploy while one runs, when staging moved, when a check fails, or before GitHub is set up", async () => {
    const { john, base } = await seedWorld();
    await request(app(john)).post(`${base}/deploy`).send({ ...deployBody, stagingRelease: 8 }).expect(409);
    await request(app(john)).post(`${base}/deploy`).send({ ...deployBody, stagingCommit: "9".repeat(40) }).expect(409);
    status.blockers = ["Staging's /shop shows no prices."];
    const blocked = await request(app(john)).post(`${base}/deploy`).send(deployBody).expect(409);
    expect(blocked.body.error).toContain("Staging's /shop shows no prices.");
    status.blockers = [];
    status.runs = [{ id: 1, action: "deploy", request: randomUUID(), status: "in_progress", conclusion: null, createdAt: "", url: "" }];
    await request(app(john)).post(`${base}/deploy`).send(deployBody).expect(409);
    await request(app(john)).post(`${base}/rollback`).send({ deployId: ROLLBACK_TO }).expect(409);
    status.runs = [];
    status.workflowReady = false;
    await request(app(john)).post(`${base}/deploy`).send(deployBody).expect(409);
    expect(dispatched).toEqual([]);
  });
});
