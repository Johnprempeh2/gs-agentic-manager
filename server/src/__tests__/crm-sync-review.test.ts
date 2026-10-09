import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  crmSyncBindings,
  crmSyncConflicts,
  crmSyncEvents,
  crmSyncFieldMaps,
  crmSyncRecordLinks,
  heartbeatRuns,
  instanceSettings,
  pipelineCaseEvents,
  pipelineCases,
  pipelineFieldDefinitions,
  pipelineStages,
  pipelineTransitions,
  pipelines,
  principalPermissionGrants,
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
import { crmSyncRunner } from "../services/crm-sync-runner.js";
import {
  buildPipedriveDealPatch,
  PipedriveValueError,
  type PipedriveDealField,
  type PipedriveFetch,
} from "../services/crm-sync-pipedrive.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { pipelineService } from "../services/pipelines.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres CRM sync review tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const PRIORITY_KEY = "8f3a1c2b9d0e4f5a6b7c8d9e0f1a2b3c4d5e6f70";
const NOTES_KEY = "1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e";

const DEAL_FIELDS: PipedriveDealField[] = [
  { key: "title", name: "Title", field_type: "varchar" },
  { key: "value", name: "Value", field_type: "monetary" },
  { key: "expected_close_date", name: "Expected close date", field_type: "date" },
  { key: PRIORITY_KEY, name: "Priority", field_type: "enum", options: [{ id: 7, label: "High" }, { id: 8, label: "Low" }] },
  { key: NOTES_KEY, name: "Notes", field_type: "text" },
];

describe("buildPipedriveDealPatch", () => {
  it("puts custom fields under custom_fields and turns choice labels back into option ids", () => {
    expect(buildPipedriveDealPatch([
      { externalField: "value", value: 15000 },
      { externalField: PRIORITY_KEY, value: "low" },
      { externalField: NOTES_KEY, value: "Three-year term" },
    ], DEAL_FIELDS)).toEqual({
      value: 15000,
      custom_fields: { [PRIORITY_KEY]: 8, [NOTES_KEY]: "Three-year term" },
    });
  });

  it("refuses read-only fields and labels Pipedrive does not have", () => {
    expect(() => buildPipedriveDealPatch([{ externalField: "update_time", value: "x" }], DEAL_FIELDS))
      .toThrow(PipedriveValueError);
    expect(() => buildPipedriveDealPatch([{ externalField: PRIORITY_KEY, value: "Urgent" }], DEAL_FIELDS))
      .toThrow(/not an option/);
  });
});

/**
 * A small Pipedrive that keeps deal state, so a test can change a deal "in
 * Pipedrive" and see what the sync writes back. Records every request.
 */
function fakePipedrive(initial: Array<Record<string, any>>) {
  const deals = new Map<string, Record<string, any>>(initial.map((deal) => [String(deal.id), structuredClone(deal)]));
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const patchFailures: number[] = [];
  let clock = Date.parse("2026-10-08T10:00:00Z");
  const tick = () => new Date((clock += 60_000)).toISOString();
  for (const deal of deals.values()) deal.update_time = tick();

  const answer = (status: number, body: unknown) => ({
    status,
    headers: { get: () => null },
    json: async () => structuredClone(body),
  });

  const fetch: PipedriveFetch = async (url, init) => {
    const parsed = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path: parsed.pathname, body });
    if (parsed.pathname === "/api/v1/dealFields") {
      return answer(200, { success: true, data: DEAL_FIELDS, additional_data: { pagination: { more_items_in_collection: false } } });
    }
    if (parsed.pathname === "/api/v2/deals") {
      const since = parsed.searchParams.get("updated_since");
      const data = [...deals.values()]
        .filter((deal) => !since || deal.update_time > since)
        .sort((a, b) => a.update_time.localeCompare(b.update_time));
      return answer(200, { success: true, data, additional_data: { next_cursor: null } });
    }
    const one = parsed.pathname.match(/^\/api\/v2\/deals\/(\d+)$/);
    if (one) {
      const deal = deals.get(one[1]!);
      if (!deal) return answer(404, { success: false, error: "Deal not found" });
      if (init.method === "GET") return answer(200, { success: true, data: deal });
      if (patchFailures.length > 0) return answer(patchFailures.shift()!, { success: false, error: "Try again" });
      const { custom_fields: custom, ...top } = body as Record<string, any>;
      Object.assign(deal, top);
      deal.custom_fields = { ...deal.custom_fields, ...(custom ?? {}) };
      deal.update_time = tick();
      return answer(200, { success: true, data: deal });
    }
    throw new Error(`No fake answer for ${init.method} ${parsed.pathname}`);
  };

  return {
    fetch,
    calls,
    patches: () => calls.filter((call) => call.method === "PATCH"),
    failNextPatch: (status: number) => patchFailures.push(status),
    /** Someone edits the deal in Pipedrive. */
    edit(dealId: number, change: Record<string, any>) {
      const deal = deals.get(String(dealId))!;
      const { custom_fields: custom, ...top } = change;
      Object.assign(deal, top);
      deal.custom_fields = { ...deal.custom_fields, ...(custom ?? {}) };
      deal.update_time = tick();
    },
    deal: (dealId: number) => deals.get(String(dealId))!,
  };
}

