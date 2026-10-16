import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  companyMemberships,
  createDb,
  instanceSettings,
  organisationContacts,
  organisations,
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
import { organisationRoutes } from "../routes/organisations.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  parseCsv,
  readActivitiesExport,
  readDealsExport,
  readOrganisationsExport,
  readPeopleExport,
} from "../services/pipedrive-export.js";
import { pipelineService } from "../services/pipelines.js";
import {
  hubspotDealStatus,
  readHubspotCompaniesExport,
  readHubspotContactsExport,
  readHubspotDealsExport,
} from "../services/hubspot-export.js";

// Headers as Pipedrive's list view export writes them, with the record type in front.
const ORGS_CSV = [
  "Organization - ID,Organization - Name,Organization - Industry,Organization - Address - Country,Organization - Owner,Organization - Won deals,Organization - Open deals",
  '101,Northwind Minerals,Mining,Ghana,Ama Owusu,1,0',
  '102,"Blue Harbour, Energy",Energy,Nigeria,Ama Owusu,0,0',
  ",No id Ltd,,,,0,0",
].join("\r\n");

const PEOPLE_CSV = [
  "Person - ID,Person - Name,Person - Organization,Person - Job title,Person - Email - Work,Person - Phone - Work",
  '501,Esi Boateng,Northwind Minerals,CFO,"esi@example.test, esi.home@example.test",+233 20 000 0001',
  '502,Tunde Bello,"Blue Harbour, Energy",,tunde@example.test,',
  "503,Nobody Org,Unknown Co,,,",
].join("\n");

// The newer export style: no record type in front of the headers.
const DEALS_CSV = [
  "ID,Title,Organization,Value,Currency of Value,Stage,Status,Expected close date,Owner,Contact person",
  "9001,Northwind audit,Northwind Minerals,\"12,500\",GBP,Proposal made,open,2026-11-30,Ben,Esi Boateng",
  "9002,Blue Harbour retainer,\"Blue Harbour, Energy\",4000,GBP,Qualified,won,,Ben,",
  "9003,Old pitch,Northwind Minerals,1000,GBP,Qualified,lost,,Ben,",
].join("\n");

const ACTIVITIES_CSV = [
  "Activity - Subject,Activity - Type,Activity - Due date,Activity - Done,Activity - Note,Deal - ID",
  "Intro call,call,2026-10-01,Done,\"Went well; wants a proposal\",9001",
  "Send proposal,task,2026-10-20,To do,,9001",
  "Chase invoice,task,2026-10-05,Done,,",
].join("\n");

// Headers as HubSpot's "Export view" writes them.
const HS_COMPANIES_CSV = [
  "Record ID,Company name,Company Domain Name,Industry,Country/Region,Company owner,Lifecycle Stage",
  "3001,Northwind Minerals,northwind.test,MINING_AND_METALS,Ghana,Ama Owusu,customer",
  "3002,Kente Logistics,kente.test,,Ghana,,lead",
].join("\n");

const HS_CONTACTS_CSV = [
  "Record ID,First Name,Last Name,Email,Phone Number,Job Title,Associated Company IDs (Primary),Associated Company (Primary)",
  "4001,Esi,Boateng,esi@example.test,+233 20 000 0001,CFO,3001,Northwind Minerals",
  "4002,,,kofi@example.test,,,,Kente Logistics",
].join("\n");

const HS_DEALS_CSV = [
  "Record ID,Deal Name,Deal Stage,Amount,Close Date,Deal owner,Associated Company IDs (Primary),Associated Company (Primary)",
  "5001,Kente fleet audit,Proposal made,8000,2026-12-01,Ben,,Kente Logistics",
  "5002,Northwind retainer,Closed won,4000,,Ben,3001,Northwind Minerals",
].join("\n");

describe("HubSpot export parsing", () => {
  it("maps companies, contacts and deals from HubSpot headers", () => {
    expect(readHubspotCompaniesExport(HS_COMPANIES_CSV).records[0]).toMatchObject({
      externalId: "3001",
      name: "Northwind Minerals",
      country: "Ghana",
      status: "client",
    });
    const contacts = readHubspotContactsExport(HS_CONTACTS_CSV).records;
    expect(contacts[0]).toMatchObject({ name: "Esi Boateng", organisationExternalId: "3001", role: "CFO" });
    // No name: the email stands in, so the person is not lost.
    expect(contacts[1]).toMatchObject({ name: "kofi@example.test", organisationName: "Kente Logistics" });
    const deals = readHubspotDealsExport(HS_DEALS_CSV).records;
    expect(deals.map((deal) => deal.status)).toEqual(["open", "won"]);
    expect(hubspotDealStatus("closedlost")).toBe("lost");
    expect(() => readHubspotCompaniesExport("Company name\nAcme")).toThrow(/In HubSpot, add the column/);
  });
});

