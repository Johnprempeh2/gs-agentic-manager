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
  organisations,
  principalPermissionGrants,
  websiteSite,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { organisationRoutes } from "../routes/organisations.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { WebsiteBridgeError } from "../services/website/data-bridge-client.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres organisation website link tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("organisation website link (GRE-2682)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  /** The website's customers, by id. */
  const websiteCustomers = new Set(["cust-1", "cust-2"]);
  const lookups: Array<{ siteId: string; id: string; actorType: string }> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-organisation-website-link-");
    db = createDb(tempDb.connectionString);
  });

  beforeEach(async () => {
    lookups.length = 0;
    await instanceSettingsService(db).updateExperimental({ enablePipelines: true, enableWebsiteView: true });
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(organisations);
    await db.delete(websiteSite);
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
    instance.use(
      "/api",
      organisationRoutes(db, {
        getWebsiteCustomer: async (site, id, bridgeActor) => {
          lookups.push({ siteId: site.id, id, actorType: bridgeActor.type });
          if (!websiteCustomers.has(id)) throw new WebsiteBridgeError("not_found", 404);
          return { id };
        },
      }),
    );
    instance.use(errorHandler);
    return instance;
  }

  async function seed() {
    const [company] = await db
      .insert(companies)
      .values({ name: "Greatstone", issuePrefix: `W${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}` })
      .returning();
    const companyId = company!.id;
    const [site] = await db
      .insert(websiteSite)
      .values({ companyId, name: "Greatstone", domain: "www.greatstone.test", netlifySiteId: "n" })
      .returning();
    const base = `/api/companies/${companyId}/organisations`;
    const acme = (await request(app()).post(base).send({ name: "Acme" }).expect(201)).body as { id: string };
    const borealis = (await request(app()).post(base).send({ name: "Borealis" }).expect(201)).body as { id: string };
    return { companyId, siteId: site!.id, base, acme, borealis };
  }

  async function seedAgent(companyId: string, keys: string[]) {
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
    for (const key of keys) {
      await db.insert(principalPermissionGrants).values({
        companyId,
        principalType: "agent",
        principalId: agent!.id,
        permissionKey: key,
        scope: null,
      });
    }
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id }).returning();
    return { type: "agent", agentId: agent!.id, companyId, runId: run!.id, source: "agent_key" } as Express.Request["actor"];
  }

  it("starts unlinked, links to a website organisation the site has, then unlinks, and logs who did each", async () => {
    const { base, siteId, acme } = await seed();
    expect((await request(app()).get(`${base}/${acme.id}`)).body.websiteOrganisationId).toBeNull();

    const linked = await request(app()).put(`${base}/${acme.id}/website-link`).send({ websiteOrganisationId: "cust-1", siteId });
    expect(linked.status).toBe(200);
    expect(linked.body.websiteOrganisationId).toBe("cust-1");
    expect(lookups).toEqual([{ siteId, id: "cust-1", actorType: "user" }]);
    const detail = await request(app()).get(`${base}/${acme.id}`);
    expect(detail.body.websiteOrganisationId).toBe("cust-1");

    const cleared = await request(app()).put(`${base}/${acme.id}/website-link`).send({ websiteOrganisationId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.websiteOrganisationId).toBeNull();
    expect(lookups).toHaveLength(1);

    const log = await db
      .select({ action: activityLog.action, actorId: activityLog.actorId, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.entityId, acme.id));
    expect(log.filter((entry) => entry.action.startsWith("organisation.website_"))).toEqual([
      {
        action: "organisation.website_linked",
        actorId: "board-user",
        details: { websiteOrganisationId: "cust-1", previousWebsiteOrganisationId: null, siteId },
      },
      {
        action: "organisation.website_unlinked",
        actorId: "board-user",
        details: { previousWebsiteOrganisationId: "cust-1" },
      },
    ]);
  });

  it("rejects an id the website does not have, and keeps the organisation unlinked", async () => {
    const { base, siteId, acme } = await seed();
    const res = await request(app()).put(`${base}/${acme.id}/website-link`).send({ websiteOrganisationId: "cust-404", siteId });
    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({ code: "website_organisation_unknown" });
    const [row] = await db.select().from(organisations).where(eq(organisations.id, acme.id));
    expect(row!.websiteOrganisationId).toBeNull();
  });

  it("rejects a website organisation that is already linked to another organisation in the company", async () => {
    const { base, siteId, acme, borealis } = await seed();
    await request(app()).put(`${base}/${acme.id}/website-link`).send({ websiteOrganisationId: "cust-1", siteId }).expect(200);
    const dup = await request(app()).put(`${base}/${borealis.id}/website-link`).send({ websiteOrganisationId: "cust-1", siteId });
    expect(dup.status).toBe(409);
    expect(dup.body.details).toMatchObject({ code: "website_organisation_already_linked", organisationId: acme.id });
    // Linking the same organisation again is not a duplicate.
    await request(app()).put(`${base}/${acme.id}/website-link`).send({ websiteOrganisationId: "cust-1", siteId }).expect(200);
  });

  it("lets another company link the same website organisation id", async () => {
    const first = await seed();
    const second = await seed();
    await request(app()).put(`${first.base}/${first.acme.id}/website-link`)
      .send({ websiteOrganisationId: "cust-2", siteId: first.siteId }).expect(200);
    await request(app()).put(`${second.base}/${second.acme.id}/website-link`)
      .send({ websiteOrganisationId: "cust-2", siteId: second.siteId }).expect(200);
  });

  it("refuses a site from another company, a missing site id and a malformed id", async () => {
    const { base, acme } = await seed();
    const other = await seed();
    const foreign = await request(app()).put(`${base}/${acme.id}/website-link`)
      .send({ websiteOrganisationId: "cust-1", siteId: other.siteId });
    expect(foreign.status).toBe(422);
    expect(foreign.body.details).toMatchObject({ code: "website_site_unknown" });
    expect((await request(app()).put(`${base}/${acme.id}/website-link`).send({ websiteOrganisationId: "cust-1" })).status).toBe(400);
    expect((await request(app()).put(`${base}/${acme.id}/website-link`)
      .send({ websiteOrganisationId: "../customers", siteId: other.siteId })).status).toBe(400);
    expect(lookups).toHaveLength(0);
  });

  it("answers 404 for an organisation of another company", async () => {
    const { siteId } = await seed();
    const other = await seed();
    const res = await request(app()).put(`/api/companies/${other.companyId}/organisations/${randomUUID()}/website-link`)
      .send({ websiteOrganisationId: "cust-1", siteId });
    expect(res.status).toBe(404);
  });

  it("needs CRM write rights, and website view to link", async () => {
    const { companyId, base, siteId, acme } = await seed();
    const reader = await seedAgent(companyId, []);
    expect((await request(app(reader)).put(`${base}/${acme.id}/website-link`)
      .send({ websiteOrganisationId: "cust-1", siteId })).status).toBe(403);

    const crmOnly = await seedAgent(companyId, ["pipelines:cases"]);
    const noWebsite = await request(app(crmOnly)).put(`${base}/${acme.id}/website-link`).send({ websiteOrganisationId: "cust-1", siteId });
    expect(noWebsite.status).toBe(403);
    expect(noWebsite.body.details).toMatchObject({ code: "website_permission_missing" });

    const both = await seedAgent(companyId, ["pipelines:cases", "website:view"]);
    const ok = await request(app(both)).put(`${base}/${acme.id}/website-link`).send({ websiteOrganisationId: "cust-1", siteId });
    expect(ok.status).toBe(200);
    expect(lookups.at(-1)).toMatchObject({ actorType: "agent" });
    // Clearing needs CRM write only.
    await request(app(crmOnly)).put(`${base}/${acme.id}/website-link`).send({ websiteOrganisationId: null }).expect(200);
  });
});
