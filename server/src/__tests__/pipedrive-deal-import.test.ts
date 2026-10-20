import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assets,
  crmFiles,
  pipelineCaseEvidence,
  crmDealProducts,
  crmProducts,
  crmTimelineEntries,
  activityLog,
  companies,
  companyMemberships,
  createDb,
  instanceSettings,
  organisationContacts,
  organisations,
  pipelineCaseContacts,
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
import type { StorageService } from "../storage/types.js";
import { pipedriveRecordFields } from "../services/pipedrive-record-fields.js";
import {
  coerceForField,
  gsamKeyForCustomField,
  pipedriveDealFieldSpecs,
} from "../services/pipedrive-deal-import.js";
import { mapPipedriveDealProduct, summariseDealProducts } from "../services/pipedrive-product-import.js";

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
  "/api/v1/deals/701/flow": { 0: recorded.dealFlow701 },
  "/api/v1/deals/702/flow": { 0: recorded.dealFlow702 },
  "/api/v1/deals/703/flow": { 0: recorded.dealFlowEmpty },
  "/api/v1/productFields": { 0: recorded.productFields },
  "/api/v1/products": { 0: recorded.productsPage },
  "/api/v1/deals/701/products": { 0: recorded.dealProducts701 },
  "/api/v1/deals/702/products": { 0: recorded.dealProducts702 },
  "/api/v1/deals/701/participants": { 0: recorded.dealParticipants701 },
  "/api/v1/deals/701/followers": { 0: recorded.dealFollowers701 },
  "/api/v1/deals/702/followers": { 0: recorded.dealFollowers702 },
  "/api/v1/leadLabels": { 0: recorded.leadLabels },
  "/api/v1/leads": { 0: recorded.leadsPage },
  "/api/v1/files": { 0: recorded.filesPage },
  "/api/v1/files/6001/download": { 0: { file: "%PDF-1.4 order form\n", contentType: "application/pdf" } },
  "/api/v1/files/6002/download": { 0: { file: "PNGBYTES", contentType: "image/png" } },
  "/api/v1/files/6005/download": { 0: { file: "Asked re SSO", contentType: "text/plain; charset=utf-8" } },
});

/** Storage held in memory, so file copies can be checked and served. */
function memoryStorage() {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const storage: StorageService = {
    provider: "local_disk",
    async putFile(input) {
      const objectKey = `${input.namespace}/${randomUUID()}`;
      objects.set(`${input.companyId}:${objectKey}`, { body: input.body, contentType: input.contentType });
      return {
        provider: "local_disk",
        objectKey,
        contentType: input.contentType,
        byteSize: input.body.length,
        sha256: createHash("sha256").update(input.body).digest("hex"),
        originalFilename: input.originalFilename,
      };
    },
    async getObject(companyId, objectKey) {
      const object = objects.get(`${companyId}:${objectKey}`)!;
      return { stream: Readable.from(object.body), contentType: object.contentType, contentLength: object.body.length };
    },
    async headObject(companyId, objectKey) {
      return { exists: objects.has(`${companyId}:${objectKey}`) };
    },
    async deleteObject(companyId, objectKey) {
      objects.delete(`${companyId}:${objectKey}`);
    },
  };
  return { storage, objects };
}

