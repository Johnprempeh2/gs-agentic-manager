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
import { fillTestCaseOrganisation } from "./helpers/case-organisation.js";
import { errorHandler } from "../middleware/error-handler.js";
import { pipelineRoutes } from "../routes/pipelines.js";
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
    instance.use("/api", fillTestCaseOrganisation(db));
    instance.use("/api", pipelineRoutes(db, { heartbeat: { wakeup: async () => null }, storage: memoryStorage }));
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
  it("uploads a file straight onto a client, files it under a stage and serves it back", async () => {
    const { company, agent } = await seedCompany("Greatstone");
    const caseId = await seedClientCase(company.id, "Indago");
    const http = request(app());
    const [leadStage] = await db.select().from(pipelineStages).where(sql`${pipelineStages.key} = 'lead'`);
    const leadStageId = leadStage!.id;

    const pdf = Buffer.from("%PDF-1.4 executive discovery");
    const uploaded = await http
      .post(`/api/cases/${caseId}/evidence/upload`)
      .field("stageId", leadStageId)
      .field("note", "Signed off by the CEO")
      .attach("file", pdf, { filename: "Executive discovery.pdf", contentType: "application/pdf" })
      .expect(201);
    expect(uploaded.body).toMatchObject({
      kind: "upload",
      title: "Executive discovery.pdf",
      typeLabel: "PDF",
      byteSize: pdf.length,
      note: "Signed off by the CEO",
      stageId: leadStageId,
      stageName: "Lead",
      sourceIssue: null,
      contentPath: `/api/cases/${caseId}/evidence/${uploaded.body.id}/content`,
      addedBy: { type: "user", id: "board-user" },
    });

    const content = await http.get(uploaded.body.contentPath).buffer(true).expect(200);
    expect(content.headers["content-type"]).toContain("application/pdf");
    expect(content.headers["content-disposition"]).toContain("inline");
    expect(Buffer.from(content.body).toString()).toBe(pdf.toString());
    const download = await http.get(uploaded.body.downloadPath).expect(200);
    expect(download.headers["content-disposition"]).toContain("attachment");

    // The upload is listed with the client's files and found by name.
    const files = await http.get(`/api/cases/${caseId}/evidence`).query({ q: "discovery" }).expect(200);
    expect(files.body.evidence.map((item: { id: string }) => item.id)).toEqual([uploaded.body.id]);

    // No file, an empty file, or a stage from another pipeline is refused.
    await http.post(`/api/cases/${caseId}/evidence/upload`).field("title", "x").expect(400);
    await http
      .post(`/api/cases/${caseId}/evidence/upload`)
      .attach("file", Buffer.alloc(0), { filename: "empty.pdf", contentType: "application/pdf" })
      .expect(422);
    const other = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({
        key: "other",
        name: "Other",
        stages: [
          { key: "a", name: "A", kind: "open", position: 100 },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "lost", name: "Lost", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(201);
    const otherStage = await db.select().from(pipelineStages).where(sql`${pipelineStages.pipelineId} = ${other.body.id} and ${pipelineStages.key} = 'a'`);
    await http
      .post(`/api/cases/${caseId}/evidence/upload`)
      .field("stageId", otherStage[0]!.id)
      .attach("file", pdf, { filename: "x.pdf", contentType: "application/pdf" })
      .expect(404);

    // An agent without a pipeline grant can read it but not upload.
    const agentHttp = request(app({
      type: "agent",
      agentId: agent.id,
      companyId: company.id,
      runId: randomUUID(),
      source: "agent_key",
    }));
    await agentHttp
      .post(`/api/cases/${caseId}/evidence/upload`)
      .attach("file", pdf, { filename: "x.pdf", contentType: "application/pdf" })
      .expect(403);

    // Removing the upload removes its stored file too.
    expect(storedObjects.size).toBe(1);
    await http.delete(`/api/cases/${caseId}/evidence/${uploaded.body.id}`).expect(200);
    expect(storedObjects.size).toBe(0);
    await http.get(uploaded.body.contentPath).expect(404);
    expect(await db.select().from(assets).where(sql`${assets.originalFilename} = 'Executive discovery.pdf'`)).toEqual([]);
  });

  it("feeds a file added to a client into memory, waiting for review and linked back to the file", async () => {
    const { company } = await seedCompany("Greatstone");
    const caseId = await seedClientCase(company.id, "Indago");
    await db.insert(memorySettings).values({ companyId: company.id, enabled: true, retainMode: "chunks" });
    const http = request(app());

    // No client memory named Indago yet: the entry goes to organisation memory, naming the client.
    const notes = await http
      .post(`/api/cases/${caseId}/evidence/upload`)
      .field("note", "From the kickoff")
      .attach("file", Buffer.from("Budget is 40k. Decision by March."), { filename: "Kickoff notes.txt", contentType: "text/plain" })
      .expect(201);
    const [orgEntry] = await db.select().from(memoryRecords).where(sql`${memoryRecords.sourceKind} = 'client_document'`);
    expect(orgEntry).toMatchObject({
      status: "unreviewed",
      sourceId: `${caseId}/${notes.body.id}`,
      title: "Indago: Kickoff notes.txt",
      contributorUserId: "board-user",
    });
    expect(orgEntry!.content).toContain("Indago: Kickoff notes.txt was added to the client on");
    expect(orgEntry!.content).toContain("Note: From the kickoff");
    expect(orgEntry!.content).toContain("Budget is 40k. Decision by March.");
    const [orgScope] = await db.select().from(memoryScopes).where(sql`${memoryScopes.id} = ${orgEntry!.scopeId}`);
    expect(orgScope!.kind).toBe("organization");

    // Once a client memory of the same name exists, the next file goes there; a PDF keeps no text.
    const clientScope = await memoryGatewayService(db).createScope(
      { companyId: company.id, actorType: "user", actorId: "board-user", agentId: null, userId: "board-user", runId: null, isBoardAdmin: true },
      { kind: "client", name: "indago" },
    );
    await http
      .post(`/api/cases/${caseId}/nda/signed`)
      .attach("file", Buffer.from("%PDF-1.4 nda"), { filename: "NDA.pdf", contentType: "application/pdf" })
      .expect(201);
    const entries = await db.select().from(memoryRecords).where(sql`${memoryRecords.scopeId} = ${clientScope!.id}`);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe("Indago: Signed NDA (NDA.pdf)");
    expect(entries[0]!.content).not.toContain("%PDF");
  });

  it("still takes the file when memory is off", async () => {
    const { company } = await seedCompany("Greatstone");
    const caseId = await seedClientCase(company.id, "Indago");
    await request(app())
      .post(`/api/cases/${caseId}/evidence/upload`)
      .attach("file", Buffer.from("hello"), { filename: "a.txt", contentType: "text/plain" })
      .expect(201);
    expect(await db.select().from(memoryRecords)).toHaveLength(0);
  });

  it("keeps a client's uploads inside its own company", async () => {
    const a = await seedCompany("Company A");
    const b = await seedCompany("Company B");
    const caseOfA = await seedClientCase(a.company.id, "Client of A");
    const caseOfB = await seedClientCase(b.company.id, "Client of B");
    const admin = request(app());
    const uploaded = await admin
      .post(`/api/cases/${caseOfA}/evidence/upload`)
      .attach("file", Buffer.from("secret"), { filename: "nda.pdf", contentType: "application/pdf" })
      .expect(201);
    // The same evidence id through another company's case finds nothing.
    await admin.get(`/api/cases/${caseOfB}/evidence/${uploaded.body.id}/content`).expect(404);
    const agentOfB = request(app({
      type: "agent",
      agentId: b.agent.id,
      companyId: b.company.id,
      runId: randomUUID(),
      source: "agent_key",
    }));
    await agentOfB.get(`/api/cases/${caseOfA}/evidence/${uploaded.body.id}/content`).expect(404);
  });
  it("takes the signed NDA as an upload and marks the NDA accepted", async () => {
    const { company, agent } = await seedCompany("Greatstone");
    const caseId = await seedClientCase(company.id, "Omni Group");
    const http = request(app());
    const signed = Buffer.from("%PDF-1.4 signed");

    const result = await http
      .post(`/api/cases/${caseId}/nda/signed`)
      .attach("file", signed, { filename: "Omni NDA signed.pdf", contentType: "application/pdf" })
      .expect(201);
    expect(result.body.nda).toMatchObject({
      status: "accepted",
      signedDocument: {
        evidenceId: result.body.evidence.id,
        title: "Signed NDA (Omni NDA signed.pdf)",
        contentPath: `/api/cases/${caseId}/evidence/${result.body.evidence.id}/content`,
      },
    });
    const journey = await http.get(`/api/cases/${caseId}/journey`).expect(200);
    expect(journey.body.nda.signedDocument.evidenceId).toBe(result.body.evidence.id);
    const content = await http.get(journey.body.nda.signedDocument.contentPath).buffer(true).expect(200);
    expect(Buffer.from(content.body).toString()).toBe(signed.toString());

    // Agents cannot record an NDA.
    const agentHttp = request(app({
      type: "agent",
      agentId: agent.id,
      companyId: company.id,
      runId: randomUUID(),
      source: "agent_key",
    }));
    await agentHttp
      .post(`/api/cases/${caseId}/nda/signed`)
      .attach("file", signed, { filename: "x.pdf", contentType: "application/pdf" })
      .expect(403);

    // Back to required drops the link but keeps the file in the client's evidence.
    const cleared = await http.put(`/api/cases/${caseId}/nda`).send({ status: "required" }).expect(200);
    expect(cleared.body.nda.signedDocument).toBeNull();
    const files = await http.get(`/api/cases/${caseId}/evidence`).expect(200);
    expect(files.body.evidence.map((item: { id: string }) => item.id)).toContain(result.body.evidence.id);
  });

  it("keeps a checklist of documents to collect at a stage and ticks one off when its file arrives", async () => {
    const { company } = await seedCompany("Greatstone");
    const caseId = await seedClientCase(company.id, "Indago");
    const http = request(app());
    const [leadStage] = await db.select().from(pipelineStages).where(sql`${pipelineStages.key} = 'lead'`);
    const leadStageId = leadStage!.id;
    await db
      .update(pipelineStages)
      .set({
        config: {
          ...(leadStage!.config as Record<string, unknown>),
          requestedDocuments: [{ title: "Organisation chart" }, { title: "Latest accounts", note: "Last two years" }],
        },
      })
      .where(sql`${pipelineStages.id} = ${leadStageId}`);

    const stageOf = async () => {
      const journey = await http.get(`/api/cases/${caseId}/journey`).expect(200);
      return journey.body.stages.find((stage: { id: string }) => stage.id === leadStageId);
    };
    expect((await stageOf()).suggestedRequests).toEqual([
      { title: "Organisation chart", note: null },
      { title: "Latest accounts", note: "Last two years" },
    ]);

    // One ad hoc request, then the standard list; a repeat title is skipped.
    const asked = await http
      .post(`/api/cases/${caseId}/document-requests`)
      .send({ stageId: leadStageId, titles: ["IT strategy", "organisation chart "] })
      .expect(201);
    expect(asked.body).toEqual({ created: 2 });
    const standard = await http
      .post(`/api/cases/${caseId}/document-requests/standard`)
      .send({ stageId: leadStageId })
      .expect(201);
    expect(standard.body).toEqual({ created: 1 });
    let stage = await stageOf();
    expect(stage.suggestedRequests).toEqual([]);
    expect(stage.requests.map((item: { title: string }) => item.title)).toEqual([
      "IT strategy",
      "organisation chart",
      "Latest accounts",
    ]);
    expect(stage.requests.every((item: { received: unknown }) => item.received === null)).toBe(true);

    // An upload sent against a request meets it, and lands on the request's stage.
    const strategy = stage.requests[0];
    const uploaded = await http
      .post(`/api/cases/${caseId}/evidence/upload`)
      .field("requestId", strategy.id)
      .attach("file", Buffer.from("%PDF-1.4 strategy"), { filename: "IT strategy.pdf", contentType: "application/pdf" })
      .expect(201);
    expect(uploaded.body.stageId).toBe(leadStageId);
    stage = await stageOf();
    expect(stage.requests[0].received).toMatchObject({
      evidenceId: uploaded.body.id,
      title: "IT strategy.pdf",
      contentPath: `/api/cases/${caseId}/evidence/${uploaded.body.id}/content`,
    });

    // Deleting the file reopens the request; deleting the request removes it.
    await http.delete(`/api/cases/${caseId}/evidence/${uploaded.body.id}`).expect(200);
    stage = await stageOf();
    expect(stage.requests[0].received).toBeNull();
    await http.delete(`/api/cases/${caseId}/document-requests/${strategy.id}`).expect(200);
    stage = await stageOf();
    expect(stage.requests).toHaveLength(2);

    // Requests stay inside their client: an unknown request or another client's stage is refused.
    await http
      .post(`/api/cases/${caseId}/evidence/upload`)
      .field("requestId", randomUUID())
      .attach("file", Buffer.from("x"), { filename: "x.pdf", contentType: "application/pdf" })
      .expect(404);
    const other = await seedCompany("Other");
    const otherCase = await seedClientCase(other.company.id, "Rival");
    await request(app())
      .post(`/api/cases/${otherCase}/document-requests`)
      .send({ stageId: leadStageId, titles: ["Anything"] })
      .expect(404);
    await http.post(`/api/cases/${caseId}/document-requests`).send({ stageId: leadStageId, titles: [] }).expect(400);
  });

  it("holds the engagement pack until the NDA clears, then tracks it sent and accepted", async () => {
    const { company, agent } = await seedCompany("Greatstone");
    const caseId = await seedClientCase(company.id, "Omni Group");
    const http = request(app());
    const pack = Buffer.from("%PDF-1.4 engagement pack");

    // Not sent by default; it cannot go out while the NDA is required, and a blocked upload stores nothing.
    let journey = await http.get(`/api/cases/${caseId}/journey`).expect(200);
    expect(journey.body.engagement).toMatchObject({ status: "not_sent", sentAt: null, pack: null, acceptance: null });
    await http.put(`/api/cases/${caseId}/engagement`).send({ status: "sent" }).expect(409);
    await http
      .post(`/api/cases/${caseId}/engagement/pack`)
      .attach("file", pack, { filename: "Pack.pdf", contentType: "application/pdf" })
      .expect(409);
    expect(storedObjects.size).toBe(0);

    await http.put(`/api/cases/${caseId}/nda`).send({ status: "accepted" }).expect(200);
    const sent = await http
      .post(`/api/cases/${caseId}/engagement/pack`)
      .attach("file", pack, { filename: "Pack.pdf", contentType: "application/pdf" })
      .expect(201);
    expect(sent.body.engagement).toMatchObject({
      status: "sent",
      pack: { evidenceId: sent.body.evidence.id, title: "Engagement pack (Pack.pdf)" },
      acceptance: null,
    });
    const sentAt = sent.body.engagement.sentAt;
    expect(sentAt).toBeTruthy();

    // Accepting keeps the sent date and the pack, and adds the signed copy.
    const accepted = await http
      .post(`/api/cases/${caseId}/engagement/acceptance`)
      .attach("file", Buffer.from("%PDF-1.4 signed"), { filename: "Signed.pdf", contentType: "application/pdf" })
      .expect(201);
    expect(accepted.body.engagement).toMatchObject({
      status: "accepted",
      sentAt,
      pack: { evidenceId: sent.body.evidence.id },
      acceptance: { evidenceId: accepted.body.evidence.id, title: "Signed engagement acceptance (Signed.pdf)" },
    });
    expect(accepted.body.engagement.acceptedAt).toBeTruthy();
    journey = await http.get(`/api/cases/${caseId}/journey`).expect(200);
    expect(journey.body.engagement.status).toBe("accepted");

    // Agents cannot move it; back to not sent clears the dates and links but keeps the files.
    const agentHttp = request(app({
      type: "agent",
      agentId: agent.id,
      companyId: company.id,
      runId: randomUUID(),
      source: "agent_key",
    }));
    await agentHttp.put(`/api/cases/${caseId}/engagement`).send({ status: "not_sent" }).expect(403);
    const reset = await http.put(`/api/cases/${caseId}/engagement`).send({ status: "not_sent" }).expect(200);
    expect(reset.body.engagement).toMatchObject({ status: "not_sent", sentAt: null, acceptedAt: null, pack: null, acceptance: null });
    const files = await http.get(`/api/cases/${caseId}/evidence`).expect(200);
    expect(files.body.evidence).toHaveLength(2);
  });
});
