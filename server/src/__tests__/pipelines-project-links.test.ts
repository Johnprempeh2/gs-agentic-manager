import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  goals,
  instanceSettings,
  pipelineCaseEvents,
  pipelineCaseProjectLinks,
  pipelineCases,
  pipelineStages,
  pipelineTransitions,
  pipelines,
  projectGoals,
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
    `Skipping embedded Postgres pipeline project link tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("pipeline case project links", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pipeline-project-links-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  // GRE-1077: the pipelines API is gated on enablePipelines.
  beforeEach(async () => {
    await instanceSettingsService(db).updateExperimental({ enablePipelines: true });
  });

  afterEach(async () => {
    await db.delete(pipelineCaseProjectLinks);
    await db.delete(pipelineCaseEvents);
    await db.delete(pipelineCases);
    await db.delete(pipelineTransitions);
    await db.delete(pipelineStages);
    await db.delete(activityLog);
    await db.delete(pipelines);
    await db.delete(projectGoals);
    await db.delete(goals);
    await db.delete(projects);
    await db.delete(companies);
    await db.delete(instanceSettings);
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
    const [company] = await db.insert(companies).values({
      name,
      issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    return company!;
  }

  async function seedProjectWithGoals(companyId: string, name: string, goalTitles: string[]) {
    const [project] = await db.insert(projects).values({ companyId, name, status: "in_progress" }).returning();
    for (const title of goalTitles) {
      const [goal] = await db.insert(goals).values({ companyId, title, level: "company", status: "active" }).returning();
      await db.insert(projectGoals).values({ companyId, projectId: project!.id, goalId: goal!.id });
    }
    return project!;
  }

  async function seedClientCase(companyId: string, title: string) {
    const http = request(app());
    const pipeline = await http
      .post(`/api/companies/${companyId}/pipelines`)
      .send({
        key: "client-journey",
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
    const caseId = (created.body.case ?? created.body).id as string;
    return { pipelineId: pipeline.body.id as string, caseId };
  }

  it("links a project to a case, lists its goals, and shows the case on the project", async () => {
    const company = await seedCompany("Greatstone");
    const project = await seedProjectWithGoals(company.id, "OMNI Group", [
      "First client install",
      "Ghana: three clients on signed terms",
    ]);
    const { pipelineId, caseId } = await seedClientCase(company.id, "OMNI");
    const http = request(app());

    const link = await http.post(`/api/cases/${caseId}/project-links`).send({ projectId: project.id }).expect(201);
    expect(link.body).toMatchObject({ companyId: company.id, caseId, projectId: project.id, createdByUserId: "board-user" });

    const listed = await http.get(`/api/cases/${caseId}/project-links`).expect(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].project).toMatchObject({ id: project.id, name: "OMNI Group", status: "in_progress" });
    expect(listed.body[0].goals.map((goal: { title: string }) => goal.title)).toEqual([
      "First client install",
      "Ghana: three clients on signed terms",
    ]);

    const onProject = await http.get(`/api/projects/${project.id}/pipeline-cases`).expect(200);
    expect(onProject.body).toEqual([
      expect.objectContaining({
        case: expect.objectContaining({ id: caseId, title: "OMNI", pipelineId }),
        pipeline: { id: pipelineId, name: "Client journey" },
        stage: expect.objectContaining({ key: "lead", name: "Lead" }),
      }),
    ]);

    // Linking the same project twice is a conflict, not a second row.
    await http.post(`/api/cases/${caseId}/project-links`).send({ projectId: project.id }).expect(409);

    const events = await db.select().from(pipelineCaseEvents).where(eq(pipelineCaseEvents.caseId, caseId));
    expect(events.map((event) => event.type)).toContain("project_linked");
  });

  it("unlinks a project from a case", async () => {
    const company = await seedCompany("Greatstone");
    const project = await seedProjectWithGoals(company.id, "OMNI Group", ["First client install"]);
    const { caseId } = await seedClientCase(company.id, "OMNI");
    const http = request(app());

    await http.post(`/api/cases/${caseId}/project-links`).send({ projectId: project.id }).expect(201);
    await http.delete(`/api/cases/${caseId}/project-links/${project.id}`).expect(200, { deleted: true });

    expect((await http.get(`/api/cases/${caseId}/project-links`).expect(200)).body).toEqual([]);
    expect((await http.get(`/api/projects/${project.id}/pipeline-cases`).expect(200)).body).toEqual([]);
    await http.delete(`/api/cases/${caseId}/project-links/${project.id}`).expect(404);

    const events = await db.select().from(pipelineCaseEvents).where(eq(pipelineCaseEvents.caseId, caseId));
    expect(events.map((event) => event.type)).toContain("project_unlinked");
  });

  it("refuses to link a case to another company's project", async () => {
    const companyA = await seedCompany("Company A");
    const companyB = await seedCompany("Company B");
    const foreignProject = await seedProjectWithGoals(companyB.id, "Company B project", ["Company B goal"]);
    const { caseId } = await seedClientCase(companyA.id, "Client of A");

    await request(app())
      .post(`/api/cases/${caseId}/project-links`)
      .send({ projectId: foreignProject.id })
      .expect(404);
    expect(await db.select().from(pipelineCaseProjectLinks)).toEqual([]);
  });

  it("hides case links from a board user of another company", async () => {
    const companyA = await seedCompany("Company A");
    const companyB = await seedCompany("Company B");
    const project = await seedProjectWithGoals(companyA.id, "Company A project", []);
    const { caseId } = await seedClientCase(companyA.id, "Client of A");
    await request(app()).post(`/api/cases/${caseId}/project-links`).send({ projectId: project.id }).expect(201);

    const outsider = request(app({
      type: "board",
      userId: "company-b-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyB.id],
    }));
    await outsider.get(`/api/cases/${caseId}/project-links`).expect(404);
    await outsider.get(`/api/projects/${project.id}/pipeline-cases`).expect(404);
    await outsider.post(`/api/cases/${caseId}/project-links`).send({ projectId: project.id }).expect(404);
    await outsider.delete(`/api/cases/${caseId}/project-links/${project.id}`).expect(404);
    expect(await db.select().from(pipelineCaseProjectLinks)).toHaveLength(1);
  });
});
