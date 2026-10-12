import { readFileSync } from "node:fs";
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
  heartbeatRuns,
  instanceSettings,
  organisationContacts,
  organisations,
  toolApplications,
  toolConnections,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { organisationRoutes } from "../routes/organisations.js";
import type { PipedriveFetch } from "../services/crm-sync-pipedrive.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  industryLabels,
  mapPipedriveOrganization,
  mapPipedrivePerson,
} from "../services/organisation-import-pipedrive.js";

const recorded = JSON.parse(
  readFileSync(new URL("./fixtures/pipedrive-organisations.json", import.meta.url), "utf8"),
) as Record<string, any>;

type Pages = { fields: unknown; organizations: Record<number, unknown>; persons: Record<number, unknown> };

const recordedPages = (): Pages => ({
  fields: recorded.organizationFields,
  organizations: { 0: recorded.organizationsPage1, 2: recorded.organizationsPage2 },
  persons: { 0: recorded.personsPage1, 2: recorded.personsPage2 },
});

/** Answers v1 list calls from recorded pages by `start`. Records every call so tests can prove nothing is written. */
function fakePipedrive(pages: () => Pages) {
  const calls: Array<{ method: string; url: string }> = [];
  const fetch: PipedriveFetch = async (url, init) => {
    calls.push({ method: init.method, url });
    const parsed = new URL(url);
    const start = Number(parsed.searchParams.get("start") ?? 0);
    const current = pages();
    const body = parsed.pathname === "/api/v1/organizationFields"
      ? current.fields
      : parsed.pathname === "/api/v1/organizations"
        ? current.organizations[start]
        : parsed.pathname === "/api/v1/persons"
          ? current.persons[start]
          : undefined;
    return {
      status: body ? 200 : 404,
      headers: { get: () => null },
      json: async () => body ?? { success: false, error: "not recorded" },
    };
  };
  return { fetch, calls };
}

/** A synthetic full export: `orgCount` organisations and two persons each, in pages of 500. */
function fullExport(orgCount: number): Pages {
  const pageSize = 500;
  const orgs = Array.from({ length: orgCount }, (_, i) => ({
    id: 10_000 + i,
    name: `Organisation ${i + 1}`,
    owner_id: { id: 1, name: "Owner One", value: 1 },
    address_country: i % 2 ? "Ghana" : "Nigeria",
    open_deals_count: i % 7 === 0 ? 1 : 0,
    won_deals_count: i % 11 === 0 ? 1 : 0,
  }));
  const persons = orgs.flatMap((org, i) => [
    { id: 50_000 + i * 2, name: `Person ${i}A`, org_id: { value: org.id }, email: [{ value: `a${i}@example.test`, primary: true }] },
    { id: 50_001 + i * 2, name: `Person ${i}B`, org_id: org.id, phone: [{ value: `+1 555 ${i}`, primary: true }] },
  ]);
  const paged = (items: unknown[]) => {
    const out: Record<number, unknown> = {};
    for (let start = 0; start < Math.max(items.length, 1); start += pageSize) {
      const more = start + pageSize < items.length;
      out[start] = {
        success: true,
        data: items.slice(start, start + pageSize),
        additional_data: { pagination: { start, limit: pageSize, more_items_in_collection: more, ...(more ? { next_start: start + pageSize } : {}) } },
      };
    }
    return out;
  };
  return { fields: recorded.organizationFields, organizations: paged(orgs), persons: paged(persons) };
}

