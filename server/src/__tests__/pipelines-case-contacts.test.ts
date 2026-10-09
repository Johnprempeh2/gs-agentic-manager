import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  instanceSettings,
  pipelineCaseContacts,
  pipelineCaseEvents,
  pipelineCases,
  pipelineStages,
  pipelineTransitions,
  pipelines,
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
    `Skipping embedded Postgres pipeline case contact tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("pipeline case contacts", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pipeline-case-contacts-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  // GRE-1077: the pipelines API is gated on enablePipelines.
  beforeEach(async () => {
    await instanceSettingsService(db).updateExperimental({ enablePipelines: true });
  });

  afterEach(async () => {
    await db.delete(pipelineCaseContacts);
    await db.delete(pipelineCaseEvents);
    await db.delete(pipelineCases);
    await db.delete(pipelineTransitions);
    await db.delete(pipelineStages);
    await db.delete(activityLog);
    await db.delete(pipelines);
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

  it("adds, lists, edits and removes contacts on a case", async () => {
    const company = await seedCompany("Greatstone");
    const { caseId } = await seedClientCase(company.id, "Client A");
    const http = request(app());

    const first = await http
      .post(`/api/cases/${caseId}/contacts`)
      .send({ name: "Ama Mensah", role: "CEO", phone: "+233 20 000 0000", email: "ama@example.com" })
      .expect(201);
    expect(first.body).toMatchObject({
      companyId: company.id,
      caseId,
      name: "Ama Mensah",
      role: "CEO",
      phone: "+233 20 000 0000",
      email: "ama@example.com",
      position: 0,
      createdByUserId: "board-user",
    });
    const second = await http
      .post(`/api/cases/${caseId}/contacts`)
      .send({ name: "Kofi Owusu", role: "", phone: "", email: "" })
      .expect(201);
    // Blank optional fields are stored as empty, and new contacts go last.
    expect(second.body).toMatchObject({ name: "Kofi Owusu", role: null, phone: null, email: null, position: 1 });

    const listed = await http.get(`/api/cases/${caseId}/contacts`).expect(200);
    expect(listed.body.map((contact: { name: string }) => contact.name)).toEqual(["Ama Mensah", "Kofi Owusu"]);

    const edited = await http
      .patch(`/api/cases/${caseId}/contacts/${second.body.id}`)
      .send({ role: "Board member", phone: "+233 24 111 1111" })
      .expect(200);
    expect(edited.body).toMatchObject({ name: "Kofi Owusu", role: "Board member", phone: "+233 24 111 1111" });

    await http.delete(`/api/cases/${caseId}/contacts/${first.body.id}`).expect(200, { deleted: true });
    await http.delete(`/api/cases/${caseId}/contacts/${first.body.id}`).expect(404);
    const after = await http.get(`/api/cases/${caseId}/contacts`).expect(200);
    expect(after.body.map((contact: { name: string }) => contact.name)).toEqual(["Kofi Owusu"]);

    const events = await db.select().from(pipelineCaseEvents).where(eq(pipelineCaseEvents.caseId, caseId));
    expect(events.map((event) => event.payload.action).filter(Boolean)).toEqual(
      expect.arrayContaining(["contact_added", "contact_updated", "contact_removed"]),
    );
  });

  it("rejects a contact without a name or with a bad email", async () => {
    const company = await seedCompany("Greatstone");
    const { caseId } = await seedClientCase(company.id, "Client A");
    const http = request(app());

    await http.post(`/api/cases/${caseId}/contacts`).send({ name: "  ", role: "CEO" }).expect(400);
    await http.post(`/api/cases/${caseId}/contacts`).send({ name: "Ama", email: "not-an-email" }).expect(400);
    await http.patch(`/api/cases/${caseId}/contacts/not-a-uuid`).send({ name: "Ama" }).expect(404);
    expect(await db.select().from(pipelineCaseContacts)).toEqual([]);
  });

  it("keeps contacts inside their company", async () => {
    const companyA = await seedCompany("Company A");
    const companyB = await seedCompany("Company B");
    const { caseId } = await seedClientCase(companyA.id, "Client of A");
    const { caseId: caseOfB } = await seedClientCase(companyB.id, "Client of B");
    const contact = await request(app())
      .post(`/api/cases/${caseId}/contacts`)
      .send({ name: "Ama Mensah", phone: "+233 20 000 0000" })
      .expect(201);

    const outsider = request(app({
      type: "board",
      userId: "company-b-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyB.id],
    }));
    await outsider.get(`/api/cases/${caseId}/contacts`).expect(404);
    await outsider.post(`/api/cases/${caseId}/contacts`).send({ name: "Intruder" }).expect(404);
    await outsider.patch(`/api/cases/${caseId}/contacts/${contact.body.id}`).send({ name: "Changed" }).expect(404);
    await outsider.delete(`/api/cases/${caseId}/contacts/${contact.body.id}`).expect(404);

    // A contact id from company A cannot be reached through company B's own case.
    const instanceAdmin = request(app());
    await instanceAdmin.patch(`/api/cases/${caseOfB}/contacts/${contact.body.id}`).send({ name: "Changed" }).expect(404);
    await instanceAdmin.delete(`/api/cases/${caseOfB}/contacts/${contact.body.id}`).expect(404);
    expect((await instanceAdmin.get(`/api/cases/${caseOfB}/contacts`).expect(200)).body).toEqual([]);

    const rows = await db.select().from(pipelineCaseContacts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ companyId: companyA.id, name: "Ama Mensah" });
  });

  it("needs pipeline write access to change contacts", async () => {
    const company = await seedCompany("Greatstone");
    const { caseId } = await seedClientCase(company.id, "Client A");
    const contact = await request(app()).post(`/api/cases/${caseId}/contacts`).send({ name: "Ama" }).expect(201);
    const agentWithoutGrant = request(app({
      type: "agent",
      agentId: randomUUID(),
      companyId: company.id,
      runId: randomUUID(),
      source: "agent_key",
    }));

    await agentWithoutGrant.get(`/api/cases/${caseId}/contacts`).expect(200);
    await agentWithoutGrant.post(`/api/cases/${caseId}/contacts`).send({ name: "Kofi" }).expect(403);
    await agentWithoutGrant.patch(`/api/cases/${caseId}/contacts/${contact.body.id}`).send({ name: "Changed" }).expect(403);
    await agentWithoutGrant.delete(`/api/cases/${caseId}/contacts/${contact.body.id}`).expect(403);
    expect(await db.select().from(pipelineCaseContacts)).toEqual([expect.objectContaining({ name: "Ama" })]);
  });

  it("shows how long each case has been in its stage", async () => {
    const company = await seedCompany("Greatstone");
    const { pipelineId, caseId } = await seedClientCase(company.id, "Client A");
    const http = request(app());

    const listed = await http.get(`/api/pipelines/${pipelineId}/cases`).expect(200);
    expect(listed.body[0].stageEnteredAt).toEqual(expect.any(String));

    const [caseRow] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, caseId));
    const enteredAt = new Date("2026-09-01T10:00:00.000Z");
    await db.insert(pipelineCaseEvents).values({
      companyId: company.id,
      caseId,
      type: "transitioned",
      actorType: "system",
      toStageId: caseRow!.stageId,
      createdAt: enteredAt,
    });
    const detail = await http.get(`/api/cases/${caseId}`).expect(200);
    expect(new Date(detail.body.stageEnteredAt).toISOString()).toBe(
      new Date(Math.max(enteredAt.getTime(), new Date(listed.body[0].stageEnteredAt).getTime())).toISOString(),
    );
  });
});