describeEmbeddedPostgres("CRM sync review queue and write-back", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-crm-sync-review-");
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
    await db.delete(pipelineCaseEvents);
    await db.delete(pipelineCases);
    await db.delete(pipelineFieldDefinitions);
    await db.delete(pipelineTransitions);
    await db.delete(pipelineStages);
    await db.delete(pipelines);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const admin: Express.Request["actor"] = {
    type: "board",
    userId: "board-user",
    source: "local_implicit",
    isInstanceAdmin: true,
  };

  function app(actor: Express.Request["actor"] = admin) {
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

  async function seedMember(companyId: string, role: "owner" | "operator") {
    const userId = `user-${randomUUID().slice(0, 8)}`;
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: role,
    });
    const actor = {
      type: "board",
      userId,
      source: "session",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: role, status: "active" }],
      isInstanceAdmin: false,
    } as Express.Request["actor"];
    return { userId, actor };
  }

  async function seedAgent(companyId: string, grants: string[]) {
    const [agent] = await db.insert(agents).values({
      companyId,
      name: `Sales agent ${randomUUID().slice(0, 4)}`,
      role: "engineer",
      adapterType: "codex_local",
    }).returning();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "agent",
      principalId: agent!.id,
      status: "active",
      membershipRole: "member",
    });
    for (const permissionKey of grants) {
      await db.insert(principalPermissionGrants).values({
        companyId,
        principalType: "agent",
        principalId: agent!.id,
        permissionKey,
        scope: null,
      });
    }
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id }).returning();
    const actor = {
      type: "agent",
      agentId: agent!.id,
      companyId,
      runId: run!.id,
      source: "agent_key",
    } as Express.Request["actor"];
    return { agentId: agent!.id, actor };
  }

  async function seed(direction: "both" | "inbound_only" = "both") {
    const [company] = await db.insert(companies).values({
      name: "Greatstone",
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
    for (const field of [
      { key: "dealValue", label: "Deal value", type: "number" },
      { key: "priority", label: "Priority", type: "select", options: ["High", "Low"] },
      { key: "notes", label: "Notes", type: "long_text" },
      { key: "closeDate", label: "Close date", type: "date" },
    ]) {
      await request(app()).post(`/api/pipelines/${pipelineId}/fields`).send(field).expect(201);
    }
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
      transport: "rest_api",
      authKind: "api_key",
      status: "active",
      enabled: true,
    }).returning().then((rows) => rows[0]!);
    const binding = await request(app())
      .post(`/api/companies/${companyId}/crm-sync/bindings`)
      .send({
        connectionId: connection.id,
        providerKey: "pipedrive",
        containerKind: "crm_pipeline",
        externalContainerId: "1",
        pipelineId,
        direction,
        stageMap: [{ externalStageId: "10", stageKey: "lead" }],
        fieldMap: [
          { externalField: "title", gsamField: "title", owner: "crm" },
          { externalField: "value", gsamField: "fields.dealValue", owner: "crm" },
          { externalField: PRIORITY_KEY, gsamField: "fields.priority", owner: "crm" },
          { externalField: NOTES_KEY, gsamField: "fields.notes", owner: "shared" },
          { externalField: "expected_close_date", gsamField: "fields.closeDate", owner: "gsam" },
        ],
      })
      .expect(201);
    const pipedrive = fakePipedrive([{
      id: 101,
      title: "Example Freight renewal",
      value: 12000,
      pipeline_id: 1,
      stage_id: 10,
      expected_close_date: "2026-11-30",
      custom_fields: { [PRIORITY_KEY]: 7, [NOTES_KEY]: "Wants a two-year term" },
    }]);
    const runner = crmSyncRunner(db, { fetch: pipedrive.fetch, resolveCredential: async () => "test-token" });
    expect(await runner.runBindingPass(binding.body.id)).toMatchObject({ status: "ok", processed: 1 });
    const caseRow = await db.select().from(pipelineCases).where(eq(pipelineCases.pipelineId, pipelineId)).then((rows) => rows[0]!);
    return { companyId, pipelineId, bindingId: binding.body.id as string, caseId: caseRow.id, pipedrive, runner };
  }

  async function caseFields(caseId: string) {
    return db.select().from(pipelineCases).where(eq(pipelineCases.id, caseId)).then((rows) => rows[0]!.fields);
  }

  function editInGsam(s: { companyId: string; caseId: string }, fields: Record<string, unknown>, userId: string) {
    return caseFields(s.caseId).then((current) => pipelineService(db).patchCaseContent({
      companyId: s.companyId,
      caseId: s.caseId,
      fields: { ...current, ...fields },
      actor: { type: "user", userId },
    }));
  }

  async function openItem(bindingId: string) {
    return db.select().from(crmSyncConflicts)
      .where(and(eq(crmSyncConflicts.bindingId, bindingId), eq(crmSyncConflicts.status, "open")))
      .then((rows) => rows[0] ?? null);
  }

  async function outboundEvents(bindingId: string) {
    return db.select().from(crmSyncEvents)
      .where(and(eq(crmSyncEvents.bindingId, bindingId), eq(crmSyncEvents.direction, "outbound")));
  }

  /** A shared field (notes) changed in GSAM by `userId` and in Pipedrive, plus a CRM-owned change. */
  async function makeConflict(s: Awaited<ReturnType<typeof seed>>, userId = "sales-rep") {
    await editInGsam(s, { notes: "Asked for three years" }, userId);
    s.pipedrive.edit(101, { value: 15000, custom_fields: { [NOTES_KEY]: "Signed for two years" } });
    await s.runner.runBindingPass(s.bindingId);
    return (await openItem(s.bindingId))!;
  }

  it("writes GSAM-owned and shared field changes back to Pipedrive once, with before and after", async () => {
    const s = await seed();
    // Importing a deal never writes to Pipedrive.
    expect(s.pipedrive.patches()).toHaveLength(0);

    await editInGsam(s, { closeDate: "2026-12-15", notes: "Three-year term" }, "sales-rep");
    expect(await s.runner.runBindingPass(s.bindingId)).toMatchObject({ status: "ok" });

    expect(s.pipedrive.patches()).toEqual([{
      method: "PATCH",
      path: "/api/v2/deals/101",
      body: { expected_close_date: "2026-12-15", custom_fields: { [NOTES_KEY]: "Three-year term" } },
    }]);
    expect(s.pipedrive.deal(101)).toMatchObject({ expected_close_date: "2026-12-15" });
    const [line] = await outboundEvents(s.bindingId);
    expect(line).toMatchObject({ action: "updated", externalId: "101", entityId: s.caseId });
    expect(line!.changedFields).toEqual(expect.arrayContaining([
      { gsamField: "fields.closeDate", from: "2026-11-30", to: "2026-12-15" },
      { gsamField: "fields.notes", from: "Wants a two-year term", to: "Three-year term" },
    ]));

    // The write-back shows up as a Pipedrive change on the next pass; nothing more is sent or logged.
    const before = (await db.select().from(crmSyncEvents).where(eq(crmSyncEvents.bindingId, s.bindingId))).length;
    await s.runner.runBindingPass(s.bindingId);
    expect(s.pipedrive.patches()).toHaveLength(1);
    expect((await db.select().from(crmSyncEvents).where(eq(crmSyncEvents.bindingId, s.bindingId))).length).toBe(before);
  });

  it("never writes back on an inbound-only binding", async () => {
    const s = await seed("inbound_only");
    await editInGsam(s, { closeDate: "2026-12-15" }, "sales-rep");
    s.pipedrive.edit(101, { title: "Example Freight renewal 2027" });
    await s.runner.runBindingPass(s.bindingId);
    expect(s.pipedrive.patches()).toHaveLength(0);
  });

  it("holds a shared field changed on both sides while other fields keep syncing", async () => {
    const s = await seed();
    const held = await makeConflict(s);
    expect(held).toMatchObject({
      kind: "conflict",
      gsamField: "fields.notes",
      crmValue: { value: "Signed for two years" },
      gsamValue: { value: "Asked for three years" },
      gsamChangedBy: [{ actorType: "user", userId: "sales-rep" }],
    });
    expect(held.gsamChangedAt).not.toBeNull();
    expect(held.crmChangedAt).not.toBeNull();
    // The CRM-owned value still synced in.
    expect(await caseFields(s.caseId)).toMatchObject({ dealValue: 15000, notes: "Asked for three years" });

    // Both sides change again: the held field moves neither way, the others still sync.
    s.pipedrive.edit(101, { value: 16000, custom_fields: { [NOTES_KEY]: "Signed for one year" } });
    await editInGsam(s, { closeDate: "2026-12-01" }, "sales-rep");
    await s.runner.runBindingPass(s.bindingId);
    expect(await caseFields(s.caseId)).toMatchObject({ dealValue: 16000, notes: "Asked for three years" });
    const sent = s.pipedrive.patches().map((call) => call.body);
    expect(sent).toEqual([{ expected_close_date: "2026-12-01" }]);
    expect(await db.select().from(crmSyncConflicts).where(eq(crmSyncConflicts.bindingId, s.bindingId))).toHaveLength(1);

    const queue = await request(app()).get(`/api/companies/${s.companyId}/crm-sync/conflicts`).expect(200);
    expect(queue.body.items).toHaveLength(1);
    expect(queue.body.items[0]).toMatchObject({ kind: "conflict", gsamChangedBy: [{ actorType: "user", userId: "sales-rep" }], proposal: null });
  });

  it("nobody resolves a conflict that holds only their own change; someone else's decision syncs both ways", async () => {
    const s = await seed();
    const rep = await seedMember(s.companyId, "owner");
    const held = await makeConflict(s, rep.userId);

    const own = await request(app(rep.actor))
      .post(`/api/crm-sync/conflicts/${held.id}/resolve`)
      .send({ resolution: "keep_gsam" })
      .expect(403);
    expect(own.body.details).toMatchObject({ code: "own_change" });
    await request(app(rep.actor)).post(`/api/crm-sync/conflicts/${held.id}/dismiss`).send({}).expect(403);

    // An operator (Work cases) is not enough to decide.
    const operator = await seedMember(s.companyId, "operator");
    await request(app(operator.actor))
      .post(`/api/crm-sync/conflicts/${held.id}/resolve`)
      .send({ resolution: "keep_gsam" })
      .expect(403);

    await db.update(crmSyncBindings).set({ nextSyncAt: new Date(Date.now() + 3_600_000) }).where(eq(crmSyncBindings.id, s.bindingId));
    const resolved = await request(app())
      .post(`/api/crm-sync/conflicts/${held.id}/resolve`)
      .send({ resolution: "keep_gsam", reason: "Client asked for three years on the call" })
      .expect(200);
    expect(resolved.body).toMatchObject({
      status: "resolved",
      resolution: "keep_gsam",
      resolvedValue: "Asked for three years",
      resolvedByUserId: "board-user",
      decisionReason: "Client asked for three years on the call",
    });
    // A decision brings the next pass forward.
    const binding = await db.select().from(crmSyncBindings).where(eq(crmSyncBindings.id, s.bindingId)).then((rows) => rows[0]!);
    expect(binding.nextSyncAt!.getTime()).toBeLessThanOrEqual(Date.now());

    await s.runner.runBindingPass(s.bindingId);
    expect(s.pipedrive.deal(101).custom_fields[NOTES_KEY]).toBe("Asked for three years");
    expect(await caseFields(s.caseId)).toMatchObject({ notes: "Asked for three years" });
    const [line] = await outboundEvents(s.bindingId);
    expect(line).toMatchObject({ action: "updated", conflictId: held.id });
    expect(line!.changedFields).toEqual([{ gsamField: "fields.notes", from: "Signed for two years", to: "Asked for three years" }]);

    const [audit] = await db.select().from(activityLog).where(eq(activityLog.action, "crm_sync.conflict_resolved"));
    expect(audit).toMatchObject({ actorType: "user", actorId: "board-user" });
    expect(audit!.details).toMatchObject({
      gsamField: "fields.notes",
      before: { lastSynced: "Wants a two-year term", crm: "Signed for two years", gsam: "Asked for three years" },
      after: "Asked for three years",
      reason: "Client asked for three years on the call",
    });

    // The field syncs again afterwards.
    s.pipedrive.edit(101, { custom_fields: { [NOTES_KEY]: "Signed for three years" } });
    await s.runner.runBindingPass(s.bindingId);
    expect(await caseFields(s.caseId)).toMatchObject({ notes: "Signed for three years" });
  });

  it("a typed value is written to both sides", async () => {
    const s = await seed();
    const held = await makeConflict(s);
    await request(app())
      .post(`/api/crm-sync/conflicts/${held.id}/resolve`)
      .send({ resolution: "custom", value: "Two years, option for a third" })
      .expect(200);
    await s.runner.runBindingPass(s.bindingId);
    expect(s.pipedrive.deal(101).custom_fields[NOTES_KEY]).toBe("Two years, option for a third");
    expect(await caseFields(s.caseId)).toMatchObject({ notes: "Two years, option for a third" });
  });

  it("an agent with Work cases proposes with a reason, and only a person accepts", async () => {
    const s = await seed();
    const held = await makeConflict(s);

    const viewer = await seedAgent(s.companyId, []);
    await request(app(viewer.actor))
      .post(`/api/crm-sync/conflicts/${held.id}/propose`)
      .send({ resolution: "keep_crm", reason: "Pipedrive holds the signed contract" })
      .expect(403);

    const worker = await seedAgent(s.companyId, ["pipelines:cases"]);
    await request(app(worker.actor))
      .post(`/api/crm-sync/conflicts/${held.id}/propose`)
      .send({ resolution: "keep_crm" })
      .expect(400); // a reason is required
    const proposed = await request(app(worker.actor))
      .post(`/api/crm-sync/conflicts/${held.id}/propose`)
      .send({ resolution: "keep_crm", reason: "Pipedrive holds the signed contract" })
      .expect(200);
    expect(proposed.body).toMatchObject({
      status: "open",
      proposal: { resolution: "keep_crm", reason: "Pipedrive holds the signed contract", proposedByAgentId: worker.agentId },
    });
    // Proposing changes nothing on either side.
    await s.runner.runBindingPass(s.bindingId);
    expect(await caseFields(s.caseId)).toMatchObject({ notes: "Asked for three years" });

    // Agents never decide.
    await request(app(worker.actor)).post(`/api/crm-sync/conflicts/${held.id}/resolve`).send({ resolution: "keep_crm" }).expect(403);
    await request(app(worker.actor)).post(`/api/crm-sync/conflicts/${held.id}/accept-proposal`).send({}).expect(403);

    const accepted = await request(app()).post(`/api/crm-sync/conflicts/${held.id}/accept-proposal`).send({}).expect(200);
    expect(accepted.body).toMatchObject({
      status: "resolved",
      resolution: "keep_crm",
      resolvedValue: "Signed for two years",
      resolvedByUserId: "board-user",
      decisionReason: "Pipedrive holds the signed contract",
    });
    await s.runner.runBindingPass(s.bindingId);
    expect(await caseFields(s.caseId)).toMatchObject({ notes: "Signed for two years" });

    const log = await db.select().from(activityLog).where(eq(activityLog.entityId, held.id));
    expect(log.find((row) => row.action === "crm_sync.conflict_proposed")).toMatchObject({
      actorType: "agent",
      agentId: worker.agentId,
      details: expect.objectContaining({ reason: "Pipedrive holds the signed contract" }),
    });
    expect(log.find((row) => row.action === "crm_sync.conflict_resolved")!.details).toMatchObject({
      acceptedProposal: { proposedByAgentId: worker.agentId },
      reason: "Pipedrive holds the signed contract",
    });
  });

  it("a suggested change to a CRM-owned field waits for review, then is written to Pipedrive", async () => {
    const s = await seed();
    const worker = await seedAgent(s.companyId, ["pipelines:cases"]);
    const suggest = (body: Record<string, unknown>, actor = worker.actor) =>
      request(app(actor)).post(`/api/cases/${s.caseId}/crm-sync/suggestions`).send(body);

    const viewer = await seedAgent(s.companyId, []);
    await suggest({ gsamField: "fields.dealValue", value: 20000, reason: "Scope grew" }, viewer.actor).expect(403);
    const notOwned = await suggest({ gsamField: "fields.notes", value: "x", reason: "y" }).expect(422);
    expect(notOwned.body.details).toMatchObject({ code: "not_crm_owned", owner: "shared" });
    const same = await suggest({ gsamField: "fields.dealValue", value: 12000, reason: "y" }).expect(422);
    expect(same.body.details).toMatchObject({ code: "no_change" });

    const notANumber = await suggest({ gsamField: "fields.dealValue", value: "lots", reason: "y" }).expect(422);
    expect(notANumber.body.details).toMatchObject({ code: "invalid_value", type: "number" });
    // Typed as text, stored as the field's type.
    const created = await suggest({ gsamField: "fields.dealValue", value: "20000", reason: "Scope grew to three sites" }).expect(201);
    expect(created.body).toMatchObject({
      kind: "suggestion",
      status: "open",
      crmValue: 12000,
      gsamValue: 20000,
      reason: "Scope grew to three sites",
      gsamChangedBy: [{ actorType: "agent", agentId: worker.agentId }],
    });
    const twice = await suggest({ gsamField: "fields.dealValue", value: 21000, reason: "again" }).expect(409);
    expect(twice.body.details).toMatchObject({ code: "field_under_review" });

    // While it waits, nothing is written to Pipedrive and the field is held for this case.
    s.pipedrive.edit(101, { value: 13000, title: "Example Freight renewal 2027" });
    await s.runner.runBindingPass(s.bindingId);
    expect(s.pipedrive.patches()).toHaveLength(0);
    expect(await caseFields(s.caseId)).toMatchObject({ dealValue: 12000 });

    await request(app()).post(`/api/crm-sync/conflicts/${created.body.id}/resolve`).send({ resolution: "keep_gsam" }).expect(200);
    await s.runner.runBindingPass(s.bindingId);
    expect(s.pipedrive.patches().map((call) => call.body)).toEqual([{ value: 20000 }]);
    expect(s.pipedrive.deal(101).value).toBe(20000);
    expect(await caseFields(s.caseId)).toMatchObject({ dealValue: 20000 });

    const [audit] = await db.select().from(activityLog).where(eq(activityLog.action, "crm_sync.change_suggested"));
    expect(audit).toMatchObject({ actorType: "agent", agentId: worker.agentId });
    expect(audit!.details).toMatchObject({ before: 12000, after: 20000, reason: "Scope grew to three sites" });
  });

  it("a person cannot accept their own suggestion but may withdraw it; a rejected suggestion writes nothing", async () => {
    const s = await seed();
    const rep = await seedMember(s.companyId, "owner");
    const created = await request(app(rep.actor))
      .post(`/api/cases/${s.caseId}/crm-sync/suggestions`)
      .send({ gsamField: "fields.priority", value: "Low", reason: "Client paused the project" })
      .expect(201);
    const own = await request(app(rep.actor))
      .post(`/api/crm-sync/conflicts/${created.body.id}/resolve`)
      .send({ resolution: "keep_gsam" })
      .expect(403);
    expect(own.body.details).toMatchObject({ code: "own_change" });
    await request(app(rep.actor)).post(`/api/crm-sync/conflicts/${created.body.id}/dismiss`).send({ reason: "Withdrawn" }).expect(200);

    const again = await request(app(rep.actor))
      .post(`/api/cases/${s.caseId}/crm-sync/suggestions`)
      .send({ gsamField: "fields.priority", value: "Low", reason: "Client paused the project" })
      .expect(201);
    await request(app())
      .post(`/api/crm-sync/conflicts/${again.body.id}/resolve`)
      .send({ resolution: "keep_crm", reason: "Still a priority deal" })
      .expect(200);
    await s.runner.runBindingPass(s.bindingId);
    expect(s.pipedrive.patches()).toHaveLength(0);
    expect(await caseFields(s.caseId)).toMatchObject({ priority: "High" });
  });

  it("logs a failed write-back with the reason and retries it on the next pass", async () => {
    const s = await seed();
    await editInGsam(s, { closeDate: "2026-12-15" }, "sales-rep");
    s.pipedrive.failNextPatch(500);
    await s.runner.runBindingPass(s.bindingId);
    const [failed] = await outboundEvents(s.bindingId);
    expect(failed).toMatchObject({ action: "failed" });
    expect(failed!.errorMessage).toMatch(/Pipedrive answered 500.*tried again on the next pass/);
    expect(s.pipedrive.deal(101).expected_close_date).toBe("2026-11-30");

    await s.runner.runBindingPass(s.bindingId);
    expect(s.pipedrive.deal(101).expected_close_date).toBe("2026-12-15");
    expect((await outboundEvents(s.bindingId)).map((event) => event.action).sort()).toEqual(["failed", "updated"]);
  });
});