describe("Pipedrive organisation mapping (GRE-1479)", () => {
  const industries = industryLabels(recorded.organizationFields.data);

  it("maps name, country, industry label, owner name and status from deals", () => {
    const [northwind, blueHarbour] = recorded.organizationsPage1.data;
    expect(mapPipedriveOrganization(northwind, industries)).toEqual({
      externalId: "101",
      name: "Northwind Minerals",
      industry: "Mining",
      country: "Ghana",
      countryOwner: "Ama Owusu",
      status: "client",
    });
    expect(mapPipedriveOrganization(blueHarbour, industries)).toMatchObject({ industry: "Energy", status: "prospect" });
  });

  it("imports an organisation with no deal as a target and trims text", () => {
    const [cedar, blank] = recorded.organizationsPage2.data;
    expect(mapPipedriveOrganization(cedar, industries)).toEqual({
      externalId: "103",
      name: "Cedar Lane Capital",
      industry: null,
      country: null,
      countryOwner: null,
      status: "target",
    });
    expect(mapPipedriveOrganization(blank, industries)).toBeNull();
  });

  it("maps a person's job title and primary email and phone", () => {
    const [esi, tunde] = recorded.personsPage1.data;
    expect(mapPipedrivePerson(esi)).toEqual({
      externalId: "501",
      organisationExternalId: "101",
      name: "Esi Boateng",
      role: "Chief Financial Officer",
      email: "esi@example.test",
      phone: "+233 20 000 0001",
    });
    // No usable primary: the first entry with a value wins.
    expect(mapPipedrivePerson(tunde)).toMatchObject({ email: "tunde@example.test", phone: null, role: null });
    expect(mapPipedrivePerson(recorded.personsPage2.data[1])).toMatchObject({ organisationExternalId: "104" });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Pipedrive import tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("Pipedrive organisation import route (GRE-1479)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-organisation-import-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    await instanceSettingsService(db).updateExperimental({ enablePipelines: true });
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(organisationContacts);
    await db.delete(organisations);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(companyMemberships);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
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

  async function seedCompany() {
    const [company] = await db
      .insert(companies)
      .values({ name: "Greatstone", issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}` })
      .returning();
    return company!.id;
  }

  async function seedMember(companyId: string, role: "owner" | "admin" | "operator") {
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

  async function seedConnection(companyId: string, values: { enabled?: boolean; status?: "active" | "draft" } = {}) {
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
      status: values.status ?? "active",
      enabled: values.enabled ?? true,
    }).returning();
    return connection!.id;
  }

  const importPath = (companyId: string) => `/api/companies/${companyId}/organisations/import/pipedrive`;

  it("imports every organisation and person, then a rerun updates instead of duplicating", async () => {
    const companyId = await seedCompany();
    const owner = await seedMember(companyId, "owner");
    const connectionId = await seedConnection(companyId);
    let pages = recordedPages();
    const pipedrive = fakePipedrive(() => pages);

    const first = await request(app(owner, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(first.status).toBe(200);
    expect(first.body.organisations).toEqual({ created: 3, updated: 0, skipped: 1, errors: 0 });
    expect(first.body.contacts).toEqual({ created: 3, updated: 0, skipped: 2, errors: 0 });

    const rows = await db.select().from(organisations).where(eq(organisations.companyId, companyId));
    expect(rows.map((row) => [row.externalId, row.name, row.status, row.source]).sort()).toEqual([
      ["101", "Northwind Minerals", "client", "pipedrive"],
      ["102", "Blue Harbour Energy", "prospect", "pipedrive"],
      ["103", "Cedar Lane Capital", "target", "pipedrive"],
    ]);
    const esi = await db.select().from(organisationContacts)
      .where(and(eq(organisationContacts.companyId, companyId), eq(organisationContacts.externalId, "501")))
      .then((found) => found[0]!);
    expect(esi).toMatchObject({ name: "Esi Boateng", role: "Chief Financial Officer", email: "esi@example.test", source: "pipedrive" });
    expect(esi.organisationId).toBe(rows.find((row) => row.externalId === "101")!.id);

    // Read only: every call to Pipedrive is a GET.
    expect(pipedrive.calls.every((call) => call.method === "GET")).toBe(true);

    // Same pages again: nothing created or changed.
    const rerun = await request(app(owner, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(rerun.body.organisations).toEqual({ created: 0, updated: 0, skipped: 4, errors: 0 });
    expect(rerun.body.contacts).toEqual({ created: 0, updated: 0, skipped: 5, errors: 0 });

    // A GSAM status choice survives a rerun; Pipedrive fields are updated.
    await db.update(organisations).set({ status: "former" })
      .where(and(eq(organisations.companyId, companyId), eq(organisations.externalId, "102")));
    pages = recordedPages();
    const changed = structuredClone(recorded.organizationsPage1);
    changed.data[1].name = "Blue Harbour Energy Ltd";
    changed.data[1].won_deals_count = 3;
    const changedPerson = structuredClone(recorded.personsPage1);
    changedPerson.data[0].job_title = "Chief Executive";
    pages = { ...pages, organizations: { ...pages.organizations, 0: changed }, persons: { ...pages.persons, 0: changedPerson } };
    const third = await request(app(owner, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(third.body.organisations).toEqual({ created: 0, updated: 1, skipped: 3, errors: 0 });
    expect(third.body.contacts).toEqual({ created: 0, updated: 1, skipped: 4, errors: 0 });
    const blueHarbour = await db.select().from(organisations)
      .where(and(eq(organisations.companyId, companyId), eq(organisations.externalId, "102")))
      .then((found) => found[0]!);
    expect(blueHarbour).toMatchObject({ name: "Blue Harbour Energy Ltd", status: "former" });
    expect(await db.select().from(organisations).where(eq(organisations.companyId, companyId))).toHaveLength(3);

    const audit = await db.select().from(activityLog).where(eq(activityLog.action, "organisation.import_completed"));
    expect(audit).toHaveLength(3);
  });

  it("loads every organisation of a full export across pages", async () => {
    const companyId = await seedCompany();
    const owner = await seedMember(companyId, "owner");
    const connectionId = await seedConnection(companyId);
    const pages = fullExport(1_234);
    const pipedrive = fakePipedrive(() => pages);

    const res = await request(app(owner, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(res.status).toBe(200);
    expect(res.body.organisations).toEqual({ created: 1_234, updated: 0, skipped: 0, errors: 0 });
    expect(res.body.contacts).toEqual({ created: 2_468, updated: 0, skipped: 0, errors: 0 });
    const statuses = await db.select({ status: organisations.status }).from(organisations).where(eq(organisations.companyId, companyId));
    expect(statuses).toHaveLength(1_234);
    expect(statuses.filter((row) => row.status === "target").length).toBeGreaterThan(0);
  }, 60_000);

  it("is owner-only", async () => {
    const companyId = await seedCompany();
    const connectionId = await seedConnection(companyId);
    const pipedrive = fakePipedrive(recordedPages);
    for (const role of ["admin", "operator"] as const) {
      const actor = await seedMember(companyId, role);
      const res = await request(app(actor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
      expect(res.status).toBe(403);
    }
    const agentActor = { type: "agent", agentId: randomUUID(), companyId, source: "agent_key" } as Express.Request["actor"];
    const res = await request(app(agentActor, pipedrive.fetch)).post(importPath(companyId)).send({ connectionId });
    expect(res.status).toBe(403);
    expect(pipedrive.calls).toHaveLength(0);
    expect(await db.select().from(organisations)).toHaveLength(0);
  });

  it("refuses another company's connection and an inactive one", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const owner = await seedMember(companyId, "owner");
    const pipedrive = fakePipedrive(recordedPages);

    const foreign = await request(app(owner, pipedrive.fetch))
      .post(importPath(companyId))
      .send({ connectionId: await seedConnection(otherCompanyId) });
    expect(foreign.status).toBe(422);
    expect(foreign.body.details?.code ?? foreign.body.code).toBe("connection_not_found");

    const inactive = await request(app(owner, pipedrive.fetch))
      .post(importPath(companyId))
      .send({ connectionId: await seedConnection(companyId, { enabled: false }) });
    expect(inactive.status).toBe(422);
    expect(pipedrive.calls).toHaveLength(0);
  });

  it("tells the owner to reconnect when Pipedrive refuses the credential", async () => {
    const companyId = await seedCompany();
    const owner = await seedMember(companyId, "owner");
    const connectionId = await seedConnection(companyId);
    const refused: PipedriveFetch = async () => ({ status: 401, headers: { get: () => null }, json: async () => ({}) });

    const res = await request(app(owner, refused)).post(importPath(companyId)).send({ connectionId });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Reconnect Pipedrive");
  });
});
