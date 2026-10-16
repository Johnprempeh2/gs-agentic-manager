import request from "supertest";
import { expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agentApiKeys,
  agents,
  approvals,
  heartbeatRuns,
  memoryOperations,
  memoryScopes,
  memorySettings,
  principalPermissionGrants,
} from "@greatstone/db";
import { memoryConnectionRoutes } from "../routes/memory-connections.js";
import type { MemoryEngine } from "../services/memory-gateway/engine.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

const engine: MemoryEngine = {
  async retain() {},
  async recall() {
    return [];
  },
  async deleteDocument() {},
};

describeEmbeddedPostgres("memory connections for Claude, Codex and other MCP apps", () => {
  const ctx = useEmbeddedPostgres("gsam-memory-connections-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(approvals);
      await db.delete(memoryOperations);
      await db.delete(memoryScopes);
      await db.delete(memorySettings);
      await db.delete(principalPermissionGrants);
      await db.delete(agentApiKeys);
      await db.delete(heartbeatRuns);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function setup(name: string, enabled = true) {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, name);
    if (enabled) await ctx.db.insert(memorySettings).values({ companyId: seeded.companyId, enabled: true });
    const factory = (db: typeof ctx.db) => memoryConnectionRoutes(db, { engine });
    const board = routeApp(ctx.db, seeded.actor, factory);
    const operator = routeApp(
      ctx.db,
      { ...seeded.actor, userId: "user-operator", memberships: [{ companyId: seeded.companyId, membershipRole: "operator", status: "active" }] },
      factory,
    );
    const base = `/api/companies/${seeded.companyId}/memory/connections`;
    return { ...seeded, board, operator, factory, base };
  }

  it("creates a paused link agent with a memory-only key and a contribute grant, reuses it and revokes it", async () => {
    const { board, base, companyId, factory } = await setup("Links");

    const created = await request(board).post(base).send({ app: "claude", canContribute: true });
    expect(created.status).toBe(201);
    expect(typeof created.body.token).toBe("string");
    expect(created.body.connection).toMatchObject({ app: "claude", canContribute: true });
    expect(created.body.connection.keys).toHaveLength(1);

    const [agent] = await ctx.db.select().from(agents).where(eq(agents.id, created.body.connection.agentId));
    expect(agent).toMatchObject({ companyId, status: "paused" });
    const [key] = await ctx.db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, agent.id));
    expect(key.scopeConfig).toEqual({ kind: "memory_only" });
    expect(JSON.stringify(key)).not.toContain(created.body.token);

    // A second link for the same person and app adds a key to the same agent.
    const again = await request(board).post(base).send({ app: "claude" });
    expect(again.body.connection.agentId).toBe(agent.id);
    expect(again.body.connection.keys).toHaveLength(2);
    expect((await ctx.db.select().from(agents)).filter((row) => row.status !== "terminated")).toHaveLength(1);

    const quiet = await request(board).get(`${base}/${agent.id}/activity`);
    expect(quiet.status).toBe(200);
    expect(quiet.body).toEqual({ lastUsedAt: null, operations: [], contributions: [] });
    await ctx.db.insert(memoryOperations).values({
      companyId,
      operation: "recall",
      outcome: "ok",
      actorType: "agent",
      actorId: agent.id,
      agentId: agent.id,
      app: "memory_key",
    });
    const busy = await request(board).get(`${base}/${agent.id}/activity`);
    expect(busy.body.operations).toEqual([expect.objectContaining({ operation: "recall", outcome: "ok" })]);

    const listed = await request(board).get(base);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);

    // The key itself cannot manage links.
    const asKey = routeApp(ctx.db, { type: "agent", agentId: agent.id, companyId, runId: null, source: "agent_key", keyScope: { kind: "memory_only" } } as never, factory);
    expect((await request(asKey).get(base)).status).toBe(403);
    expect((await request(asKey).post(base).send({ app: "codex" })).status).toBe(403);
    expect((await request(asKey).get(`${base}/${agent.id}/activity`)).status).toBe(403);

    const revoked = await request(board).delete(`${base}/${agent.id}`);
    expect(revoked.status).toBe(200);
    const live = await ctx.db.select().from(agentApiKeys).where(and(eq(agentApiKeys.agentId, agent.id)));
    expect(live.every((row) => row.revokedAt !== null)).toBe(true);
    expect((await request(board).get(base)).body).toEqual([]);

    const actions = (await ctx.db.select().from(activityLog)).map((row) => row.action);
    expect(actions.filter((action) => action === "memory.connection_created")).toHaveLength(2);
    expect(actions).toContain("memory.connection_revoked");
  });

  it("gives each person their own link; a person sees and cuts off only their own (GRE-1081)", async () => {
    const { board, operator, base } = await setup("Operator");
    const mine = await request(operator).post(base).send({ app: "codex", canContribute: true });
    expect(mine.status).toBe(201);
    expect(mine.body.connection).toMatchObject({ app: "codex", createdByUserId: "user-operator", canContribute: true });
    const owners = await request(board).post(base).send({ app: "codex" });
    expect(owners.status).toBe(201);
    // Same app, different person: a separate link agent and a separate key.
    expect(owners.body.connection.agentId).not.toBe(mine.body.connection.agentId);
    expect(owners.body.token).not.toBe(mine.body.token);

    expect((await request(operator).get(base)).body.map((c: { agentId: string }) => c.agentId)).toEqual([mine.body.connection.agentId]);
    expect((await request(board).get(base)).body).toHaveLength(2);
    // Someone else's link answers like a missing one.
    expect((await request(operator).get(`${base}/${owners.body.connection.agentId}/activity`)).status).toBe(404);
    expect((await request(operator).delete(`${base}/${owners.body.connection.agentId}`)).status).toBe(404);
    // An owner or admin may cut off anyone's link.
    expect((await request(board).delete(`${base}/${mine.body.connection.agentId}`)).status).toBe(200);
    expect((await request(operator).get(base)).body).toEqual([]);
  });

  it("is only while memory is on", async () => {
    const off = await setup("Off", false);
    expect((await request(off.board).post(off.base).send({ app: "codex" })).status).toBe(404);
  });
});
