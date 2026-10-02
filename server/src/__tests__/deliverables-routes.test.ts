import { randomUUID } from "node:crypto";
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
  heartbeatRuns,
  issueAttachments,
  issues,
  issueWorkProducts,
  projects,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { deliverableRoutes } from "../routes/deliverables.js";
import { deliverableService, extractHtmlSearchText } from "../services/deliverables.js";
import type { StorageService } from "../storage/types.js";

// GRE-388 Deliverables: company scoping, versioning, search and filters.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres deliverables tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const secondAgentId = "34343434-3434-4343-8343-343434343434";
const otherAgentId = "44444444-4444-4444-8444-444444444444";
const projectId = "55555555-5555-4555-8555-555555555555";
const issueId = "66666666-6666-4666-8666-666666666666";
const secondIssueId = "77777777-7777-4777-8777-777777777777";
const otherIssueId = "88888888-8888-4888-8888-888888888888";

function createStorageService(files: Record<string, string>): StorageService {
  return {
    provider: "local_disk",
    putFile: vi.fn(),
    getObject: vi.fn(async (_companyId: string, objectKey: string) => {
      const body = Buffer.from(files[objectKey] ?? "", "utf8");
      return { stream: Readable.from(body), contentType: "text/html", contentLength: body.length };
    }),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  } as unknown as StorageService;
}

const files = {
  "q3.html": "<html><head><style>.x{color:red}</style><script>var hidden = 'zebra';</script></head><body><h1>Q3 board pack</h1><p>Revenue grew in the Accra market &amp; beyond.</p></body></html>",
  "q3-v2.html": "<html><body><h1>Q3 board pack</h1><p>Revised for the Kumasi office.</p></body></html>",
  "brief.html": "<html><body><h1>Hiring brief</h1></body></html>",
  "other.html": "<html><body><h1>Other company report</h1></body></html>",
};

