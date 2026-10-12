import { randomUUID } from "node:crypto";
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
  pipelineCaseEvidence,
  projects,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { pipelineRoutes } from "../routes/pipelines.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres client files tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Client files (GRE-1311): Evidence and Deliverables on a client page.
describeEmbeddedPostgres("client files", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pipeline-case-files-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    await instanceSettingsService(db).updateExperimental({ enablePipelines: true });
  });

  afterEach(async () => {
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
    instance.use("/api", pipelineRoutes(db, { heartbeat: { wakeup: async () => null } }));
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

  async function seedIssue(companyId: string, input: { identifier: string; title: string; projectId?: string | null }) {
    const [issue] = await db.insert(issues).values({
      companyId,
      projectId: input.projectId ?? null,
      identifier: input.identifier,
      title: input.title,
      status: "todo",
      priority: "medium",
    }).returning();
    return issue!;
  }

  async function seedAttachment(companyId: string, issueId: string, filename: string, contentType = "application/pdf") {
    const assetId = randomUUID();
    await db.insert(assets).values({
      id: assetId,
      companyId,
      provider: "local_disk",
      objectKey: `issues/${issueId}/${filename}`,
      contentType,
      byteSize: 1234,
      sha256: `sha-${assetId}`,
      originalFilename: filename,
    });
    const [attachment] = await db.insert(issueAttachments).values({ companyId, issueId, assetId }).returning();
    return attachment!;
  }

  async function seedDocument(companyId: string, issueId: string, key: string, title: string) {
    const [document] = await db.insert(documents).values({ companyId, title, latestBody: "Notes", format: "markdown" }).returning();
    await db.insert(issueDocuments).values({ companyId, issueId, documentId: document!.id, key });
    return document!;
  }

  async function seedDeliverable(companyId: string, issueId: string, attachmentId: string, title: string) {
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "deliverable",
      provider: "paperclip",
      externalId: title.toLowerCase().replace(/\W+/g, "-"),
      title,
      status: "active",
      metadata: { version: 1, attachmentId, kind: "report", contentType: "text/html" },
    });
  }

  it("files task attachments, documents and links as evidence and finds them by name", async () => {
    const { company, project, agent } = await seedCompany("Greatstone");
    const caseId = await seedClientCase(company.id, "Stratafrique");
    const http = request(app());
    await http.post(`/api/cases/${caseId}/project-links`).send({ projectId: project.id }).expect(201);

    // GRE-1128-style task in the client's project, holding the client's outline.
    const projectIssue = await seedIssue(company.id, { identifier: "GRE-1128", title: "Kick-off", projectId: project.id });
    const outline = await seedAttachment(company.id, projectIssue.id, "ecaps-outline.pdf");
    const notes = await seedDocument(company.id, projectIssue.id, "meeting-notes", "Meeting notes");
    const report = await seedAttachment(company.id, projectIssue.id, "market-report.html", "text/html");
    await seedDeliverable(company.id, projectIssue.id, report.id, "Market entry report");

    const candidates = await http.get(`/api/cases/${caseId}/evidence/candidates`).expect(200);
    expect(candidates.body.candidates.map((item: { title: string }) => item.title)).toEqual(
      expect.arrayContaining(["ecaps-outline.pdf", "Meeting notes"]),
    );

    const added = await http
      .post(`/api/cases/${caseId}/evidence`)
      .send({ kind: "attachment", attachmentId: outline.id })
      .expect(201);
    expect(added.body).toMatchObject({
      kind: "attachment",
      title: "ecaps-outline.pdf",
      typeLabel: "PDF",
      contentPath: `/api/attachments/${outline.id}/content`,
      sourceIssue: { identifier: "GRE-1128", path: expect.stringContaining("/issues/GRE-1128") },
      addedBy: { type: "user", id: "board-user" },
    });
    await http.post(`/api/cases/${caseId}/evidence`).send({ kind: "document", documentId: notes.id }).expect(201);
    await http
      .post(`/api/cases/${caseId}/evidence`)
      .send({ kind: "link", url: "https://www.notion.so/stratafrique-brief", title: "Notion brief", sourceIssueId: projectIssue.id })
      .expect(201);
    // The same file cannot be filed twice.
    await http.post(`/api/cases/${caseId}/evidence`).send({ kind: "attachment", attachmentId: outline.id }).expect(409);
    // Only web links.
    await http.post(`/api/cases/${caseId}/evidence`).send({ kind: "link", url: "javascript:alert(1)", title: "x" }).expect(400);

    const after = await http.get(`/api/cases/${caseId}/evidence/candidates`).expect(200);
    expect(after.body.candidates.map((item: { title: string }) => item.title)).not.toContain("ecaps-outline.pdf");

    // An agent in the company reads the client's files and finds an item by name.
    const agentHttp = request(app({
      type: "agent",
      agentId: agent.id,
      companyId: company.id,
      runId: randomUUID(),
      source: "agent_key",
    }));
    const files = await agentHttp.get(`/api/cases/${caseId}/files`).expect(200);
    expect(files.body.clients).toEqual([expect.objectContaining({ id: caseId, title: "Stratafrique" })]);
    expect(files.body.evidence.map((item: { title: string }) => item.title).sort()).toEqual(
      ["Meeting notes", "Notion brief", "ecaps-outline.pdf"],
    );
    expect(files.body.deliverables.map((item: { title: string }) => item.title)).toEqual(["Market entry report"]);
    const document = files.body.evidence.find((item: { kind: string }) => item.kind === "document");
    expect(document).toMatchObject({
      documentKey: "meeting-notes",
      contentPath: `/api/issues/${projectIssue.id}/documents/meeting-notes`,
    });

    const found = await agentHttp.get(`/api/cases/${caseId}/evidence`).query({ q: "ecaps" }).expect(200);
    expect(found.body.evidence.map((item: { title: string }) => item.title)).toEqual(["ecaps-outline.pdf"]);

    const byProject = await agentHttp
      .get(`/api/companies/${company.id}/client-files`)
      .query({ projectId: project.id, q: "notion" })
      .expect(200);
    expect(byProject.body.evidence.map((item: { title: string }) => item.title)).toEqual(["Notion brief"]);
    expect(byProject.body.deliverables).toEqual([]);
    await agentHttp.get(`/api/companies/${company.id}/client-files`).expect(400);

    await http.delete(`/api/cases/${caseId}/evidence/${added.body.id}`).expect(200, { deleted: true });
    await http.delete(`/api/cases/${caseId}/evidence/${added.body.id}`).expect(404);
  });

  it("keeps client files inside their company", async () => {
    const a = await seedCompany("Company A");
    const b = await seedCompany("Company B");
    const caseOfA = await seedClientCase(a.company.id, "Client of A");
    const caseOfB = await seedClientCase(b.company.id, "Client of B");
    const issueOfA = await seedIssue(a.company.id, { identifier: "A-1", title: "A task", projectId: a.project.id });
    const fileOfA = await seedAttachment(a.company.id, issueOfA.id, "secret-plan.pdf");
    const docOfA = await seedDocument(a.company.id, issueOfA.id, "notes", "A notes");
    const admin = request(app());
    const evidence = await admin
      .post(`/api/cases/${caseOfA}/evidence`)
      .send({ kind: "attachment", attachmentId: fileOfA.id })
      .expect(201);

    // A member of company B cannot see or change company A's client files.
    const outsider = request(app({
      type: "board",
      userId: "company-b-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [b.company.id],
    }));
    await outsider.get(`/api/cases/${caseOfA}/files`).expect(404);
    await outsider.get(`/api/cases/${caseOfA}/evidence`).expect(404);
    await outsider.get(`/api/cases/${caseOfA}/evidence/candidates`).expect(404);
    await outsider.post(`/api/cases/${caseOfA}/evidence`).send({ kind: "link", url: "https://x.example", title: "x" }).expect(404);
    await outsider.delete(`/api/cases/${caseOfA}/evidence/${evidence.body.id}`).expect(404);
    await outsider.get(`/api/companies/${a.company.id}/client-files`).query({ caseId: caseOfA }).expect(404);

    // An agent of company B cannot read company A's files either.
    const agentOfB = request(app({
      type: "agent",
      agentId: b.agent.id,
      companyId: b.company.id,
      runId: randomUUID(),
      source: "agent_key",
    }));
    await agentOfB.get(`/api/cases/${caseOfA}/files`).expect(404);
    await agentOfB.get(`/api/companies/${a.company.id}/client-files`).query({ caseId: caseOfA }).expect(404);
    // Asking its own company for company A's case or project finds nothing.
    await agentOfB.get(`/api/companies/${b.company.id}/client-files`).query({ caseId: caseOfA }).expect(404);
    await agentOfB.get(`/api/companies/${b.company.id}/client-files`).query({ projectId: a.project.id }).expect(404);

    // Company A's file, document or task cannot be filed on company B's client.
    await admin.post(`/api/cases/${caseOfB}/evidence`).send({ kind: "attachment", attachmentId: fileOfA.id }).expect(404);
    await admin.post(`/api/cases/${caseOfB}/evidence`).send({ kind: "document", documentId: docOfA.id }).expect(404);
    await admin
      .post(`/api/cases/${caseOfB}/evidence`)
      .send({ kind: "link", url: "https://x.example", title: "x", sourceIssueId: issueOfA.id })
      .expect(404);
    // And company A's evidence id cannot be removed through company B's case.
    await admin.delete(`/api/cases/${caseOfB}/evidence/${evidence.body.id}`).expect(404);
    expect((await admin.get(`/api/cases/${caseOfB}/files`).expect(200)).body.evidence).toEqual([]);

    const rows = await db.select().from(pipelineCaseEvidence);
    expect(rows).toEqual([expect.objectContaining({ companyId: a.company.id, caseId: caseOfA })]);
  });

  it("needs pipeline write access to change evidence", async () => {
    const { company, agent } = await seedCompany("Greatstone");
    const caseId = await seedClientCase(company.id, "Client A");
    const agentWithoutGrant = request(app({
      type: "agent",
      agentId: agent.id,
      companyId: company.id,
      runId: randomUUID(),
      source: "agent_key",
    }));
    await agentWithoutGrant.get(`/api/cases/${caseId}/evidence`).expect(200);
    await agentWithoutGrant
      .post(`/api/cases/${caseId}/evidence`)
      .send({ kind: "link", url: "https://www.notion.so/x", title: "Notion" })
      .expect(403);
    expect(await db.select().from(pipelineCaseEvidence)).toEqual([]);
  });
});
