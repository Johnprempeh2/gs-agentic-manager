import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  crmTimelineEntries,
  activityLog,
  companies,
  companyMemberships,
  createDb,
  instanceSettings,
  organisationContacts,
  organisations,
  pipelineCases,
  pipelineFieldDefinitions,
  pipelines,
  pipelineStages,
  toolApplications,
  toolConnections,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { organisationRoutes } from "../routes/organisations.js";
import type { PipedriveDealField, PipedriveFetch } from "../services/crm-sync-pipedrive.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { pipedriveRecordFields } from "../services/pipedrive-record-fields.js";
import {
  coerceForField,
  gsamKeyForCustomField,
  pipedriveDealFieldSpecs,
} from "../services/pipedrive-deal-import.js";

const orgs = JSON.parse(
  readFileSync(new URL("./fixtures/pipedrive-organisations.json", import.meta.url), "utf8"),
) as Record<string, any>;
const recorded = JSON.parse(
  readFileSync(new URL("./fixtures/pipedrive-full-import.json", import.meta.url), "utf8"),
) as Record<string, any>;

const PLAN = gsamKeyForCustomField("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
const SEATS = gsamKeyForCustomField("b1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
const TOOLS = gsamKeyForCustomField("c1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
const ACV = gsamKeyForCustomField("d1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
const TRIAL = gsamKeyForCustomField("e1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
const CSM = gsamKeyForCustomField("f1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
const NOTES = gsamKeyForCustomField("0ab2c3d4e5f60718293a4b5c6d7e8f9012345678");

type Pages = Record<string, any>;
const recordedPages = (): Pages => structuredClone({
  "/api/v1/organizationFields": { 0: orgs.organizationFields },
  "/api/v1/organizations": { 0: orgs.organizationsPage1, 2: orgs.organizationsPage2 },
  "/api/v1/persons": { 0: orgs.personsPage1, 2: orgs.personsPage2 },
  "/api/v1/personFields": { 0: { success: true, data: [] } },
  "/api/v1/pipelines": { 0: recorded.pipelines },
  "/api/v1/stages": { 0: recorded.stages },
  "/api/v1/users": { 0: recorded.users },
  "/api/v1/dealFields": { 0: recorded.dealFields },
  "/api/v1/deals": { 0: recorded.dealsPage1, 2: recorded.dealsPage2 },
  "/api/v1/activities": { 0: recorded.activitiesPage },
  "/api/v1/notes": { 0: recorded.notesPage },
  "/api/v1/callLogs": { 0: recorded.callLogsPage },
});

function fakePipedrive(pages: () => Pages) {
  const calls: Array<{ method: string; url: string }> = [];
  const fetch: PipedriveFetch = async (url, init) => {
    calls.push({ method: init.method, url });
    const parsed = new URL(url);
    const body = pages()[parsed.pathname]?.[Number(parsed.searchParams.get("start") ?? 0)];
    return {
      status: body ? 200 : 404,
      headers: { get: () => null },
      json: async () => body ?? { success: false, error: "not recorded" },
    };
  };
  return { fetch, calls };
}

describe("Pipedrive deal field mapping", () => {
  const lookups = {
    users: new Map([["9001", "Ama Owusu"], ["9002", "Kofi Mensah"]]),
    stageNames: new Map([["12", "Trial"]]),
  };
  const specs = pipedriveDealFieldSpecs(recorded.dealFields.data as PipedriveDealField[], lookups);
  const deal = recorded.dealsPage1.data[0];
  const read = (key: string) => specs.find((spec) => spec.key === key)!.read(deal);

  it("keeps every custom field as a named, typed field", () => {
    const byKey = new Map(specs.map((spec) => [spec.key, spec]));
    expect(byKey.get(PLAN)).toMatchObject({ label: "DevTools plan", type: "select", options: ["Starter", "Team", "Scale"] });
    expect(byKey.get(SEATS)).toMatchObject({ label: "Seats", type: "number" });
    expect(byKey.get(TOOLS)).toMatchObject({ label: "Tools in use", type: "multi_select" });
    expect(byKey.get(ACV)).toMatchObject({ label: "Annual contract value", type: "number" });
    expect(byKey.get(`${ACV}_currency`)).toMatchObject({ label: "Annual contract value currency", type: "text" });
    expect(byKey.get(TRIAL)).toMatchObject({ type: "date" });
    expect(byKey.get(CSM)).toMatchObject({ type: "text" });
    expect(byKey.get(NOTES)).toMatchObject({ label: "Technical notes", type: "long_text" });
  });

  it("reads choices as labels, users as names and times as dates", () => {
    expect(read(PLAN)).toBe("Team");
    expect(read(SEATS)).toBe(25);
    expect(read(TOOLS)).toEqual(["CLI", "SDK"]);
    expect(read(ACV)).toBe(18000);
    expect(read(`${ACV}_currency`)).toBe("GBP");
    expect(read(CSM)).toBe("Kofi Mensah");
    expect(read("dealLabels")).toEqual(["Hot", "Enterprise"]);
    expect(read("sourceChannel")).toBe("Product sign-up");
    expect(read("dealOwner")).toBe("Ama Owusu");
    expect(read("pipedriveStage")).toBe("Trial");
    expect(read("addedOn")).toBe("2026-09-01");
    expect(read("dealStatus")).toBe("Open");
  });

  it("keeps a choice Pipedrive no longer lists instead of dropping it", () => {
    expect(coerceForField({ type: "select", options: ["Starter"] }, "Legacy")).toEqual({ value: "Legacy", missing: ["Legacy"] });
    expect(coerceForField({ type: "date", options: [] }, "not a date")).toEqual({ value: null, missing: [] });
    expect(coerceForField({ type: "text", options: [] }, "x".repeat(600)).value).toHaveLength(500);
  });
});

const ORG_FIELDS = [
  { key: "name", name: "Name", field_type: "varchar" },
  { key: "owner_id", name: "Owner", field_type: "user" },
  { key: "website", name: "Website", field_type: "varchar" },
  { key: "label_ids", name: "Labels", field_type: "set", options: [{ id: 1, label: "DevTools" }, { id: 2, label: "Partner" }] },
  { key: "address", name: "Address", field_type: "address" },
  { key: "employee_count", name: "Number of employees", field_type: "int" },
  { key: "9a1b2c3d4e5f60718293a4b5c6d7e8f901234567", name: "Signed up via", field_type: "enum", options: [{ id: 7, label: "CLI" }] },
  { key: "8a1b2c3d4e5f60718293a4b5c6d7e8f901234567", name: "Account manager", field_type: "user" },
  { key: "7a1b2c3d4e5f60718293a4b5c6d7e8f901234567", name: "Empty field", field_type: "varchar" },
];

describe("Pipedrive organisation and person fields", () => {
  it("keeps every field with a value under Pipedrive's name, skipping the ones with a column", () => {
    const org = {
      id: 101,
      name: "Northwind Minerals",
      owner_id: { id: 9001, name: "Ama Owusu", value: 9001 },
      website: "northwind.example",
      label_ids: [1, 2],
      address: "1 Harbour Road, Accra, Ghana",
      employee_count: 120,
      "9a1b2c3d4e5f60718293a4b5c6d7e8f901234567": "7",
      "8a1b2c3d4e5f60718293a4b5c6d7e8f901234567": 9002,
      "7a1b2c3d4e5f60718293a4b5c6d7e8f901234567": "",
    };
    const fields = pipedriveRecordFields(org, ORG_FIELDS as PipedriveDealField[], {
      skip: new Set(["id", "name", "owner_id"]),
      users: new Map([["9002", "Kofi Mensah"]]),
    });
    expect(fields).toEqual([
      { key: "website", label: "Website", value: "northwind.example" },
      { key: "label_ids", label: "Labels", value: ["DevTools", "Partner"] },
      { key: "address", label: "Address", value: "1 Harbour Road, Accra, Ghana" },
      { key: "employee_count", label: "Number of employees", value: 120 },
      { key: "9a1b2c3d4e5f60718293a4b5c6d7e8f901234567", label: "Signed up via", value: "CLI" },
      { key: "8a1b2c3d4e5f60718293a4b5c6d7e8f901234567", label: "Account manager", value: "Kofi Mensah" },
    ]);
  });

  it("lists every email and phone with its label", () => {
    const fields = pipedriveRecordFields(
      { email: [{ value: "esi@example.test", label: "work", primary: true }, { value: "esi@home.test", label: "home" }] },
      [{ key: "email", name: "Email", field_type: "varchar" }],
      { skip: new Set() },
    );
    expect(fields).toEqual([{ key: "email", label: "Email", value: "esi@example.test (work), esi@home.test (home)" }]);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

describeEmbeddedPostgres("Pipedrive deal import through the connection", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pipedrive-deals-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    await instanceSettingsService(db).updateExperimental({ enablePipelines: true });
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(crmTimelineEntries);
    await db.delete(pipelines);
    await db.delete(organisations);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: Express.Request["actor"], fetch: PipedriveFetch) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", organisationRoutes(db, { pipedriveFetch: fetch, resolveCredential: async () => "test-token" }));
    instance.use(errorHandler);
    return instance;
  }

  async function seed() {
    const [company] = await db
      .insert(companies)
      .values({ name: "Greatstone", issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}` })
      .returning();
    const companyId = company!.id;
    const userId = `user-${randomUUID().slice(0, 8)}`;
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
    });
    const [application] = await db.insert(toolApplications).values({
      companyId,
      applicationKey: `pipedrive-${randomUUID().slice(0, 8)}`,
      name: "Pipedrive",
      type: "mcp_http",
      status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId,
      applicationId: application!.id,
      name: "Pipedrive",
      uid: `test/${randomUUID()}`,
      transport: "rest_api",
      authKind: "api_key",
      status: "active",
      enabled: true,
    }).returning();
    const actor = {
      type: "board",
      userId,
      source: "session",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: false,
    } as Express.Request["actor"];
    return { companyId, actor, connectionId: connection!.id };
  }

  const importPath = (companyId: string) => `/api/companies/${companyId}/organisations/import/pipedrive`;

  async function casesByKey(companyId: string) {
    const rows = await db
      .select({ caseKey: pipelineCases.caseKey, title: pipelineCases.title, fields: pipelineCases.fields, stageKey: pipelineStages.key, pipelineKey: pipelines.key, organisationId: pipelineCases.organisationId })
      .from(pipelineCases)
      .innerJoin(pipelineStages, eq(pipelineStages.id, pipelineCases.stageId))
      .innerJoin(pipelines, eq(pipelines.id, pipelineCases.pipelineId))
      .where(eq(pipelineCases.companyId, companyId));
    return new Map(rows.map((row) => [row.caseKey, row]));
  }

  it("brings every pipeline, stage and deal across with its fields, and a rerun updates in place", async () => {
    const { companyId, actor, connectionId } = await seed();
    let pages = recordedPages();
    const pipedrive = fakePipedrive(() => pages);

    const first = await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(first.status).toBe(200);
    expect(first.body.pipelines).toEqual({ created: 2, updated: 0, skipped: 0, errors: 0 });
    expect(first.body.deals).toEqual({ created: 3, updated: 0, skipped: 1, errors: 0 });
    // Read only: every call to Pipedrive is a GET.
    expect(pipedrive.calls.every((call) => call.method === "GET")).toBe(true);

    const gsamPipelines = await db.select().from(pipelines).where(eq(pipelines.companyId, companyId)).orderBy(asc(pipelines.key));
    expect(gsamPipelines.map((row) => [row.key, row.name])).toEqual([
      ["pipedrive-1", "DevTools journey"],
      ["pipedrive-2", "DX engagements"],
    ]);
    const devToolsStages = await db.select().from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, gsamPipelines[0]!.id))
      .orderBy(asc(pipelineStages.position));
    expect(devToolsStages.map((stage) => [stage.name, stage.kind])).toEqual([
      ["Signed up", "working"],
      ["Trial", "working"],
      ["Team rollout", "working"],
      ["Won", "done"],
      ["Lost", "cancelled"],
    ]);

    const fieldLabels = await db.select().from(pipelineFieldDefinitions).where(eq(pipelineFieldDefinitions.pipelineId, gsamPipelines[0]!.id));
    expect(fieldLabels.map((field) => field.label)).toEqual(expect.arrayContaining(["DevTools plan", "Seats", "Tools in use", "Lost reason", "Deal status"]));

    const northwind = await db.select().from(organisations)
      .where(and(eq(organisations.companyId, companyId), eq(organisations.externalId, "101")))
      .then((rows) => rows[0]!);
    let cases = await casesByKey(companyId);
    expect(cases.get("pipedrive-701")).toMatchObject({
      title: "Northwind CLI trial",
      pipelineKey: "pipedrive-1",
      stageKey: "pd_12",
      organisationId: northwind.id,
    });
    expect(cases.get("pipedrive-701")!.fields).toMatchObject({
      pipedriveDealId: "701",
      dealValue: 12000,
      dealCurrency: "GBP",
      dealStatus: "Open",
      dealOwner: "Ama Owusu",
      contactPerson: "Esi Boateng",
      expectedCloseDate: "2026-12-01",
      dealLabels: ["Hot", "Enterprise"],
      [PLAN]: "Team",
      [SEATS]: 25,
      [TOOLS]: ["CLI", "SDK"],
      [CSM]: "Kofi Mensah",
      [NOTES]: "Uses the SDK in CI.",
    });
    // Won and lost deals land in Won and Lost, with the lost reason kept.
    expect(cases.get("pipedrive-702")).toMatchObject({ stageKey: "won", pipelineKey: "pipedrive-1" });
    expect(cases.get("pipedrive-702")!.fields).toMatchObject({ dealOwner: "Kofi Mensah", wonOn: "2026-08-30", [PLAN]: "99" });
    expect(cases.get("pipedrive-703")).toMatchObject({ stageKey: "lost", pipelineKey: "pipedrive-2" });
    expect(cases.get("pipedrive-703")!.fields).toMatchObject({ lostReason: "Chose an in-house build", lostOn: "2026-07-04" });
    // An option Pipedrive no longer lists is added to the field, not dropped.
    const plan = fieldLabels.find((field) => field.key === PLAN)!;
    const planNow = await db.select().from(pipelineFieldDefinitions).where(eq(pipelineFieldDefinitions.id, plan.id)).then((rows) => rows[0]!);
    expect(planNow.options).toContain("99");

    // Same answers again: nothing changes.
    const rerun = await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(rerun.body.pipelines).toEqual({ created: 0, updated: 0, skipped: 2, errors: 0 });
    expect(rerun.body.deals).toEqual({ created: 0, updated: 0, skipped: 4, errors: 0 });

    // A new stage, a stage move and a field edit in Pipedrive all come across.
    pages = recordedPages();
    pages["/api/v1/stages"][0].data.push({ id: 14, name: "Security review", pipeline_id: 1, order_nr: 4 });
    const deal = pages["/api/v1/deals"][0].data[0];
    deal.stage_id = 14;
    deal["b1b2c3d4e5f60718293a4b5c6d7e8f9012345678"] = 40;
    const third = await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(third.body.pipelines).toEqual({ created: 0, updated: 1, skipped: 1, errors: 0 });
    expect(third.body.deals).toEqual({ created: 0, updated: 1, skipped: 3, errors: 0 });
    cases = await casesByKey(companyId);
    expect(cases.get("pipedrive-701")).toMatchObject({ stageKey: "pd_14" });
    expect(cases.get("pipedrive-701")!.fields).toMatchObject({ [SEATS]: 40 });
    const stagesNow = await db.select().from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, gsamPipelines[0]!.id))
      .orderBy(asc(pipelineStages.position));
    expect(stagesNow.map((stage) => stage.name)).toEqual(["Signed up", "Trial", "Team rollout", "Security review", "Won", "Lost"]);

    // Winning the deal in Pipedrive moves it to Won.
    pages["/api/v1/deals"][0].data[0].status = "won";
    await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    cases = await casesByKey(companyId);
    expect(cases.get("pipedrive-701")).toMatchObject({ stageKey: "won" });
    expect(await db.select().from(pipelineCases).where(eq(pipelineCases.companyId, companyId))).toHaveLength(3);
  }, 60_000);

  it("brings activities, notes and calls across, linked to the organisation, person and deal", async () => {
    const { companyId, actor, connectionId } = await seed();
    let pages = recordedPages();
    const pipedrive = fakePipedrive(() => pages);

    const first = await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(first.status).toBe(200);
    expect(first.body.activities).toEqual({ created: 2, updated: 0, skipped: 0, errors: 0 });
    // The empty note is skipped, not stored.
    expect(first.body.notes).toEqual({ created: 1, updated: 0, skipped: 1, errors: 0 });
    expect(first.body.calls).toEqual({ created: 1, updated: 0, skipped: 0, errors: 0 });
    expect(pipedrive.calls.every((call) => call.method === "GET")).toBe(true);
    expect(pipedrive.calls.some((call) => call.url.includes("/v1/activities") && call.url.includes("user_id=0"))).toBe(true);

    const northwind = await db.select().from(organisations)
      .where(and(eq(organisations.companyId, companyId), eq(organisations.externalId, "101")))
      .then((rows) => rows[0]!);
    const history = await request(app(actor, pipedrive.fetch)).get(`/api/companies/${companyId}/organisations/${northwind.id}/history`);
    expect(history.status).toBe(200);
    const timeline = history.body.timeline as Array<Record<string, unknown>>;
    // The demo (org, person and deal), the planned check-in (deal only) and the note (org only).
    expect(timeline.map((entry) => entry.subject ?? entry.kind)).toEqual(["Trial check-in", "DevTools demo", "note"]);
    expect(timeline[1]).toMatchObject({
      kind: "activity",
      activityType: "meeting",
      body: "Showed the CLI & SDK.",
      occurredAt: "2026-09-20T10:30:00.000Z",
      durationMinutes: 45,
      done: true,
      ownerName: "Ama Owusu",
      contactName: "Esi Boateng",
      caseTitle: "Northwind CLI trial",
      details: expect.objectContaining({ location: "Accra office" }),
    });
    expect(timeline[0]).toMatchObject({ done: false, caseTitle: "Northwind CLI trial", contactName: null });
    expect(timeline[2]).toMatchObject({ kind: "note", body: "Wants a trial licence\nfor 25 seats.", details: { pinned: true } });
    // A planned activity does not count as contact.
    expect(history.body.lastContactAt.startsWith("2099")).toBe(false);

    const blueHarbour = await db.select().from(organisations)
      .where(and(eq(organisations.companyId, companyId), eq(organisations.externalId, "102")))
      .then((rows) => rows[0]!);
    const blue = await request(app(actor, pipedrive.fetch)).get(`/api/companies/${companyId}/organisations/${blueHarbour.id}/history`);
    expect(blue.body.timeline).toEqual([expect.objectContaining({
      kind: "call",
      subject: "Intro call",
      durationMinutes: 12,
      contactName: "Tunde Bakare",
      details: expect.objectContaining({ outcome: "connected" }),
    })]);

    // A rerun changes nothing; an edit in Pipedrive updates in place.
    const rerun = await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(rerun.body.activities).toEqual({ created: 0, updated: 0, skipped: 2, errors: 0 });
    expect(rerun.body.notes).toEqual({ created: 0, updated: 0, skipped: 2, errors: 0 });
    pages = recordedPages();
    pages["/api/v1/activities"][0].data[1].done = true;
    const third = await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(third.body.activities).toEqual({ created: 0, updated: 1, skipped: 1, errors: 0 });
    expect(await db.select().from(crmTimelineEntries).where(eq(crmTimelineEntries.companyId, companyId))).toHaveLength(4);
  }, 60_000);

  it("still imports everything else when the account cannot read call logs", async () => {
    const { companyId, actor, connectionId } = await seed();
    const pages = recordedPages();
    delete pages["/api/v1/callLogs"];
    const pipedrive = fakePipedrive(() => pages);
    const res = await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(res.status).toBe(200);
    expect(res.body.activities.created).toBe(2);
    expect(res.body.calls).toEqual({ created: 0, updated: 0, skipped: 0, errors: 1 });
    expect(res.body.errorSamples).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "call" })]));
  }, 60_000);

  it("keeps every organisation and person field on the record, and a rerun changes nothing", async () => {
    const { companyId, actor, connectionId } = await seed();
    const pages = recordedPages();
    pages["/api/v1/organizationFields"][0] = { success: true, data: [...orgs.organizationFields.data, ...ORG_FIELDS] };
    const northwind = pages["/api/v1/organizations"][0].data[0];
    Object.assign(northwind, { website: "northwind.example", label_ids: [1], "9a1b2c3d4e5f60718293a4b5c6d7e8f901234567": 7 });
    pages["/api/v1/personFields"][0] = {
      success: true,
      data: [{ key: "phone", name: "Phone", field_type: "phone" }, { key: "6a1b2c3d4e5f60718293a4b5c6d7e8f901234567", name: "GitHub handle", field_type: "varchar" }],
    };
    pages["/api/v1/persons"][0].data[0]["6a1b2c3d4e5f60718293a4b5c6d7e8f901234567"] = "esi-b";
    const pipedrive = fakePipedrive(() => pages);

    const first = await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(first.status).toBe(200);
    const detail = await db.select().from(organisations)
      .where(and(eq(organisations.companyId, companyId), eq(organisations.externalId, "101")))
      .then((rows) => rows[0]!);
    expect(detail.website).toBe("https://northwind.example/");
    expect(detail.crmFields).toEqual([
      { key: "website", label: "Website", value: "northwind.example" },
      { key: "label_ids", label: "Labels", value: ["DevTools"] },
      { key: "9a1b2c3d4e5f60718293a4b5c6d7e8f901234567", label: "Signed up via", value: "CLI" },
    ]);
    const esi = await db.select().from(organisationContacts)
      .where(and(eq(organisationContacts.companyId, companyId), eq(organisationContacts.externalId, "501")))
      .then((rows) => rows[0]!);
    expect(esi.crmFields).toEqual(expect.arrayContaining([
      { key: "6a1b2c3d4e5f60718293a4b5c6d7e8f901234567", label: "GitHub handle", value: "esi-b" },
    ]));

    const rerun = await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(rerun.body.organisations.updated).toBe(0);
    expect(rerun.body.contacts.updated).toBe(0);
  }, 60_000);
});
