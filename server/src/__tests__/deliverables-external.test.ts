import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  assets,
  companies,
  createDb,
  issueAttachments,
  issues,
  issueWorkProducts,
  pipelineCaseIssueLinks,
  pipelineCases,
  pipelines,
  pipelineStages,
  projects,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { deliverableRoutes } from "../routes/deliverables.js";
import { deliverableService } from "../services/deliverables.js";
import type { StorageService } from "../storage/types.js";

// Link deliverables (live sites), labels, the daily link check, and agents
// finding a deliverable by search with a direct link ("Ask Everest").

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres external deliverables tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const otherAgentId = "44444444-4444-4444-8444-444444444444";
const projectId = "55555555-5555-4555-8555-555555555555";
const issueId = "66666666-6666-4666-8666-666666666666";
const BASE = "https://gsam.example.com";

const storage = {
  provider: "local_disk",
  putFile: vi.fn(async (input: { namespace: string; originalFilename: string | null; contentType: string; body: Buffer }) => ({
    provider: "local_disk",
    objectKey: `${input.namespace}/${Math.random().toString(36).slice(2)}-${input.originalFilename}`,
    contentType: input.contentType,
    byteSize: input.body.length,
    sha256: "sha-screenshot",
    originalFilename: input.originalFilename,
  })),
  getObject: vi.fn(async () => ({ stream: Readable.from(Buffer.from("")), contentType: "text/html", contentLength: 0 })),
  headObject: vi.fn(),
  deleteObject: vi.fn(),
} as unknown as StorageService;

