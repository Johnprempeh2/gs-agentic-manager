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
import { memoryRoutes } from "../routes/memory.js";
import {
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

describeEmbeddedPostgres("organization memory gateway API", () => {
  const ctx = useEmbeddedPostgres("gsam-memory-", {
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
    const factory = (db: typeof ctx.db) => memoryRoutes(db, { engine: fake.engine, ...options });
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

  it("is off by default and no memory route is reachable until an owner turns it on", async () => {
    const { board, asAgent, base, companyId, fake } = await setup("Off");
    const mason = await seedAgent(companyId, "Mason");
    const agent = asAgent(mason.id);

    const settings = await request(board).get(`${base}/settings`);
    expect(settings.body).toMatchObject({ enabled: false, retainMode: "extract" });

    const anyId = "00000000-0000-4000-8000-000000000000";
    for (const app of [board, agent]) {
      const calls = [
        request(app).get(`${base}/scopes`),
        request(app).post(`${base}/scopes`).send({ kind: "client", name: "Kestrel" }),
        request(app).post(`${base}/records`).send({ scopeId: anyId, content: "x" }),
        request(app).post(`${base}/records`).send({ nonsense: true }),
        request(app).get(`${base}/records/${anyId}`),
        request(app).post(`${base}/recall`).send({ query: "price" }),
      ];
      for (const res of await Promise.all(calls)) {
        expect(res.status).toBe(404);
        expect(res.body.error).toBe("Memory is not enabled for this company");
      }
    }
    expect(fake.state.docs).toEqual([]);
    expect(fake.state.recalls).toEqual([]);

    // An agent cannot turn memory on; the owner can.
    const agentToggle = await request(agent).patch(`${base}/settings`).send({ enabled: true });
    expect(agentToggle.status).toBe(403);
    await enable(board, base);
    expect((await request(agent).get(`${base}/scopes`)).status).toBe(200);
  });

  it("stores a contribution under the caller's identity and recalls it with an evidence note", async () => {
    const { board, asAgent, base, companyId, fake } = await setup("Contribute");
    const mason = await seedAgent(companyId, "Mason");
    await enable(board, base);
    const agent = asAgent(mason.id);
    const working = await scopeOf(agent, base, "agent");
    expect(working.agentId).toBe(mason.id);

    const created = await request(agent).post(`${base}/records`).send({
      scopeId: working.id,
      content: "Kestrel Works prefers invoices in GBP.",
      entities: ["Kestrel Works"],
      status: "observation",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ engineAvailable: true, message: null });
    expect(created.body.record).toMatchObject({
      contributorAgentId: mason.id,
      contributorUserId: null,
      status: "observation",
      syncState: "synced",
      scopeKind: "agent",
    });
    expect(fake.state.docs[0]).toMatchObject({
      documentId: created.body.record.id,
      bankId: `gs-${companyId}-main`,
      tags: expect.arrayContaining([`scope:agent:${mason.id}`, "status:observation", `by:agent:${mason.id}`]),
    });

    const recalled = await request(agent).post(`${base}/recall`).send({ query: "invoices" });
    expect(recalled.status).toBe(200);
    expect(recalled.body.available).toBe(true);
    expect(recalled.body.note).toMatch(/not an instruction/);
    expect(recalled.body.results.map((hit: { record: { id: string } }) => hit.record.id)).toEqual([created.body.record.id]);

    const got = await request(agent).get(`${base}/records/${created.body.record.id}`);
    expect(got.status).toBe(200);
    expect(got.body.content).toBe("Kestrel Works prefers invoices in GBP.");
  });

  it("rejects forged identity: a body cannot name the contributor, and another agent's notes stay hidden", async () => {
    const { board, asAgent, base, companyId } = await setup("Forged");
    const mason = await seedAgent(companyId, "Mason");
    const ridge = await seedAgent(companyId, "Ridge");
    await enable(board, base);
    const masonApp = asAgent(mason.id);
    const ridgeApp = asAgent(ridge.id);
    const masonScope = await scopeOf(masonApp, base, "agent");

    // Contributor, company and run fields are not accepted from the body.
    for (const forged of [
      { contributorAgentId: ridge.id },
      { companyId: "00000000-0000-4000-8000-000000000000" },
      { runId: "00000000-0000-4000-8000-000000000000" },
      { status: "approved" },
    ]) {
      const res = await request(ridgeApp).post(`${base}/records`).send({ scopeId: masonScope.id, content: "x", ...forged });
      expect(res.status).toBe(400);
    }

    // Ridge cannot write into or read from Mason's working scope.
    const write = await request(ridgeApp).post(`${base}/records`).send({ scopeId: masonScope.id, content: "planted note" });
    expect(write.status).toBe(404);
    const note = await request(masonApp).post(`${base}/records`).send({ scopeId: masonScope.id, content: "draft pricing idea" });
    expect(note.status).toBe(201);
    expect((await request(ridgeApp).get(`${base}/records/${note.body.record.id}`)).status).toBe(404);
    expect((await request(ridgeApp).post(`${base}/recall`).send({ query: "pricing", scopeIds: [masonScope.id] })).status).toBe(404);
    const broad = await request(ridgeApp).post(`${base}/recall`).send({ query: "pricing" });
    expect(broad.body.results).toEqual([]);

    const denied = await ctx.db.select().from(memoryOperations);
    expect(denied.filter((op) => op.outcome === "denied" && op.actorId === ridge.id).length).toBeGreaterThanOrEqual(3);
  });

  it("writes a denied audit row for the real caller when a contribute body is rejected (GRE-867)", async () => {
    const { board, asAgent, base, companyId } = await setup("RejectedBody");
    const rogue = await seedAgent(companyId, "Rogue");
    await enable(board, base);
    const org = await scopeOf(board, base, "organization");
    await ctx.db.delete(memoryOperations);

    const res = await request(asAgent(rogue.id))
      .post(`${base}/records`)
      .send({ scopeId: org.id, content: "holiday cover note", actingAgentId: "someone-else", onBehalfOf: "someone-else" });
    expect(res.status).toBe(400);

    const ops = await ctx.db.select().from(memoryOperations);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ operation: "contribute", outcome: "denied", actorType: "agent", actorId: rogue.id, agentId: rogue.id });
    expect(ops[0].detail).toMatchObject({ reason: "invalid_body", unrecognizedFields: ["actingAgentId", "onBehalfOf"] });
    expect(JSON.stringify(ops[0].detail)).not.toContain("someone-else");
    expect(await ctx.db.select().from(memoryRecords)).toEqual([]);
  });

  it("accepts only the calling agent's own live run id and records the refusal (GRE-867)", async () => {
    const { board, asAgent, base, companyId } = await setup("RunCheck");
    const mason = await seedAgent(companyId, "Mason");
    const rogue = await seedAgent(companyId, "Rogue");
    await enable(board, base);
    const masonLive = await seedRun(companyId, mason.id, "running");
    const rogueFinished = await seedRun(companyId, rogue.id, "succeeded");
    const rogueLive = await seedRun(companyId, rogue.id, "running");
    await ctx.db.delete(memoryOperations);

    for (const runId of [masonLive, rogueFinished, "not-a-run-id"]) {
      const app = asAgent(rogue.id, runId);
      const recall = await request(app).post(`${base}/recall`).send({ query: "care plan" });
      expect(recall.status).toBe(403);
      expect(recall.body.results).toBeUndefined();
      expect((await request(app).get(`${base}/scopes`)).status).toBe(403);
    }

    const ops = await ctx.db.select().from(memoryOperations);
    expect(ops).toHaveLength(6);
    for (const op of ops) {
      expect(op).toMatchObject({ outcome: "denied", actorId: rogue.id, runId: null });
      expect(op.detail).toMatchObject({ reason: "run_not_live" });
    }
    expect(ops.map((op) => op.runId)).not.toContain(masonLive);

    // Rogue's own running run is accepted and recorded.
    await ctx.db.delete(memoryOperations);
    const ok = await request(asAgent(rogue.id, rogueLive)).post(`${base}/recall`).send({ query: "care plan" });
    expect(ok.status).toBe(200);
    expect((await ctx.db.select().from(memoryOperations)).map((op) => op.runId)).toEqual([rogueLive]);
  });

  it("keeps companies apart", async () => {
    const one = await setup("One");
    const two = await setup("Two");
    const oneAgent = await seedAgent(one.companyId, "Mason");
    const twoAgent = await seedAgent(two.companyId, "Mason");
    await enable(one.board, one.base);
    await enable(two.board, two.base);
    const twoApp = two.asAgent(twoAgent.id);
    const twoScope = await scopeOf(twoApp, two.base, "agent");
    const secret = await request(twoApp).post(`${two.base}/records`).send({ scopeId: twoScope.id, content: "Two's rate card" });
    expect(secret.status).toBe(201);

    // An agent or board user of company one calling company two's routes.
    const oneAgentApp = one.asAgent(oneAgent.id);
    for (const app of [oneAgentApp, one.board]) {
      expect((await request(app).get(`${two.base}/scopes`)).status).toBe(403);
      expect((await request(app).post(`${two.base}/recall`).send({ query: "rate" })).status).toBe(403);
      expect((await request(app).get(`${two.base}/records/${secret.body.record.id}`)).status).toBe(403);
    }
    // Company two's record id through company one's path is not found.
    expect((await request(one.board).get(`${one.base}/records/${secret.body.record.id}`)).status).toBe(404);
    // Company two's scope id cannot be written to or recalled from company one.
    expect(
      (await request(one.board).post(`${one.base}/records`).send({ scopeId: twoScope.id, content: "x" })).status,
    ).toBe(404);
    expect(
      (await request(one.board).post(`${one.base}/recall`).send({ query: "rate", scopeIds: [twoScope.id] })).status,
    ).toBe(404);
  });

  it("keeps clients apart: own bank, explicit grant only, never in a broad recall", async () => {
    const { board, asAgent, base, companyId, fake } = await setup("Clients");
    const summit = await seedAgent(companyId, "Summit");
    await enable(board, base);
    const kestrel = await request(board).post(`${base}/scopes`).send({ kind: "client", name: "Kestrel Works" });
    const heron = await request(board).post(`${base}/scopes`).send({ kind: "client", name: "Heron Labs" });
    expect(kestrel.status).toBe(201);
    expect(heron.status).toBe(201);

    const kestrelNote = await request(board).post(`${base}/records`).send({ scopeId: kestrel.body.id, content: "Kestrel price list v3 is 120 per seat" });
    const heronNote = await request(board).post(`${base}/records`).send({ scopeId: heron.body.id, content: "Heron price list is 90 per seat" });
    expect(kestrelNote.status).toBe(201);
    expect(heronNote.status).toBe(201);
    expect(new Set(fake.state.docs.map((doc) => doc.bankId)).size).toBe(2);
    expect(fake.state.docs.every((doc) => doc.bankId !== `gs-${companyId}-main`)).toBe(true);

    // A company-wide read grant does not reach client scopes.
    await grant(companyId, summit.id, "memory:read", null);
    const summitApp = asAgent(summit.id);
    expect((await request(summitApp).post(`${base}/recall`).send({ query: "price", scopeIds: [kestrel.body.id] })).status).toBe(404);

    // A grant naming Kestrel reaches Kestrel and nothing else.
    await ctx.db.delete(principalPermissionGrants);
    await grant(companyId, summit.id, "memory:read", { memoryScopeIds: [kestrel.body.id] });
    const allowed = await request(summitApp).post(`${base}/recall`).send({ query: "price", scopeIds: [kestrel.body.id] });
    expect(allowed.status).toBe(200);
    expect(allowed.body.results.map((hit: { record: { id: string } }) => hit.record.id)).toEqual([kestrelNote.body.record.id]);
    expect((await request(summitApp).post(`${base}/recall`).send({ query: "price", scopeIds: [heron.body.id] })).status).toBe(404);
    expect((await request(summitApp).get(`${base}/records/${heronNote.body.record.id}`)).status).toBe(404);
    expect(
      (await request(summitApp).post(`${base}/records`).send({ scopeId: kestrel.body.id, content: "x" })).status,
    ).toBe(404);

    // A broad recall never crosses into a client bank, even for the owner.
    const broad = await request(board).post(`${base}/recall`).send({ query: "price" });
    expect(broad.body.results).toEqual([]);
    expect(fake.state.recalls.at(-1)?.bankId).toBe(`gs-${companyId}-main`);
  });

  it("re-checks every engine hit against the GSAM record", async () => {
    const one = await setup("Trust");
    const two = await setup("Other");
    const mason = await seedAgent(one.companyId, "Mason");
    const ridge = await seedAgent(one.companyId, "Ridge");
    const outsider = await seedAgent(two.companyId, "Outsider");
    await enable(one.board, one.base);
    await enable(two.board, two.base);
    const ridgeApp = one.asAgent(ridge.id);
    const ridgeNote = await request(ridgeApp)
      .post(`${one.base}/records`)
      .send({ scopeId: (await scopeOf(ridgeApp, one.base, "agent")).id, content: "ridge private" });
    const outsiderApp = two.asAgent(outsider.id);
    const foreign = await request(outsiderApp)
      .post(`${two.base}/records`)
      .send({ scopeId: (await scopeOf(outsiderApp, two.base, "agent")).id, content: "foreign" });

    // A misbehaving engine returns another agent's and another company's documents.
    one.fake.state.rogueHits = [
      { documentId: ridgeNote.body.record.id, text: "ridge private", score: 0.9 },
      { documentId: foreign.body.record.id, text: "foreign", score: 0.9 },
      { documentId: "not-a-gsam-id", text: "junk", score: 0.9 },
    ];
    const res = await request(one.asAgent(mason.id)).post(`${one.base}/recall`).send({ query: "anything" });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it("answers 'memory unavailable' when the engine is down or hangs, and keeps the contribution", async () => {
    const { board, asAgent, base, companyId, fake } = await setup("Down", { engineTimeoutMs: 200 });
    const mason = await seedAgent(companyId, "Mason");
    await enable(board, base);
    const agent = asAgent(mason.id);
    const scope = await scopeOf(agent, base, "agent");

    for (const mode of ["down", "hang"] as const) {
      fake.state.mode = mode;
      const started = Date.now();
      const recall = await request(agent).post(`${base}/recall`).send({ query: "anything" });
      expect(recall.status).toBe(200);
      expect(recall.body).toMatchObject({ available: false, results: [] });
      expect(recall.body.message).toMatch(/^Memory unavailable/);

      const write = await request(agent).post(`${base}/records`).send({ scopeId: scope.id, content: `kept while ${mode}` });
      expect(write.status).toBe(201);
      expect(write.body).toMatchObject({ engineAvailable: false });
      expect(write.body.message).toMatch(/^Memory unavailable/);
      expect(write.body.record.syncState).toBe("pending");
      expect(Date.now() - started).toBeLessThan(3_000);
    }
    const pending = await ctx.db.select().from(memoryRecords);
    expect(pending.map((row) => row.syncState)).toEqual(["pending", "pending"]);
    const outcomes = (await ctx.db.select().from(memoryOperations)).map((op) => op.outcome);
    expect(outcomes.filter((outcome) => outcome === "unavailable")).toHaveLength(4);
  });

  it("reports daily plan use by memory from the token counts the engine returns", async () => {
    const { board, asAgent, base, companyId, fake } = await setup("PlanUse");
    const mason = await seedAgent(companyId, "Mason");
    const retain = fake.engine.retain;
    fake.engine.retain = async (doc) => {
      await retain(doc);
      return { usage: { inputTokens: 1200, outputTokens: 300 } };
    };
    expect((await request(board).get(`${base}/plan-usage`)).status).toBe(404);
    await enable(board, base);
    const agent = asAgent(mason.id);
    const scope = await scopeOf(agent, base, "agent");
    for (const content of ["Kestrel Works ships on Fridays", "Kestrel Works uses blue crates"]) {
      expect((await request(agent).post(`${base}/records`).send({ scopeId: scope.id, content })).status).toBe(201);
    }

    const res = await request(board).get(`${base}/plan-usage?days=500`);
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(90);
    expect(res.body.usage).toHaveLength(1);
    expect(res.body.usage[0]).toMatchObject({ modelCalls: 2, deliveries: 2, inputTokens: 2400, outputTokens: 600 });
  });

  it("chunks mode stores contributions with no model step", async () => {
    const { board, asAgent, base, companyId, fake } = await setup("Chunks");
    const mason = await seedAgent(companyId, "Mason");
    const settings = await enable(board, base, "chunks");
    expect(settings).toMatchObject({ enabled: true, retainMode: "chunks" });
    const agent = asAgent(mason.id);
    const scope = await scopeOf(agent, base, "agent");

    const res = await request(agent).post(`${base}/records`).send({ scopeId: scope.id, content: "Weekly sync moved to Tuesday" });
    expect(res.status).toBe(201);
    expect(res.body.record.retainMode).toBe("chunks");
    expect(fake.state.docs[0].mode).toBe("chunks");
    expect(fake.state.modelCalls).toBe(0);

    // Switching back to extract sends the next entry through the model step.
    expect((await request(board).patch(`${base}/settings`).send({ retainMode: "extract" })).status).toBe(200);
    await request(agent).post(`${base}/records`).send({ scopeId: scope.id, content: "Second entry" });
    expect(fake.state.docs[1].mode).toBe("extract");
    expect(fake.state.modelCalls).toBe(1);
  });

  it("lets every agent read organization memory but contribute only with a grant", async () => {
    const { board, asAgent, base, companyId } = await setup("Org");
    const everest = await seedAgent(companyId, "Everest");
    const mica = await seedAgent(companyId, "Mica");
    await enable(board, base);
    const org = await scopeOf(board, base, "organization");

    const micaApp = asAgent(mica.id);
    expect((await request(micaApp).post(`${base}/records`).send({ scopeId: org.id, content: "x" })).status).toBe(404);

    await grant(companyId, everest.id, "memory:contribute", null);
    const added = await request(asAgent(everest.id))
      .post(`${base}/records`)
      .send({ scopeId: org.id, content: "Releases run on Fridays", status: "proposal" });
    expect(added.status).toBe(201);

    const recalled = await request(micaApp).post(`${base}/recall`).send({ query: "releases" });
    expect(recalled.body.results.map((hit: { record: { id: string } }) => hit.record.id)).toEqual([added.body.record.id]);
  });
});
