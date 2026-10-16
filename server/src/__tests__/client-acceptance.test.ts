import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  assets,
  companies,
  createDb,
  documents,
  issueAttachments,
  issueDocuments,
  issues,
  issueWorkProducts,
  memoryRecords,
  memoryScopes,
  memorySettings,
  pipelineCaseEvidence,
  pipelineStages,
  projects,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { pipelineRoutes } from "../routes/pipelines.js";
import { clientAcceptancePublicRoutes } from "../routes/client-acceptance-public.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { memoryGatewayService } from "../services/memory-gateway/service.js";
import type { StorageService } from "../storage/types.js";

// In-memory storage for uploads: object key to bytes.
const storedObjects = new Map<string, { body: Buffer; contentType: string }>();
const memoryStorage: StorageService = {
  provider: "local_disk",
  putFile: async (input) => {
    const objectKey = `${input.companyId}/${input.namespace}/${randomUUID()}-${input.originalFilename ?? "file"}`;
    storedObjects.set(objectKey, { body: input.body, contentType: input.contentType });
    return {
      provider: "local_disk",
      objectKey,
      contentType: input.contentType,
      byteSize: input.body.length,
      sha256: createHash("sha256").update(input.body).digest("hex"),
      originalFilename: input.originalFilename,
    };
  },
  getObject: async (_companyId, objectKey) => {
    const object = storedObjects.get(objectKey);
    if (!object) throw new Error("missing object");
    return { stream: Readable.from(object.body), contentType: object.contentType, contentLength: object.body.length };
  },
  headObject: async (_companyId, objectKey) => ({ exists: storedObjects.has(objectKey) }),
  deleteObject: async (_companyId, objectKey) => {
    storedObjects.delete(objectKey);
  },
};

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres client files tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Online acceptance of the engagement pack (John's yes, 16 Oct).
describeEmbeddedPostgres("client acceptance link", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-client-acceptance-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    await instanceSettingsService(db).updateExperimental({ enablePipelines: true });
  });

  afterEach(async () => {
    storedObjects.clear();
    await db.execute(sql`TRUNCATE "companies", "instance_settings", "activity_log" CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const boardActor: Express.Request["actor"] = {
    type: "board",
    userId: "board-user",
    source: "local_implicit",
    isInstanceAdmin: true,
  };

  function app(actor: Express.Request["actor"] = boardActor) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", pipelineRoutes(db, { heartbeat: { wakeup: async () => null }, storage: memoryStorage, publicBaseUrl: "https://gsam.example.com/" }));
    instance.use("/api", clientAcceptancePublicRoutes(db, memoryStorage));
    instance.use(errorHandler);
    return instance;
  }

  async function seedCompany(name: string) {
    const prefix = `P${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const [company] = await db.insert(companies).values({ name, issuePrefix: prefix }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: `${name} agent`, role: "engineer" }).returning();
    const [project] = await db.insert(projects).values({ companyId: company!.id, name: `${name} project`, status: "in_progress" }).returning();
    return { company: company!, agent: agent!, project: project!, prefix };
  }

  async function seedClientCase(companyId: string, title: string) {
    const http = request(app());
    const pipeline = await http
      .post(`/api/companies/${companyId}/pipelines`)
      .send({
        key: "client",
        name: "Client journey",
        stages: [
          { key: "lead", name: "Lead", kind: "open", position: 100 },
          { key: "live", name: "Live and expansion", kind: "done", position: 900 },
          { key: "lost", name: "Lost", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(201);
    const created = await http
      .post(`/api/pipelines/${pipeline.body.id}/cases`)
      .send({ caseKey: "client-1", title, stageKey: "lead" })
      .expect(201);
    return (created.body.case ?? created.body).id as string;
  }

  const anonymous: Express.Request["actor"] = { type: "none", source: "none" };

  async function readyClient() {
    const { company, agent } = await seedCompany("Greatstone");
    const caseId = await seedClientCase(company.id, "Omni Group");
    const http = request(app());
    await http.put(`/api/cases/${caseId}/nda`).send({ status: "accepted" }).expect(200);
    return { company, agent, caseId, http };
  }

  it("needs a cleared NDA and an uploaded pack before a link is made", async () => {
    const { company } = await seedCompany("Greatstone");
    const caseId = await seedClientCase(company.id, "Omni Group");
    const http = request(app());
    const blocked = await http.post(`/api/cases/${caseId}/engagement/online-link`).expect(409);
    expect(blocked.body.details?.code ?? blocked.body.code).toBe("nda_required");
    await http.put(`/api/cases/${caseId}/nda`).send({ status: "accepted" }).expect(200);
    const noPack = await http.post(`/api/cases/${caseId}/engagement/online-link`).expect(409);
    expect(noPack.body.details?.code ?? noPack.body.code).toBe("pack_required");
  });

  it("lets a client read the pack and accept it online, without signing in", async () => {
    const { caseId, http, agent, company } = await readyClient();
    await http
      .post(`/api/cases/${caseId}/engagement/pack`)
      .attach("file", Buffer.from("%PDF-1.4 engagement pack"), { filename: "Pack.pdf", contentType: "application/pdf" })
      .expect(201);

    // Only board users make links.
    const agentHttp = request(app({ type: "agent", agentId: agent.id, companyId: company.id, runId: randomUUID(), source: "agent_key" }));
    await agentHttp.post(`/api/cases/${caseId}/engagement/online-link`).expect(403);

    const created = await http.post(`/api/cases/${caseId}/engagement/online-link`).expect(201);
    expect(created.body.url).toMatch(/^https:\/\/gsam\.example\.com\/accept\/gsa_accept_/);
    const token = decodeURIComponent(created.body.path.replace("/accept/", ""));
    let journey = await http.get(`/api/cases/${caseId}/journey`).expect(200);
    expect(journey.body.engagement.onlineLink).toMatchObject({ id: created.body.link.id, acceptedAt: null, expired: false });

    const client = request(app(anonymous));
    const view = await client.get(`/api/client-acceptance/${token}`).expect(200);
    expect(view.body).toEqual({
      companyName: "Greatstone",
      clientName: "Omni Group",
      packTitle: "Engagement pack",
      packPath: `/api/client-acceptance/${token}/pack`,
      status: "open",
      expiresAt: created.body.link.expiresAt,
      acceptedAt: null,
      acceptedName: null,
    });
    expect(view.headers["cache-control"]).toBe("no-store");
    const file = await client.get(`/api/client-acceptance/${token}/pack`).expect(200);
    expect(Buffer.from(file.body).toString()).toBe("%PDF-1.4 engagement pack");

    // The form must be complete and ticked.
    await client.post(`/api/client-acceptance/${token}/accept`).send({ name: "Ada Mensah", email: "ada@omni.com" }).expect(400);
    await client.post(`/api/client-acceptance/${token}/accept`).send({ name: "Ada Mensah", email: "nope", agree: true }).expect(400);

    const accepted = await client
      .post(`/api/client-acceptance/${token}/accept`)
      .send({ name: "Ada Mensah", role: "Chief Executive", email: "ada@omni.com", agree: true })
      .expect(200);
    expect(accepted.body).toMatchObject({ status: "accepted", acceptedName: "Ada Mensah" });
    await client
      .post(`/api/client-acceptance/${token}/accept`)
      .send({ name: "Someone Else", email: "x@omni.com", agree: true })
      .expect(409);

    journey = await http.get(`/api/cases/${caseId}/journey`).expect(200);
    expect(journey.body.engagement).toMatchObject({
      status: "accepted",
      onlineLink: { acceptedName: "Ada Mensah", acceptedRole: "Chief Executive", acceptedEmail: "ada@omni.com" },
    });
    expect(journey.body.engagement.sentAt).toBeTruthy();
    expect(journey.body.engagement.acceptedAt).toBeTruthy();

    // The accepted page still opens, so the client can see the confirmation.
    await client.get(`/api/client-acceptance/${token}`).expect(200);
  });

  it("stops an old link working once it is replaced, revoked or the engagement starts over", async () => {
    const { caseId, http } = await readyClient();
    await http
      .post(`/api/cases/${caseId}/engagement/pack`)
      .attach("file", Buffer.from("%PDF-1.4 pack"), { filename: "Pack.pdf", contentType: "application/pdf" })
      .expect(201);
    const client = request(app(anonymous));
    const tokenOf = (body: { path: string }) => decodeURIComponent(body.path.replace("/accept/", ""));

    const first = await http.post(`/api/cases/${caseId}/engagement/online-link`).expect(201);
    const second = await http.post(`/api/cases/${caseId}/engagement/online-link`).expect(201);
    await client.get(`/api/client-acceptance/${tokenOf(first.body)}`).expect(404);
    await client.get(`/api/client-acceptance/${tokenOf(second.body)}`).expect(200);

    await http.delete(`/api/cases/${caseId}/engagement/online-link`).expect(204);
    await client.get(`/api/client-acceptance/${tokenOf(second.body)}`).expect(404);
    await http.delete(`/api/cases/${caseId}/engagement/online-link`).expect(404);
    let journey = await http.get(`/api/cases/${caseId}/journey`).expect(200);
    expect(journey.body.engagement.onlineLink).toBeNull();

    const third = await http.post(`/api/cases/${caseId}/engagement/online-link`).expect(201);
    await http.put(`/api/cases/${caseId}/engagement`).send({ status: "not_sent" }).expect(200);
    await client.get(`/api/client-acceptance/${tokenOf(third.body)}`).expect(404);
    journey = await http.get(`/api/cases/${caseId}/journey`).expect(200);
    expect(journey.body.engagement.onlineLink).toBeNull();

    // Made-up tokens find nothing.
    await client.get("/api/client-acceptance/gsa_accept_madeup").expect(404);
    await client.get("/api/client-acceptance/anything").expect(404);
  });

  it("refuses a link that has expired", async () => {
    const { caseId, http } = await readyClient();
    await http
      .post(`/api/cases/${caseId}/engagement/pack`)
      .attach("file", Buffer.from("%PDF-1.4 pack"), { filename: "Pack.pdf", contentType: "application/pdf" })
      .expect(201);
    const created = await http.post(`/api/cases/${caseId}/engagement/online-link`).expect(201);
    await db.execute(sql`UPDATE client_acceptance_links SET expires_at = now() - interval '1 day'`);
    const token = decodeURIComponent(created.body.path.replace("/accept/", ""));
    await request(app(anonymous)).get(`/api/client-acceptance/${token}`).expect(404);
    const journey = await http.get(`/api/cases/${caseId}/journey`).expect(200);
    expect(journey.body.engagement.onlineLink.expired).toBe(true);
  });
});
