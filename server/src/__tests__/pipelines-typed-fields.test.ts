import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  instanceSettings,
  pipelineCaseEvents,
  pipelineCases,
  pipelineFieldDefinitions,
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres typed pipeline field tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("typed pipeline fields", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pipeline-typed-fields-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(pipelineCaseEvents);
    await db.delete(pipelineCases);
    await db.delete(pipelineFieldDefinitions);
    await db.delete(pipelineTransitions);
    await db.delete(pipelineStages);
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

  async function seedPipeline(name = "Greatstone") {
    const [company] = await db.insert(companies).values({
      name,
      issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const pipeline = await request(app())
      .post(`/api/companies/${company!.id}/pipelines`)
      .send({
        key: "sales",
        name: "Sales",
        stages: [
          { key: "lead", name: "Lead", kind: "open", position: 100 },
          { key: "won", name: "Won", kind: "done", position: 900 },
          { key: "lost", name: "Lost", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(201);
    return { companyId: company!.id, pipelineId: pipeline.body.id as string };
  }

  async function addFields(pipelineId: string) {
    const http = request(app());
    const value = await http
      .post(`/api/pipelines/${pipelineId}/fields`)
      .send({ key: "dealValue", label: "Deal value", type: "number", required: true })
      .expect(201);
    const tier = await http
      .post(`/api/pipelines/${pipelineId}/fields`)
      .send({ key: "tier", label: "Tier", type: "select", options: ["Gold", "Silver"] })
      .expect(201);
    const closeDate = await http
      .post(`/api/pipelines/${pipelineId}/fields`)
      .send({ key: "closeDate", label: "Close date", type: "date" })
      .expect(201);
    return { value: value.body, tier: tier.body, closeDate: closeDate.body };
  }

  function createCase(pipelineId: string, fields: Record<string, unknown>) {
    return request(app())
      .post(`/api/pipelines/${pipelineId}/cases`)
      .send({ title: "Acme deal", stageKey: "lead", fields });
  }

  it("creates, lists and edits typed fields", async () => {
    const { companyId, pipelineId } = await seedPipeline();
    const { value, tier } = await addFields(pipelineId);
    expect(value).toMatchObject({
      companyId,
      pipelineId,
      key: "dealValue",
      type: "number",
      required: true,
      options: [],
      position: 0,
      createdByUserId: "board-user",
    });
    expect(tier).toMatchObject({ type: "select", options: ["Gold", "Silver"], position: 1 });

    const http = request(app());
    const listed = await http.get(`/api/pipelines/${pipelineId}/fields`).expect(200);
    expect(listed.body.map((field: { key: string }) => field.key)).toEqual(["dealValue", "tier", "closeDate"]);
    const detail = await http.get(`/api/pipelines/${pipelineId}`).expect(200);
    expect(detail.body.fieldDefinitions.map((field: { key: string }) => field.key)).toEqual(["dealValue", "tier", "closeDate"]);

    const edited = await http
      .patch(`/api/pipelines/${pipelineId}/fields/${tier.id}`)
      .send({ label: "Account tier", options: ["Gold", "Silver", "Bronze"], required: true })
      .expect(200);
    expect(edited.body).toMatchObject({ key: "tier", label: "Account tier", options: ["Gold", "Silver", "Bronze"], required: true });

    const actions = (await db.select().from(activityLog).where(eq(activityLog.companyId, companyId)))
      .map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["pipeline.field_created", "pipeline.field_updated"]));
  });

  it("rejects bad field definitions", async () => {
    const { pipelineId } = await seedPipeline();
    const { tier, value } = await addFields(pipelineId);
    const http = request(app());

    await http.post(`/api/pipelines/${pipelineId}/fields`).send({ key: "stage", label: "Stage", type: "select" }).expect(400);
    await http.post(`/api/pipelines/${pipelineId}/fields`).send({ key: "bad-key", label: "Bad", type: "text" }).expect(400);
    await http.post(`/api/pipelines/${pipelineId}/fields`).send({ key: "colour", label: "Colour", type: "rainbow" }).expect(400);
    const duplicate = await http
      .post(`/api/pipelines/${pipelineId}/fields`)
      .send({ key: "tier", label: "Tier again", type: "text" })
      .expect(409);
    expect(duplicate.body.details).toMatchObject({ code: "duplicate_field_key", fieldKey: "tier" });

    // Key and type are fixed once created.
    await http.patch(`/api/pipelines/${pipelineId}/fields/${tier.id}`).send({ type: "text" }).expect(400);
    await http.patch(`/api/pipelines/${pipelineId}/fields/${tier.id}`).send({ key: "level" }).expect(400);
    await http.patch(`/api/pipelines/${pipelineId}/fields/${tier.id}`).send({ options: [] }).expect(422);
    await http.patch(`/api/pipelines/${pipelineId}/fields/${value.id}`).send({ options: ["1"] }).expect(422);
    await http.patch(`/api/pipelines/${pipelineId}/fields/${randomUUID()}`).send({ label: "X" }).expect(404);
    await http.patch(`/api/pipelines/${pipelineId}/fields/not-a-uuid`).send({ label: "X" }).expect(404);
  });

  it("checks case values against field types when a case is created", async () => {
    const { pipelineId } = await seedPipeline();
    await addFields(pipelineId);

    const missing = await createCase(pipelineId, { tier: "Gold" }).expect(422);
    expect(missing.body.details).toMatchObject({ code: "required_field", fieldKey: "dealValue" });
    const wrongNumber = await createCase(pipelineId, { dealValue: "12000" }).expect(422);
    expect(wrongNumber.body.details).toMatchObject({ code: "invalid_field_value", fieldKey: "dealValue" });
    const wrongChoice = await createCase(pipelineId, { dealValue: 12000, tier: "Platinum" }).expect(422);
    expect(wrongChoice.body.details).toMatchObject({ code: "invalid_field_value", fieldKey: "tier" });
    const wrongDate = await createCase(pipelineId, { dealValue: 12000, closeDate: "31/12/2026" }).expect(422);
    expect(wrongDate.body.details).toMatchObject({ code: "invalid_field_value", fieldKey: "closeDate" });
    expect(await db.select().from(pipelineCases)).toEqual([]);

    // Keys without a definition pass through untouched.
    const created = await createCase(pipelineId, {
      dealValue: 12000,
      tier: "Gold",
      closeDate: "2026-12-31",
      source: "referral",
    }).expect(201);
    expect((created.body.case ?? created.body).fields).toEqual({
      dealValue: 12000,
      tier: "Gold",
      closeDate: "2026-12-31",
      source: "referral",
    });
  });

  it("checks case values when a case is edited", async () => {
    const { pipelineId } = await seedPipeline();
    await addFields(pipelineId);
    const created = await createCase(pipelineId, { dealValue: 12000 }).expect(201);
    const caseId = (created.body.case ?? created.body).id as string;
    const http = request(app());

    const wrong = await http.patch(`/api/cases/${caseId}`).send({ fields: { dealValue: 12000, closeDate: "soon" } }).expect(422);
    expect(wrong.body.details).toMatchObject({ code: "invalid_field_value", fieldKey: "closeDate" });
    const cleared = await http.patch(`/api/cases/${caseId}`).send({ fields: { dealValue: null } }).expect(422);
    expect(cleared.body.details).toMatchObject({ code: "required_field", fieldKey: "dealValue" });

    const ok = await http.patch(`/api/cases/${caseId}`).send({ fields: { dealValue: 15000, tier: "Silver" } }).expect(200);
    expect(ok.body.fields).toEqual({ dealValue: 15000, tier: "Silver" });
  });

  it("lets older cases be edited when a required field is added later", async () => {
    const { pipelineId } = await seedPipeline();
    const created = await createCase(pipelineId, { note: "first call" }).expect(201);
    const caseId = (created.body.case ?? created.body).id as string;
    await addFields(pipelineId);

    const http = request(app());
    await http.patch(`/api/cases/${caseId}`).send({ fields: { note: "second call" } }).expect(200);
    await http.patch(`/api/cases/${caseId}`).send({ fields: { note: "third call", tier: "Bronze" } }).expect(422);
  });

  it("stops checking an archived field and restores it", async () => {
    const { pipelineId } = await seedPipeline();
    const { value } = await addFields(pipelineId);
    const http = request(app());

    await http.patch(`/api/pipelines/${pipelineId}/fields/${value.id}`).send({ archived: true }).expect(200);
    const listed = await http.get(`/api/pipelines/${pipelineId}/fields`).expect(200);
    expect(listed.body.map((field: { key: string }) => field.key)).toEqual(["tier", "closeDate"]);
    const all = await http.get(`/api/pipelines/${pipelineId}/fields?includeArchived=true`).expect(200);
    expect(all.body).toHaveLength(3);

    await createCase(pipelineId, { dealValue: "anything" }).expect(201);
    // The archived key stays reserved so stored values keep their type.
    await http.post(`/api/pipelines/${pipelineId}/fields`).send({ key: "dealValue", label: "Value", type: "text" }).expect(409);

    const restored = await http.patch(`/api/pipelines/${pipelineId}/fields/${value.id}`).send({ archived: false }).expect(200);
    expect(restored.body.archivedAt).toBeNull();
    await createCase(pipelineId, {}).expect(422);
  });

  it("keeps fields inside their company and needs write access to change them", async () => {
    const { companyId, pipelineId } = await seedPipeline("Company A");
    const { companyId: companyB } = await seedPipeline("Company B");
    const { tier } = await addFields(pipelineId);

    const outsider = request(app({
      type: "board",
      userId: "company-b-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyB],
    }));
    await outsider.get(`/api/pipelines/${pipelineId}/fields`).expect(404);
    await outsider.post(`/api/pipelines/${pipelineId}/fields`).send({ key: "x", label: "X", type: "text" }).expect(404);
    await outsider.patch(`/api/pipelines/${pipelineId}/fields/${tier.id}`).send({ label: "Changed" }).expect(404);

    const agentWithoutGrant = request(app({
      type: "agent",
      agentId: randomUUID(),
      companyId,
      runId: randomUUID(),
      source: "agent_key",
    }));
    await agentWithoutGrant.get(`/api/pipelines/${pipelineId}/fields`).expect(200);
    await agentWithoutGrant.post(`/api/pipelines/${pipelineId}/fields`).send({ key: "x", label: "X", type: "text" }).expect(403);
    await agentWithoutGrant.patch(`/api/pipelines/${pipelineId}/fields/${tier.id}`).send({ label: "Changed" }).expect(403);

    const rows = await db.select().from(pipelineFieldDefinitions);
    expect(rows.every((row) => row.companyId === companyId)).toBe(true);
    expect(rows.find((row) => row.id === tier.id)?.label).toBe("Tier");
  });
});
