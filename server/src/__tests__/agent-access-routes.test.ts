import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
} from "@greatstone/db";
import type { AgentAccessSummary } from "@greatstone/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent access route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function createRouteApp(db: ReturnType<typeof createDb>, allowedCompanyIds: string[]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "board-user",
      userName: "Board User",
      userEmail: null,
      isInstanceAdmin: false,
      source: "session",
      companyIds: allowedCompanyIds,
    } as typeof req.actor;
    next();
  });
  app.use("/api", toolAccessRoutes(db, { deploymentMode: "authenticated", deploymentExposure: "private" }));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("GET /companies/:companyId/tools/agent-access", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-access-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(connectionGrants);
    await db.delete(toolConnectionInstalls);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(name: string) {
    const company = await db
      .insert(companies)
      .values({ name: `${name} ${randomUUID()}`, issuePrefix: `AA${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "admin",
    });
    return company;
  }

  async function createConnection(
    companyId: string,
    name: string,
    values: Partial<typeof toolConnections.$inferInsert> = {},
  ) {
    const application = await db
      .insert(toolApplications)
      .values({ companyId, name, type: "mcp_http", status: "active", metadata: {} })
      .returning()
      .then((rows) => rows[0]!);
    const connection = await db
      .insert(toolConnections)
      .values({
        companyId,
        applicationId: application.id,
        name,
        uid: `test/${randomUUID()}`,
        transport: "mcp_remote",
        status: "active",
        enabled: true,
        ...values,
      })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(toolConnectionInstalls).values({
      companyId,
      connectionId: connection.id,
      targetType: "company",
      targetId: companyId,
    });
    return connection;
  }

  it("reports healthy, needs-reconnect and missing access for each agent", async () => {
    const company = await createCompany("Access");
    const agent = await db
      .insert(agents)
      .values({ companyId: company.id, name: "Writer" })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(agents).values({ companyId: company.id, name: "Retired", status: "terminated" });

    const healthy = await createConnection(company.id, "Notion", { healthStatus: "ok" });
    const reauth = await createConnection(company.id, "Google Drive", { healthStatus: "ok" });
    await db.insert(connectionGrants).values({
      companyId: company.id,
      connectionId: reauth.id,
      kind: "organization",
      status: "needs_reauthorization",
      isDefault: true,
      providerTenant: { name: "Do not leak", oauth: { refreshTokenExpiresAt: "2099-01-01T00:00:00.000Z" } },
    });
    const perAgent = await createConnection(company.id, "GitHub", {
      healthStatus: "ok",
      credentialPolicy: "per_agent",
    });

    const res = await request(createRouteApp(db, [company.id])).get(
      `/api/companies/${company.id}/tools/agent-access`,
    );

    expect(res.status).toBe(200);
    const body = res.body as AgentAccessSummary;
    expect(body.agents.map((entry) => entry.name)).toEqual(["Writer"]);
    const summary = body.agents[0]!;
    expect(summary.agentId).toBe(agent.id);
    const byId = new Map(summary.items.map((item) => [item.id, item]));
    expect(byId.get(healthy.id)).toMatchObject({ kind: "connection", state: "ok", connectionId: healthy.id });
    expect(byId.get(reauth.id)).toMatchObject({ state: "failing", reason: "Needs to be reconnected" });
    expect(byId.get(perAgent.id)).toMatchObject({ state: "missing", reason: "No sign-in set up for this agent" });
    expect(summary.counts).toEqual({ missing: 1, failing: 1, expiring: 0 });
    expect(JSON.stringify(body)).not.toContain("Do not leak");
    expect(JSON.stringify(body)).not.toContain("providerTenant");
  });

  it("refuses a board user from another company", async () => {
    const mine = await createCompany("Mine");
    const theirs = await createCompany("Theirs");

    const res = await request(createRouteApp(db, [mine.id])).get(
      `/api/companies/${theirs.id}/tools/agent-access`,
    );

    expect(res.status).toBe(403);
  });
});
