import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import {
  activityLog,
  agentQaLogins,
  agents,
  authAccounts,
  authSessions,
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  principalPermissionGrants,
  type Db,
} from "@greatstone/db";
import { describe, expect, it } from "vitest";
import { agentQaLoginRoutes } from "../routes/agent-qa-logins.js";
import { qaLoginDeniedReason } from "../middleware/qa-login-guard.js";
import { agentQaLoginService, qaLoginEmail } from "../services/agent-qa-logins.js";
import { authorizationService } from "../services/authorization.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

const DAY = 24 * 60 * 60 * 1000;

describe("qaLoginDeniedReason (GRE-2387)", () => {
  it.each([
    ["POST", "/approvals/a1/approve", "approve cards"],
    ["POST", "/approvals/a1/reject", "approve cards"],
    ["POST", "/issues/i1/interactions/x1/accept", "answer Decisions cards"],
    ["POST", "/issues/i1/interactions/x1/respond", "answer Decisions cards"],
    ["POST", "/companies/c1/website/sites/s1/publish", "publish"],
    ["POST", "/companies/c1/releases/release", "publish"],
    ["PATCH", "/companies/c1/budgets", "move money"],
    ["POST", "/companies/c1/budgets/top-ups", "move money"],
    ["PATCH", "/agents/a1/budgets", "move money"],
    ["PUT", "/instance/billing-account", "move money"],
    ["POST", "/cli-auth/challenges/c1/approve", "make API keys"],
    ["POST", "/board-api-keys", "make API keys"],
    ["POST", "/auth/update-user", "change its own log-in"],
    ["POST", "/auth/change-email", "change its own log-in"],
    ["PATCH", "/companies/c1/members/m1", "change members"],
    ["POST", "/companies/c1/invites", "change members"],
    ["POST", "/agents/a1/qa-login", "change QA access"],
  ])("refuses %s %s", (method, path, what) => {
    expect(qaLoginDeniedReason(method, path)).toBe(what);
  });

  it.each([
    ["GET", "/approvals/a1"],
    ["GET", "/companies/c1/budgets/overview"],
    ["POST", "/issues/i1/comments"],
    ["PATCH", "/issues/i1"],
    ["POST", "/auth/sign-out"],
  ])("lets %s %s through", (method, path) => {
    expect(qaLoginDeniedReason(method, path)).toBeNull();
  });
});

describe("qaLoginEmail", () => {
  it("is qa-<agent>@<company>.local", () => {
    expect(qaLoginEmail("Flint", "GRE")).toBe("qa-flint@gre.local");
    expect(qaLoginEmail("Summit QA", "GRE")).toBe("qa-summit-qa@gre.local");
  });
});