function fakePipedrive(pages: () => Pages) {
  const calls: Array<{ method: string; url: string }> = [];
  const fetch: PipedriveFetch = async (url, init) => {
    calls.push({ method: init.method, url });
    const parsed = new URL(url);
    const body = pages()[parsed.pathname]?.[Number(parsed.searchParams.get("start") ?? 0)];
    if (body && typeof body.file === "string") {
      const bytes = Buffer.from(body.file);
      return {
        status: 200,
        headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? body.contentType : null) },
        json: async () => null,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    }
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
  it("lists a deal's products with quantity, price, discount and total", () => {
    const items = recorded.dealProducts701.data.map((item: Record<string, unknown>, index: number) => mapPipedriveDealProduct(item, index)!);
    expect(items[0]).toMatchObject({ externalId: "9101", productExternalId: "801", quantity: 20, discount: 10, discountType: "percentage", sum: 10800 });
    expect(items[1]).toMatchObject({ discount: 200, discountType: "amount" });
    expect(summariseDealProducts(items)).toBe([
      "20 x Team seat at 600 GBP, 10% off: 10,800 GBP (Annual, billed upfront)",
      "1 x Onboarding workshop at 1,500 GBP, 200 GBP off: 1,300 GBP",
      "Total: 12,100 GBP",
    ].join("\n"));
    // A zero discount from an older account is no discount.
    const older = mapPipedriveDealProduct(recorded.dealProducts702.data[0], 0)!;
    expect(older).toMatchObject({ discount: null, discountType: null });
    expect(summariseDealProducts([older])).toBe("40 x Team seat at 750 USD: 30,000 USD");
    expect(summariseDealProducts([])).toBeNull();
  });

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
  });

  beforeEach(async () => {
    await instanceSettingsService(db).updateExperimental({ enablePipelines: true });
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(crmTimelineEntries);
    await db.delete(crmFiles);
    await db.delete(pipelines);
    await db.delete(assets);
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

  function app(actor: Express.Request["actor"], fetch: PipedriveFetch, storage?: StorageService) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", organisationRoutes(db, { pipedriveFetch: fetch, resolveCredential: async () => "test-token", storage }));
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
      .select({ id: pipelineCases.id, caseKey: pipelineCases.caseKey, title: pipelineCases.title, fields: pipelineCases.fields, stageKey: pipelineStages.key, pipelineKey: pipelines.key, organisationId: pipelineCases.organisationId })
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
      ["pipedrive-leads", "Pipedrive leads"],
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
    // Every card names an organisation (GRE-1538): a deal with none in Pipedrive is filed under its title.
    const cedar = await db.select().from(organisations).where(eq(organisations.id, cases.get("pipedrive-703")!.organisationId!)).then((rows) => rows[0]!);
    expect(cedar).toMatchObject({ companyId, name: "Cedar Lane discovery" });
    expect([...cases.values()].every((row) => row.organisationId)).toBe(true);
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
    // Three deal cases plus the two leads.
    expect(await db.select().from(pipelineCases).where(eq(pipelineCases.companyId, companyId))).toHaveLength(5);
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
    // Deal history: one email, the stage and status changes, and the value change.
    expect(first.body.emails).toEqual({ created: 1, updated: 0, skipped: 0, errors: 0 });
    expect(first.body.stageChanges).toEqual({ created: 3, updated: 0, skipped: 0, errors: 0 });
    expect(pipedrive.calls.every((call) => call.method === "GET")).toBe(true);
    expect(pipedrive.calls.some((call) => call.url.includes("/v1/activities") && call.url.includes("user_id=0"))).toBe(true);

    const northwind = await db.select().from(organisations)
      .where(and(eq(organisations.companyId, companyId), eq(organisations.externalId, "101")))
      .then((rows) => rows[0]!);
    const history = await request(app(actor, pipedrive.fetch)).get(`/api/companies/${companyId}/organisations/${northwind.id}/history`);
    expect(history.status).toBe(200);
    const timeline = history.body.timeline as Array<Record<string, unknown>>;
    // The demo (org, person and deal), the planned check-in (deal only) and the note (org only).
    expect(timeline.slice(0, 4).map((entry) => entry.subject ?? entry.kind)).toEqual([
      "Trial check-in",
      "Re: CLI trial",
      "DevTools demo",
      "note",
    ]);
    // The stage move and the value change at the same moment, in either order.
    expect(timeline.slice(4).map((entry) => entry.subject).sort()).toEqual(["Stage: Signed up → Trial", "Value: 10000 → 12000"]);
    expect(timeline.find((entry) => entry.kind === "field_change")).toMatchObject({
      activityType: "value",
      ownerName: "Ama Owusu",
      caseTitle: "Northwind CLI trial",
      details: expect.objectContaining({ field: "value", from: "10000", to: "12000" }),
    });
    expect(timeline[1]).toMatchObject({
      kind: "email",
      body: "Thanks, the team & I loved the demo.",
      caseTitle: "Northwind CLI trial",
      details: { from: ["Esi Boateng <esi@northwind.example>"], to: ["Ama Owusu <ama@greatstone.example>"], threadId: "4401" },
    });
    expect(timeline.find((entry) => entry.kind === "stage_change")).toMatchObject({ kind: "stage_change", ownerName: "Ama Owusu", details: expect.objectContaining({ from: "Signed up", to: "Trial" }) });
    expect(timeline[2]).toMatchObject({
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
    expect(timeline[3]).toMatchObject({ kind: "note", body: "Wants a trial licence\nfor 25 seats.", details: { pinned: true } });
    // A planned activity does not count as contact.
    expect(history.body.lastContactAt.startsWith("2099")).toBe(false);

    const blueHarbour = await db.select().from(organisations)
      .where(and(eq(organisations.companyId, companyId), eq(organisations.externalId, "102")))
      .then((rows) => rows[0]!);
    const blue = await request(app(actor, pipedrive.fetch)).get(`/api/companies/${companyId}/organisations/${blueHarbour.id}/history`);
    expect(blue.body.timeline).toEqual([
      expect.objectContaining({
        kind: "call",
        subject: "Intro call",
        durationMinutes: 12,
        contactName: "Tunde Bakare",
        details: expect.objectContaining({ outcome: "connected" }),
      }),
      expect.objectContaining({ kind: "stage_change", subject: "Status: open → won", caseTitle: expect.any(String) }),
    ]);

    // A rerun changes nothing; an edit in Pipedrive updates in place.
    const rerun = await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(rerun.body.activities).toEqual({ created: 0, updated: 0, skipped: 2, errors: 0 });
    expect(rerun.body.notes).toEqual({ created: 0, updated: 0, skipped: 2, errors: 0 });
    pages = recordedPages();
    pages["/api/v1/activities"][0].data[1].done = true;
    const third = await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(third.body.activities).toEqual({ created: 0, updated: 1, skipped: 1, errors: 0 });
    expect(rerun.body.emails).toEqual({ created: 0, updated: 0, skipped: 1, errors: 0 });
    expect(rerun.body.stageChanges).toEqual({ created: 0, updated: 0, skipped: 3, errors: 0 });
    expect(await db.select().from(crmTimelineEntries).where(eq(crmTimelineEntries.companyId, companyId))).toHaveLength(8);
  }, 60_000);

  it("brings the product catalogue and each deal's products across, and a rerun updates in place", async () => {
    const { companyId, actor, connectionId } = await seed();
    let pages = recordedPages();
    const pipedrive = fakePipedrive(() => pages);

    const first = await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(first.status).toBe(200);
    expect(first.body.products).toEqual({ created: 2, updated: 0, skipped: 0, errors: 0 });
    expect(first.body.dealProducts).toEqual({ created: 3, updated: 0, skipped: 0, errors: 0 });
    expect(pipedrive.calls.every((call) => call.method === "GET")).toBe(true);
    // A deal with no products is not asked for them.
    expect(pipedrive.calls.some((call) => call.url.includes("/deals/703/products"))).toBe(false);

    const catalogue = await db.select().from(crmProducts).where(eq(crmProducts.companyId, companyId)).orderBy(asc(crmProducts.externalId));
    expect(catalogue[0]).toMatchObject({
      name: "Team seat",
      code: "SEAT-T",
      unit: "seat",
      tax: 20,
      active: true,
      ownerName: "Ama Owusu",
      prices: [
        { currency: "GBP", price: 600, cost: 120, overheadCost: null },
        { currency: "USD", price: 750, cost: 150, overheadCost: 10 },
      ],
    });
    expect(catalogue[0]!.fields).toEqual([
      { key: "category", label: "Category", value: "Licences" },
      { key: "billing_frequency", label: "Billing frequency", value: "annually" },
      { key: "9ab2c3d4e5f60718293a4b5c6d7e8f9012345678", label: "SKU family", value: "DevTools" },
    ]);
    expect(catalogue[1]).toMatchObject({ name: "Onboarding workshop", active: false, ownerName: "Kofi Mensah" });

    const cases = await casesByKey(companyId);
    expect(cases.get("pipedrive-701")!.fields).toMatchObject({
      dealProducts: expect.stringContaining("20 x Team seat at 600 GBP, 10% off: 10,800 GBP"),
    });
    expect(cases.get("pipedrive-703")!.fields).not.toHaveProperty("dealProducts");
    const lines = await db.select().from(crmDealProducts).where(eq(crmDealProducts.companyId, companyId)).orderBy(asc(crmDealProducts.externalId));
    expect(lines.map((line) => [line.externalId, line.name, line.quantity, line.sum, line.currency])).toEqual([
      ["9101", "Team seat", 20, 10800, "GBP"],
      ["9102", "Onboarding workshop", 1, 1300, "GBP"],
      ["9201", "Team seat", 40, 30000, "USD"],
    ]);
    expect(lines[0]!.productId).toBe(catalogue[0]!.id);
    expect(lines[0]!.details).toMatchObject({ taxMethod: "exclusive", billingFrequency: "annually" });

    // The catalogue reads back with the deals each product is on.
    const listed = await request(app(actor, pipedrive.fetch)).get(`/api/companies/${companyId}/crm-products`);
    expect(listed.status).toBe(200);
    expect(listed.body.map((product: { name: string }) => product.name)).toEqual(["Onboarding workshop", "Team seat"]);
    const seat = listed.body.find((product: { name: string }) => product.name === "Team seat");
    expect(seat.prices).toHaveLength(2);
    expect(seat.fields).toContainEqual({ key: "category", label: "Category", value: "Licences" });
    expect(seat.deals.map((deal: { caseId: string; quantity: number; sum: number; currency: string }) => [deal.caseId, deal.quantity, deal.sum, deal.currency]).sort()).toEqual([
      [cases.get("pipedrive-701")!.id, 20, 10800, "GBP"],
      [cases.get("pipedrive-702")!.id, 40, 30000, "USD"],
    ].sort());

    // Same answers again: nothing changes.
    const rerun = await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(rerun.body.products).toEqual({ created: 0, updated: 0, skipped: 2, errors: 0 });
    expect(rerun.body.dealProducts).toEqual({ created: 0, updated: 0, skipped: 3, errors: 0 });
    expect(rerun.body.deals).toEqual({ created: 0, updated: 0, skipped: 4, errors: 0 });

    // A price change and a product taken off a deal both come across.
    pages = recordedPages();
    pages["/api/v1/products"][0].data[1].prices[0].price = 1800;
    pages["/api/v1/deals"][0].data[0].products_count = 1;
    pages["/api/v1/deals/701/products"][0].data.pop();
    const third = await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(third.body.products).toEqual({ created: 0, updated: 1, skipped: 1, errors: 0 });
    expect(third.body.dealProducts).toEqual({ created: 0, updated: 1, skipped: 2, errors: 0 });
    expect(third.body.deals).toEqual({ created: 0, updated: 1, skipped: 3, errors: 0 });
    expect(await db.select().from(crmDealProducts).where(eq(crmDealProducts.companyId, companyId))).toHaveLength(2);
    const after = await casesByKey(companyId);
    expect(after.get("pipedrive-701")!.fields.dealProducts).toBe("20 x Team seat at 600 GBP, 10% off: 10,800 GBP (Annual, billed upfront)");
  }, 60_000);

  it("keeps the people on each deal as case contacts and names its followers", async () => {
    const { companyId, actor, connectionId } = await seed();
    let pages = recordedPages();
    const pipedrive = fakePipedrive(() => pages);

    const first = await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(first.status).toBe(200);
    expect(first.body.participants).toEqual({ created: 3, updated: 0, skipped: 0, errors: 0 });
    expect(pipedrive.calls.every((call) => call.method === "GET")).toBe(true);
    // Deals with nobody on them, or no followers, are not asked.
    expect(pipedrive.calls.some((call) => call.url.includes("/deals/702/participants"))).toBe(false);
    expect(pipedrive.calls.some((call) => call.url.includes("/deals/703/followers"))).toBe(false);

    const cases = await casesByKey(companyId);
    const caseId = cases.get("pipedrive-701")!.id;
    const contactsOf = () => db.select().from(pipelineCaseContacts)
      .where(and(eq(pipelineCaseContacts.companyId, companyId), eq(pipelineCaseContacts.caseId, caseId)))
      .orderBy(asc(pipelineCaseContacts.position));
    // The main contact comes first and uses the imported person's details; a
    // person who was not imported keeps what the deal said about them.
    expect((await contactsOf()).map((row) => [row.name, row.role, row.email, row.phone, row.source, row.externalId])).toEqual([
      ["Esi Boateng", "Main contact, Chief Financial Officer", "esi@example.test", expect.anything(), "pipedrive", "501"],
      ["Tunde Bakare", null, "tunde@example.test", null, "pipedrive", "502"],
      ["Kwame Ofori", null, "kwame@example.test", "+233 24 555 0102", "pipedrive", "599"],
    ]);
    expect(cases.get("pipedrive-701")!.fields).toMatchObject({ dealFollowers: "Ama Owusu, Kofi Mensah" });
    expect(cases.get("pipedrive-702")!.fields).toMatchObject({ dealFollowers: "Kofi Mensah" });
    expect(cases.get("pipedrive-703")!.fields).not.toHaveProperty("dealFollowers");

    // The organisation page shows each deal's people and its filled-in fields.
    const [deal] = await db.select({ organisationId: pipelineCases.organisationId }).from(pipelineCases).where(eq(pipelineCases.id, caseId));
    const history = await request(app(actor, pipedrive.fetch)).get(`/api/companies/${companyId}/organisations/${deal!.organisationId}/history`);
    expect(history.status).toBe(200);
    const onPage = history.body.cases.find((row: { id: string }) => row.id === caseId);
    expect(onPage.people).toEqual([
      { name: "Esi Boateng", role: "Main contact, Chief Financial Officer" },
      { name: "Tunde Bakare", role: null },
      { name: "Kwame Ofori", role: null },
    ]);
    expect(onPage.details).toContainEqual({ key: "dealFollowers", label: "Followers", value: "Ama Owusu, Kofi Mensah" });
    expect(onPage.details.every((field: { value: unknown }) => field.value !== null && field.value !== "")).toBe(true);

    // A contact added by hand in GSAM is left alone by every rerun.
    await db.insert(pipelineCaseContacts).values({ companyId, caseId, name: "Added in GSAM", position: 9 });
    const rerun = await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(rerun.body.participants).toEqual({ created: 0, updated: 0, skipped: 3, errors: 0 });
    expect(rerun.body.deals).toEqual({ created: 0, updated: 0, skipped: 4, errors: 0 });

    // Someone taken off the deal in Pipedrive leaves the case.
    pages = recordedPages();
    pages["/api/v1/deals/701/participants"][0].data.splice(0, 1);
    pages["/api/v1/deals/701/followers"][0].data.pop();
    const third = await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(third.body.participants).toEqual({ created: 0, updated: 2, skipped: 1, errors: 0 });
    expect((await contactsOf()).map((row) => row.name)).toEqual(["Esi Boateng", "Kwame Ofori", "Added in GSAM"]);
    expect((await casesByKey(companyId)).get("pipedrive-701")!.fields.dealFollowers).toBe("Ama Owusu");
  }, 60_000);

  it("brings emails on a person or organisation that are not on a deal, once each", async () => {
    const { companyId, actor, connectionId } = await seed();
    const pages = recordedPages();
    pages["/api/v1/persons"][0].data[0].email_messages_count = 2;
    pages["/api/v1/organizations"][0].data[0].email_messages_count = 2;
    const mail = (id: number, subject: string, extra: Record<string, unknown> = {}) => ({
      object: "mailMessage",
      timestamp: "2026-09-25 10:00:00",
      data: { id, subject, snippet: `${subject} body`, message_time: "2026-09-25 10:00:00", from: [{ email_address: "esi@northwind.example", name: "Esi Boateng" }], to: [], ...extra },
    });
    const page = (data: unknown[]) => ({ success: true, data, additional_data: { pagination: { start: 0, limit: 100, more_items_in_collection: false } } });
    // The deal's email again, one only on the person, and an activity the timeline import already has.
    pages["/api/v1/persons/501/flow"] = { 0: page([
      recorded.dealFlow701.data.find((item: { object: string }) => item.object === "mailMessage"),
      mail(88101, "Invoice address"),
      { object: "activity", data: { id: 1 } },
    ]) };
    // The person's email again, and one only on the organisation.
    pages["/api/v1/organizations/101/flow"] = { 0: page([mail(88101, "Invoice address"), mail(88102, "Board pack")]) };
    const pipedrive = fakePipedrive(() => pages);

    const first = await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(first.status).toBe(200);
    expect(first.body.emails).toEqual({ created: 3, updated: 0, skipped: 0, errors: 0 });
    expect(pipedrive.calls.every((call) => call.method === "GET")).toBe(true);
    // Records with no emails are not asked.
    expect(pipedrive.calls.some((call) => call.url.includes("/persons/502/flow"))).toBe(false);

    const emails = await db.select().from(crmTimelineEntries)
      .where(and(eq(crmTimelineEntries.companyId, companyId), eq(crmTimelineEntries.kind, "email")))
      .orderBy(asc(crmTimelineEntries.externalId));
    const esi = await db.select().from(organisationContacts)
      .where(and(eq(organisationContacts.companyId, companyId), eq(organisationContacts.externalId, "501")))
      .then((rows) => rows[0]!);
    const northwind = await db.select().from(organisations)
      .where(and(eq(organisations.companyId, companyId), eq(organisations.externalId, "101")))
      .then((rows) => rows[0]!);
    expect(emails.map((row) => [row.externalId, row.subject, Boolean(row.caseId), row.contactId, row.organisationId])).toEqual([
      ["88001", "Re: CLI trial", true, null, null],
      ["88101", "Invoice address", false, esi.id, null],
      ["88102", "Board pack", false, null, northwind.id],
    ]);

    const rerun = await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(rerun.body.emails).toEqual({ created: 0, updated: 0, skipped: 3, errors: 0 });
  }, 60_000);

  it("brings the Leads inbox across as cases, links notes to them, and moves converted leads", async () => {
    const { companyId, actor, connectionId } = await seed();
    let pages = recordedPages();
    pages["/api/v1/notes"][0].data.push({ id: 7003, content: "Asked about SSO.", add_time: "2026-10-03 09:00:00", user_id: 9001, lead_id: "adf21080-0e10-11eb-879b-05d71fb426ec" });
    const pipedrive = fakePipedrive(() => pages);

    const first = await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(first.status).toBe(200);
    expect(first.body.leads).toEqual({ created: 2, updated: 0, skipped: 0, errors: 0 });
    expect(pipedrive.calls.every((call) => call.method === "GET")).toBe(true);
    expect(pipedrive.calls.some((call) => call.url.includes("/api/v1/leads") && call.url.includes("archived_status=all"))).toBe(true);

    const blueHarbour = await db.select().from(organisations)
      .where(and(eq(organisations.companyId, companyId), eq(organisations.externalId, "102")))
      .then((rows) => rows[0]!);
    let cases = await casesByKey(companyId);
    const open = cases.get("pipedrive-lead-adf21080-0e10-11eb-879b-05d71fb426ec")!;
    expect(open).toMatchObject({ title: "Tunde Bakare CLI enquiry", pipelineKey: "pipedrive-leads", stageKey: "lead_open", organisationId: blueHarbour.id });
    expect(open.fields).toMatchObject({
      leadValue: 5000,
      leadCurrency: "GBP",
      leadOwner: "Ama Owusu",
      leadCreator: "Kofi Mensah",
      contactPerson: "Tunde Bakare",
      pipedriveOrganisation: "Blue Harbour Energy",
      expectedCloseDate: "2026-11-30",
      leadLabels: ["Hot", "From the SDK docs"],
      leadSource: "Web forms",
      leadSeen: "Yes",
      addedOn: "2026-10-02",
      [PLAN]: "Starter",
    });
    expect(cases.get("pipedrive-lead-bdf21080-0e10-11eb-879b-05d71fb426ec")).toMatchObject({ stageKey: "lead_archived" });
    const note = await db.select().from(crmTimelineEntries)
      .where(and(eq(crmTimelineEntries.companyId, companyId), eq(crmTimelineEntries.externalId, "7003")))
      .then((rows) => rows[0]!);
    const leadCase = await db.select().from(pipelineCases)
      .where(and(eq(pipelineCases.companyId, companyId), eq(pipelineCases.caseKey, "pipedrive-lead-adf21080-0e10-11eb-879b-05d71fb426ec")))
      .then((rows) => rows[0]!);
    expect(note.caseId).toBe(leadCase.id);

    // Same answers again: nothing changes.
    const rerun = await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(rerun.body.leads).toEqual({ created: 0, updated: 0, skipped: 2, errors: 0 });

    // Converted to a deal in Pipedrive: the lead is gone from the list.
    pages = recordedPages();
    pages["/api/v1/leads"][0].data.shift();
    const third = await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(third.body.leads).toEqual({ created: 0, updated: 1, skipped: 1, errors: 0 });
    cases = await casesByKey(companyId);
    expect(cases.get("pipedrive-lead-adf21080-0e10-11eb-879b-05d71fb426ec")).toMatchObject({ stageKey: "lead_closed" });
  }, 60_000);

  it("makes no leads pipeline for an account without leads, and still imports the rest", async () => {
    const { companyId, actor, connectionId } = await seed();
    const pages = recordedPages();
    pages["/api/v1/leads"][0].data = [];
    delete pages["/api/v1/leadLabels"];
    let pipedrive = fakePipedrive(() => pages);
    const denied = await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(denied.status).toBe(200);
    expect(denied.body.leads).toEqual({ created: 0, updated: 0, skipped: 0, errors: 1 });
    expect(denied.body.deals.created).toBe(3);

    pages["/api/v1/leadLabels"] = { 0: recorded.leadLabels };
    pipedrive = fakePipedrive(() => pages);
    const empty = await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(empty.body.leads).toEqual({ created: 0, updated: 0, skipped: 0, errors: 0 });
    const keys = (await db.select().from(pipelines).where(eq(pipelines.companyId, companyId))).map((row) => row.key);
    expect(keys).not.toContain("pipedrive-leads");
  }, 60_000);

  it("copies every file into GSAM, puts deal and lead files on the case, and never copies one twice", async () => {
    const { companyId, actor, connectionId } = await seed();
    const pages = recordedPages();
    const pipedrive = fakePipedrive(() => pages);
    const { storage, objects } = memoryStorage();

    const first = await request(app(actor, pipedrive.fetch, storage)).post(importPath(companyId)).send({ connectionId });
    expect(first.status).toBe(200);
    expect(first.body.files).toEqual({ created: 4, updated: 0, skipped: 1, errors: 0 });
    expect(pipedrive.calls.every((call) => call.method === "GET")).toBe(true);
    // Linked and deleted files are not downloaded.
    expect(pipedrive.calls.filter((call) => call.url.includes("/download")).map((call) => new URL(call.url).pathname).sort()).toEqual([
      "/api/v1/files/6001/download",
      "/api/v1/files/6002/download",
      "/api/v1/files/6005/download",
    ]);
    expect(objects.size).toBe(3);

    const rows = new Map((await db.select().from(crmFiles).where(eq(crmFiles.companyId, companyId))).map((row) => [row.externalId, row]));
    const northwindCase = await db.select().from(pipelineCases)
      .where(and(eq(pipelineCases.companyId, companyId), eq(pipelineCases.caseKey, "pipedrive-701")))
      .then((found) => found[0]!);
    const leadCase = await db.select().from(pipelineCases)
      .where(and(eq(pipelineCases.companyId, companyId), eq(pipelineCases.caseKey, "pipedrive-lead-adf21080-0e10-11eb-879b-05d71fb426ec")))
      .then((found) => found[0]!);
    expect(rows.get("6001")).toMatchObject({ name: "Northwind order form.pdf", contentType: "application/pdf", caseId: northwindCase.id, ownerName: "Ama Owusu", description: "Signed copy" });
    expect(rows.get("6001")!.assetId).toBeTruthy();
    expect(rows.get("6001")!.evidenceId).toBeTruthy();
    expect(rows.get("6002")).toMatchObject({ contentType: "image/png", caseId: null, evidenceId: null });
    expect(rows.get("6002")!.assetId).toBeTruthy();
    expect(rows.get("6003")).toMatchObject({ assetId: null, remoteUrl: "https://docs.google.com/presentation/d/1AbC" });
    expect(rows.get("6003")!.details).toMatchObject({ notCopied: "Linked from googledrive" });
    expect(rows.get("6005")).toMatchObject({ caseId: leadCase.id, contentType: "text/plain" });
    expect(rows.has("6004")).toBe(false);

    // Deal and lead files show on the case's files.
    const evidence = await db.select().from(pipelineCaseEvidence).where(eq(pipelineCaseEvidence.companyId, companyId));
    expect(evidence.map((row) => [row.caseId, row.title, row.kind]).sort()).toEqual([
      [leadCase.id, "Enquiry notes.txt", "upload"],
      [northwindCase.id, "Northwind order form.pdf", "upload"],
    ].sort());

    // The organisation page lists them, and the copy downloads.
    const northwind = await db.select().from(organisations)
      .where(and(eq(organisations.companyId, companyId), eq(organisations.externalId, "101")))
      .then((found) => found[0]!);
    const history = await request(app(actor, pipedrive.fetch, storage)).get(`/api/companies/${companyId}/organisations/${northwind.id}/history`);
    expect(history.status).toBe(200);
    expect(history.body.files.map((file: { name: string }) => file.name)).toEqual(["Northwind order form.pdf", "Proposal deck", "Northwind logo.png"]);
    const order = history.body.files[0];
    expect(order).toMatchObject({ caseTitle: "Northwind CLI trial", contactName: "Esi Boateng", notCopied: null });
    expect(history.body.files[1]).toMatchObject({ contentPath: null, notCopied: "Linked from googledrive" });
    const download = await request(app(actor, pipedrive.fetch, storage)).get(order.contentPath).buffer(true);
    expect(download.status).toBe(200);
    expect(download.headers["content-type"]).toBe("application/pdf");
    expect(download.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.from(download.body).toString()).toBe("%PDF-1.4 order form\n");

    // A rerun downloads nothing again.
    const before = pipedrive.calls.length;
    const rerun = await request(app(actor, pipedrive.fetch, storage)).post(importPath(companyId)).send({ connectionId });
    expect(rerun.body.files).toEqual({ created: 0, updated: 0, skipped: 5, errors: 0 });
    expect(pipedrive.calls.slice(before).some((call) => call.url.includes("/download"))).toBe(false);
    expect(objects.size).toBe(3);
  }, 60_000);

  it("keeps file details when storage is missing or a download fails, and copies it on a later run", async () => {
    const { companyId, actor, connectionId } = await seed();
    const pages = recordedPages();
    delete pages["/api/v1/files/6002/download"];
    const pipedrive = fakePipedrive(() => pages);
    const { storage } = memoryStorage();

    const noStorage = await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(noStorage.body.files).toEqual({ created: 4, updated: 0, skipped: 1, errors: 0 });
    expect(pipedrive.calls.some((call) => call.url.includes("/download"))).toBe(false);
    let logo = await db.select().from(crmFiles).where(and(eq(crmFiles.companyId, companyId), eq(crmFiles.externalId, "6002"))).then((found) => found[0]!);
    expect(logo.details).toMatchObject({ notCopied: "File storage is not available" });

    const withStorage = await request(app(actor, pipedrive.fetch, storage)).post(importPath(companyId)).send({ connectionId });
    expect(withStorage.body.files).toEqual({ created: 0, updated: 3, skipped: 2, errors: 0 });
    expect(withStorage.body.errorSamples).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "file", externalId: "6002" })]));
    logo = await db.select().from(crmFiles).where(and(eq(crmFiles.companyId, companyId), eq(crmFiles.externalId, "6002"))).then((found) => found[0]!);
    expect(logo.assetId).toBeNull();
    expect(logo.details).toMatchObject({ notCopied: "Download failed; the next import tries again" });

    pages["/api/v1/files/6002/download"] = { 0: { file: "PNGBYTES", contentType: "image/png" } };
    const third = await request(app(actor, pipedrive.fetch, storage)).post(importPath(companyId)).send({ connectionId });
    expect(third.body.files.updated).toBe(1);
    logo = await db.select().from(crmFiles).where(and(eq(crmFiles.companyId, companyId), eq(crmFiles.externalId, "6002"))).then((found) => found[0]!);
    expect(logo.assetId).toBeTruthy();
    expect(logo.details).not.toHaveProperty("notCopied");
  }, 60_000);

  it("still imports everything else when the account has no products, keeping what deals had", async () => {
    const { companyId, actor, connectionId } = await seed();
    let pages = recordedPages();
    const pipedrive = fakePipedrive(() => pages);
    await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });

    pages = recordedPages();
    delete pages["/api/v1/products"];
    delete pages["/api/v1/deals/701/products"];
    const res = await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(res.status).toBe(200);
    expect(res.body.products).toEqual({ created: 0, updated: 0, skipped: 0, errors: 1 });
    expect(res.body.deals).toEqual({ created: 0, updated: 0, skipped: 4, errors: 0 });
    expect(res.body.errorSamples).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "product", externalId: "all" }),
      expect.objectContaining({ kind: "product", externalId: "701" }),
    ]));
    // Deal 701's products could not be read this time, so it keeps them.
    expect(await db.select().from(crmDealProducts).where(eq(crmDealProducts.companyId, companyId))).toHaveLength(3);
    const cases = await casesByKey(companyId);
    expect(cases.get("pipedrive-701")!.fields.dealProducts).toEqual(expect.stringContaining("Total: 12,100 GBP"));
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
