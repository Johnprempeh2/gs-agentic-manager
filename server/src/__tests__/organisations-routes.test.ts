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
    `Skipping embedded Postgres organisation route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("organisation routes (GRE-1477)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-organisations-routes-");
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

  it("creates, lists with key contacts, reads, updates and archives an organisation", async () => {
    const companyId = await seedCompany();
    const acme = await createOrganisation(companyId, {
      name: "Acme Mining",
      industry: "Mining",
      country: "Ghana",
      countryOwner: "Ama",
      status: "prospect",
      website: "",
    });
    await createOrganisation(companyId, { name: "Blue Bank", country: "Kenya", status: "client" });

    const key = await request(app())
      .post(`/api/companies/${companyId}/organisations/${acme.id}/contacts`)
      .send({ name: "Kofi Mensah", role: "CEO", email: "kofi@example.com", isKeyContact: true });
    expect(key.status).toBe(201);
    await request(app())
      .post(`/api/companies/${companyId}/organisations/${acme.id}/contacts`)
      .send({ name: "Esi Owusu", role: "Analyst" })
      .expect(201);

    const list = await request(app()).get(`/api/companies/${companyId}/organisations`);
    expect(list.status).toBe(200);
    expect(list.body.map((row: { name: string }) => row.name)).toEqual(["Acme Mining", "Blue Bank"]);
    expect(list.body[0]).toMatchObject({
      industry: "Mining",
      country: "Ghana",
      countryOwner: "Ama",
      status: "prospect",
      website: null,
      source: "manual",
      contactCount: 2,
      keyContacts: [{ name: "Kofi Mensah", role: "CEO", email: "kofi@example.com" }],
    });

    const detail = await request(app()).get(`/api/companies/${companyId}/organisations/${acme.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.contacts.map((contact: { name: string }) => contact.name)).toEqual(["Kofi Mensah", "Esi Owusu"]);

    const updated = await request(app())
      .patch(`/api/companies/${companyId}/organisations/${acme.id}`)
      .send({ status: "client", notes: "Signed in October" });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ status: "client", notes: "Signed in October", country: "Ghana" });

    const archived = await request(app()).post(`/api/companies/${companyId}/organisations/${acme.id}/archive`);
    expect(archived.status).toBe(200);
    expect(archived.body.archivedAt).toEqual(expect.any(String));

    const afterArchive = await request(app()).get(`/api/companies/${companyId}/organisations`);
    expect(afterArchive.body.map((row: { name: string }) => row.name)).toEqual(["Blue Bank"]);
    const withArchived = await request(app()).get(`/api/companies/${companyId}/organisations?includeArchived=true`);
    expect(withArchived.body).toHaveLength(2);

    const restored = await request(app())
      .patch(`/api/companies/${companyId}/organisations/${acme.id}`)
      .send({ archived: false });
    expect(restored.body.archivedAt).toBeNull();

    const actions = await db.select({ action: activityLog.action }).from(activityLog);
    expect(actions.map((row) => row.action)).toEqual(
      expect.arrayContaining(["organisation.created", "organisation.updated", "organisation.archived", "organisation.contact_created"]),
    );
  });

  it("searches by name, country and contact name, and filters by status", async () => {
    const companyId = await seedCompany();
    const acme = await createOrganisation(companyId, { name: "Acme Mining", country: "Ghana", status: "prospect" });
    await createOrganisation(companyId, { name: "Blue Bank", country: "Kenya", status: "client" });
    await request(app())
      .post(`/api/companies/${companyId}/organisations/${acme.id}/contacts`)
      .send({ name: "Kofi Mensah" })
      .expect(201);

    const names = async (query: string) =>
      (await request(app()).get(`/api/companies/${companyId}/organisations${query}`)).body.map(
        (row: { name: string }) => row.name,
      );
    expect(await names("?q=bank")).toEqual(["Blue Bank"]);
    expect(await names("?q=ghana")).toEqual(["Acme Mining"]);
    expect(await names("?q=kofi")).toEqual(["Acme Mining"]);
    expect(await names("?q=100%25")).toEqual([]);
    expect(await names("?status=client")).toEqual(["Blue Bank"]);
    expect(await names("?status=client&q=acme")).toEqual([]);

    const bad = await request(app()).get(`/api/companies/${companyId}/organisations?status=lead`);
    expect(bad.status).toBe(400);
  });

  it("keeps each company's organisations to itself", async () => {
    const companyA = await seedCompany("Company A");
    const companyB = await seedCompany("Company B");
    const acme = await createOrganisation(companyA, { name: "Acme Mining" });
    const memberOfB = await seedMember(companyB, "owner");

    // A member of B cannot list A's organisations.
    const list = await request(app(memberOfB)).get(`/api/companies/${companyA}/organisations`);
    expect(list.status).toBe(403);

    // Using B's company id with A's organisation id answers 404 for reads and writes.
    const read = await request(app(memberOfB)).get(`/api/companies/${companyB}/organisations/${acme.id}`);
    expect(read.status).toBe(404);
    const patch = await request(app(memberOfB))
      .patch(`/api/companies/${companyB}/organisations/${acme.id}`)
      .send({ name: "Hijacked" });
    expect(patch.status).toBe(404);
    const archive = await request(app(memberOfB)).post(`/api/companies/${companyB}/organisations/${acme.id}/archive`);
    expect(archive.status).toBe(404);
    const contact = await request(app(memberOfB))
      .post(`/api/companies/${companyB}/organisations/${acme.id}/contacts`)
      .send({ name: "Spy" });
    expect(contact.status).toBe(404);

    // An agent of B cannot reach company A at all.
    const agentOfB = await seedAgent(companyB, [{ key: "pipelines:cases", scope: null }]);
    const agentRead = await request(app(agentOfB)).get(`/api/companies/${companyA}/organisations/${acme.id}`);
    expect(agentRead.status).toBe(403);

    const [row] = await db.select().from(organisations);
    expect(row!.name).toBe("Acme Mining");
    expect(await db.select().from(organisationContacts)).toHaveLength(0);
  });

  it("lets viewers read but only Work-cases holders write", async () => {
    const companyId = await seedCompany();
    const acme = await createOrganisation(companyId, { name: "Acme Mining" });

    const viewer = await seedMember(companyId, "viewer");
    expect((await request(app(viewer)).get(`/api/companies/${companyId}/organisations`)).status).toBe(200);
    expect(
      (await request(app(viewer)).post(`/api/companies/${companyId}/organisations`).send({ name: "Nope" })).status,
    ).toBe(403);

    const operator = await seedMember(companyId, "operator");
    expect(
      (await request(app(operator)).post(`/api/companies/${companyId}/organisations`).send({ name: "Op Co" })).status,
    ).toBe(201);

    const plainAgent = await seedAgent(companyId, []);
    expect((await request(app(plainAgent)).get(`/api/companies/${companyId}/organisations`)).status).toBe(200);
    const denied = await request(app(plainAgent))
      .patch(`/api/companies/${companyId}/organisations/${acme.id}`)
      .send({ status: "client" });
    expect(denied.status).toBe(403);
    expect(denied.body.details).toMatchObject({ code: "crm_write_forbidden" });

    // Work cases on one pipeline only is not enough: organisations span all pipelines.
    const scopedAgent = await seedAgent(companyId, [{ key: "pipelines:cases", scope: { pipelineIds: [randomUUID()] } }]);
    expect(
      (await request(app(scopedAgent)).post(`/api/companies/${companyId}/organisations`).send({ name: "Scoped" })).status,
    ).toBe(403);

    const crmAgent = await seedAgent(companyId, [{ key: "pipelines:cases", scope: null }]);
    const created = await request(app(crmAgent)).post(`/api/companies/${companyId}/organisations`).send({ name: "Agent Co" });
    expect(created.status).toBe(201);
    const [row] = await db
      .select({ createdByAgentId: organisations.createdByAgentId })
      .from(organisations)
      .where(eq(organisations.id, created.body.id));
    expect(row!.createdByAgentId).toBe((crmAgent as { agentId: string }).agentId);
  });

  it("rejects invalid input", async () => {
    const companyId = await seedCompany();
    const base = `/api/companies/${companyId}/organisations`;
    expect((await request(app()).post(base).send({ name: "  " })).status).toBe(400);
    expect((await request(app()).post(base).send({ name: "X", status: "lead" })).status).toBe(400);
    expect((await request(app()).post(base).send({ name: "X", companyId: randomUUID() })).status).toBe(400);
    const acme = await createOrganisation(companyId, { name: "Acme" });
    expect(
      (await request(app()).post(`${base}/${acme.id}/contacts`).send({ name: "Kofi", email: "not-an-email" })).status,
    ).toBe(400);
    expect((await request(app()).patch(`${base}/${acme.id}`).send({ archived: true })).status).toBe(400);
    expect((await request(app()).get(`${base}/not-a-uuid`)).status).toBe(404);
  });

  it("refuses a second import row with the same source and external id", async () => {
    const companyId = await seedCompany();
    await createOrganisation(companyId, { name: "Acme", source: "pipedrive", externalId: "42" });
    const dup = await request(app())
      .post(`/api/companies/${companyId}/organisations`)
      .send({ name: "Acme again", source: "pipedrive", externalId: "42" });
    expect(dup.status).toBe(409);
  });

  it("answers not entitled while pipelines are off", async () => {
    const companyId = await seedCompany();
    await instanceSettingsService(db).updateExperimental({ enablePipelines: false });
    const res = await request(app()).get(`/api/companies/${companyId}/organisations`);
    expect(res.status).toBe(403);
  });
});
