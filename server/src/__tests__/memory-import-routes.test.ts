import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import request from "supertest";
import { expect, it } from "vitest";
import {
  activityLog,
  agents,
  heartbeatRuns,
  memoryIngestOutbox,
  memoryOperations,
  memoryRecords,
  memoryScopes,
  memorySettings,
  principalPermissionGrants,
} from "@greatstone/db";
import type { MemoryScope } from "@greatstone/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { HTTP_LOG_REDACT_PATHS } from "../middleware/http-log-redaction.js";
import { createHttpLogger } from "../middleware/logger.js";
import { memoryRoutes } from "../routes/memory.js";
import { accessService } from "../services/access.js";
import {
  createEngineCallSlots,
  MEMORY_DIRECT_RETAIN_CONCURRENCY,
  MemoryEngineUnavailableError,
  type MemoryEngine,
  type MemoryEngineDocument,
  type MemoryEngineRecallRequest,
} from "../services/memory-gateway/engine.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

/**
 * Test double of the engine. It answers like Hindsight with strict tag
 * matching: a document is returned only from the bank asked for and only if
 * it carries one of the requested tags.
 */
function fakeEngine() {
  const docs: MemoryEngineDocument[] = [];
  const state = {
    docs,
    mode: "up" as "up" | "down" | "hang",
    modelCalls: 0,
    recalls: [] as MemoryEngineRecallRequest[],
    /** Extra hits the engine returns no matter what, to prove the gateway re-checks them. */
    rogueHits: [] as Array<{ documentId: string; text: string; score: number }>,
  };
  const gate = async () => {
    if (state.mode === "down") throw new MemoryEngineUnavailableError("connect ECONNREFUSED 127.0.0.1:18888");
    if (state.mode === "hang") await new Promise(() => {});
  };
  const engine: MemoryEngine = {
    async retain(doc) {
      await gate();
      if (doc.mode === "extract") state.modelCalls += 1;
      docs.push(doc);
    },
    async recall(req) {
      await gate();
      state.recalls.push(req);
      const words = req.query.toLowerCase().split(/\W+/).filter(Boolean);
      const hits = docs
        .filter((doc) => doc.bankId === req.bankId)
        .filter((doc) => doc.tags.some((tag) => req.tags.includes(tag)))
        .filter((doc) => words.some((word) => doc.content.toLowerCase().includes(word)))
        .map((doc) => ({ documentId: doc.documentId, text: doc.content, score: 0.5 }));
      return [...hits, ...state.rogueHits].slice(0, req.limit);
    },
    async deleteDocument() {
      await gate();
    },
  };
  return { engine, state };
}

