import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  crmSyncBindings,
  crmSyncConflicts,
  crmSyncEvents,
  crmSyncFieldMaps,
  crmSyncRecordLinks,
  instanceSettings,
  pipelineCaseContacts,
  pipelineCaseEvents,
  pipelineCases,
  pipelineFieldDefinitions,
  pipelineStages,
  pipelineTransitions,
  pipelines,
  toolApplications,
  toolConnections,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { crmSyncRoutes } from "../routes/crm-sync.js";
import { pipelineRoutes } from "../routes/pipelines.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres CRM sync route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("CRM sync routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-crm-sync-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    await instanceSettingsService(db).updateExperimental({ enablePipelines: true });
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(crmSyncEvents);
    await db.delete(crmSyncConflicts);
    await db.delete(crmSyncRecordLinks);
    await db.delete(crmSyncFieldMaps);
    await db.delete(crmSyncBindings);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(pipelineCaseContacts);
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

  function memberOf(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "other-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    } as Express.Request["actor"];
  }

  function agentOf(companyId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId: randomUUID(),
      companyId,
      runId: randomUUID(),
    } as Express.Request["actor"];
  }

  function app(actor: Express.Request["actor"] = boardActor) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", pipelineRoutes(db, { heartbeat: { wakeup: async () => null } }));
    instance.use("/api", crmSyncRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function seedCompany(name = "Greatstone") {
    const [company] = await db.insert(companies).values({
      name,
      issuePrefix: `C${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const companyId = company!.id;
    const pipeline = await request(app())
      .post(`/api/companies/${companyId}/pipelines`)
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
    const pipelineId = pipeline.body.id as string;
    await request(app())
      .post(`/api/pipelines/${pipelineId}/fields`)
      .send({ key: "dealValue", label: "Deal value", type: "number" })
      .expect(201);
    const application = await db.insert(toolApplications).values({
      companyId,
      applicationKey: `pipedrive-${randomUUID().slice(0, 8)}`,
      name: "Pipedrive",
      type: "mcp_http",
      status: "active",
    }).returning().then((rows) => rows[0]!);
    const connection = await db.insert(toolConnections).values({
      companyId,
      applicationId: application.id,
      name: "Pipedrive",
      uid: `test/${randomUUID()}`,
      transport: "mcp_remote",
      status: "active",
      enabled: true,
    }).returning().then((rows) => rows[0]!);
    return { companyId, pipelineId, connectionId: connection.id };
  }

  function bindingBody(seed: { pipelineId: string; connectionId: string }, overrides: Record<string, unknown> = {}) {
    return {
      connectionId: seed.connectionId,
      providerKey: "pipedrive",
      containerKind: "crm_pipeline",
      externalContainerId: "1",
      externalContainerLabel: "Sales pipeline",
      pipelineId: seed.pipelineId,
      direction: "inbound_only",
      stageMap: [{ externalStageId: "10", stageKey: "lead" }, { externalStageId: "11", stageKey: "won" }],
      fieldMap: [
        { externalField: "title", gsamField: "title", owner: "crm" },
        { externalField: "value", externalFieldLabel: "Value", gsamField: "fields.dealValue", owner: "crm" },
      ],
      ...overrides,
    };
  }

  async function createBinding(seed: { companyId: string; pipelineId: string; connectionId: string }) {
    const res = await request(app())
      .post(`/api/companies/${seed.companyId}/crm-sync/bindings`)
      .send(bindingBody(seed))
      .expect(201);
    return res.body as { id: string };
  }

  it("creates a binding with its stage and field maps and logs the write", async () => {
    const seed = await seedCompany();
    const created = await request(app())
      .post(`/api/companies/${seed.companyId}/crm-sync/bindings`)
      .send(bindingBody(seed))
      .expect(201);
    expect(created.body).toMatchObject({
      companyId: seed.companyId,
      providerKey: "pipedrive",
      direction: "inbound_only",
      status: "active",
      openConflictCount: 0,
      stageMap: [{ externalStageId: "10", stageKey: "lead" }, { externalStageId: "11", stageKey: "won" }],
    });

    const list = await request(app()).get(`/api/companies/${seed.companyId}/crm-sync/bindings`).expect(200);
    expect(list.body.map((row: { id: string }) => row.id)).toEqual([created.body.id]);

    const map = await request(app()).get(`/api/crm-sync/bindings/${created.body.id}/field-map`).expect(200);
    expect(map.body.fields.map((row: { gsamField: string; owner: string }) => [row.gsamField, row.owner])).toEqual([
      ["title", "crm"],
      ["fields.dealValue", "crm"],
    ]);

    const activity = await db.select().from(activityLog).where(eq(activityLog.action, "crm_sync.binding_created"));
    expect(activity).toHaveLength(1);
    expect(activity[0]!.entityId).toBe(created.body.id);
  });

  it("rejects unknown stages, unknown or archived typed fields, foreign connections and duplicates", async () => {
    const seed = await seedCompany();
    const other = await seedCompany("Other");
    const url = `/api/companies/${seed.companyId}/crm-sync/bindings`;

    const badStage = await request(app())
      .post(url)
      .send(bindingBody(seed, { stageMap: [{ externalStageId: "10", stageKey: "nope" }] }))
      .expect(422);
    expect(badStage.body.details).toMatchObject({ code: "unknown_stage_key", stageKeys: ["nope"] });

    const badField = await request(app())
      .post(url)
      .send(bindingBody(seed, { fieldMap: [{ externalField: "x", gsamField: "fields.missing", owner: "crm" }] }))
      .expect(422);
    expect(badField.body.details).toMatchObject({ code: "unknown_pipeline_field", fieldKeys: ["missing"] });

    const [field] = await db.select().from(pipelineFieldDefinitions)
      .where(eq(pipelineFieldDefinitions.pipelineId, seed.pipelineId));
    await request(app()).patch(`/api/pipelines/${seed.pipelineId}/fields/${field!.id}`).send({ archived: true }).expect(200);
    await request(app()).post(url).send(bindingBody(seed)).expect(422);
    await request(app()).patch(`/api/pipelines/${seed.pipelineId}/fields/${field!.id}`).send({ archived: false }).expect(200);

    const foreign = await request(app())
      .post(url)
      .send(bindingBody(seed, { connectionId: other.connectionId }))
      .expect(422);
    expect(foreign.body.details).toMatchObject({ code: "connection_not_found" });
    await request(app()).post(url).send(bindingBody(seed, { pipelineId: other.pipelineId })).expect(422);

    await request(app()).post(url).send(bindingBody(seed)).expect(201);
    const duplicate = await request(app()).post(url).send(bindingBody(seed)).expect(409);
    expect(duplicate.body.details).toMatchObject({ code: "duplicate_binding" });
  });

  it("lets agents read but not write", async () => {
    const seed = await seedCompany();
    const binding = await createBinding(seed);
    const agent = request(app(agentOf(seed.companyId)));

    await agent.get(`/api/companies/${seed.companyId}/crm-sync/bindings`).expect(200);
    await agent.get(`/api/crm-sync/bindings/${binding.id}`).expect(200);
    await agent.get(`/api/crm-sync/bindings/${binding.id}/field-map`).expect(200);
    await agent.get(`/api/crm-sync/bindings/${binding.id}/events`).expect(200);
    await agent.get(`/api/companies/${seed.companyId}/crm-sync/conflicts`).expect(200);

    await agent.post(`/api/companies/${seed.companyId}/crm-sync/bindings`)
      .send(bindingBody(seed, { externalContainerId: "2" })).expect(403);
    await agent.patch(`/api/crm-sync/bindings/${binding.id}`).send({ status: "paused" }).expect(403);
    await agent.put(`/api/crm-sync/bindings/${binding.id}/field-map`).send({ fields: [] }).expect(403);
    await agent.delete(`/api/crm-sync/bindings/${binding.id}`).expect(403);
  });

  it("hides another company's bindings, conflicts and case links", async () => {
    const seed = await seedCompany();
    const other = await seedCompany("Other");
    const binding = await createBinding(seed);
    const [conflictRow] = await db.insert(crmSyncConflicts).values({
      companyId: seed.companyId,
      bindingId: binding.id,
      entityKind: "case",
      entityId: randomUUID(),
      externalId: "500",
      gsamField: "title",
      externalField: "title",
      crmValue: { value: "A" },
      gsamValue: { value: "B" },
    }).returning();
    const [stage] = await db.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, seed.pipelineId));
    const [caseRow] = await db.insert(pipelineCases).values({
      companyId: seed.companyId,
      pipelineId: seed.pipelineId,
      stageId: stage!.id,
      caseKey: "c-1",
      title: "Acme",
    }).returning();

    const outsider = request(app(memberOf(other.companyId)));
    await outsider.get(`/api/companies/${seed.companyId}/crm-sync/bindings`).expect(404);
    await outsider.get(`/api/crm-sync/bindings/${binding.id}`).expect(404);
    await outsider.patch(`/api/crm-sync/bindings/${binding.id}`).send({ status: "paused" }).expect(404);
    await outsider.post(`/api/crm-sync/conflicts/${conflictRow!.id}/dismiss`).send({}).expect(404);
    await outsider.get(`/api/cases/${caseRow!.id}/crm-sync/links`).expect(404);
    await outsider.get(`/api/companies/${other.companyId}/crm-sync/bindings`).expect(200, []);
  });

  it("pauses, resumes, edits the stage map and deletes while keeping the log", async () => {
    const seed = await seedCompany();
    const binding = await createBinding(seed);
    await db.update(crmSyncBindings).set({ status: "error", lastErrorMessage: "Pipedrive said 401" })
      .where(eq(crmSyncBindings.id, binding.id));

    const resumed = await request(app()).patch(`/api/crm-sync/bindings/${binding.id}`).send({ status: "active" }).expect(200);
    expect(resumed.body).toMatchObject({ status: "active", lastErrorMessage: null });
    await request(app()).patch(`/api/crm-sync/bindings/${binding.id}`)
      .send({ stageMap: [{ externalStageId: "10", stageKey: "missing" }] }).expect(422);
    const paused = await request(app()).patch(`/api/crm-sync/bindings/${binding.id}`)
      .send({ status: "paused", stageMap: [{ externalStageId: "10", stageKey: "won" }] }).expect(200);
    expect(paused.body).toMatchObject({ status: "paused", stageMap: [{ externalStageId: "10", stageKey: "won" }] });

    await db.insert(crmSyncEvents).values({
      companyId: seed.companyId,
      bindingId: binding.id,
      direction: "inbound",
      action: "created",
      entityKind: "case",
      externalId: "500",
    });
    await db.insert(crmSyncConflicts).values({
      companyId: seed.companyId,
      bindingId: binding.id,
      entityKind: "case",
      entityId: randomUUID(),
      externalId: "500",
      gsamField: "title",
      externalField: "title",
      crmValue: { value: "A" },
      gsamValue: { value: "B" },
    });

    await request(app()).delete(`/api/crm-sync/bindings/${binding.id}`).expect(204);
    await request(app()).get(`/api/crm-sync/bindings/${binding.id}`).expect(404);
    expect(await db.select().from(crmSyncEvents).where(eq(crmSyncEvents.bindingId, binding.id))).toHaveLength(1);
    const conflicts = await db.select().from(crmSyncConflicts).where(eq(crmSyncConflicts.bindingId, binding.id));
    expect(conflicts.map((row) => row.status)).toEqual(["dismissed"]);

    // The container can be bound again once the old binding is gone.
    await createBinding(seed);
  });

  it("replaces the field map and checks typed fields", async () => {
    const seed = await seedCompany();
    const binding = await createBinding(seed);
    await request(app()).put(`/api/crm-sync/bindings/${binding.id}/field-map`)
      .send({ fields: [{ externalField: "x", gsamField: "fields.ghost", owner: "crm" }] }).expect(422);
    await request(app()).put(`/api/crm-sync/bindings/${binding.id}/field-map`)
      .send({ fields: [{ externalField: "a", gsamField: "title", owner: "crm" }, { externalField: "a", gsamField: "summary", owner: "crm" }] })
      .expect(400);
    const replaced = await request(app()).put(`/api/crm-sync/bindings/${binding.id}/field-map`)
      .send({ fields: [{ externalField: "org_name", gsamField: "summary", owner: "shared" }] }).expect(200);
    expect(replaced.body.fields).toEqual([
      expect.objectContaining({ externalField: "org_name", gsamField: "summary", owner: "shared" }),
    ]);
    const rows = await db.select().from(crmSyncFieldMaps).where(eq(crmSyncFieldMaps.bindingId, binding.id));
    expect(rows).toHaveLength(1);
  });

  it("pages the sync log newest first", async () => {
    const seed = await seedCompany();
    const binding = await createBinding(seed);
    const base = Date.now();
    for (let index = 0; index < 3; index += 1) {
      await db.insert(crmSyncEvents).values({
        companyId: seed.companyId,
        bindingId: binding.id,
        direction: "inbound",
        action: index === 2 ? "failed" : "updated",
        entityKind: "case",
        externalId: String(100 + index),
        errorMessage: index === 2 ? "Rate limited" : null,
        createdAt: new Date(base + index * 1000),
      });
    }
    const first = await request(app()).get(`/api/crm-sync/bindings/${binding.id}/events?limit=2`).expect(200);
    expect(first.body.items.map((row: { externalId: string }) => row.externalId)).toEqual(["102", "101"]);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await request(app())
      .get(`/api/crm-sync/bindings/${binding.id}/events?limit=2&cursor=${first.body.nextCursor}`)
      .expect(200);
    expect(second.body).toMatchObject({ items: [expect.objectContaining({ externalId: "100" })], nextCursor: null });

    const failed = await request(app()).get(`/api/crm-sync/bindings/${binding.id}/events?action=failed`).expect(200);
    expect(failed.body.items).toEqual([expect.objectContaining({ errorMessage: "Rate limited" })]);
    await request(app()).get(`/api/crm-sync/bindings/${binding.id}/events?cursor=nope`).expect(400);
  });

  it("resolves and dismisses conflicts once", async () => {
    const seed = await seedCompany();
    const binding = await createBinding(seed);
    const [first, second] = await db.insert(crmSyncConflicts).values([
      {
        companyId: seed.companyId,
        bindingId: binding.id,
        entityKind: "case",
        entityId: randomUUID(),
        externalId: "500",
        gsamField: "title",
        externalField: "title",
        lastSyncedValue: { value: "Acme" },
        crmValue: { value: "Acme Ltd" },
        gsamValue: { value: "Acme Inc" },
      },
      {
        companyId: seed.companyId,
        bindingId: binding.id,
        entityKind: "case",
        entityId: randomUUID(),
        externalId: "501",
        gsamField: "summary",
        externalField: "notes",
        crmValue: { value: null },
        gsamValue: { value: "x" },
      },
    ]).returning();

    const open = await request(app()).get(`/api/companies/${seed.companyId}/crm-sync/conflicts`).expect(200);
    expect(open.body.items).toHaveLength(2);
    const counted = await request(app()).get(`/api/crm-sync/bindings/${binding.id}`).expect(200);
    expect(counted.body.openConflictCount).toBe(2);

    const resolved = await request(app()).post(`/api/crm-sync/conflicts/${first!.id}/resolve`)
      .send({ resolution: "keep_crm" }).expect(200);
    expect(resolved.body).toMatchObject({
      status: "resolved",
      resolution: "keep_crm",
      lastSyncedValue: "Acme",
      resolvedValue: "Acme Ltd",
      resolvedByUserId: "board-user",
    });
    await request(app()).post(`/api/crm-sync/conflicts/${first!.id}/resolve`)
      .send({ resolution: "keep_gsam" }).expect(409);

    const dismissed = await request(app()).post(`/api/crm-sync/conflicts/${second!.id}/dismiss`)
      .send({ reason: "Old note" }).expect(200);
    expect(dismissed.body).toMatchObject({ status: "dismissed", crmValue: null });
    expect(dismissed.body).not.toHaveProperty("lastSyncedValue");

    const closed = await request(app())
      .get(`/api/companies/${seed.companyId}/crm-sync/conflicts?status=resolved`).expect(200);
    expect(closed.body.items.map((row: { id: string }) => row.id)).toEqual([first!.id]);
    const audit = await db.select().from(activityLog)
      .where(and(eq(activityLog.entityType, "crm_sync_conflict"), eq(activityLog.entityId, first!.id)));
    expect(audit.map((row) => row.action)).toEqual(["crm_sync.conflict_resolved"]);
  });

  it("lists the external ids held by a case and its contacts", async () => {
    const seed = await seedCompany();
    const [stage] = await db.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, seed.pipelineId));
    const [caseRow] = await db.insert(pipelineCases).values({
      companyId: seed.companyId,
      pipelineId: seed.pipelineId,
      stageId: stage!.id,
      caseKey: "c-1",
      title: "Acme",
    }).returning();
    const [contact] = await db.insert(pipelineCaseContacts).values({
      companyId: seed.companyId,
      caseId: caseRow!.id,
      name: "Ada",
    }).returning();
    await db.insert(crmSyncRecordLinks).values([
      { companyId: seed.companyId, entityKind: "case", entityId: caseRow!.id, connectionId: seed.connectionId, providerKey: "pipedrive", externalId: "500" },
      { companyId: seed.companyId, entityKind: "contact", entityId: contact!.id, connectionId: seed.connectionId, providerKey: "pipedrive", externalId: "p-9" },
    ]);
    const links = await request(app()).get(`/api/cases/${caseRow!.id}/crm-sync/links`).expect(200);
    // Both links share one insert time, so their order is not fixed.
    expect(links.body.map((row: { entityKind: string; externalId: string }) => [row.entityKind, row.externalId]).sort()).toEqual([
      ["case", "500"],
      ["contact", "p-9"],
    ]);
  });

  it("is off while enablePipelines is off", async () => {
    const seed = await seedCompany();
    await instanceSettingsService(db).updateExperimental({ enablePipelines: false });
    const res = await request(app()).get(`/api/companies/${seed.companyId}/crm-sync/bindings`).expect(403);
    expect(res.body.details ?? res.body).toMatchObject({ code: "not_entitled" });
  });
});