describeEmbeddedPostgres("agentQaLoginService (GRE-2387)", () => {
  const ctx = useEmbeddedPostgres("gsam-agent-qa-logins-", {
    resetEach: async (db) => {
      await db.delete(agentQaLogins);
      await db.delete(activityLog);
      await db.delete(boardApiKeys);
      await db.delete(authSessions);
      await db.delete(authAccounts);
      await db.delete(authUsers);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function seed(db: Db) {
    const seeded = await seedCompanyWithBoardAccess(db, "QA");
    const agent = await db
      .insert(agents)
      .values({ companyId: seeded.companyId, name: "Flint", role: "qa", adapterType: "process", adapterConfig: {} })
      .returning()
      .then((rows) => rows[0]!);
    const prefix = await db.select({ p: companies.issuePrefix }).from(companies).where(eq(companies.id, seeded.companyId)).then((r) => r[0]!.p);
    return { ...seeded, agentId: agent.id, prefix };
  }

  async function membership(db: Db, companyId: string, userId: string) {
    return db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, userId)))
      .then((r) => r[0] ?? null);
  }

  async function actions(db: Db, companyId: string) {
    return db
      .select({ action: activityLog.action, actorType: activityLog.actorType })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId))
      .then((rows) => rows.map((r) => `${r.actorType}:${r.action}`).sort());
  }

  it("makes a QA member log-in with no password, the chosen role and a 7-day expiry", async () => {
    const { companyId, userId, agentId, prefix } = await seed(ctx.db);
    const now = new Date("2026-10-25T10:00:00Z");
    const qa = await agentQaLoginService(ctx.db).grant({ companyId, agentId, role: "viewer", grantedByUserId: userId, now });

    expect(qa.email).toBe(qaLoginEmail("Flint", prefix));
    expect(qa.expiresAt).toBe(new Date(now.getTime() + 7 * DAY).toISOString());
    const user = await ctx.db.select().from(authUsers).where(eq(authUsers.id, qa.userId)).then((r) => r[0]!);
    expect(user.name).toBe("QA for Flint");
    // Nobody can sign in to it with a password: there is no credential account.
    expect(await ctx.db.select().from(authAccounts).where(eq(authAccounts.userId, qa.userId))).toEqual([]);
    const member = await membership(ctx.db, companyId, qa.userId);
    expect(member).toMatchObject({ status: "active", membershipRole: "viewer" });
    expect(await actions(ctx.db, companyId)).toEqual(["user:agent_qa_login.granted"]);
  });

  it("refuses Owner and Admin, a bad expiry, and a second grant", async () => {
    const { companyId, userId, agentId } = await seed(ctx.db);
    const svc = agentQaLoginService(ctx.db);
    await expect(svc.grant({ companyId, agentId, role: "owner", grantedByUserId: userId })).rejects.toMatchObject({ status: 422 });
    await expect(svc.grant({ companyId, agentId, role: "admin", grantedByUserId: userId })).rejects.toMatchObject({ status: 422 });
    await expect(svc.grant({ companyId, agentId, role: "viewer", expiresInDays: 0, grantedByUserId: userId })).rejects.toMatchObject({ status: 422 });
    await expect(svc.grant({ companyId, agentId, role: "viewer", expiresInDays: 31, grantedByUserId: userId })).rejects.toMatchObject({ status: 422 });
    await svc.grant({ companyId, agentId, role: "operator", grantedByUserId: userId });
    await expect(svc.grant({ companyId, agentId, role: "viewer", grantedByUserId: userId })).rejects.toMatchObject({ status: 409 });
  });

  it("revoke suspends the log-in and removes its rights, sessions and board keys", async () => {
    const { companyId, userId, agentId } = await seed(ctx.db);
    const svc = agentQaLoginService(ctx.db);
    const qa = await svc.grant({ companyId, agentId, role: "operator", grantedByUserId: userId });
    const now = new Date();
    await ctx.db.insert(authSessions).values({ id: randomUUID(), token: "t", userId: qa.userId, expiresAt: new Date(now.getTime() + DAY), createdAt: now, updatedAt: now });
    await ctx.db.insert(boardApiKeys).values({ userId: qa.userId, name: "k", keyHash: "h" });
    expect((await svc.standingForUser(qa.userId)).kind).toBe("active");

    const ended = await svc.revoke({ companyId, agentId, byUserId: userId });
    expect(ended.status).toBe("revoked");
    expect(await membership(ctx.db, companyId, qa.userId)).toMatchObject({ status: "suspended" });
    expect(await ctx.db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, qa.userId))).toEqual([]);
    expect(await ctx.db.select().from(authSessions).where(eq(authSessions.userId, qa.userId))).toEqual([]);
    const [key] = await ctx.db.select().from(boardApiKeys).where(eq(boardApiKeys.userId, qa.userId));
    expect(key!.revokedAt).not.toBeNull();
    expect((await svc.standingForUser(qa.userId)).kind).toBe("inactive");
    expect(await actions(ctx.db, companyId)).toEqual(["user:agent_qa_login.granted", "user:agent_qa_login.revoked"]);
  });

  it("is shut out at expiry even before the sweep, and the sweep ends it once", async () => {
    const { companyId, userId, agentId } = await seed(ctx.db);
    const svc = agentQaLoginService(ctx.db);
    const start = new Date("2026-10-25T10:00:00Z");
    const qa = await svc.grant({ companyId, agentId, role: "viewer", expiresInDays: 1, grantedByUserId: userId, now: start });
    const later = new Date(start.getTime() + DAY + 1000);

    expect((await svc.standingForUser(qa.userId, later)).kind).toBe("inactive");
    expect(await svc.reapExpired(later)).toBe(1);
    expect(await svc.reapExpired(later)).toBe(0);
    expect(await membership(ctx.db, companyId, qa.userId)).toMatchObject({ status: "suspended" });
    expect(await actions(ctx.db, companyId)).toEqual(["system:agent_qa_login.expired", "user:agent_qa_login.granted"]);
  });

  it("gives the same log-in back when the agent gets access again", async () => {
    const { companyId, userId, agentId } = await seed(ctx.db);
    const svc = agentQaLoginService(ctx.db);
    const first = await svc.grant({ companyId, agentId, role: "viewer", grantedByUserId: userId });
    await svc.revoke({ companyId, agentId, byUserId: userId });
    const second = await svc.grant({ companyId, agentId, role: "operator", grantedByUserId: userId });
    expect(second.userId).toBe(first.userId);
    expect(await membership(ctx.db, companyId, second.userId)).toMatchObject({ status: "active", membershipRole: "operator" });
  });

  it("never lets an extra grant give a QA log-in publish or other rights", async () => {
    const { companyId, userId, agentId } = await seed(ctx.db);
    const qa = await agentQaLoginService(ctx.db).grant({ companyId, agentId, role: "operator", grantedByUserId: userId });
    await ctx.db.insert(principalPermissionGrants).values(
      (["website:publish", "agents:create", "users:manage_permissions"] as const).map((permissionKey) => ({
        companyId,
        principalType: "user",
        principalId: qa.userId,
        permissionKey,
        scope: null,
      })),
    );
    const authz = authorizationService(ctx.db);
    const decide = (permissionKey: "website:publish" | "agents:create" | "users:manage_permissions" | "tasks:assign" | "website:edit") =>
      authz.decidePrincipalGrant({ companyId, principalType: "user", principalId: qa.userId, permissionKey, action: permissionKey }).then((d) => d.allowed);
    expect(await decide("website:publish")).toBe(false);
    expect(await decide("agents:create")).toBe(false);
    expect(await decide("users:manage_permissions")).toBe(false);
    // The Operator role's own defaults still work.
    expect(await decide("tasks:assign")).toBe(true);
    expect(await decide("website:edit")).toBe(true);
  });

  it("routes: only a board owner gives or revokes access", async () => {
    const { companyId, agentId, actor } = await seed(ctx.db);
    const operatorActor = { ...actor, userId: "user-operator", memberships: [{ companyId, membershipRole: "operator", status: "active" }] };
    await request(routeApp(ctx.db, operatorActor, agentQaLoginRoutes)).post(`/api/agents/${agentId}/qa-login`).send({ role: "viewer" }).expect(403);

    const ownerApp = routeApp(ctx.db, actor, agentQaLoginRoutes);
    const created = await request(ownerApp).post(`/api/agents/${agentId}/qa-login`).send({ role: "operator", expiresInDays: 3 }).expect(201);
    expect(created.body.qaLogin).toMatchObject({ role: "operator", status: "active" });
    const read = await request(ownerApp).get(`/api/agents/${agentId}/qa-login`).expect(200);
    expect(read.body.qaLogin.id).toBe(created.body.qaLogin.id);
    await request(ownerApp).post(`/api/agents/${agentId}/qa-login`).send({ role: "admin" }).expect(422);
    await request(ownerApp).post(`/api/agents/${agentId}/qa-login`).send({ role: "viewer" }).expect(409);

    const qaActor = { ...actor, userId: created.body.qaLogin.userId, qaLogin: { loginId: "x", companyId, agentId, expiresAt: "" } } as typeof actor;
    await request(routeApp(ctx.db, qaActor, agentQaLoginRoutes)).delete(`/api/agents/${agentId}/qa-login`).expect(403);

    const revoked = await request(ownerApp).delete(`/api/agents/${agentId}/qa-login`).expect(200);
    expect(revoked.body.qaLogin.status).toBe("revoked");
    expect((await request(ownerApp).get(`/api/agents/${agentId}/qa-login`).expect(200)).body.qaLogin).toBeNull();
  });
});
