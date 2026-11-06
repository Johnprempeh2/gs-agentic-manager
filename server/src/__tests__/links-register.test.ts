import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issues,
  issueWorkProducts,
  pipelineCaseIssueLinks,
  pipelineCaseProjectLinks,
  pipelineCases,
  pipelines,
  pipelineStages,
  projects,
  sharedLinks,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { deliverableRoutes } from "../routes/deliverables.js";
import { linkRoutes } from "../routes/links.js";
import { workProductService } from "../services/work-products.js";
import type { StorageService } from "../storage/types.js";

// The links register (GRE-4252): search, filters, one row per URL, company
// isolation, the Notion CSV import and automatic capture of deliverables and
// previews.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres links register tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const otherAgentId = "44444444-4444-4444-8444-444444444444";
const projectId = "55555555-5555-4555-8555-555555555555";
const issueId = "66666666-6666-4666-8666-666666666666";
const otherProjectId = "77777777-7777-4777-8777-777777777777";
const otherIssueId = "88888888-8888-4888-8888-888888888888";

const storage = {
  provider: "local_disk",
  putFile: vi.fn(),
  getObject: vi.fn(async () => ({ stream: Readable.from(Buffer.from("")), contentType: "text/html", contentLength: 0 })),
  headObject: vi.fn(),
  deleteObject: vi.fn(),
} as unknown as StorageService;

