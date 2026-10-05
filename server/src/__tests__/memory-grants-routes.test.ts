import request from "supertest";
import { expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import {
  activityLog,
  agents,
  approvals,
  heartbeatRuns,
  memoryConflicts,
  memoryIngestOutbox,
  memoryOperations,
  memoryRecords,
  memoryReviewEvents,
  memoryScopes,
  memorySettings,
  principalPermissionGrants,
} from "@greatstone/db";
import type { MemoryScope } from "@greatstone/shared";
import { memoryRoutes } from "../routes/memory.js";
import { accessService } from "../services/access.js";
import type { MemoryEngine } from "../services/memory-gateway/engine.js";
import { permissionGrantRequestService } from "../services/permission-grant-requests.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

// G3 memory rights (GRE-933): only John sets them, through one route, and
// every grant and refusal is audited.

const engine: MemoryEngine = {
  async retain() {},
  async recall() {
    return [];
  },
  async deleteDocument() {},
};

describeEmbeddedPostgres("memory grants (GRE-933)", () => {
  const ctx = useEmbeddedPostgres("gsam-memory-grants-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(approvals);
      await db.delete(memoryConflicts);
      await db.delete(memoryReviewEvents);
      await db.delete(memoryIngestOutbox);
      await db.delete(memoryOperations);
      await db.delete(memoryRecords);
      await db.delete(memoryScopes);
      await db.delete(memorySettings);
      await db.delete(principalPermissionGrants);
      await db.delete(heartbeatRuns);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function seedAgent(companyId: string, name: string, role = "engineer") {
    const [agent] = await ctx.db
      .insert(agents)
      .values({ companyId, name, role, status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
      .returning();
    return agent!;
  }

  async function setup(name: string) {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, name);
    const factory = (db: typeof ctx.db) => memoryRoutes(db, { engine });
    const board = routeApp(ctx.db, seeded.actor, factory);
    const asAgent = (agentId: string) =>
      routeApp(ctx.db, { type: "agent", agentId, companyId: seeded.companyId, runId: null, source: "agent_key" } as never, factory);
    const operator = routeApp(
      ctx.db,
      { ...seeded.actor, userId: "user-operator", memberships: [{ companyId: seeded.companyId, membershipRole: "operator", status: "active" }] },
      factory,
    );
    const base = `/api/companies/${seeded.companyId}/memory`;
    expect((await request(board).patch(`${base}/settings`).send({ enabled: true, retainMode: "chunks" })).status).toBe(200);
    const scopes = (await request(board).get(`${base}/scopes`)).body as MemoryScope[];
    const org = scopes.find((scope) => scope.kind === "organization")!;
    const everest = await seedAgent(seeded.companyId, "Everest", "ceo");
    const mason = await seedAgent(seeded.companyId, "Mason");
    return { ...seeded, board, asAgent, operator, base, org, everest, mason };
  }

  const memoryRows = (companyId: string, principalId: string) =>
    ctx.db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalId, principalId),
          like(principalPermissionGrants.permissionKey, "memory:%"),
        ),
      );

  const audit = (companyId: string, operation: string) =>
    ctx.db
      .select()
      .from(memoryOperations)
      .where(and(eq(memoryOperations.companyId, companyId), eq(memoryOperations.operation, operation)));

  const everestGrant = (agentId: string) => ({
    principalType: "agent",
    principalId: agentId,
    permissions: ["memory:read", "memory:contribute", "memory:approve"],
    reason: "G3: John's decision, 5 Oct",
  });

  it("only the owner sets memory rights; agents and operators are refused and audited", async () => {
    const s = await setup("OwnerOnly");

    // An agent cannot grant itself or another agent anything.
    const self = await request(s.asAgent(s.everest.id)).put(`${s.base}/grants`).send(everestGrant(s.everest.id));
    expect(self.status).toBe(403);
    const other = await request(s.asAgent(s.everest.id)).put(`${s.base}/grants`).send(everestGrant(s.mason.id));
    expect(other.status).toBe(403);
    expect((await request(s.operator).put(`${s.base}/grants`).send(everestGrant(s.mason.id))).status).toBe(403);
    expect((await request(s.asAgent(s.everest.id)).get(`${s.base}/grants`)).status).toBe(403);
    expect(await memoryRows(s.companyId, s.everest.id)).toHaveLength(0);
    expect(await memoryRows(s.companyId, s.mason.id)).toHaveLength(0);
    const refused = (await audit(s.companyId, "grant_set")).filter((row) => row.outcome === "denied");
    expect(refused).toHaveLength(3);
    expect(refused.map((row) => (row.detail as { reason: string }).reason)).toEqual(["not_owner", "not_owner", "not_owner"]);
    expect(refused[0]).toMatchObject({ actorType: "agent", actorId: s.everest.id });

    // John grants Everest; the grant is audited with what changed and why.
    const granted = await request(s.board).put(`${s.base}/grants`).send(everestGrant(s.everest.id));
    expect(granted.status).toBe(200);
    expect(granted.body.permissions).toEqual(["memory:read", "memory:contribute", "memory:approve"]);
    const rows = await memoryRows(s.companyId, s.everest.id);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.scope === null && row.grantedByUserId === s.userId)).toBe(true);
    const [ok] = (await audit(s.companyId, "grant_set")).filter((row) => row.outcome === "ok");
    expect(ok).toMatchObject({ actorType: "user", actorId: s.userId });
    expect(ok!.detail).toMatchObject({ principalId: s.everest.id, before: [], after: ["memory:read", "memory:contribute", "memory:approve"] });
    const listed = await request(s.board).get(`${s.base}/grants`);
    expect(listed.body).toEqual([expect.objectContaining({ principalId: s.everest.id })]);

    // Everest, now holding memory:approve, still cannot widen anything.
    expect((await request(s.asAgent(s.everest.id)).put(`${s.base}/grants`).send(everestGrant(s.mason.id))).status).toBe(403);
    expect(await memoryRows(s.companyId, s.mason.id)).toHaveLength(0);
  });

  it("refuses memory:admin, client scopes and unknown principals, with an audit row", async () => {
    const s = await setup("Refusals");
    const admin = await request(s.board).put(`${s.base}/grants`).send({ ...everestGrant(s.everest.id), permissions: ["memory:admin"] });
    expect(admin.status).toBe(400);
    const scoped = await request(s.board)
      .put(`${s.base}/grants`)
      .send({ ...everestGrant(s.everest.id), scope: { memoryScopeIds: [s.org.id] } });
    expect(scoped.status).toBe(400);
    const ghost = await request(s.board).put(`${s.base}/grants`).send(everestGrant("00000000-0000-4000-8000-000000000000"));
    expect(ghost.status).toBe(404);
    expect(await memoryRows(s.companyId, s.everest.id)).toHaveLength(0);
    const reasons = (await audit(s.companyId, "grant_set")).map((row) => (row.detail as { reason: string }).reason);
    expect(reasons).toEqual(["invalid_body", "invalid_body", "unknown_principal"]);

    // A replace clears any other memory row the principal held, admin included.
    await ctx.db.insert(principalPermissionGrants).values({
      companyId: s.companyId,
      principalType: "agent",
      principalId: s.mason.id,
      permissionKey: "memory:admin",
    });
    expect((await request(s.board).put(`${s.base}/grants`).send({ ...everestGrant(s.mason.id), permissions: ["memory:read"] })).status).toBe(200);
    expect((await memoryRows(s.companyId, s.mason.id)).map((row) => row.permissionKey)).toEqual(["memory:read"]);
    expect((await request(s.board).put(`${s.base}/grants`).send({ ...everestGrant(s.mason.id), permissions: [] })).status).toBe(200);
    expect(await memoryRows(s.companyId, s.mason.id)).toHaveLength(0);
  });

  it("no other grant path can create, widen or remove a memory right", async () => {
    const s = await setup("OtherPaths");
    const access = accessService(ctx.db);
    expect((await request(s.board).put(`${s.base}/grants`).send({ ...everestGrant(s.everest.id), permissions: ["memory:read"] })).status).toBe(200);

    // Member permissions, invites and plugins use setPrincipalGrants / setMemberPermissions.
    await access.setPrincipalGrants(
      s.companyId,
      "agent",
      s.everest.id,
      [{ permissionKey: "tasks:assign" }, { permissionKey: "memory:admin" }, { permissionKey: "memory:approve", scope: { memoryScopeIds: ["x"] } }],
      null,
    );
    await access.ensureMembership(s.companyId, "agent", s.mason.id, "member", "active");
    const member = (await access.listMembers(s.companyId)).find((row) => row.principalId === s.mason.id)!;
    await access.setMemberPermissions(s.companyId, member.id, [{ permissionKey: "memory:approve" }], null);
    await access.updateMemberAndPermissions(s.companyId, member.id, { grants: [{ permissionKey: "memory:delete" }] }, null);
    // Imports, built-in agents and approved permission requests use setPrincipalPermission.
    await access.setPrincipalPermission(s.companyId, "agent", s.mason.id, "memory:contribute", true, null);
    await access.setPrincipalPermission(s.companyId, "agent", s.everest.id, "memory:read", false, null);
    const request_ = await permissionGrantRequestService(ctx.db).recordRefusal({
      companyId: s.companyId,
      agentId: s.mason.id,
      permissionKey: "memory:approve",
    });
    expect(request_).toBeNull();

    // Everest keeps exactly what John granted; Mason has nothing.
    expect((await memoryRows(s.companyId, s.everest.id)).map((row) => row.permissionKey)).toEqual(["memory:read"]);
    expect(await memoryRows(s.companyId, s.mason.id)).toHaveLength(0);
    // Non-memory keys still work through those paths.
    const everestKeys = (await access.listPrincipalGrants(s.companyId, "agent", s.everest.id)).map((row) => row.permissionKey);
    expect(everestKeys).toEqual(["memory:read", "tasks:assign"]);
  });

  it("Everest with the grant approves another agent's operational fact, never owner-only classes or its own", async () => {
    const s = await setup("EverestReview");
    expect((await request(s.board).put(`${s.base}/grants`).send(everestGrant(s.everest.id))).status).toBe(200);
    expect((await request(s.board).put(`${s.base}/grants`).send({ ...everestGrant(s.mason.id), permissions: ["memory:contribute"] })).status).toBe(200);
    const everest = s.asAgent(s.everest.id);
    const mason = s.asAgent(s.mason.id);
    const contribute = async (app: typeof everest, content: string, decisionClass = "operational") => {
      const res = await request(app).post(`${s.base}/records`).send({ scopeId: s.org.id, content, decisionClass, topics: [content.slice(0, 20)] });
      expect(res.status).toBe(201);
      return res.body.record.id as string;
    };
    const approve = (recordId: string) =>
      request(everest).post(`${s.base}/records/${recordId}/review`).send({ action: "approve", reason: "Checked" });

    const operational = await contribute(mason, "Stand-up is at 09:30 on weekdays.");
    expect((await approve(operational)).status).toBe(200);

    for (const decisionClass of ["pricing", "policy", "legal", "client_commitment"]) {
      const id = await contribute(mason, `A ${decisionClass} statement for review.`, decisionClass);
      const res = await approve(id);
      expect(res.status).toBe(403);
    }
    const own = await contribute(everest, "Everest writes the weekly brief on Mondays.");
    expect((await approve(own)).status).toBe(403);

    const denied = (await ctx.db.select().from(memoryOperations).where(eq(memoryOperations.actorId, s.everest.id)))
      .filter((row) => row.outcome === "denied")
      .map((row) => (row.detail as { reason?: string }).reason);
    expect(denied).toEqual(["owner_only", "owner_only", "owner_only", "owner_only", "own_entry"]);
  });
});
