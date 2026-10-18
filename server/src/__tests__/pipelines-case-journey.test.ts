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
  issueAttachments,
  issues,
  issueWorkProducts,
  pipelineCaseStageDeliverables,
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres client journey tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Client journey by stage (GRE-1473): deliverables per stage inside the app,
// and only completed-stage, client-facing, final deliverables on the portal.
describeEmbeddedPostgres("client journey by stage", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pipeline-case-journey-");
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
    instance.use("/api", fillTestCaseOrganisation(db));
    instance.use("/api", pipelineRoutes(db, { heartbeat: { wakeup: async () => null } }));
    instance.use(errorHandler);
    return instance;
  }

  async function seedCompany(name: string) {
    const prefix = `J${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const [company] = await db.insert(companies).values({ name, issuePrefix: prefix }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: `${name} agent`, role: "engineer" }).returning();
    const [project] = await db.insert(projects).values({ companyId: company!.id, name: `${name} project`, status: "in_progress" }).returning();
    return { company: company!, agent: agent!, project: project! };
  }

  /** A made-up client on the Greatstone journey: Executive Discovery to playback. */
  async function seedJourneyCase(companyId: string, projectId: string) {
    const http = request(app());
    const pipeline = await http
      .post(`/api/companies/${companyId}/pipelines`)
      .send({
        key: "client",
        name: "Client journey",
        stages: [
          {
            key: "discovery",
            name: "Executive Discovery",
            kind: "working",
            position: 100,
            config: { templates: [{ title: "Executive Discovery pre-read", url: "https://example.com/pre-read" }] },
          },
          { key: "gita", name: "GITA", kind: "working", position: 200, config: { templates: [{ title: "GITA template" }] } },
          { key: "deep-dive", name: "Deep Dive", kind: "working", position: 300 },
          { key: "gdxp", name: "GDXP", kind: "working", position: 400 },
          { key: "playback", name: "Playback", kind: "done", position: 500 },
          { key: "paused", name: "Paused", kind: "cancelled", position: 900 },
        ],
      })
      .expect(201);
    const created = await http
      .post(`/api/pipelines/${pipeline.body.id}/cases`)
      .send({ caseKey: "client-1", title: "Northwind Logistics", stageKey: "discovery" })
      .expect(201);
    const caseRow = created.body.case ?? created.body;
    await http.post(`/api/cases/${caseRow.id}/project-links`).send({ projectId }).expect(201);
    const stages = (await http.get(`/api/pipelines/${pipeline.body.id}`).expect(200)).body.stages as Array<{ id: string; key: string }>;
    const stageId = (key: string) => stages.find((stage) => stage.key === key)!.id;
    return { caseId: caseRow.id as string, stageId };
  }

  async function moveTo(caseId: string, toStageKey: string) {
    const http = request(app());
    const current = await http.get(`/api/cases/${caseId}`).expect(200);
    const version = (current.body.case ?? current.body).version;
    await http.post(`/api/cases/${caseId}/transition`).send({ toStageKey, expectedVersion: version, force: true }).expect(200);
  }

  async function seedDeliverable(
    companyId: string,
    projectId: string,
    input: { title: string; status?: "draft" | "final"; identifier: string },
  ) {
    const [issue] = await db.insert(issues).values({
      companyId,
      projectId,
      identifier: input.identifier,
      title: `Make ${input.title}`,
      status: "done",
      priority: "medium",
    }).returning();
    const assetId = randomUUID();
    await db.insert(assets).values({
      id: assetId,
      companyId,
      provider: "local_disk",
      objectKey: `issues/${issue!.id}/${input.identifier}.html`,
      contentType: "text/html",
      byteSize: 1234,
      sha256: `sha-${assetId}`,
      originalFilename: `${input.identifier}.html`,
    });
    const [attachment] = await db.insert(issueAttachments).values({ companyId, issueId: issue!.id, assetId }).returning();
    const [row] = await db.insert(issueWorkProducts).values({
      companyId,
      issueId: issue!.id,
      type: "deliverable",
      provider: "paperclip",
      externalId: input.title.toLowerCase().replace(/\W+/g, "-"),
      title: input.title,
      summary: "Internal working note",
      status: "active",
      metadata: { version: 1, attachmentId: attachment!.id, kind: "report", deliverableStatus: input.status ?? "final", confidentiality: "public" },
    }).returning();
    return row!;
  }

  it("lists deliverables and templates per stage and shows only completed, client-facing, final ones on the portal", async () => {
    const { company, project } = await seedCompany("Greatstone");
    const { caseId, stageId } = await seedJourneyCase(company.id, project.id);
    const http = request(app());

    const northStar = await seedDeliverable(company.id, project.id, { title: "North Star summary", identifier: "J-1" });
    const discoveryNotes = await seedDeliverable(company.id, project.id, { title: "Discovery working notes", identifier: "J-2" });
    const gita = await seedDeliverable(company.id, project.id, { title: "GITA", identifier: "J-3" });
    const gitaDraft = await seedDeliverable(company.id, project.id, { title: "GITA demos", identifier: "J-4", status: "draft" });
    const deepDive = await seedDeliverable(company.id, project.id, { title: "Journey maps", identifier: "J-5" });
    const unfiled = await seedDeliverable(company.id, project.id, { title: "Loose report", identifier: "J-6" });

    const file = (deliverableId: string, stage: string, clientFacing: boolean) =>
      http.post(`/api/cases/${caseId}/journey/deliverables`).send({ stageId: stageId(stage), deliverableId, clientFacing });
    await file(northStar.id, "discovery", true).expect(201);
    await file(discoveryNotes.id, "discovery", false).expect(201);
    await file(gita.id, "gita", true).expect(201);
    await file(gitaDraft.id, "gita", true).expect(201);
    const deepDiveLink = await file(deepDive.id, "deep-dive", true).expect(201);
    // One deliverable sits under one stage per client.
    await file(northStar.id, "gita", true).expect(409);

    // Inside the app: every stage is a section with its templates and deliverables.
    const journey = await http.get(`/api/cases/${caseId}/journey`).expect(200);
    expect(journey.body.stages.map((stage: { name: string; state: string }) => [stage.name, stage.state])).toEqual([
      ["Executive Discovery", "current"],
      ["GITA", "next"],
      ["Deep Dive", "next"],
      ["GDXP", "next"],
      ["Playback", "next"],
    ]);
    const discovery = journey.body.stages[0];
    expect(discovery.templates).toEqual([{ title: "Executive Discovery pre-read", url: "https://example.com/pre-read", note: null }]);
    expect(discovery.deliverables.map((item: { deliverable: { title: string }; clientFacing: boolean }) =>
      [item.deliverable.title, item.clientFacing])).toEqual(expect.arrayContaining([
      ["North Star summary", true],
      ["Discovery working notes", false],
    ]));
    expect(journey.body.stages[1].templates).toEqual([{ title: "GITA template", url: null, note: null }]);
    expect(journey.body.unfiled.map((item: { id: string }) => item.id)).toEqual([unfiled.id]);

    // Nothing is complete yet, so the portal is empty.
    expect((await http.get(`/api/cases/${caseId}/portal`).expect(200)).body.stages).toEqual([]);

    await moveTo(caseId, "deep-dive");
    const portal = await http.get(`/api/cases/${caseId}/portal`).expect(200);
    expect(portal.body).toEqual({
      caseId,
      title: "Northwind Logistics",
      stages: [
        {
          key: "discovery",
          name: "Executive Discovery",
          deliverables: [expect.objectContaining({ title: "North Star summary", kind: "report", version: 1 })],
        },
        {
          key: "gita",
          name: "GITA",
          deliverables: [expect.objectContaining({ title: "GITA" })],
        },
      ],
    });
    // Only outcome fields: no task, agent, project or link ids.
    expect(Object.keys(portal.body.stages[0].deliverables[0]).sort()).toEqual(
      ["confidentiality", "contentPath", "contentType", "kind", "summary", "title", "updatedAt", "url", "version"],
    );
    const raw = JSON.stringify(portal.body);
    for (const internal of ["Discovery working notes", "GITA demos", "Journey maps", "Loose report", "J-1", "issue", "agent", "linkId"]) {
      expect(raw).not.toContain(internal);
    }

    // Pausing in Deep Dive keeps the earlier stages complete, not Deep Dive.
    await moveTo(caseId, "paused");
    const paused = await http.get(`/api/cases/${caseId}/portal`).expect(200);
    expect(paused.body.stages.map((stage: { key: string }) => stage.key)).toEqual(["discovery", "gita"]);

    // Finishing the journey completes Deep Dive; turning off client-facing hides an item again.
    await moveTo(caseId, "playback");
    await http
      .patch(`/api/cases/${caseId}/journey/deliverables/${deepDiveLink.body.id}`)
      .send({ clientFacing: false })
      .expect(200);
    const finished = await http.get(`/api/cases/${caseId}/portal`).expect(200);
    expect(finished.body.stages.find((stage: { key: string }) => stage.key === "deep-dive").deliverables).toEqual([]);
    await http
      .patch(`/api/cases/${caseId}/journey/deliverables/${deepDiveLink.body.id}`)
      .send({ clientFacing: true })
      .expect(200);
    const shown = await http.get(`/api/cases/${caseId}/portal`).expect(200);
    expect(shown.body.stages.find((stage: { key: string }) => stage.key === "deep-dive").deliverables)
      .toEqual([expect.objectContaining({ title: "Journey maps" })]);

    // Moving a deliverable to another stage and removing it.
    await http
      .patch(`/api/cases/${caseId}/journey/deliverables/${deepDiveLink.body.id}`)
      .send({ stageId: stageId("gdxp") })
      .expect(200);
    await http.delete(`/api/cases/${caseId}/journey/deliverables/${deepDiveLink.body.id}`).expect(200);
    await http.delete(`/api/cases/${caseId}/journey/deliverables/${deepDiveLink.body.id}`).expect(404);
  });

  it("only files the client's own deliverables under the client's own stages", async () => {
    const { company, project } = await seedCompany("Greatstone");
    const { caseId, stageId } = await seedJourneyCase(company.id, project.id);
    const [otherProject] = await db.insert(projects).values({ companyId: company.id, name: "Other client", status: "in_progress" }).returning();
    const elsewhere = await seedDeliverable(company.id, otherProject!.id, { title: "Other client report", identifier: "J-9" });
    const own = await seedDeliverable(company.id, project.id, { title: "Own report", identifier: "J-10" });
    const http = request(app());

    await http
      .post(`/api/cases/${caseId}/journey/deliverables`)
      .send({ stageId: stageId("discovery"), deliverableId: elsewhere.id })
      .expect(422);
    await http
      .post(`/api/cases/${caseId}/journey/deliverables`)
      .send({ stageId: randomUUID(), deliverableId: own.id })
      .expect(422);
    await http
      .post(`/api/cases/${caseId}/journey/deliverables`)
      .send({ stageId: stageId("discovery"), deliverableId: randomUUID() })
      .expect(404);
  });

  it("keeps the journey and portal inside the company and needs write access to change it", async () => {
    const a = await seedCompany("Company A");
    const b = await seedCompany("Company B");
    const { caseId, stageId } = await seedJourneyCase(a.company.id, a.project.id);
    const report = await seedDeliverable(a.company.id, a.project.id, { title: "A report", identifier: "A-1" });
    const link = await request(app())
      .post(`/api/cases/${caseId}/journey/deliverables`)
      .send({ stageId: stageId("discovery"), deliverableId: report.id, clientFacing: true })
      .expect(201);

    const outsider = request(app({
      type: "board",
      userId: "company-b-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [b.company.id],
    }));
    await outsider.get(`/api/cases/${caseId}/journey`).expect(404);
    await outsider.get(`/api/cases/${caseId}/portal`).expect(404);
    await outsider
      .post(`/api/cases/${caseId}/journey/deliverables`)
      .send({ stageId: stageId("discovery"), deliverableId: report.id })
      .expect(404);
    await outsider.patch(`/api/cases/${caseId}/journey/deliverables/${link.body.id}`).send({ clientFacing: false }).expect(404);
    await outsider.delete(`/api/cases/${caseId}/journey/deliverables/${link.body.id}`).expect(404);

    const agentOfB = request(app({
      type: "agent",
      agentId: b.agent.id,
      companyId: b.company.id,
      runId: randomUUID(),
      source: "agent_key",
    }));
    await agentOfB.get(`/api/cases/${caseId}/portal`).expect(404);

    // An agent of company A without Work cases may read but not change the journey.
    const agentOfA = request(app({
      type: "agent",
      agentId: a.agent.id,
      companyId: a.company.id,
      runId: randomUUID(),
      source: "agent_key",
    }));
    await agentOfA.get(`/api/cases/${caseId}/journey`).expect(200);
    await agentOfA.get(`/api/cases/${caseId}/portal`).expect(200);
    await agentOfA.patch(`/api/cases/${caseId}/journey/deliverables/${link.body.id}`).send({ clientFacing: false }).expect(403);
    await agentOfA.delete(`/api/cases/${caseId}/journey/deliverables/${link.body.id}`).expect(403);

    expect(await db.select().from(pipelineCaseStageDeliverables)).toEqual([
      expect.objectContaining({ companyId: a.company.id, caseId, clientFacing: true }),
    ]);
  });
});