describeEmbeddedPostgres("links register", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let clientCaseId = "";
  let secondClientCaseId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-links-register-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(sharedLinks);
    await db.delete(issueWorkProducts);
    await db.delete(pipelineCaseIssueLinks);
    await db.delete(pipelineCaseProjectLinks);
    await db.delete(pipelineCases);
    await db.delete(pipelineStages);
    await db.delete(pipelines);
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
    await db.insert(projects).values([
      { id: projectId, companyId, name: "Clinic website", status: "in_progress" },
      { id: otherProjectId, companyId, name: "Bakery portal", status: "in_progress" },
    ]);
    await db.insert(issues).values([
      { id: issueId, companyId, projectId, identifier: "GRE-9", title: "Clinic site", status: "in_progress", priority: "medium", assigneeAgentId: agentId },
      { id: otherIssueId, companyId, projectId: otherProjectId, identifier: "GRE-10", title: "Bakery portal", status: "in_progress", priority: "medium", assigneeAgentId: agentId },
    ]);
    const [pipeline] = await db.insert(pipelines).values({ companyId, key: "clients", name: "Clients" }).returning();
    const [stage] = await db.insert(pipelineStages).values({
      pipelineId: pipeline!.id, key: "active", name: "Active", kind: "working", position: 0,
    }).returning();
    const [clientCase, secondCase] = await db.insert(pipelineCases).values([
      { companyId, pipelineId: pipeline!.id, stageId: stage!.id, caseKey: "acme", title: "Acme Clinic" },
      { companyId, pipelineId: pipeline!.id, stageId: stage!.id, caseKey: "bakery", title: "Northside Bakery" },
    ]).returning();
    clientCaseId = clientCase!.id;
    secondClientCaseId = secondCase!.id;
    // Acme through a task link; the bakery through its project.
    await db.insert(pipelineCaseIssueLinks).values({ companyId, caseId: clientCaseId, issueId, role: "work" });
    await db.insert(pipelineCaseProjectLinks).values({ companyId, caseId: secondClientCaseId, projectId: otherProjectId });
  }

  function appAs(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json({ limit: "5mb" }));
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", linkRoutes(db));
    app.use("/api", deliverableRoutes(db, storage, { screenshot: async () => null, publicBaseUrl: "https://gsam.example.com/" }));
    app.use(errorHandler);
    return app;
  }

  const board = (companyIds = [companyId]) => appAs({
    type: "board",
    userId: "user-1",
    source: "session",
    isInstanceAdmin: false,
    companyIds,
    memberships: companyIds.map((id) => ({ companyId: id, membershipRole: "owner", status: "active" })),
  } as Express.Request["actor"]);
  const agent = (id = agentId, company = companyId) =>
    appAs({ type: "agent", agentId: id, companyId: company, source: "agent_key" } as Express.Request["actor"]);

  async function addLink(body: Record<string, unknown>, app = agent()) {
    return request(app).post(`/api/companies/${companyId}/links`).send(body);
  }

  it("adds a link, fills client and project from the source task, and a second add updates the same row", async () => {
    await seed();
    const created = await addLink({ url: "https://Acme-Clinic.netlify.app", title: "Acme demo", type: "demo", sourceIssueId: issueId });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      url: "https://acme-clinic.netlify.app/",
      title: "Acme demo",
      type: "demo",
      status: "live",
      source: "manual",
      clientCase: { id: clientCaseId, name: "Acme Clinic" },
      project: { id: projectId, name: "Clinic website" },
      sourceIssue: { id: issueId, identifier: "GRE-9", path: "/GRE/issues/GRE-9" },
      addedBy: { type: "agent", id: agentId, name: "Everest" },
    });

    const again = await addLink({ url: "https://acme-clinic.netlify.app/", title: "Acme demo v2", notes: "Sent to the clinic" });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(created.body.id);
    expect(again.body).toMatchObject({ title: "Acme demo v2", notes: "Sent to the clinic", type: "demo", clientCase: { id: clientCaseId } });
    expect(await db.select().from(sharedLinks)).toHaveLength(1);
  });

  it("searches title, URL, client and notes, and filters by client, project, type and status", async () => {
    await seed();
    await addLink({ url: "https://acme-clinic.netlify.app", title: "Clinic demo", type: "demo", sourceIssueId: issueId });
    await addLink({ url: "https://bakery-portal.greatstoneint.com", title: "Bakery portal", type: "portal", projectId: otherProjectId, notes: "login for the owner" });
    await addLink({ url: "https://notion.so/old-plan", title: "Old plan", type: "report", status: "draft" });

    const search = async (query: Record<string, string>) => {
      const res = await request(board()).get(`/api/companies/${companyId}/links`).query(query);
      expect(res.status).toBe(200);
      return (res.body.links as Array<{ title: string }>).map((link) => link.title).sort();
    };

    expect(await search({ q: "clinic.netlify" })).toEqual(["Clinic demo"]);
    expect(await search({ q: "northside" })).toEqual(["Bakery portal"]);
    expect(await search({ q: "OWNER" })).toEqual(["Bakery portal"]);
    expect(await search({ q: "old plan" })).toEqual(["Old plan"]);
    expect(await search({ clientCaseId })).toEqual(["Clinic demo"]);
    expect(await search({ clientCaseId: secondClientCaseId })).toEqual(["Bakery portal"]);
    expect(await search({ projectId: otherProjectId })).toEqual(["Bakery portal"]);
    expect(await search({ type: "demo" })).toEqual(["Clinic demo"]);
    expect(await search({ status: "draft" })).toEqual(["Old plan"]);

    const all = await request(board()).get(`/api/companies/${companyId}/links`);
    expect(all.body.total).toBe(3);
    expect(all.body.facets.clients.map((c: { name: string }) => c.name)).toEqual(["Acme Clinic", "Northside Bakery"]);
  });

  it("archives a link and hides it unless archived links are asked for", async () => {
    await seed();
    const created = await addLink({ url: "https://old.netlify.app", title: "Old site" });
    const archived = await request(agent()).post(`/api/companies/${companyId}/links/${created.body.id}/archive`);
    expect(archived.status).toBe(200);
    expect(archived.body.status).toBe("archived");
    const visible = await request(board()).get(`/api/companies/${companyId}/links`);
    expect(visible.body.links).toHaveLength(0);
    const withArchived = await request(board()).get(`/api/companies/${companyId}/links`).query({ includeArchived: "true" });
    expect(withArchived.body.links).toHaveLength(1);

    const updated = await request(board()).patch(`/api/companies/${companyId}/links/${created.body.id}`).send({ status: "live", title: "Back up" });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ status: "live", title: "Back up" });
  });

  it("keeps companies apart: no reads, writes or cross-company references", async () => {
    await seed();
    const created = await addLink({ url: "https://acme-clinic.netlify.app", title: "Clinic demo" });

    const outsider = agent(otherAgentId, otherCompanyId);
    expect((await request(outsider).get(`/api/companies/${companyId}/links`)).status).toBe(403);
    expect((await request(outsider).post(`/api/companies/${companyId}/links`).send({ url: "https://x.example.com", title: "x" })).status).toBe(403);
    expect((await request(outsider).post(`/api/companies/${companyId}/links/${created.body.id}/archive`)).status).toBe(403);

    // Their own list is empty, and our row id is not found under their company.
    const theirs = await request(outsider).get(`/api/companies/${otherCompanyId}/links`);
    expect(theirs.status).toBe(200);
    expect(theirs.body.links).toEqual([]);
    expect((await request(outsider).get(`/api/companies/${otherCompanyId}/links/${created.body.id}`)).status).toBe(404);

    // They cannot point a link at our client, project or task.
    const crossRef = await request(outsider).post(`/api/companies/${otherCompanyId}/links`).send({
      url: "https://x.example.com", title: "x", clientCaseId,
    });
    expect(crossRef.status).toBe(422);
    const crossIssue = await request(outsider).post(`/api/companies/${otherCompanyId}/links`).send({
      url: "https://x.example.com", title: "x", sourceIssueId: issueId,
    });
    expect(crossIssue.status).toBe(422);

    // The same URL in two companies is two rows.
    const same = await request(outsider).post(`/api/companies/${otherCompanyId}/links`).send({ url: "https://acme-clinic.netlify.app", title: "Theirs" });
    expect(same.status).toBe(201);
    expect(same.body.id).not.toBe(created.body.id);
  });

  it("files a link deliverable in the register with its client, project and source task", async () => {
    await seed();
    const res = await request(agent())
      .post(`/api/issues/${issueId}/deliverables`)
      .send({ url: "https://acme-clinic-proposal.netlify.app", title: "Acme proposal", kind: "proposal" });
    expect(res.status).toBe(201);

    const list = await request(board()).get(`/api/companies/${companyId}/links`).query({ q: "clinic-proposal" });
    expect(list.body.links).toHaveLength(1);
    expect(list.body.links[0]).toMatchObject({
      url: "https://acme-clinic-proposal.netlify.app/",
      title: "Acme proposal",
      type: "proposal",
      source: "deliverable",
      clientCase: { id: clientCaseId, name: "Acme Clinic" },
      project: { id: projectId },
      sourceIssue: { identifier: "GRE-9" },
      addedBy: { type: "agent", id: agentId },
    });

    // A second version of the same deliverable updates the row, not a new one.
    await request(agent())
      .post(`/api/issues/${issueId}/deliverables`)
      .send({ url: "https://acme-clinic-proposal.netlify.app", title: "Acme proposal", kind: "proposal" });
    expect(await db.select().from(sharedLinks)).toHaveLength(1);
  });

  it("files a preview work product, but not a dev server on this machine", async () => {
    await seed();
    const products = workProductService(db);
    await products.createForIssue(otherIssueId, companyId, {
      type: "preview_url", provider: "custom", title: "Bakery preview", url: "https://bakery-preview.example.ts.net", status: "active",
    });
    await products.createForIssue(otherIssueId, companyId, {
      type: "preview_url", provider: "custom", title: "Local", url: "http://127.0.0.1:5173", status: "active",
    });
    await products.createForIssue(otherIssueId, companyId, {
      type: "pull_request", provider: "github", title: "PR", url: "https://github.com/acme/site/pull/1", status: "active",
    });
    const rows = await db.select().from(sharedLinks);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      url: "https://bakery-preview.example.ts.net/",
      type: "preview",
      source: "preview",
      clientCaseId: secondClientCaseId,
      projectId: otherProjectId,
      sourceIssueId: otherIssueId,
    });
  });

  it("imports a CSV in the Notion register's shape", async () => {
    await seed();
    const csv = [
      "Name,Client,Project,Type,Status,URL,Deploy Date,Notes",
      "Clinic proposal,Acme Clinic,Clinic website,Proposal,Live,https://acme-proposal.netlify.app,2026-08-01,\"First draft, sent\"",
      "Bakery portal,northside bakery,Bakery portal,Portal,Live,https://bakery.greatstoneint.com,2026-08-02,",
      "Unknown client deck,Someone New,New thing,Deck,Draft,https://someone-new.netlify.app,2026-08-03,",
      "Old recap,Acme Clinic,,Recap,Archived,https://acme-recap.netlify.app,,",
      "No link,Acme Clinic,,Demo,Live,,,",
    ].join("\n");
    const res = await request(agent()).post(`/api/companies/${companyId}/links/import`).send({ csv });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ created: 4, updated: 0, skipped: [{ row: 6, reason: "No URL" }] });

    const rows = await request(board()).get(`/api/companies/${companyId}/links`).query({ includeArchived: "true" });
    const byTitle = Object.fromEntries((rows.body.links as Array<{ title: string }>).map((link) => [link.title, link]));
    expect(byTitle["Clinic proposal"]).toMatchObject({
      type: "proposal", status: "live", source: "import", clientCase: { id: clientCaseId }, project: { id: projectId }, notes: "First draft, sent",
      deployedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(byTitle["Bakery portal"]).toMatchObject({ clientCase: { id: secondClientCaseId }, project: { id: otherProjectId } });
    expect(byTitle["Unknown client deck"]).toMatchObject({ clientCase: null, clientName: "Someone New", projectName: "New thing", status: "draft" });
    expect(byTitle["Old recap"]).toMatchObject({ status: "archived", type: "recap" });

    // Running it again updates instead of duplicating.
    const again = await request(agent()).post(`/api/companies/${companyId}/links/import`).send({ csv });
    expect(again.body).toMatchObject({ created: 0, updated: 4 });
  });

  it("backfills from existing link deliverables and previews", async () => {
    await seed();
    await db.insert(issueWorkProducts).values([
      {
        companyId, issueId, projectId, type: "deliverable", provider: "paperclip", externalId: "acme-deck", title: "Acme deck",
        url: "https://acme-deck.netlify.app", status: "active", metadata: { version: 1, kind: "deck", external: true },
      },
      {
        companyId, issueId, projectId, type: "deliverable", provider: "paperclip", externalId: "file", title: "A file",
        url: null, status: "active", metadata: { version: 1, kind: "report" },
      },
      {
        companyId, issueId: otherIssueId, projectId: otherProjectId, type: "preview_url", provider: "custom", title: "Bakery preview",
        url: "https://bakery-preview.example.ts.net", status: "active",
      },
    ]);
    const res = await request(board()).post(`/api/companies/${companyId}/links/backfill`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ scanned: 2, created: 2, updated: 0 });
    const rows = await request(board()).get(`/api/companies/${companyId}/links`);
    expect(rows.body.links.map((link: { title: string; type: string }) => [link.title, link.type]).sort()).toEqual([
      ["Acme deck", "deck"],
      ["Bakery preview", "preview"],
    ]);
  });

  it("rejects a non-web URL", async () => {
    await seed();
    const res = await addLink({ url: "ftp://files.example.com/x", title: "x" });
    expect(res.status).toBe(400);
  });
});
