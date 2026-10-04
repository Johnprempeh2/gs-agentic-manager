import { randomUUID } from "node:crypto";
import request from "supertest";
import { expect, it } from "vitest";
import {
  activityLog,
  agents,
  heartbeatRuns,
  issues,
  memoryOperations,
  memoryRecords,
  memoryScopes,
  memorySettings,
  runIdentityContexts,
} from "@greatstone/db";
import { memoryRoutes } from "../routes/memory.js";
import { memoryToolRoutes } from "../routes/memory-tools.js";
import { companyMemoryEnabled } from "../services/memory-gateway/service.js";
import type { MemoryEngine, MemoryEngineDocument } from "../services/memory-gateway/engine.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

function fakeEngine() {
  const docs: MemoryEngineDocument[] = [];
  const engine: MemoryEngine = {
    async retain(doc) {
      docs.push(doc);
    },
    async recall(req) {
      return docs
        .filter((doc) => doc.bankId === req.bankId && doc.tags.some((tag) => req.tags.includes(tag)))
        .map((doc) => ({ documentId: doc.documentId, text: doc.content, score: 0.5 }));
    },
    async deleteDocument() {},
  };
  return { engine, docs };
}

describeEmbeddedPostgres("agent memory tools (MCP)", () => {
  const ctx = useEmbeddedPostgres("gsam-memory-tools-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(memoryOperations);
      await db.delete(memoryRecords);
      await db.delete(memoryScopes);
      await db.delete(memorySettings);
      await db.delete(runIdentityContexts);
      await db.delete(heartbeatRuns);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function seedRun(companyId: string, name: string) {
    const [agent] = await ctx.db
      .insert(agents)
      .values({
        companyId,
        name,
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning();
    const issueId = randomUUID();
    await ctx.db.insert(issues).values({ id: issueId, companyId, title: `${name} task`, status: "in_progress", priority: "medium" });
    const runId = randomUUID();
    await ctx.db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: agent.id,
      status: "running",
      contextSnapshot: { issueId },
    });
    return { agentId: agent.id, runId, issueId };
  }

  function runActor(companyId: string, agentId: string, runId: string) {
    return { type: "agent", source: "agent_jwt", agentId, companyId, runId } as never;
  }

  let rpcId = 0;
  function rpc(app: ReturnType<typeof routeApp>, method: string, params?: Record<string, unknown>) {
    return request(app).post("/api/mcp/memory-tools").send({ jsonrpc: "2.0", id: ++rpcId, method, ...(params ? { params } : {}) });
  }
  function callTool(app: ReturnType<typeof routeApp>, name: string, args: Record<string, unknown>) {
    return rpc(app, "tools/call", { name, arguments: args });
  }

  async function setup(name: string) {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, name);
    const fake = fakeEngine();
    const tools = (db: typeof ctx.db) => memoryToolRoutes(db, { engine: fake.engine });
    const board = routeApp(ctx.db, seeded.actor, (db) => memoryRoutes(db, { engine: fake.engine }));
    const asRun = (agentId: string, runId: string, companyId = seeded.companyId) =>
      routeApp(ctx.db, runActor(companyId, agentId, runId), tools);
    return { ...seeded, fake, board, asRun };
  }

  it("is unreachable while the company setting is off, and the heartbeat does not offer it", async () => {
    const { companyId, asRun, board } = await setup("Off");
    const run = await seedRun(companyId, "Mason");
    const app = asRun(run.agentId, run.runId);
    expect(await companyMemoryEnabled(ctx.db, companyId)).toBe(false);
    for (const res of [
      await rpc(app, "initialize"),
      await rpc(app, "tools/list"),
      await callTool(app, "memory_recall", { query: "anything" }),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Memory is not enabled for this company");
    }

    await request(board).patch(`/api/companies/${companyId}/memory/settings`).send({ enabled: true });
    expect(await companyMemoryEnabled(ctx.db, companyId)).toBe(true);
    const list = await rpc(app, "tools/list");
    expect(list.status).toBe(200);
    expect(list.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "memory_recall",
      "memory_contribute",
      "memory_get",
    ]);
  });

  it("contributes, recalls and gets under the run's identity", async () => {
    const { companyId, asRun, board } = await setup("Tools");
    await request(board).patch(`/api/companies/${companyId}/memory/settings`).send({ enabled: true, retainMode: "chunks" });
    const run = await seedRun(companyId, "Mason");
    const app = asRun(run.agentId, run.runId);

    const added = await callTool(app, "memory_contribute", { content: "Kestrel Works pays on 30-day terms", entities: ["Kestrel Works"] });
    expect(added.body.result.isError).toBeUndefined();
    const record = added.body.result.structuredContent.record;
    expect(record).toMatchObject({ contributorAgentId: run.agentId, runId: run.runId, scopeKind: "agent", retainMode: "chunks" });

    const recalled = await callTool(app, "memory_recall", { query: "terms", scopes: ["my_notes"] });
    expect(recalled.body.result.structuredContent).toMatchObject({ available: true });
    expect(recalled.body.result.structuredContent.results[0].record.id).toBe(record.id);

    const got = await callTool(app, "memory_get", { recordId: record.id });
    expect(got.body.result.structuredContent.content).toBe("Kestrel Works pays on 30-day terms");
  });

  it("rejects forged identity in arguments and runs that are not the caller's", async () => {
    const one = await setup("One");
    const two = await setup("Two");
    for (const s of [one, two]) {
      await request(s.board).patch(`/api/companies/${s.companyId}/memory/settings`).send({ enabled: true });
    }
    const mason = await seedRun(one.companyId, "Mason");
    const ridge = await seedRun(one.companyId, "Ridge");
    const outsider = await seedRun(two.companyId, "Outsider");
    const masonApp = one.asRun(mason.agentId, mason.runId);

    // Arguments cannot carry a contributor, company or run.
    for (const forged of [{ contributorAgentId: ridge.agentId }, { companyId: two.companyId }, { runId: ridge.runId }]) {
      const res = await callTool(masonApp, "memory_contribute", { content: "x", ...forged });
      expect(res.body.result.isError).toBe(true);
      expect(res.body.result.content[0].text).toMatch(/Invalid arguments/);
    }

    // A token naming Ridge's run but Mason's agent, or another company's run, is refused.
    expect((await rpc(one.asRun(mason.agentId, ridge.runId), "tools/list")).status).toBe(403);
    expect((await rpc(one.asRun(mason.agentId, outsider.runId), "tools/list")).status).toBe(403);
    expect((await rpc(one.asRun(outsider.agentId, outsider.runId), "tools/list")).status).toBe(403);
    // A non-run agent key cannot use the tools.
    const keyApp = routeApp(
      ctx.db,
      { type: "agent", source: "agent_key", agentId: mason.agentId, companyId: one.companyId, runId: null } as never,
      (db) => memoryToolRoutes(db),
    );
    expect((await rpc(keyApp, "tools/list")).status).toBe(403);

    // Ridge's notes stay hidden from Mason's tools.
    const ridgeApp = one.asRun(ridge.agentId, ridge.runId);
    const note = await callTool(ridgeApp, "memory_contribute", { content: "ridge private note" });
    const noteId = note.body.result.structuredContent.record.id;
    const got = await callTool(masonApp, "memory_get", { recordId: noteId });
    expect(got.body.result).toMatchObject({ isError: true, content: [{ text: "Memory record not found" }] });
    const recall = await callTool(masonApp, "memory_recall", { query: "private" });
    expect(recall.body.result.structuredContent.results).toEqual([]);
    const intoRidge = await callTool(masonApp, "memory_contribute", { content: "x", scope: note.body.result.structuredContent.record.scopeId });
    expect(intoRidge.body.result).toMatchObject({ isError: true, content: [{ text: "Memory scope not found" }] });
  });
});