describeEmbeddedPostgres("memory import from Claude and ChatGPT", () => {
  const ctx = useEmbeddedPostgres("gsam-memory-import-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
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

  async function seedAgent(companyId: string, name: string) {
    const [agent] = await ctx.db
      .insert(agents)
      .values({
        companyId,
        name,
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning();
    return agent;
  }

  function agentActor(companyId: string, agentId: string, runId: string | null = null) {
    return { type: "agent", agentId, companyId, runId, source: "agent_key" } as never;
  }

  async function seedRun(companyId: string, agentId: string, status: string) {
    const [run] = await ctx.db.insert(heartbeatRuns).values({ companyId, agentId, status }).returning();
    return run.id;
  }

  async function grant(companyId: string, agentId: string, permissionKey: string, scope: Record<string, unknown> | null) {
    await ctx.db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      permissionKey,
      scope,
    });
  }

  async function setup(name: string, options: { engineTimeoutMs?: number } = {}) {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, name);
    const fake = fakeEngine();
    const directRetainSlots = createEngineCallSlots(MEMORY_DIRECT_RETAIN_CONCURRENCY);
    const factory = (db: typeof ctx.db) => memoryRoutes(db, { engine: fake.engine, directRetainSlots, ...options });
    const board = routeApp(ctx.db, seeded.actor, factory);
    const asAgent = (agentId: string, runId: string | null = null) =>
      routeApp(ctx.db, agentActor(seeded.companyId, agentId, runId), factory);
    const base = `/api/companies/${seeded.companyId}/memory`;
    return { ...seeded, fake, factory, board, asAgent, base };
  }

  async function enable(app: ReturnType<typeof routeApp>, base: string, retainMode?: "extract" | "chunks") {
    const res = await request(app).patch(`${base}/settings`).send({ enabled: true, ...(retainMode ? { retainMode } : {}) });
    expect(res.status).toBe(200);
    return res.body;
  }

  async function scopeOf(app: ReturnType<typeof routeApp>, base: string, kind: string) {
    const res = await request(app).get(`${base}/scopes`);
    expect(res.status).toBe(200);
    return (res.body as MemoryScope[]).find((scope) => scope.kind === kind)!;
  }

  it("adds picked entries unreviewed with app provenance, skips repeats and holds back secrets", async () => {
    const { board, base, companyId } = await setup("Import");
    await enable(board, base);
    const org = await scopeOf(board, base, "organization");

    const first = await request(board).post(`${base}/import`).send({
      scopeId: org.id,
      app: "chatgpt",
      via: "paste",
      entries: [
        { sourceId: "paste:aaaa0001", content: "Greatstone prices discovery workshops per day." },
        { sourceId: "paste:aaaa0002", content: "Ben prefers short written updates." },
        { sourceId: "paste:aaaa0003", content: `Call me on 07700 900123` },
      ],
    });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ added: 2, alreadyImported: 0, heldBack: 1 });
    expect(JSON.stringify(first.body)).not.toContain("07700");

    const rows = await ctx.db.select().from(memoryRecords);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        companyId,
        scopeId: org.id,
        status: "unreviewed",
        entryType: "observation",
        sourceKind: "chatgpt_import",
        evidence: { importedFrom: "chatgpt", via: "paste" },
      });
    }

    const again = await request(board).post(`${base}/import`).send({
      scopeId: org.id,
      app: "chatgpt",
      via: "paste",
      entries: [
        { sourceId: "paste:aaaa0001", content: "Greatstone prices discovery workshops per day." },
        { sourceId: "paste:aaaa0004", content: "Indago kick-off is the top priority." },
      ],
    });
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ added: 1, alreadyImported: 1, heldBack: 0 });

    const activity = await ctx.db.select().from(activityLog);
    expect(activity.filter((row) => row.action === "memory.imported")).toHaveLength(2);
  });

  it("flags entries already imported or with much the same words, and writes nothing", async () => {
    const { board, base } = await setup("ImportCheck");
    await enable(board, base);
    const org = await scopeOf(board, base, "organization");
    await request(board).post(`${base}/import`).send({
      scopeId: org.id,
      app: "claude",
      via: "paste",
      entries: [{ sourceId: "paste:bbbb0001", content: "Greatstone prices discovery workshops per day for new clients." }],
    });
    const before = (await ctx.db.select().from(memoryRecords)).length;

    const check = await request(board).post(`${base}/import/check`).send({
      scopeId: org.id,
      app: "claude",
      entries: [
        { sourceId: "paste:bbbb0001", content: "anything" },
        { sourceId: "paste:bbbb0002", content: "Greatstone prices discovery workshops per day, for new clients" },
        { sourceId: "paste:bbbb0003", content: "Ben prefers short written updates." },
      ],
    });
    expect(check.status).toBe(200);
    expect(check.body.entries.map((entry: { match: string | null }) => entry.match)).toEqual(["already_imported", "similar", null]);
    expect(check.body.entries[1].existing).toMatchObject({ status: "unreviewed" });
    expect((await ctx.db.select().from(memoryRecords)).length).toBe(before);
  });

  it("answers 404 for a scope the caller cannot see and validates the body", async () => {
    const { board, base, asAgent, companyId } = await setup("ImportScope");
    await enable(board, base);
    const mason = await seedAgent(companyId, "Mason");
    const masonScope = await scopeOf(asAgent(mason.id), base, "agent");
    const other = await seedAgent(companyId, "Other");

    const hidden = await request(asAgent(other.id)).post(`${base}/import`).send({
      scopeId: masonScope.id,
      app: "claude",
      via: "export",
      entries: [{ sourceId: "conversation:1", content: "x" }],
    });
    expect(hidden.status).toBe(404);

    const org = await scopeOf(board, base, "organization");
    const empty = await request(board).post(`${base}/import`).send({ scopeId: org.id, app: "claude", via: "paste", entries: [] });
    expect(empty.status).toBe(400);
    const tooMany = await request(board)
      .post(`${base}/import`)
      .send({ scopeId: org.id, app: "claude", via: "paste", entries: Array.from({ length: 51 }, (_, i) => ({ sourceId: `p:${i}`, content: "x" })) });
    expect(tooMany.status).toBe(400);
  });
});