describeEmbeddedPostgres("deliverables", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const storage = createStorageService(files);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-deliverables-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueWorkProducts);
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function addAttachment(input: { company: string; issue: string; objectKey: string; agent?: string | null; contentType?: string }) {
    const assetId = randomUUID();
    const attachmentId = randomUUID();
    await db.insert(assets).values({
      id: assetId,
      companyId: input.company,
      provider: "local_disk",
      objectKey: input.objectKey,
      contentType: input.contentType ?? "text/html",
      byteSize: Buffer.byteLength(files[input.objectKey as keyof typeof files] ?? "x"),
      sha256: `sha-${assetId}`,
      originalFilename: input.objectKey,
      createdByAgentId: input.agent === undefined ? agentId : input.agent,
    });
    await db.insert(issueAttachments).values({ id: attachmentId, companyId: input.company, issueId: input.issue, assetId });
    return attachmentId;
  }

  async function seed() {
    await db.insert(companies).values([
      { id: companyId, name: "Greatstone", issuePrefix: "GRE", requireBoardApprovalForNewAgents: false },
      { id: otherCompanyId, name: "OtherCo", issuePrefix: "OTH", requireBoardApprovalForNewAgents: false },
    ]);
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Everest", role: "engineer" },
      { id: secondAgentId, companyId, name: "Summit", role: "engineer" },
      { id: otherAgentId, companyId: otherCompanyId, name: "Outsider", role: "engineer" },
    ]);
    await db.insert(projects).values({ id: projectId, companyId, name: "Board", status: "in_progress" });
    await db.insert(issues).values([
      { id: issueId, companyId, projectId, identifier: "GRE-1", title: "Quarterly pack", status: "in_progress", priority: "medium", assigneeAgentId: agentId },
      { id: secondIssueId, companyId, identifier: "GRE-2", title: "Hiring", status: "in_progress", priority: "medium", assigneeAgentId: secondAgentId },
      { id: otherIssueId, companyId: otherCompanyId, identifier: "OTH-1", title: "Other", status: "in_progress", priority: "medium", assigneeAgentId: otherAgentId },
    ]);
  }

  function boardApp(companyIds = [companyId]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
        isInstanceAdmin: true,
        companyIds,
        memberships: companyIds.map((id) => ({ companyId: id, membershipRole: "owner", status: "active" })),
      } as typeof req.actor;
      next();
    });
    app.use("/api", deliverableRoutes(db, storage));
    app.use(errorHandler);
    return app;
  }

  function agentApp(actorAgentId: string, actorCompanyId = companyId) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", agentId: actorAgentId, companyId: actorCompanyId, source: "agent_key" } as typeof req.actor;
      next();
    });
    app.use("/api", deliverableRoutes(db, storage));
    app.use(errorHandler);
    return app;
  }

  it("extracts visible text from HTML for search", () => {
    expect(extractHtmlSearchText(files["q3.html"])).toBe("Q3 board pack Revenue grew in the Accra market & beyond.");
  });

  it("registers versions under one key, lists the latest and keeps older versions", async () => {
    await seed();
    const first = await addAttachment({ company: companyId, issue: issueId, objectKey: "q3.html" });
    const second = await addAttachment({ company: companyId, issue: issueId, objectKey: "q3-v2.html" });
    const app = agentApp(agentId);

    const v1 = await request(app).post(`/api/issues/${issueId}/deliverables`).send({
      attachmentId: first,
      title: "Q3 board pack",
      summary: "Numbers for the board",
      kind: "deck",
      status: "draft",
    });
    expect(v1.status).toBe(201);
    expect(v1.body).toMatchObject({
      key: "q3-board-pack",
      version: 1,
      kind: "deck",
      brand: "Greatstone",
      status: "draft",
      contentPath: `/api/attachments/${first}/content`,
      downloadPath: `/api/attachments/${first}/content?download=1`,
      issue: { id: issueId, identifier: "GRE-1" },
      project: { id: projectId, name: "Board" },
      createdByAgent: { id: agentId, name: "Everest" },
    });
    expect(v1.body).not.toHaveProperty("searchText");

    const v2 = await request(app).post(`/api/issues/${issueId}/deliverables`).send({
      attachmentId: second,
      key: "q3-board-pack",
      title: "Q3 board pack (revised)",
      status: "final",
    });
    expect(v2.status).toBe(201);
    // Omitted fields carry over from version 1.
    expect(v2.body).toMatchObject({ version: 2, versionCount: 2, kind: "deck", summary: "Numbers for the board", status: "final" });
    expect(v2.body.versions.map((version: { version: number }) => version.version)).toEqual([2, 1]);

    const list = await request(boardApp()).get(`/api/companies/${companyId}/deliverables`);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.deliverables).toHaveLength(1);
    expect(list.body.deliverables[0]).toMatchObject({ id: v2.body.id, version: 2, versionCount: 2 });

    const older = await request(boardApp()).get(`/api/companies/${companyId}/deliverables/${v1.body.id}`);
    expect(older.status).toBe(200);
    expect(older.body).toMatchObject({ version: 1, versions: [{ version: 2 }, { version: 1 }] });
  });

  it("searches title, summary, issue, agent and the document's own text, and filters", async () => {
    await seed();
    const q3 = await addAttachment({ company: companyId, issue: issueId, objectKey: "q3.html" });
    const brief = await addAttachment({ company: companyId, issue: secondIssueId, objectKey: "brief.html", agent: secondAgentId });
    const svc = deliverableService(db, storage);
    const issue = { id: issueId, companyId, projectId };
    const secondIssue = { id: secondIssueId, companyId, projectId: null };
    const report = await svc.register({
      issue,
      attachment: (await svc.getAttachment(companyId, q3))!,
      fields: { title: "Q3 board pack", kind: "report" },
      createdByAgentId: agentId,
      createdByRunId: null,
    });
    await svc.register({
      issue: secondIssue,
      attachment: (await svc.getAttachment(companyId, brief))!,
      fields: { title: "Hiring brief", kind: "brief", brand: "Acme" },
      createdByAgentId: secondAgentId,
      createdByRunId: null,
    });

    const titles = async (query: Record<string, string>) =>
      (await svc.list(companyId, query)).deliverables.map((item) => item.title);

    expect(await titles({ q: "accra" })).toEqual(["Q3 board pack"]); // HTML body text
    expect(await titles({ q: "zebra" })).toEqual([]); // script text is not indexed
    expect(await titles({ q: "GRE-2" })).toEqual(["Hiring brief"]);
    expect(await titles({ q: "summit" })).toEqual(["Hiring brief"]); // agent name
    expect(await titles({ q: "quarterly" })).toEqual(["Q3 board pack"]); // issue title
    expect(await titles({ kind: "brief" })).toEqual(["Hiring brief"]);
    expect(await titles({ brand: "acme" })).toEqual(["Hiring brief"]);
    expect(await titles({ projectId })).toEqual(["Q3 board pack"]);
    expect(await titles({ agentId })).toEqual(["Q3 board pack"]);
    expect(await titles({ sort: "title" })).toEqual(["Hiring brief", "Q3 board pack"]);
    expect(await titles({ from: "2999-01-01T00:00:00.000Z" })).toEqual([]);

    await svc.markOpened(companyId, report.id);
    expect(await titles({ sort: "recently_opened" })).toEqual(["Q3 board pack", "Hiring brief"]);

    const result = await svc.list(companyId, {});
    expect(result.facets).toEqual({
      brands: ["Acme", "Greatstone"],
      agents: [{ id: agentId, name: "Everest" }, { id: secondAgentId, name: "Summit" }],
      projects: [{ id: projectId, name: "Board" }],
    });
  });

  it("keeps deliverables inside their company", async () => {
    await seed();
    const otherAttachment = await addAttachment({ company: otherCompanyId, issue: otherIssueId, objectKey: "other.html", agent: otherAgentId });
    const own = await addAttachment({ company: companyId, issue: issueId, objectKey: "q3.html" });

    const outsider = await request(agentApp(otherAgentId, otherCompanyId)).post(`/api/issues/${otherIssueId}/deliverables`).send({
      attachmentId: otherAttachment,
      title: "Other company report",
    });
    expect(outsider.status).toBe(201);

    // An agent from another company cannot see or write this company's issue.
    const crossWrite = await request(agentApp(otherAgentId, otherCompanyId)).post(`/api/issues/${issueId}/deliverables`).send({
      attachmentId: own,
      title: "Sneaky",
    });
    expect(crossWrite.status).toBe(404);
    const crossList = await request(agentApp(otherAgentId, otherCompanyId)).get(`/api/companies/${companyId}/deliverables`);
    expect(crossList.status).toBe(403);

    // An attachment from another issue is refused.
    const wrongIssue = await request(agentApp(agentId)).post(`/api/issues/${issueId}/deliverables`).send({
      attachmentId: otherAttachment,
      title: "Borrowed",
    });
    expect(wrongIssue.status).toBe(422);

    const list = await request(boardApp()).get(`/api/companies/${companyId}/deliverables`);
    expect(list.body.deliverables).toEqual([]);
    const detail = await request(boardApp()).get(`/api/companies/${companyId}/deliverables/${outsider.body.id}`);
    expect(detail.status).toBe(404);
  });

  it("lets a board user mark an existing artifact as a deliverable, and agents cannot", async () => {
    await seed();
    const attachmentId = await addAttachment({ company: companyId, issue: issueId, objectKey: "q3.html" });

    const denied = await request(agentApp(agentId)).post(`/api/companies/${companyId}/deliverables/mark`).send({
      artifactId: `attachment:${attachmentId}`,
    });
    expect(denied.status).toBe(403);

    const marked = await request(boardApp()).post(`/api/companies/${companyId}/deliverables/mark`).send({
      artifactId: `attachment:${attachmentId}`,
      kind: "plan",
    });
    expect(marked.status).toBe(201);
    expect(marked.body).toMatchObject({
      title: "q3",
      kind: "plan",
      version: 1,
      createdByAgent: { id: agentId, name: "Everest" },
    });

    const opened = await request(boardApp()).post(`/api/companies/${companyId}/deliverables/${marked.body.id}/opened`);
    expect(opened.status).toBe(200);
    const detail = await request(boardApp()).get(`/api/companies/${companyId}/deliverables/${marked.body.id}`);
    expect(detail.body.lastOpenedAt).toEqual(expect.any(String));
  });
});
