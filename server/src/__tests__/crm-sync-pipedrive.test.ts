import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
import {
  createPipedriveClient,
  flattenPipedriveDeal,
  PipedriveRateLimitError,
  type PipedriveFetch,
} from "../services/crm-sync-pipedrive.js";
import { crmSyncRunner, CRM_SYNC_POLL_INTERVAL_MS } from "../services/crm-sync-runner.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { pipelineService } from "../services/pipelines.js";

// Recorded Pipedrive answers. No test here calls Pipedrive.
const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/pipedrive-deals.json", import.meta.url), "utf8"),
) as Record<string, any>;

const PRIORITY_KEY = "8f3a1c2b9d0e4f5a6b7c8d9e0f1a2b3c4d5e6f70";
const NOTES_KEY = "1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e";

type Answer = { status: number; headers?: Record<string, string>; body: unknown };
const ok = (body: unknown): Answer => ({ status: 200, body });

/**
 * Plays recorded answers in order per path, and records every request so a
 * test can prove nothing but GET was sent.
 */
function fakePipedrive(routes: Record<string, Answer[]>) {
  const calls: Array<{ method: string; url: URL; headers: Record<string, string> }> = [];
  const fetch: PipedriveFetch = async (url, init) => {
    const parsed = new URL(url);
    calls.push({ method: init.method, url: parsed, headers: init.headers });
    const queue = routes[parsed.pathname];
    const answer = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
    if (!answer) throw new Error(`No recorded answer for ${parsed.pathname}`);
    const headers = answer.headers ?? {};
    return {
      status: answer.status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      json: async () => structuredClone(answer.body),
    };
  };
  return { fetch, calls };
}

const recorded = (name: string): Answer => {
  const entry = fixtures[name];
  return "status" in entry ? entry : ok(entry);
};

