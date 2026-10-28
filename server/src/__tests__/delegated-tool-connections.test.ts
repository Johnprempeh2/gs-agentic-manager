import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, authUsers, companies, companyMemberships, connectionGrants, createDb, heartbeatRuns, issues,
  principalPermissionGrants, toolApplications, toolConnectionInstalls, toolConnections } from "@greatstone/db";
import { LOW_TRUST_REVIEW_PRESET } from "@greatstone/shared";
import { delegatedToolConnectionRoutes } from "../routes/delegated-tool-connections.js";
import { toolAccessService } from "../services/tool-access.js";
import { errorHandler } from "../middleware/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("delegated personal tool connections", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("delegated-tool-connections-");
    db = createDb(temp.connectionString);
  }, 20_000);
  afterAll(async () => { await temp?.cleanup(); });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: `Company ${randomUUID()}`, issuePrefix: `DC${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    const userId = `user-${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: "Responsible User", email: `${randomUUID()}@example.com`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Delegated Agent", role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {} }).returning();
    await db.insert(companyMemberships).values([
      { companyId: company.id, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" },
      { companyId: company.id, principalType: "agent", principalId: agent.id, status: "active", membershipRole: "member" },
    ]);
    await db.insert(principalPermissionGrants).values({ companyId: company.id, principalType: "agent", principalId: agent.id, permissionKey: "tools:manage_connections", scope: null });
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Assigned setup", status: "in_progress", workMode: "standard", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "running", responsibleUserId: userId, contextSnapshot: { issueId: issue.id } }).returning();
    await db.update(issues).set({ checkoutRunId: run.id }).where(eq(issues.id, issue.id));
    const [application] = await db.insert(toolApplications).values({ companyId: company.id, name: `App ${randomUUID()}`, type: "mcp_http", status: "active" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: company.id, applicationId: application.id, name: "Personal GitHub", uid: `personal-${randomUUID()}`, transport: "mcp_remote", credentialPolicy: "per_user", connectionPurpose: "tool", createdByUserId: userId, config: { sourceTemplateKey: "github" }, transportConfig: { sourceTemplateKey: "github" } }).returning();
    const actor = { type: "agent" as const, agentId: agent.id, companyId: company.id, runId: run.id, onBehalfOfUserId: userId, source: "agent_jwt" as const };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
    app.use("/api", delegatedToolConnectionRoutes(db, toolAccessService(db, { remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }] })));
    app.use(errorHandler);
    const get = () => request(app).get(`/api/agents/me/tool-connections/${connection.id}`);
    return { company, userId, agent, issue, run, connection, actor, app, get };
  }

  it("allows metadata reads and revokes them with the grant or responsible user", async () => {
    const fx = await fixture();
    const allowed = await fx.get();
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ id: fx.connection.id, provider: "github" });
    expect(allowed.body).not.toHaveProperty("credentialSecretRefs");
    await db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.companyId, fx.company.id), eq(principalPermissionGrants.principalId, fx.agent.id)));
    expect((await fx.get()).status).toBe(403);
    await db.insert(principalPermissionGrants).values({ companyId: fx.company.id, principalType: "agent", principalId: fx.agent.id, permissionKey: "tools:manage_connections", scope: null });
    await db.update(companyMemberships).set({ status: "suspended" }).where(and(eq(companyMemberships.companyId, fx.company.id), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, fx.userId)));
    expect((await fx.get()).status).toBe(403);
  });

  it("creates only a personal draft and leaves credential entry with the user", async () => {
    const fx = await fixture();
    await db.update(principalPermissionGrants).set({ scope: { provider: "arcade", purpose: "tool", operation: "create" } })
      .where(and(eq(principalPermissionGrants.companyId, fx.company.id), eq(principalPermissionGrants.principalId, fx.agent.id)));
    const response = await request(fx.app).post("/api/agents/me/tool-connections").send({
      galleryKey: "arcade", connectionMethodKey: "mcp", name: `Arcade ${randomUUID()}`, link: "https://api.arcade.dev/mcp",
    });
    expect(response.status).toBe(201);
    expect(response.body.requiredUserAction.userId).toBe(fx.userId);
    const [saved] = await db.select().from(toolConnections).where(eq(toolConnections.id, response.body.connectionId));
    expect(saved).toMatchObject({ companyId: fx.company.id, createdByUserId: fx.userId, credentialPolicy: "per_user", status: "draft" });
    expect(saved.credentialSecretRefs).toEqual([]);
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, saved.id))).toEqual([]);
    const unsafe = await request(fx.app).post("/api/agents/me/tool-connections").send({
      galleryKey: "arcade", connectionMethodKey: "mcp", link: "https://api.arcade.dev/mcp?token=secret",
    });
    expect(unsafe.status).toBe(403);
    await db.update(principalPermissionGrants).set({ scope: { connectionId: randomUUID(), provider: "arcade", purpose: "tool", operation: "create" } })
      .where(and(eq(principalPermissionGrants.companyId, fx.company.id), eq(principalPermissionGrants.principalId, fx.agent.id)));
    expect((await request(fx.app).post("/api/agents/me/tool-connections").send({
      galleryKey: "arcade", connectionMethodKey: "mcp", link: "https://api.arcade.dev/mcp",
    })).status).toBe(403);
  });

  it("denies narrow scope mismatches, another user's connection and another company", async () => {
    const fx = await fixture();
    await db.update(principalPermissionGrants).set({ scope: { provider: "slack" } }).where(and(eq(principalPermissionGrants.companyId, fx.company.id), eq(principalPermissionGrants.principalId, fx.agent.id)));
    expect((await fx.get()).status).toBe(403);
    await db.update(principalPermissionGrants).set({ scope: null }).where(and(eq(principalPermissionGrants.companyId, fx.company.id), eq(principalPermissionGrants.principalId, fx.agent.id)));
    const [other] = await db.insert(toolConnections).values({ companyId: fx.company.id, applicationId: fx.connection.applicationId, name: "Someone else's", uid: `other-${randomUUID()}`, transport: "mcp_remote", credentialPolicy: "per_user", connectionPurpose: "tool", createdByUserId: `other-${randomUUID()}` }).returning();
    expect((await request(fx.app).get(`/api/agents/me/tool-connections/${other.id}`)).status).toBe(403);
    const [otherCompany] = await db.insert(companies).values({ name: `Other ${randomUUID()}`, issuePrefix: `OD${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    const [otherApp] = await db.insert(toolApplications).values({ companyId: otherCompany.id, name: "Other", type: "mcp_http", status: "active" }).returning();
    const [foreign] = await db.insert(toolConnections).values({ companyId: otherCompany.id, applicationId: otherApp.id, name: "Foreign", uid: `foreign-${randomUUID()}`, transport: "mcp_remote", credentialPolicy: "per_user", connectionPurpose: "tool", createdByUserId: fx.userId }).returning();
    expect((await request(fx.app).get(`/api/agents/me/tool-connections/${foreign.id}`)).status).toBe(404);
  });

  it("cannot claim another user's archived connection through name recovery", async () => {
    const fx = await fixture();
    const name = `Archived ${randomUUID()}`;
    const [application] = await db.insert(toolApplications).values({ companyId: fx.company.id, name,
      applicationKey: `app-gallery:arcade:${randomUUID()}`, type: "mcp_http", status: "archived",
      metadata: { sourceTemplateKey: "arcade", galleryKey: "arcade" } }).returning();
    const [foreign] = await db.insert(toolConnections).values({ companyId: fx.company.id, applicationId: application.id,
      name, uid: `foreign-${randomUUID()}`, transport: "mcp_remote", credentialPolicy: "per_user",
      connectionPurpose: "tool", status: "archived", createdByUserId: `other-${randomUUID()}`,
      config: { sourceTemplateKey: "arcade", connectionMethodKey: "mcp", url: "https://api.arcade.dev/mcp" } }).returning();
    const response = await request(fx.app).post("/api/agents/me/tool-connections").send({
      galleryKey: "arcade", connectionMethodKey: "mcp", name, link: "https://api.arcade.dev/mcp",
    });
    expect(response.status).toBe(403);
    const [saved] = await db.select().from(toolConnections).where(eq(toolConnections.id, foreign.id));
    expect(saved.status).toBe("archived");
  });

  it("denies low trust, Plan mode and all-agent install targets", async () => {
    const fx = await fixture();
    expect((await request(fx.app).post(`/api/agents/me/tool-connections/${fx.connection.id}/installs/all`)).status).toBe(404);
    await db.update(issues).set({ workMode: "plan" }).where(eq(issues.id, fx.issue.id));
    expect((await fx.get()).status).toBe(403);
    await db.update(issues).set({ workMode: "standard" }).where(eq(issues.id, fx.issue.id));
    await db.update(agents).set({ permissions: { trustPreset: LOW_TRUST_REVIEW_PRESET, authorizationPolicy: { trustBoundary: { mode: LOW_TRUST_REVIEW_PRESET, projectIds: [], rootIssueId: fx.issue.id } } } }).where(eq(agents.id, fx.agent.id));
    expect((await fx.get()).status).toBe(403);
  });

  it("requires current run identity and both principals' authority for a named install", async () => {
    const fx = await fixture();
    const [target] = await db.insert(agents).values({ companyId: fx.company.id, name: "Target", role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {} }).returning();
    const install = () => request(fx.app).post(`/api/agents/me/tool-connections/${fx.connection.id}/installs/${target.id}`);
    expect((await install()).status).toBe(403);
    await db.insert(principalPermissionGrants).values({ companyId: fx.company.id, principalType: "agent", principalId: fx.agent.id, permissionKey: "agents:configure", scope: null });
    expect((await install()).status).toBe(403);
    await db.insert(principalPermissionGrants).values({ companyId: fx.company.id, principalType: "user", principalId: fx.userId, permissionKey: "agents:configure", scope: null });
    await db.insert(toolConnectionInstalls).values({ companyId: fx.company.id, connectionId: fx.connection.id,
      targetType: "company", targetId: fx.company.id });
    expect((await install()).status).toBe(200);
    expect((await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, fx.connection.id))).map(row => row.targetType)).toContain("company");
    await db.update(heartbeatRuns).set({ responsibleUserId: `changed-${randomUUID()}` }).where(eq(heartbeatRuns.id, fx.run.id));
    expect((await fx.get()).status).toBe(403);
    await db.update(heartbeatRuns).set({ responsibleUserId: fx.userId }).where(eq(heartbeatRuns.id, fx.run.id));
    fx.actor.onBehalfOfUserId = "";
    expect((await fx.get()).status).toBe(403);
  });

  it("enforces human authority in shadow mode and stops after cancellation", async () => {
    const fx = await fixture();
    const previous = process.env.GSAM_RESPONSIBLE_USER_AUTHZ_MODE;
    process.env.GSAM_RESPONSIBLE_USER_AUTHZ_MODE = "shadow";
    try {
      await db.update(companyMemberships).set({ membershipRole: "operator" }).where(and(
        eq(companyMemberships.companyId, fx.company.id), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, fx.userId),
      ));
      expect((await fx.get()).status).toBe(403);
      await db.insert(principalPermissionGrants).values({ companyId: fx.company.id, principalType: "user", principalId: fx.userId, permissionKey: "tools:manage_connections", scope: null });
      expect((await fx.get()).status).toBe(200);
      await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, fx.issue.id));
      expect((await fx.get()).status).toBe(403);
    } finally {
      if (previous === undefined) delete process.env.GSAM_RESPONSIBLE_USER_AUTHZ_MODE;
      else process.env.GSAM_RESPONSIBLE_USER_AUTHZ_MODE = previous;
    }
  });

  it("rejects task-bridge key scope", async () => {
    const fx = await fixture();
    Object.assign(fx.actor, { keyScope: { kind: "task_bridge" } });
    expect((await fx.get()).status).toBe(403);
  });
});