describe("Pipedrive export parsing", () => {
  it("parses quoted commas, doubled quotes, line breaks and semicolons", () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n"multi\nline",z\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["multi\nline", "z"],
    ]);
    expect(parseCsv("﻿Name;Country\r\nAcme;Ghana")).toEqual([["Name", "Country"], ["Acme", "Ghana"]]);
  });

  it("maps organisations and works out status from deal counts", () => {
    const parsed = readOrganisationsExport(ORGS_CSV);
    expect(parsed.skipped).toBe(1);
    expect(parsed.records[0]).toMatchObject({
      externalId: "101",
      name: "Northwind Minerals",
      industry: "Mining",
      country: "Ghana",
      countryOwner: "Ama Owusu",
      status: "client",
    });
    expect(parsed.records[1]).toMatchObject({ name: "Blue Harbour, Energy", status: "target" });
  });

  it("maps people with their organisation name and first email", () => {
    const parsed = readPeopleExport(PEOPLE_CSV);
    expect(parsed.records[0]).toMatchObject({
      externalId: "501",
      organisationExternalId: null,
      organisationName: "Northwind Minerals",
      role: "CFO",
      email: "esi@example.test",
      phone: "+233 20 000 0001",
    });
  });

  it("maps deals from unprefixed headers and activities by deal id", () => {
    const deals = readDealsExport(DEALS_CSV).records;
    expect(deals[0]).toMatchObject({ externalId: "9001", value: 12500, currency: "GBP", stageName: "Proposal made", status: "open" });
    const activities = readActivitiesExport(ACTIVITIES_CSV).records;
    expect(activities[0]).toMatchObject({ subject: "Intro call", done: true, dealExternalId: "9001" });
    expect(activities[1]!.done).toBe(false);
  });

  it("explains a file with no id column", () => {
    expect(() => readOrganisationsExport("Name,Country\nAcme,Ghana")).toThrow(/no ID column/);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Pipedrive export tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("Pipedrive export import route", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pipedrive-export-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    await instanceSettingsService(db).updateExperimental({ enablePipelines: true });
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(pipelineCaseEvents);
    await db.delete(pipelineCases);
    await db.delete(pipelineTransitions);
    await db.delete(pipelineStages);
    await db.delete(pipelines);
    await db.delete(organisationContacts);
    await db.delete(organisations);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: Express.Request["actor"]) {
    const instance = express();
    instance.use(express.json({ limit: "10mb" }));
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", organisationRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function seedCompany() {
    const [company] = await db
      .insert(companies)
      .values({ name: "Greatstone", issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}` })
      .returning();
    return company!.id;
  }

  async function seedMember(companyId: string, role: "owner" | "admin") {
    const userId = `user-${randomUUID().slice(0, 8)}`;
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: role,
    });
    return {
      type: "board",
      userId,
      source: "session",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: role, status: "active" }],
      isInstanceAdmin: false,
    } as Express.Request["actor"];
  }

  async function seedPipeline(companyId: string) {
    return pipelineService(db).createPipeline({
      companyId,
      key: "clients",
      name: "Clients",
      stages: [
        { key: "lead", name: "Lead", kind: "open" },
        { key: "proposal", name: "Proposal made", kind: "working" },
        { key: "won", name: "Won", kind: "done" },
        { key: "lost", name: "Lost", kind: "cancelled" },
      ],
      actor: { type: "system" },
    });
  }

  const importPath = (companyId: string) => `/api/companies/${companyId}/organisations/import/pipedrive-export`;

  it("imports all four files, puts open deals in the pipeline, and a rerun updates instead of duplicating", async () => {
    const companyId = await seedCompany();
    const owner = await seedMember(companyId, "owner");
    const pipeline = await seedPipeline(companyId);
    const body = {
      organisations: ORGS_CSV,
      people: PEOPLE_CSV,
      deals: DEALS_CSV,
      activities: ACTIVITIES_CSV,
      pipelineId: pipeline.id,
    };

    const first = await request(app(owner)).post(importPath(companyId)).send(body);
    expect(first.status).toBe(200);
    expect(first.body.organisations).toEqual({ created: 2, updated: 0, skipped: 1, errors: 0 });
    expect(first.body.contacts).toEqual({ created: 3, updated: 0, skipped: 0, errors: 0 });
    expect(first.body.deals).toEqual({ created: 1, updated: 0, skipped: 2, errors: 0 });
    expect(first.body.activities).toEqual({ created: 2, updated: 0, skipped: 1, errors: 0 });

    const orgs = await db.select().from(organisations).where(eq(organisations.companyId, companyId));
    // The won deal makes Blue Harbour a client even though its own row said no won deals.
    expect(orgs.map((row) => [row.externalId, row.status, row.source]).sort()).toEqual([
      ["101", "client", "pipedrive"],
      ["102", "client", "pipedrive"],
    ]);

    const cases = await db.select().from(pipelineCases).where(eq(pipelineCases.companyId, companyId));
    expect(cases).toHaveLength(1);
    const northwind = orgs.find((row) => row.externalId === "101")!;
    expect(cases[0]).toMatchObject({ caseKey: "pipedrive-9001", title: "Northwind audit", organisationId: northwind.id });
    const stage = await db.select().from(pipelineStages).where(eq(pipelineStages.id, cases[0]!.stageId));
    expect(stage[0]!.key).toBe("proposal");
    expect(cases[0]!.fields).toMatchObject({ dealValue: 12500, dealCurrency: "GBP", pipedriveDealId: "9001" });
    expect((cases[0]!.fields as { pipedriveActivities: Array<{ subject: string }> }).pipedriveActivities.map((a) => a.subject))
      .toEqual(["Send proposal", "Intro call"]);

    const second = await request(app(owner)).post(importPath(companyId)).send(body);
    expect(second.status).toBe(200);
    expect(second.body.organisations).toEqual({ created: 0, updated: 0, skipped: 3, errors: 0 });
    expect(second.body.deals).toEqual({ created: 0, updated: 0, skipped: 3, errors: 0 });
    expect(await db.select().from(pipelineCases).where(eq(pipelineCases.companyId, companyId))).toHaveLength(1);
    expect(await db.select().from(organisationContacts).where(eq(organisationContacts.companyId, companyId))).toHaveLength(3);

    const log = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(log.filter((row) => row.action === "organisation.import_completed")).toHaveLength(2);
  });

  it("attaches a later activities file to the deal cases imported before", async () => {
    const companyId = await seedCompany();
    const owner = await seedMember(companyId, "owner");
    const pipeline = await seedPipeline(companyId);
    await request(app(owner)).post(importPath(companyId)).send({ deals: DEALS_CSV, pipelineId: pipeline.id }).expect(200);

    const res = await request(app(owner)).post(importPath(companyId)).send({ activities: ACTIVITIES_CSV });
    expect(res.status).toBe(200);
    expect(res.body.activities).toEqual({ created: 2, updated: 0, skipped: 1, errors: 0 });
    const [caseRow] = await db.select().from(pipelineCases).where(eq(pipelineCases.companyId, companyId));
    expect((caseRow!.fields as { pipedriveActivities: unknown[] }).pipedriveActivities).toHaveLength(2);
  });

  it("asks for a pipeline when open deals have nowhere to go, and writes nothing", async () => {
    const companyId = await seedCompany();
    const owner = await seedMember(companyId, "owner");
    const res = await request(app(owner)).post(importPath(companyId)).send({ organisations: ORGS_CSV, deals: DEALS_CSV });
    expect(res.status).toBe(422);
    expect(res.body.details?.code).toBe("pipeline_required");
    expect(await db.select().from(organisations).where(eq(organisations.companyId, companyId))).toHaveLength(0);
  });

  it("rejects a file without an id column, and anyone but an owner", async () => {
    const companyId = await seedCompany();
    const owner = await seedMember(companyId, "owner");
    const admin = await seedMember(companyId, "admin");
    const bad = await request(app(owner)).post(importPath(companyId)).send({ organisations: "Name\nAcme" });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatch(/no ID column/);
    const denied = await request(app(admin)).post(importPath(companyId)).send({ organisations: ORGS_CSV });
    expect(denied.status).toBe(403);
    const empty = await request(app(owner)).post(importPath(companyId)).send({});
    expect(empty.status).toBe(400);
  });

  it("imports HubSpot export files into their own rows and cases", async () => {
    const companyId = await seedCompany();
    const owner = await seedMember(companyId, "owner");
    const pipeline = await seedPipeline(companyId);
    const body = { companies: HS_COMPANIES_CSV, contacts: HS_CONTACTS_CSV, deals: HS_DEALS_CSV, pipelineId: pipeline.id };
    const path = `/api/companies/${companyId}/organisations/import/hubspot-export`;

    const first = await request(app(owner)).post(path).send(body);
    expect(first.status).toBe(200);
    expect(first.body.source).toBe("hubspot");
    expect(first.body.organisations).toMatchObject({ created: 2, errors: 0 });
    expect(first.body.contacts).toMatchObject({ created: 2, errors: 0 });
    expect(first.body.deals).toEqual({ created: 1, updated: 0, skipped: 1, errors: 0 });

    const orgs = await db.select().from(organisations).where(eq(organisations.companyId, companyId));
    expect(orgs.map((row) => [row.externalId, row.status, row.source]).sort()).toEqual([
      ["3001", "client", "hubspot"],
      ["3002", "prospect", "hubspot"],
    ]);
    const [caseRow] = await db.select().from(pipelineCases).where(eq(pipelineCases.companyId, companyId));
    expect(caseRow).toMatchObject({ caseKey: "hubspot-5001", title: "Kente fleet audit" });
    expect(caseRow!.fields).toMatchObject({ hubspotDealId: "5001", hubspotStage: "Proposal made", dealValue: 8000 });

    const second = await request(app(owner)).post(path).send(body);
    expect(second.body.organisations).toMatchObject({ created: 0, updated: 0 });
    expect(await db.select().from(pipelineCases).where(eq(pipelineCases.companyId, companyId))).toHaveLength(1);
    const log = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(log.filter((row) => (row.details as { source?: string } | null)?.source === "hubspot")).toHaveLength(2);
  });
});
