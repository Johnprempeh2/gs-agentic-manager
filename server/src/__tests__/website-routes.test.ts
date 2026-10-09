import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  companySecrets,
  companySecretVersions,
  createDb,
  instanceSettings,
  websiteProperties,
  websitePulls,
} from "@greatstone/db";
import type { WebsiteProperty, WebsiteReport } from "@greatstone/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { websiteRoutes } from "../routes/website.js";
import { instanceSettingsService } from "../services/index.js";
import {
  GoogleApiError,
  createFixtureGoogleClient,
  type WebsiteGoogleClient,
} from "../services/website/google-client.js";
import { resetWebsiteServiceStateForTests, websiteService } from "../services/website/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres website route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("website view routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const keyFolder = mkdtempSync(path.join(os.tmpdir(), "paperclip-website-key-"));
  const previousKeyFile = process.env.GSAM_SECRETS_MASTER_KEY_FILE;

  beforeAll(async () => {
    process.env.GSAM_SECRETS_MASTER_KEY_FILE = path.join(keyFolder, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-website-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    resetWebsiteServiceStateForTests();
    await db.delete(websitePulls);
    await db.delete(websiteProperties);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(activityLog);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) delete process.env.GSAM_SECRETS_MASTER_KEY_FILE;
    else process.env.GSAM_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(keyFolder, { recursive: true, force: true });
  });

  const localBoard: Express.Request["actor"] = {
    type: "board",
    userId: "local-board",
    source: "local_implicit",
    isInstanceAdmin: true,
  };

  function memberActor(companyId: string, role: "owner" | "operator" | "viewer", userId = `user-${role}`): Express.Request["actor"] {
    return {
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: role, status: "active" }],
    } as Express.Request["actor"];
  }

  function app(actor: Express.Request["actor"] = localBoard, googleClient: WebsiteGoogleClient | null = createFixtureGoogleClient()) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", websiteRoutes(db, { googleClient }));
    instance.use(errorHandler);
    return instance;
  }

  async function seedCompany(name = "Greatstone") {
    const [company] = await db.insert(companies).values({
      name,
      issuePrefix: `W${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    return company!;
  }

  async function enableWebsiteView() {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
  }

  async function createProperty(companyId: string, http = request(app())) {
    const response = await http
      .post(`/api/companies/${companyId}/website/properties`)
      .send({ name: "Greatstone website", siteUrl: "https://www.example.com/", ga4PropertyId: "properties/123456789" })
      .expect(201);
    return response.body as WebsiteProperty;
  }

  /** Start sign-in and follow the fixture consent URL back to our callback. */
  async function connect(companyId: string, propertyId: string, actor = localBoard) {
    const http = request(app(actor));
    const start = await http
      .post(`/api/companies/${companyId}/website/properties/${propertyId}/google/connect`)
      .set("host", "127.0.0.1:3100")
      .send({})
      .expect(200);
    const consent = new URL(start.body.authorizationUrl);
    expect(consent.pathname).toBe("/api/website/google/callback");
    return http.get(`${consent.pathname}${consent.search}`);
  }

  it("answers 403 not_entitled on every Website route while the switch is off", async () => {
    const company = await seedCompany();
    const http = request(app());
    const propertyId = randomUUID();
    const calls = [
      http.get(`/api/companies/${company.id}/website`),
      http.post(`/api/companies/${company.id}/website/properties`).send({ name: "x", siteUrl: "https://a.example/", ga4PropertyId: "1" }),
      http.patch(`/api/companies/${company.id}/website/properties/${propertyId}`).send({ name: "y" }),
      http.get(`/api/companies/${company.id}/website/properties/${propertyId}/report`),
      http.post(`/api/companies/${company.id}/website/properties/${propertyId}/google/connect`).send({}),
      http.post(`/api/companies/${company.id}/website/properties/${propertyId}/google/disconnect`),
      http.post(`/api/companies/${company.id}/website/properties/${propertyId}/pull`),
      http.get(`/api/website/google/callback?state=x&code=y`),
    ];
    for (const response of await Promise.all(calls)) {
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("not_entitled");
    }
    expect(await db.select().from(websiteProperties)).toEqual([]);

    await enableWebsiteView();
    await http.get(`/api/companies/${company.id}/website`).expect(200);
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: false });
    const off = await http.get(`/api/companies/${company.id}/website`);
    expect(off.status).toBe(403);
    expect(off.body.code).toBe("not_entitled");
  });

  it("connects Google, pulls from fixtures and reads the stored report end to end", async () => {
    await enableWebsiteView();
    const company = await seedCompany();
    const property = await createProperty(company.id);
    expect(property).toMatchObject({ ga4PropertyId: "123456789", connectionStatus: "not_connected", lastPullAt: null });

    const callback = await connect(company.id, property.id);
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe(`/${company.issuePrefix}/website?websiteGoogle=connected`);

    // The refresh token is in the vault, not on the property row.
    const [row] = await db.select().from(websiteProperties).where(eq(websiteProperties.id, property.id));
    expect(row!.connectionStatus).toBe("connected");
    expect(row!.googleTokenSecretId).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain("fixture-refresh-token");
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, row!.googleTokenSecretId!));
    expect(secret!.companyId).toBe(company.id);

    const http = request(app());
    const pull = await http.post(`/api/companies/${company.id}/website/properties/${property.id}/pull`).expect(200);
    expect(pull.body).toMatchObject({ status: "succeeded", trigger: "manual", errors: [] });

    const report = (await http.get(`/api/companies/${company.id}/website/properties/${property.id}/report`).expect(200))
      .body as WebsiteReport;
    expect(report.property.lastPullAt).toBeTruthy();
    expect(report.property.lastPullStatus).toBe("succeeded");
    expect(report.lastPull?.id).toBe(pull.body.id);
    expect(report.ga4?.totals).toMatchObject({ visitors: 2140, pageViews: 4116 });
    expect(report.ga4?.sources[0]).toEqual({ source: "google", medium: "organic", sessions: 1810, visitors: 1402 });
    expect(report.ga4?.topPages).toHaveLength(6);
    expect(report.ga4?.conversions[0]).toEqual({ eventName: "generate_lead", count: 41 });
    expect(report.ga4?.dailyTrend).toHaveLength(28);
    expect(report.ga4?.dailyTrend[0]?.date).toBe("2026-09-11");
    expect(report.searchConsole?.queries[0]).toMatchObject({ query: "greatstone international", clicks: 210 });
    expect(report.searchConsole?.totals.averagePosition).toBe(10.82);
    expect(report.searchConsole?.pagesInspected).toBe(6);
    expect(report.searchConsole?.pagesNotIndexed.map((page) => page.url).sort()).toEqual([
      "https://www.example.com/contact",
      "https://www.example.com/insights/old-announcement",
    ]);

    const overview = await http.get(`/api/companies/${company.id}/website`).expect(200);
    expect(overview.body.googleSignInAvailable).toBe(true);
    expect(overview.body.properties[0]).toMatchObject({ id: property.id, connectionStatus: "connected" });

    const disconnected = await http
      .post(`/api/companies/${company.id}/website/properties/${property.id}/google/disconnect`)
      .expect(200);
    expect(disconnected.body.connectionStatus).toBe("not_connected");
    const [afterDisconnect] = await db.select().from(websiteProperties).where(eq(websiteProperties.id, property.id));
    expect(afterDisconnect!.googleTokenSecretId).toBeNull();
    // Stored reports stay readable after disconnect.
    const kept = await http.get(`/api/companies/${company.id}/website/properties/${property.id}/report`).expect(200);
    expect(kept.body.ga4.totals.visitors).toBe(2140);
  });

  it("records pull errors per source and asks for a reconnect when Google access is gone", async () => {
    await enableWebsiteView();
    const company = await seedCompany();
    const property = await createProperty(company.id);
    await connect(company.id, property.id);

    const fixtures = createFixtureGoogleClient();
    const ga4Down: WebsiteGoogleClient = {
      ...fixtures,
      async batchRunReports() {
        throw new GoogleApiError("Google Analytics: User does not have sufficient permissions for this property.", 403);
      },
    };
    const partial = await request(app(localBoard, ga4Down))
      .post(`/api/companies/${company.id}/website/properties/${property.id}/pull`)
      .expect(200);
    expect(partial.body.status).toBe("partial");
    expect(partial.body.errors).toEqual([
      { source: "ga4", message: "Google Analytics: User does not have sufficient permissions for this property." },
    ]);
    const report = await request(app()).get(`/api/companies/${company.id}/website/properties/${property.id}/report`).expect(200);
    expect(report.body.property.lastPullErrors).toHaveLength(1);
    expect(report.body.ga4).toBeNull();
    expect(report.body.searchConsole.queries.length).toBeGreaterThan(0);

    const revoked: WebsiteGoogleClient = {
      ...fixtures,
      async refreshAccessToken() {
        throw new GoogleApiError("Google sign-in failed: invalid_grant", 400, true);
      },
    };
    const failed = await request(app(localBoard, revoked))
      .post(`/api/companies/${company.id}/website/properties/${property.id}/pull`)
      .expect(200);
    expect(failed.body.status).toBe("failed");
    expect(failed.body.errors[0]).toMatchObject({ source: "auth" });
    const [row] = await db.select().from(websiteProperties).where(eq(websiteProperties.id, property.id));
    expect(row!.connectionStatus).toBe("needs_reconnect");
    // Last good Search Console data is still served alongside the error.
    const after = await request(app()).get(`/api/companies/${company.id}/website/properties/${property.id}/report`).expect(200);
    expect(after.body.lastPull.status).toBe("failed");
    expect(after.body.searchConsole).not.toBeNull();
  });

  it("pulls each connected property once a day from the scheduler", async () => {
    await enableWebsiteView();
    const company = await seedCompany();
    const connected = await createProperty(company.id);
    await connect(company.id, connected.id);
    const http = request(app());
    await http
      .post(`/api/companies/${company.id}/website/properties`)
      .send({ name: "Not connected", siteUrl: "sc-domain:example.org", ga4PropertyId: "987" })
      .expect(201);

    const service = websiteService(db, { googleClient: createFixtureGoogleClient() });
    const now = new Date("2026-10-09T06:00:00Z");
    const first = await service.tickDuePulls(now);
    expect(first.results).toEqual([{ propertyId: connected.id, status: "succeeded" }]);
    const pulls = await db.select().from(websitePulls);
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toMatchObject({ trigger: "schedule", rangeStart: "2026-09-11", rangeEnd: "2026-10-08" });

    const sameDay = await service.tickDuePulls(new Date(Date.now() + 60 * 60 * 1000));
    expect(sameDay.results).toEqual([]);
    const nextDay = await service.tickDuePulls(new Date(Date.now() + 25 * 60 * 60 * 1000));
    expect(nextDay.results).toHaveLength(1);
  });

  it("keeps each company's websites to that company", async () => {
    await enableWebsiteView();
    const companyA = await seedCompany("Company A");
    const companyB = await seedCompany("Company B");
    const property = await createProperty(companyA.id);

    const outsider = request(app(memberActor(companyB.id, "owner")));
    const denied = await outsider.get(`/api/companies/${companyA.id}/website/properties/${property.id}/report`);
    expect(denied.status).toBe(403);
    // Another company's property id under your own company is not found.
    await outsider.get(`/api/companies/${companyB.id}/website/properties/${property.id}/report`).expect(404);
    await outsider
      .post(`/api/companies/${companyB.id}/website/properties/${property.id}/google/connect`)
      .send({})
      .expect(404);
    const listB = await outsider.get(`/api/companies/${companyB.id}/website`).expect(200);
    expect(listB.body.properties).toEqual([]);
  });

  it("lets only owners and admins connect, and only the starting user finish sign-in", async () => {
    await enableWebsiteView();
    const company = await seedCompany();
    const property = await createProperty(company.id);

    const operator = request(app(memberActor(company.id, "operator")));
    await operator
      .post(`/api/companies/${company.id}/website/properties/${property.id}/google/connect`)
      .send({})
      .expect(403);
    await operator.get(`/api/companies/${company.id}/website/properties/${property.id}/report`).expect(200);

    const agent = request(app({ type: "agent", companyId: company.id, agentId: randomUUID(), runId: null, source: "agent_jwt" } as Express.Request["actor"]));
    await agent.post(`/api/companies/${company.id}/website/properties/${property.id}/pull`).expect(403);

    const owner = memberActor(company.id, "owner", "owner-1");
    const start = await request(app(owner))
      .post(`/api/companies/${company.id}/website/properties/${property.id}/google/connect`)
      .set("host", "127.0.0.1:3100")
      .send({ returnTo: "/settings" })
      .expect(200);
    const consent = new URL(start.body.authorizationUrl);
    const otherOwner = request(app(memberActor(company.id, "owner", "owner-2")));
    const hijack = await otherOwner.get(`${consent.pathname}${consent.search}`);
    expect(hijack.status).toBe(403);
    expect(hijack.body.code).toBe("website_google_user_mismatch");

    const done = await request(app(owner)).get(`${consent.pathname}${consent.search}`);
    expect(done.status).toBe(302);
    expect(done.headers.location).toBe("/settings?websiteGoogle=connected");
    // State is single use.
    const replay = await request(app(owner)).get(`${consent.pathname}${consent.search}`);
    expect(replay.status).toBe(400);
  });

  it("says when Google sign-in is not set up on the instance", async () => {
    await enableWebsiteView();
    const company = await seedCompany();
    const property = await createProperty(company.id, request(app(localBoard, null)));
    const overview = await request(app(localBoard, null)).get(`/api/companies/${company.id}/website`).expect(200);
    expect(overview.body.googleSignInAvailable).toBe(false);
    const start = await request(app(localBoard, null))
      .post(`/api/companies/${company.id}/website/properties/${property.id}/google/connect`)
      .set("host", "127.0.0.1:3100")
      .send({});
    expect(start.status).toBe(400);
    expect(start.body.code).toBe("website_google_not_configured");
  });
});