describeEmbeddedPostgres("external deliverables", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const screenshot = vi.fn(async (_url: string): Promise<Buffer | null> => Buffer.from("jpeg"));

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-deliverables-external-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    screenshot.mockClear();
    await db.delete(activityLog);
    await db.delete(issueWorkProducts);
    await db.delete(pipelineCaseIssueLinks);
    await db.delete(pipelineCases);
    await db.delete(pipelineStages);
    await db.delete(pipelines);
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    await db.insert(companies).values([
      { id: companyId, name: "Greatstone", issuePrefix: "GRE", requireBoardApprovalForNewAgents: false },
      { id: otherCompanyId, name: "OtherCo", issuePrefix: "OTH", requireBoardApprovalForNewAgents: false },
    ]);
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Everest", role: "engineer" },
      { id: otherAgentId, companyId: otherCompanyId, name: "Outsider", role: "engineer" },
    ]);
    await db.insert(projects).values({ id: projectId, companyId, name: "Energy sector websites", status: "in_progress" });
    await db.insert(issues).values({
      id: issueId, companyId, projectId, identifier: "GRE-9", title: "Netlify sites", status: "in_progress", priority: "medium", assigneeAgentId: agentId,
    });
    const [pipeline] = await db.insert(pipelines).values({ companyId, key: "clients", name: "Clients" }).returning();
    const [stage] = await db.insert(pipelineStages).values({
      pipelineId: pipeline!.id, key: "active", name: "Active", kind: "working", position: 0,
    }).returning();
    const [clientCase] = await db.insert(pipelineCases).values({
      companyId, pipelineId: pipeline!.id, stageId: stage!.id, caseKey: "moen", title: "Ministry of Energy",
    }).returning();
    await db.insert(pipelineCaseIssueLinks).values({ companyId, caseId: clientCase!.id, issueId, role: "work" });
  }

  function appAs(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", deliverableRoutes(db, storage, { screenshot, publicBaseUrl: `${BASE}/` }));
    app.use(errorHandler);
    return app;
  }

  const board = () => appAs({
    type: "board",
    userId: "user-1",
    source: "local_implicit",
    isInstanceAdmin: true,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
  } as Express.Request["actor"]);
  const agent = (id = agentId, company = companyId) =>
    appAs({ type: "agent", agentId: id, companyId: company, source: "agent_key" } as Express.Request["actor"]);

  async function createSite(body: Record<string, unknown> = {}) {
    const res = await request(board()).post(`/api/issues/${issueId}/deliverables`).send({
      url: "https://greatstone-moengt-deck.netlify.app",
      title: "MoEnGT deck",
      kind: "deck",
      summary: "Ministry of Energy deck",
      confidentiality: "client",
      status: "final",
      ...body,
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  it("creates a link deliverable from a url, with a screenshot and versions", async () => {
    await seed();
    const created = await createSite();
    expect(created).toMatchObject({
      key: "moengt-deck",
      version: 1,
      external: true,
      url: "https://greatstone-moengt-deck.netlify.app",
      attachmentId: null,
      contentType: "text/uri-list",
      openPath: "https://greatstone-moengt-deck.netlify.app",
      confidentiality: "client",
      restricted: false,
      linkCheck: null,
      clientCase: { name: "Ministry of Energy" },
      appUrl: `${BASE}/GRE/deliverables?open=${created.id}`,
    });

    // The screenshot is taken on demand too; it becomes an image attachment on the task.
    const refreshed = await request(board()).post(`/api/companies/${companyId}/deliverables/${created.id}/screenshot`);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.captured).toBe(true);
    expect(refreshed.body.deliverable.screenshotPath).toMatch(/^\/api\/attachments\/[0-9a-f-]{36}\/content$/);
    expect(screenshot).toHaveBeenCalledWith("https://greatstone-moengt-deck.netlify.app");

    // No browser on the server: the card keeps its placeholder.
    screenshot.mockResolvedValueOnce(null);
    const none = await request(board()).post(`/api/companies/${companyId}/deliverables/${created.id}/screenshot`);
    expect(none.body.captured).toBe(false);

    // The same key makes v2 and keeps the label.
    const v2 = await request(board()).post(`/api/issues/${issueId}/deliverables`).send({
      url: "https://greatstone-moengt-deck.netlify.app/v2",
      title: "MoEnGT deck",
    });
    expect(v2.body).toMatchObject({ version: 2, versionCount: 2, confidentiality: "client", url: "https://greatstone-moengt-deck.netlify.app/v2" });
    expect(v2.body.versions.map((version: { contentPath: string }) => version.contentPath)).toEqual([
      "https://greatstone-moengt-deck.netlify.app/v2",
      "https://greatstone-moengt-deck.netlify.app",
    ]);

    // Exactly one of attachmentId or url, https only.
    const both = await request(board()).post(`/api/issues/${issueId}/deliverables`).send({
      url: "https://example.com", attachmentId: "6f9619ff-8b86-4011-b42d-00c04fc964ff", title: "Both",
    });
    expect(both.status).toBe(400);
    const plain = await request(board()).post(`/api/issues/${issueId}/deliverables`).send({ url: "http://example.com", title: "Plain" });
    expect(plain.status).toBe(400);
  });

  it("lets agents search by project or client and get direct links", async () => {
    await seed();
    const created = await createSite();
    for (const q of ["moengt", "Energy sector", "Ministry of Energy", "netlify.app"]) {
      const res = await request(agent()).get(`/api/companies/${companyId}/deliverables`).query({ q });
      expect(res.status).toBe(200);
      expect(res.body.deliverables).toEqual([
        expect.objectContaining({
          id: created.id,
          url: "https://greatstone-moengt-deck.netlify.app",
          appUrl: `${BASE}/GRE/deliverables?open=${created.id}`,
        }),
      ]);
    }
    const miss = await request(agent()).get(`/api/companies/${companyId}/deliverables`).query({ q: "Kumasi" });
    expect(miss.body.deliverables).toEqual([]);
    // Another company's agent cannot search this company.
    const outsider = await request(agent(otherAgentId, otherCompanyId)).get(`/api/companies/${companyId}/deliverables`).query({ q: "moengt" });
    expect(outsider.status).toBe(403);
  });

  it("relabels deliverables for board users and agents that may change the task, and filters by label", async () => {
    await seed();
    const created = await createSite({ confidentiality: undefined });
    expect(created.confidentiality).toBe("internal");

    const byAgent = await request(agent()).patch(`/api/companies/${companyId}/deliverables/${created.id}`).send({ confidentiality: "public" });
    expect(byAgent.status).toBe(200);
    expect(byAgent.body.confidentiality).toBe("public");
    const byBoard = await request(board()).patch(`/api/companies/${companyId}/deliverables/${created.id}`).send({ restricted: true });
    expect(byBoard.body).toMatchObject({ confidentiality: "public", restricted: true });
    const outsider = await request(agent(otherAgentId, otherCompanyId))
      .patch(`/api/companies/${companyId}/deliverables/${created.id}`).send({ confidentiality: "internal" });
    expect(outsider.status).toBe(403);

    const publicOnly = await request(board()).get(`/api/companies/${companyId}/deliverables`).query({ confidentiality: "public" });
    expect(publicOnly.body.deliverables.map((item: { id: string }) => item.id)).toEqual([created.id]);
    const internalOnly = await request(board()).get(`/api/companies/${companyId}/deliverables`).query({ confidentiality: "internal" });
    expect(internalOnly.body.deliverables).toEqual([]);
  });

  it("checks each link daily and records status, broken and restricted", async () => {
    await seed();
    const broken = await createSite({ url: "https://gone.example.com", title: "Gone site" });
    const locked = await createSite({ url: "https://locked.example.com", title: "Locked site" });
    const statuses: Record<string, number | null> = { "https://gone.example.com": 404, "https://locked.example.com": 401 };
    const svc = deliverableService(db, storage);
    const now = new Date("2026-10-13T09:00:00.000Z");

    const first = await svc.checkDueLinks({ now, check: async (url) => statuses[url] ?? null });
    expect(first).toEqual({ checked: 2, broken: 1 });
    // Checked today: nothing is due until a day has passed.
    expect(await svc.checkDueLinks({ now, check: async () => 200 })).toEqual({ checked: 0, broken: 0 });

    const brokenOnly = await request(board()).get(`/api/companies/${companyId}/deliverables`).query({ linkHealth: "broken" });
    expect(brokenOnly.body.deliverables).toEqual([
      expect.objectContaining({ id: broken.id, linkCheck: { lastCheckedAt: now.toISOString(), httpStatus: 404, ok: false } }),
    ]);
    const lockedDetail = await request(board()).get(`/api/companies/${companyId}/deliverables/${locked.id}`);
    expect(lockedDetail.body).toMatchObject({ restricted: true, linkCheck: { httpStatus: 401, ok: true } });

    const tomorrow = new Date(now.getTime() + 25 * 60 * 60 * 1000);
    expect(await svc.checkDueLinks({ now: tomorrow, check: async () => 200 })).toEqual({ checked: 2, broken: 0 });
  });
});