describe("Pipedrive client", () => {
  it("retries a 429 after the wait Pipedrive asks for, then succeeds", async () => {
    const sleeps: number[] = [];
    const { fetch, calls } = fakePipedrive({
      "/api/v1/dealFields": [recorded("rateLimited"), recorded("dealFields")],
    });
    const client = createPipedriveClient({ token: "t", authKind: "api_key", fetch, sleep: async (ms) => { sleeps.push(ms); } });
    const fields = await client.listDealFields();
    expect(fields.map((field) => field.key)).toContain(PRIORITY_KEY);
    expect(sleeps).toEqual([2_000]);
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET"]);
    expect(calls[0]!.headers["x-api-token"]).toBe("t");
    expect(calls[0]!.url.searchParams.has("api_token")).toBe(false);
  });

  it("backs off exponentially without a retry header and gives up after the last try", async () => {
    const sleeps: number[] = [];
    const { fetch } = fakePipedrive({ "/api/v2/deals": [{ status: 429, body: {} }] });
    const client = createPipedriveClient({ token: "t", authKind: "oauth", fetch, sleep: async (ms) => { sleeps.push(ms); } });
    await expect(client.listDealsPage({ pipelineId: "1" })).rejects.toBeInstanceOf(PipedriveRateLimitError);
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
  });

  it("flattens a deal and shows choice fields as their labels", () => {
    const deal = fixtures.firstPassPage1.data[0];
    const flat = flattenPipedriveDeal(deal, fixtures.dealFields.data);
    expect(flat).toMatchObject({ title: "Example Freight renewal", value: 12000, stage_id: 10, [PRIORITY_KEY]: "High" });
    expect(flat[NOTES_KEY]).toBe("Wants a two-year term");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Pipedrive sync tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("Pipedrive read sync", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  // Close to the real clock, because rate-limit waits are read against it.
  const fixedNow = new Date();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-crm-sync-pipedrive-");
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
    instance.use("/api", crmSyncRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function seed() {
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
          { key: "qualified", name: "Qualified", kind: "open", position: 200 },
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
        externalContainerLabel: "Sales pipeline",
        pipelineId,
        direction: "inbound_only",
        stageMap: [
          { externalStageId: "10", stageKey: "lead" },
          { externalStageId: "11", stageKey: "qualified" },
        ],
        fieldMap: [
          { externalField: "title", gsamField: "title", owner: "crm" },
          { externalField: "value", gsamField: "fields.dealValue", owner: "crm" },
          { externalField: PRIORITY_KEY, gsamField: "fields.priority", owner: "crm" },
          { externalField: NOTES_KEY, gsamField: "fields.notes", owner: "shared" },
          { externalField: "expected_close_date", gsamField: "fields.closeDate", owner: "gsam" },
        ],
      })
      .expect(201);
    return { companyId, pipelineId, connectionId: connection.id, bindingId: binding.body.id as string };
  }

  function runner(fetch: PipedriveFetch, sleeps: number[] = []) {
    return crmSyncRunner(db, {
      fetch,
      sleep: async (ms) => { sleeps.push(ms); },
      now: () => fixedNow,
      resolveCredential: async () => "test-token",
    });
  }

  function firstPass() {
    return fakePipedrive({
      "/api/v1/dealFields": [recorded("dealFields")],
      "/api/v2/deals": [recorded("firstPassPage1"), recorded("firstPassPage2")],
    });
  }

  async function casesByKey(pipelineId: string) {
    const rows = await db.select().from(pipelineCases).where(eq(pipelineCases.pipelineId, pipelineId));
    return new Map(rows.map((row) => [row.caseKey, row]));
  }

  async function stageKey(stageId: string) {
    return db.select({ key: pipelineStages.key }).from(pipelineStages).where(eq(pipelineStages.id, stageId)).then((rows) => rows[0]!.key);
  }

  async function events(bindingId: string) {
    return db.select().from(crmSyncEvents).where(eq(crmSyncEvents.bindingId, bindingId));
  }

  it("imports deals into cases through the field and stage maps, one log line per change, GET only", async () => {
    const s = await seed();
    const pipedrive = firstPass();
    const result = await runner(pipedrive.fetch).runBindingPass(s.bindingId);
    expect(result).toEqual({ status: "ok", processed: 3, events: 3 });

    const cases = await casesByKey(s.pipelineId);
    expect([...cases.keys()].sort()).toEqual(["pipedrive-101", "pipedrive-102", "pipedrive-104"]);
    const freight = cases.get("pipedrive-101")!;
    expect(freight.title).toBe("Example Freight renewal");
    expect(freight.fields).toEqual({ dealValue: 12000, priority: "High", notes: "Wants a two-year term" });
    expect(await stageKey(freight.stageId)).toBe("lead");
    // Close date is GSAM-owned, so the CRM value is not pulled.
    expect(freight.fields).not.toHaveProperty("closeDate");
    expect(await stageKey(cases.get("pipedrive-102")!.stageId)).toBe("qualified");
    // Stage 12 is not in the stage map: the case starts in the first stage.
    expect(await stageKey(cases.get("pipedrive-104")!.stageId)).toBe("lead");

    const log = await events(s.bindingId);
    expect(log).toHaveLength(3);
    expect(log.every((event) => event.action === "created" && event.direction === "inbound")).toBe(true);
    expect(log.find((event) => event.externalId === "101")!.changedFields).toEqual(expect.arrayContaining([
      { gsamField: "fields.dealValue", from: null, to: 12000 },
      { gsamField: "stage", from: null, to: "lead" },
    ]));
    // Deal 103 is in another Pipedrive pipeline.
    expect(log.some((event) => event.externalId === "103")).toBe(false);

    const links = await db.select().from(crmSyncRecordLinks).where(eq(crmSyncRecordLinks.connectionId, s.connectionId));
    expect(links.map((link) => link.externalId).sort()).toEqual(["101", "102", "104"]);

    expect(pipedrive.calls.every((call) => call.method === "GET")).toBe(true);
    const dealCalls = pipedrive.calls.filter((call) => call.url.pathname === "/api/v2/deals");
    expect(dealCalls[0]!.url.searchParams.get("pipeline_id")).toBe("1");
    expect(dealCalls[0]!.url.searchParams.has("updated_since")).toBe(false);
    expect(dealCalls[1]!.url.searchParams.get("cursor")).toBe("eyJpZCI6MTAyfQ");
    expect(dealCalls[0]!.headers["x-api-token"]).toBe("test-token");

    const binding = await db.select().from(crmSyncBindings).where(eq(crmSyncBindings.id, s.bindingId)).then((rows) => rows[0]!);
    expect(binding.syncState).toMatchObject({ updatedSince: "2026-10-08T12:00:00Z" });
    expect(binding.lastErrorMessage).toBeNull();
    expect(binding.nextSyncAt?.getTime()).toBe(fixedNow.getTime() + CRM_SYNC_POLL_INTERVAL_MS);
  });

  it("updates changed deals, logs nothing for unchanged ones, queues a conflict and applies its resolution", async () => {
    const s = await seed();
    await runner(firstPass().fetch).runBindingPass(s.bindingId);
    const freight = (await casesByKey(s.pipelineId)).get("pipedrive-101")!;
    // Someone edits the shared notes field in GSAM while the deal changes in Pipedrive.
    await pipelineService(db).patchCaseContent({
      companyId: s.companyId,
      caseId: freight.id,
      fields: { ...freight.fields, notes: "Asked for three years" },
      actor: { type: "user", userId: "sales-rep" },
    });

    const second = fakePipedrive({
      "/api/v1/dealFields": [recorded("dealFields")],
      "/api/v2/deals": [recorded("secondPass")],
    });
    expect(await runner(second.fetch).runBindingPass(s.bindingId)).toEqual({ status: "ok", processed: 2, events: 1 });
    expect(second.calls.find((call) => call.url.pathname === "/api/v2/deals")!.url.searchParams.get("updated_since"))
      .toBe("2026-10-08T12:00:00Z");

    const updated = (await casesByKey(s.pipelineId)).get("pipedrive-101")!;
    expect(updated.fields).toMatchObject({ dealValue: 15000, notes: "Asked for three years" });
    expect(await stageKey(updated.stageId)).toBe("qualified");

    const log = (await events(s.bindingId)).filter((event) => event.action !== "created");
    expect(log).toHaveLength(1); // deal 104 did not change: no line
    expect(log[0]).toMatchObject({ action: "conflict", externalId: "101", entityId: freight.id });
    expect(log[0]!.changedFields).toEqual(expect.arrayContaining([
      { gsamField: "fields.dealValue", from: 12000, to: 15000 },
      { gsamField: "stage", from: "lead", to: "qualified" },
    ]));
    const conflict = await db.select().from(crmSyncConflicts).where(eq(crmSyncConflicts.id, log[0]!.conflictId!)).then((rows) => rows[0]!);
    expect(conflict).toMatchObject({
      status: "open",
      gsamField: "fields.notes",
      lastSyncedValue: { value: "Wants a two-year term" },
      crmValue: { value: "Signed for two years" },
      gsamValue: { value: "Asked for three years" },
      kind: "conflict",
      gsamChangedBy: [{ actorType: "user", userId: "sales-rep" }],
    });
    expect(conflict.crmChangedAt).not.toBeNull();

    await request(app()).post(`/api/crm-sync/conflicts/${conflict.id}/resolve`).send({ resolution: "keep_crm" }).expect(200);
    const third = fakePipedrive({
      "/api/v1/dealFields": [recorded("dealFields")],
      "/api/v2/deals": [ok({ ...fixtures.secondPass, data: [fixtures.secondPass.data[1]] })],
    });
    const later = crmSyncRunner(db, {
      fetch: third.fetch,
      now: () => new Date(Date.now() + 60_000),
      resolveCredential: async () => "test-token",
    });
    expect(await later.runBindingPass(s.bindingId)).toMatchObject({ status: "ok", events: 1 });
    const resolved = (await casesByKey(s.pipelineId)).get("pipedrive-101")!;
    expect(resolved.fields).toMatchObject({ notes: "Signed for two years" });
    const lines = await db.select().from(crmSyncEvents)
      .where(and(eq(crmSyncEvents.bindingId, s.bindingId), eq(crmSyncEvents.action, "updated")));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.changedFields).toEqual([{ gsamField: "fields.notes", from: "Asked for three years", to: "Signed for two years" }]);
  });

  it("logs a failed line with the reason when a deal value does not fit the typed field", async () => {
    const s = await seed();
    const badDeal = { ...fixtures.firstPassPage1.data[0], id: 900, value: { value: "lots", currency: "GBP" } };
    const pipedrive = fakePipedrive({
      "/api/v1/dealFields": [recorded("dealFields")],
      "/api/v2/deals": [ok({ success: true, data: [badDeal], additional_data: { next_cursor: null } })],
    });
    expect(await runner(pipedrive.fetch).runBindingPass(s.bindingId)).toMatchObject({ status: "ok", events: 1 });
    const [line] = await events(s.bindingId);
    expect(line).toMatchObject({ action: "failed", externalId: "900", entityId: null });
    expect(line!.errorMessage).toContain("Deal value");
    expect((await casesByKey(s.pipelineId)).size).toBe(0);
  });

  it("backs off on 429, keeps the binding active and shows the wait on the case", async () => {
    const s = await seed();
    await runner(firstPass().fetch).runBindingPass(s.bindingId);
    const freight = (await casesByKey(s.pipelineId)).get("pipedrive-101")!;

    const sleeps: number[] = [];
    const limited = fakePipedrive({ "/api/v1/dealFields": [recorded("rateLimited")] });
    const result = await runner(limited.fetch, sleeps).runBindingPass(s.bindingId);
    expect(result.status).toBe("rate_limited");
    expect(sleeps).toEqual([2_000, 2_000, 2_000]); // retried 3 times with back-off before giving up
    expect(limited.calls).toHaveLength(4);

    const binding = await db.select().from(crmSyncBindings).where(eq(crmSyncBindings.id, s.bindingId)).then((rows) => rows[0]!);
    expect(binding.status).toBe("active");
    expect(binding.nextSyncAt!.getTime()).toBe(fixedNow.getTime() + CRM_SYNC_POLL_INTERVAL_MS);
    expect(binding.lastErrorMessage).toBe("Pipedrive rate limit reached. Sync retries in 5 min.");
    // Progress from the earlier pass is kept.
    expect(binding.syncState).toMatchObject({ updatedSince: "2026-10-08T12:00:00Z", consecutiveFailures: 1 });

    // A second 429 in a row waits twice as long.
    await runner(fakePipedrive({ "/api/v1/dealFields": [recorded("rateLimited")] }).fetch).runBindingPass(s.bindingId);
    const again = await db.select().from(crmSyncBindings).where(eq(crmSyncBindings.id, s.bindingId)).then((rows) => rows[0]!);
    expect(again.nextSyncAt!.getTime()).toBe(fixedNow.getTime() + 2 * CRM_SYNC_POLL_INTERVAL_MS);

    const status = await request(app()).get(`/api/cases/${freight.id}/crm-sync/status`).expect(200);
    expect(status.body.sources).toHaveLength(1);
    expect(status.body.sources[0]).toMatchObject({
      bindingId: s.bindingId,
      providerKey: "pipedrive",
      externalId: "101",
      bindingStatus: "active",
      lastErrorMessage: "Pipedrive rate limit reached. Sync retries in 10 min.",
      lastEvent: { action: "created", externalId: "101" },
    });
    expect(status.body.sources[0].rateLimitedUntil).toBe(again.nextSyncAt!.toISOString());

    // A good pass clears the wait.
    const recovered = fakePipedrive({
      "/api/v1/dealFields": [recorded("dealFields")],
      "/api/v2/deals": [ok({ success: true, data: [], additional_data: { next_cursor: null } })],
    });
    await crmSyncRunner(db, { fetch: recovered.fetch, resolveCredential: async () => "test-token" }).runBindingPass(s.bindingId);
    const cleared = await request(app()).get(`/api/cases/${freight.id}/crm-sync/status`).expect(200);
    expect(cleared.body.sources[0]).toMatchObject({ lastErrorMessage: null, rateLimitedUntil: null });
  });

  it("stops polling and says what to do when Pipedrive refuses the credential", async () => {
    const s = await seed();
    const result = await runner(fakePipedrive({ "/api/v1/dealFields": [recorded("unauthorized")] }).fetch).runBindingPass(s.bindingId);
    expect(result.status).toBe("failed");
    const binding = await db.select().from(crmSyncBindings).where(eq(crmSyncBindings.id, s.bindingId)).then((rows) => rows[0]!);
    expect(binding.status).toBe("error");
    expect(binding.nextSyncAt).toBeNull();
    expect(binding.lastErrorMessage).toContain("Reconnect Pipedrive");
  });

  it("runs due bindings once, claims them, and does nothing while pipelines are off", async () => {
    const s = await seed();
    const sync = runner(firstPass().fetch);
    const first = await sync.runDuePasses();
    expect(first).toEqual([{ bindingId: s.bindingId, result: { status: "ok", processed: 3, events: 3 } }]);
    expect(await sync.runDuePasses()).toEqual([]); // next run is 5 minutes out

    await db.update(crmSyncBindings).set({ nextSyncAt: null }).where(eq(crmSyncBindings.id, s.bindingId));
    await instanceSettingsService(db).updateExperimental({ enablePipelines: false });
    expect(await sync.runDuePasses()).toEqual([]);
  });

  it("POST sync queues a pass for board users only, waits out a rate limit, and refuses outbound on an inbound-only binding", async () => {
    const s = await seed();
    const queued = await request(app()).post(`/api/crm-sync/bindings/${s.bindingId}/sync`).send({}).expect(202);
    expect(queued.body.bindingId).toBe(s.bindingId);
    const audit = await db.select().from(activityLog).where(eq(activityLog.action, "crm_sync.run_queued"));
    expect(audit).toHaveLength(1);

    const refused = await request(app()).post(`/api/crm-sync/bindings/${s.bindingId}/sync`).send({ direction: "outbound" }).expect(422);
    expect(refused.body.details).toMatchObject({ code: "direction_not_allowed" });
    await request(app({
      type: "agent",
      agentId: randomUUID(),
      companyId: s.companyId,
      runId: randomUUID(),
    } as Express.Request["actor"])).post(`/api/crm-sync/bindings/${s.bindingId}/sync`).send({}).expect(403);

    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    await db.update(crmSyncBindings).set({ syncState: { rateLimitedUntil: until } }).where(eq(crmSyncBindings.id, s.bindingId));
    const waiting = await request(app()).post(`/api/crm-sync/bindings/${s.bindingId}/sync`).send({}).expect(202);
    expect(waiting.body.nextSyncAt).toBe(until);
    const binding = await request(app()).get(`/api/crm-sync/bindings/${s.bindingId}`).expect(200);
    expect(binding.body).toMatchObject({ rateLimitedUntil: until, nextSyncAt: until });

    await request(app()).patch(`/api/crm-sync/bindings/${s.bindingId}`).send({ status: "paused" }).expect(200);
    await request(app()).post(`/api/crm-sync/bindings/${s.bindingId}/sync`).send({}).expect(409);
  });

  it("answers 404 for another company's case status", async () => {
    const s = await seed();
    await runner(firstPass().fetch).runBindingPass(s.bindingId);
    const freight = (await casesByKey(s.pipelineId)).get("pipedrive-101")!;
    const outsider = {
      type: "board",
      userId: "outsider",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [randomUUID()],
    } as Express.Request["actor"];
    await request(app(outsider)).get(`/api/cases/${freight.id}/crm-sync/status`).expect(404);
  });
});
