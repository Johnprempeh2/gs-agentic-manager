import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
  principalPermissionGrants,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { organisationRoutes } from "../routes/organisations.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres organisation CRM field tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("organisation global CRM fields (GRE-1539)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-organisation-crm-fields-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    await instanceSettingsService(db).updateExperimental({ enablePipelines: true });
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(organisationContacts);
    await db.delete(organisations);
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
    instance.use("/api", organisationRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function seedCompany(name = "Greatstone") {
    const [company] = await db
      .insert(companies)
      .values({ name, issuePrefix: `O${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}` })
      .returning();
    return company!.id;
  }

  async function seedMember(companyId: string, role: "owner" | "operator" | "viewer") {
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

  async function seedAgent(companyId: string, grants: Array<{ key: string; scope: Record<string, unknown> | null }>) {
    const [agent] = await db
      .insert(agents)
      .values({ companyId, name: `Sales ${randomUUID().slice(0, 4)}`, role: "engineer", adapterType: "codex_local" })
      .returning();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "agent",
      principalId: agent!.id,
      status: "active",
      membershipRole: "member",
    });
    for (const grant of grants) {
      await db.insert(principalPermissionGrants).values({
        companyId,
        principalType: "agent",
        principalId: agent!.id,
        permissionKey: grant.key,
        scope: grant.scope,
      });
    }
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id }).returning();
    return {
      type: "agent",
      agentId: agent!.id,
      companyId,
      runId: run!.id,
      source: "agent_key",
    } as Express.Request["actor"];
  }

  async function createOrganisation(companyId: string, body: Record<string, unknown>) {
    const res = await request(app()).post(`/api/companies/${companyId}/organisations`).send(body);
    expect(res.status).toBe(201);
    return res.body as { id: string };
  }

  const crmFields = {
    legalName: "Acme Mining Holdings Limited",
    domain: "https://www.Acme-Mining.example/about",
    phone: "+233 30 000 0000",
    email: "info@acme-mining.example",
    addressStreet: "1 Independence Avenue",
    addressCity: "Accra",
    addressRegion: "Greater Accra",
    addressPostalCode: "GA-100",
    country: "Ghana",
    employeeCount: 450,
    sizeBand: "201-500",
    annualRevenue: 12500000.75,
    annualRevenueCurrency: "usd",
    ownershipType: "private",
    linkedinUrl: "linkedin.com/company/acme-mining",
    segment: "Enterprise",
    tags: ["Mining", " gold ", "mining", ""],
    description: "Gold and bauxite producer.",
    registrationNumber: "CS-123456",
    taxId: "GH-998877",
  };

  it("saves every CRM field on create and loads it from list and detail", async () => {
    const companyId = await seedCompany();
    const created = await request(app())
      .post(`/api/companies/${companyId}/organisations`)
      .send({ name: "Acme Mining", ...crmFields });
    expect(created.status).toBe(201);
    const expected = {
      ...crmFields,
      domain: "acme-mining.example",
      annualRevenueCurrency: "USD",
      linkedinUrl: "https://linkedin.com/company/acme-mining",
      tags: ["Mining", "gold"],
      parentOrganisationId: null,
      accountOwnerUserId: null,
      accountOwnerAgentId: null,
    };
    expect(created.body).toMatchObject(expected);

    const detail = await request(app()).get(`/api/companies/${companyId}/organisations/${created.body.id}`);
    expect(detail.body).toMatchObject(expected);
    const list = await request(app()).get(`/api/companies/${companyId}/organisations`);
    expect(list.body[0]).toMatchObject(expected);

    // Search reaches the new text fields and tags.
    const names = async (q: string) =>
      (await request(app()).get(`/api/companies/${companyId}/organisations?q=${q}`)).body.map((row: { name: string }) => row.name);
    expect(await names("holdings")).toEqual(["Acme Mining"]);
    expect(await names("acme-mining.example")).toEqual(["Acme Mining"]);
    expect(await names("gold")).toEqual(["Acme Mining"]);
  });

  it("leaves CRM fields empty when not given, and clears and keeps them on edit", async () => {
    const companyId = await seedCompany();
    const bare = await createOrganisation(companyId, { name: "Blue Bank" });
    const read = await request(app()).get(`/api/companies/${companyId}/organisations/${bare.id}`);
    expect(read.body).toMatchObject({ legalName: null, domain: null, employeeCount: null, annualRevenue: null, tags: [] });

    const filled = await request(app())
      .patch(`/api/companies/${companyId}/organisations/${bare.id}`)
      .send({ legalName: "Blue Bank plc", annualRevenue: 1000, annualRevenueCurrency: "KES", tags: ["bank"] });
    expect(filled.status).toBe(200);
    expect(filled.body).toMatchObject({ legalName: "Blue Bank plc", annualRevenue: 1000, annualRevenueCurrency: "KES", tags: ["bank"] });

    // A patch that does not name a field keeps it; a blank clears it.
    const cleared = await request(app())
      .patch(`/api/companies/${companyId}/organisations/${bare.id}`)
      .send({ legalName: "", tags: [] });
    expect(cleared.body).toMatchObject({ legalName: null, tags: [], annualRevenue: 1000, annualRevenueCurrency: "KES" });
  });

  it("links a parent organisation of the same company and refuses loops and other companies", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany("Other");
    const group = await createOrganisation(companyId, { name: "Acme Group" });
    const child = await createOrganisation(companyId, { name: "Acme Mining", parentOrganisationId: group.id });
    const grandchild = await createOrganisation(companyId, { name: "Acme Mining Ghana", parentOrganisationId: child.id });
    const foreign = await createOrganisation(otherCompanyId, { name: "Foreign" });

    const read = await request(app()).get(`/api/companies/${companyId}/organisations/${child.id}`);
    expect(read.body.parentOrganisationId).toBe(group.id);

    const self = await request(app()).patch(`/api/companies/${companyId}/organisations/${group.id}`).send({ parentOrganisationId: group.id });
    expect(self.status).toBe(422);
    const loop = await request(app())
      .patch(`/api/companies/${companyId}/organisations/${group.id}`)
      .send({ parentOrganisationId: grandchild.id });
    expect(loop.status).toBe(422);
    expect(loop.body.details?.code ?? loop.body.code).toBe("parent_loop");
    const crossCompany = await request(app())
      .post(`/api/companies/${companyId}/organisations`)
      .send({ name: "Sneaky", parentOrganisationId: foreign.id });
    expect(crossCompany.status).toBe(422);

    const unlinked = await request(app())
      .patch(`/api/companies/${companyId}/organisations/${child.id}`)
      .send({ parentOrganisationId: null });
    expect(unlinked.body.parentOrganisationId).toBeNull();
  });

  it("sets a person or an agent of the company as account owner, never both", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany("Other");
    const member = await seedMember(companyId, "operator");
    const memberId = (member as { userId: string }).userId;
    const agentActor = await seedAgent(companyId, []);
    const agentId = (agentActor as { agentId: string }).agentId;
    const foreignAgent = await seedAgent(otherCompanyId, []);
    const organisation = await createOrganisation(companyId, { name: "Acme", accountOwnerUserId: memberId });

    const byAgent = await request(app())
      .patch(`/api/companies/${companyId}/organisations/${organisation.id}`)
      .send({ accountOwnerAgentId: agentId });
    expect(byAgent.status).toBe(200);
    // Picking the agent clears the person.
    expect(byAgent.body).toMatchObject({ accountOwnerAgentId: agentId, accountOwnerUserId: null });

    const both = await request(app())
      .patch(`/api/companies/${companyId}/organisations/${organisation.id}`)
      .send({ accountOwnerAgentId: agentId, accountOwnerUserId: memberId });
    expect(both.status).toBe(400);
    const foreign = await request(app())
      .patch(`/api/companies/${companyId}/organisations/${organisation.id}`)
      .send({ accountOwnerAgentId: (foreignAgent as { agentId: string }).agentId });
    expect(foreign.status).toBe(422);
    const stranger = await request(app())
      .post(`/api/companies/${companyId}/organisations`)
      .send({ name: "Nobody's", accountOwnerUserId: "not-a-member" });
    expect(stranger.status).toBe(422);
  });

  it("rejects bad CRM values", async () => {
    const companyId = await seedCompany();
    const post = (body: Record<string, unknown>) =>
      request(app()).post(`/api/companies/${companyId}/organisations`).send({ name: "Acme", ...body });
    expect((await post({ email: "not-an-email" })).status).toBe(400);
    expect((await post({ domain: "not a domain" })).status).toBe(400);
    expect((await post({ sizeBand: "huge" })).status).toBe(400);
    expect((await post({ ownershipType: "pirate" })).status).toBe(400);
    expect((await post({ employeeCount: 12.5 })).status).toBe(400);
    expect((await post({ employeeCount: -1 })).status).toBe(400);
    expect((await post({ annualRevenueCurrency: "dollars" })).status).toBe(400);
    expect((await post({ tags: Array.from({ length: 31 }, (_, i) => `t${i}`) })).status).toBe(400);
    const noCurrency = await post({ annualRevenue: 5000 });
    expect(noCurrency.status).toBe(422);
  });
});
