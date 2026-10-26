import { eq } from "drizzle-orm";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companyMemberships,
  heartbeatRuns,
  issueComments,
  issues,
  issueThreadInteractions,
  memoryIngestOutbox,
  memoryOperations,
  memoryRecords,
  memoryReviewEvents,
  memoryScopes,
  memorySettings,
  principalPermissionGrants,
} from "@greatstone/db";
import type { MemorySyncResult } from "@greatstone/shared";
import { memoryKeyNetworkRefusal } from "../middleware/memory-only-key-guard.js";
import { memoryRoutes } from "../routes/memory.js";
import { memoryToolRoutes } from "../routes/memory-tools.js";
import type { MemoryEngine, MemoryEngineDocument } from "../services/memory-gateway/engine.js";
import { runScheduledMemoryPersonFeed } from "../services/memory-gateway/person-feed.js";
import { personBankSlug, personScopeOwner } from "../services/memory-gateway/service.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

/** Like Hindsight with strict tags: only the bank asked for, only the tags asked for. */
function fakeEngine() {
  const docs: MemoryEngineDocument[] = [];
  const engine: MemoryEngine = {
    async retain(doc) {
      docs.push(doc);
    },
    async recall(req) {
      const words = req.query.toLowerCase().split(/\W+/).filter((word) => word.length > 2);
      return docs
        .filter((doc) => doc.bankId === req.bankId && doc.tags.some((tag) => req.tags.includes(tag)))
        .filter((doc) => words.some((word) => doc.content.toLowerCase().includes(word)))
        .map((doc) => ({ documentId: doc.documentId, text: doc.content, score: 0.5 }));
    },
    async deleteDocument() {},
  };
  return { engine, docs };
}

describe("memory keys stay on the tailnet (GRE-2668)", () => {
  const req = (remoteAddress: string, headers: Record<string, string> = {}) => ({ headers, socket: { remoteAddress } });

  it("accepts this PC and Tailscale addresses", () => {
    expect(memoryKeyNetworkRefusal(req("127.0.0.1"), {})).toBeNull();
    expect(memoryKeyNetworkRefusal(req("::1"), {})).toBeNull();
    expect(memoryKeyNetworkRefusal(req("::ffff:127.0.0.1"), {})).toBeNull();
    expect(memoryKeyNetworkRefusal(req("100.101.12.3"), {})).toBeNull();
    expect(memoryKeyNetworkRefusal(req("100.64.0.1"), {})).toBeNull();
    expect(memoryKeyNetworkRefusal(req("fd7a:115c:a1e0::1234"), {})).toBeNull();
  });

  it("refuses Funnel whatever the address, and any other network", () => {
    expect(memoryKeyNetworkRefusal(req("127.0.0.1", { "tailscale-funnel-request": "?1" }), {})).toBe("funnel");
    expect(
      memoryKeyNetworkRefusal(req("127.0.0.1", { "tailscale-funnel-request": "?1" }), { GSAM_MEMORY_KEYS_ANY_NETWORK: "true" }),
    ).toBe("funnel");
    expect(memoryKeyNetworkRefusal(req("8.8.8.8"), {})).toBe("not_tailnet");
    expect(memoryKeyNetworkRefusal(req("100.128.0.1"), {})).toBe("not_tailnet");
    expect(memoryKeyNetworkRefusal(req("192.168.1.20"), {})).toBe("not_tailnet");
    expect(memoryKeyNetworkRefusal(req("8.8.8.8"), { GSAM_MEMORY_KEYS_ANY_NETWORK: "true" })).toBeNull();
  });

  it("names the bank after the person's first name", () => {
    expect(personBankSlug("John Prempeh")).toBe("john");
    expect(personBankSlug("  Ben ")).toBe("ben");
    expect(personBankSlug("Zoë Ama")).toBe("zoe");
    expect(personBankSlug("")).toBeNull();
    expect(personScopeOwner({ kind: "person", tag: "scope:person:user-1" })).toBe("user-1");
    expect(personScopeOwner({ kind: "client", tag: "scope:client:x" })).toBeNull();
  });
});

describeEmbeddedPostgres("one shared memory for Claude Code, Codex and GSAM (GRE-2668)", () => {
  const ctx = useEmbeddedPostgres("gsam-memory-sync-", {
    resetEach: async (db) => {
      await db.delete(issueThreadInteractions);
      await db.delete(issueComments);
      await db.delete(activityLog);
      await db.delete(memoryIngestOutbox);
      await db.delete(memoryOperations);
      await db.delete(memoryReviewEvents);
      await db.delete(memoryRecords);
      await db.delete(memoryScopes);
      await db.delete(memorySettings);
      await db.delete(principalPermissionGrants);
      await db.delete(heartbeatRuns);
      await db.delete(agents);
      await db.delete(authUsers);
      await resetCompanyIssueFixtures(db);
    },
  });

  afterEach(() => {
    delete process.env.GSAM_MEMORY_SYNC_DAILY_CAP;
  });

  async function seedAgent(companyId: string, name: string, metadata: Record<string, unknown> | null = null) {
    const [agent] = await ctx.db
      .insert(agents)
      .values({
        companyId,
        name,
        role: "engineer",
        status: metadata ? "paused" : "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        metadata,
      })
      .returning();
    return agent;
  }

  async function grant(companyId: string, agentId: string, permissionKey: string, scope: Record<string, unknown> | null) {
    await ctx.db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: agentId, permissionKey, scope });
  }

  let rpcId = 0;
  function callTool(app: ReturnType<typeof routeApp>, name: string, args: Record<string, unknown>) {
    return request(app)
      .post("/api/mcp/memory-tools")
      .send({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } });
  }

  async function setup(name: string) {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, name);
    const now = new Date();
    await ctx.db.insert(authUsers).values({ id: seeded.userId, name: "John Prempeh", email: `${seeded.userId}@example.test`, createdAt: now, updatedAt: now });
    await ctx.db.insert(memorySettings).values({ companyId: seeded.companyId, enabled: true });
    const fake = fakeEngine();
    const factory = (db: typeof ctx.db) => memoryRoutes(db, { engine: fake.engine });
    const tools = (db: typeof ctx.db) => memoryToolRoutes(db, { engine: fake.engine });
    const keyActor = (agentId: string) =>
      ({ type: "agent", agentId, companyId: seeded.companyId, runId: null, source: "agent_key", keyScope: { kind: "memory_only" } }) as never;
    // John's two app links, as the connect button makes them.
    const links = {} as Record<"claude_code" | "codex", { agentId: string; rest: ReturnType<typeof routeApp>; tools: ReturnType<typeof routeApp> }>;
    for (const app of ["claude_code", "codex"] as const) {
      const agent = await seedAgent(seeded.companyId, `John's ${app}`, { memoryConnection: { app, createdByUserId: seeded.userId } });
      await grant(seeded.companyId, agent.id, "memory:contribute", null);
      links[app] = {
        agentId: agent.id,
        rest: routeApp(ctx.db, keyActor(agent.id), factory),
        tools: routeApp(ctx.db, keyActor(agent.id), tools),
      };
    }
    const board = routeApp(ctx.db, seeded.actor, factory);
    const base = `/api/companies/${seeded.companyId}/memory`;
    return { ...seeded, fake, factory, tools, links, board, base };
  }

  const turn = (sourceId: string, content: string, occurredAt = "2026-10-25T14:05:00.000Z", source = "codex") => ({
    source,
    sourceId,
    title: `Codex session, 25 Oct`,
    content,
    occurredAt,
    origin: { app: source, sessionId: "rollout-1" },
  });

  it("puts each app's entries in the person's own bank, skips resends and revises a changed source", async () => {
    const { links, base, fake, companyId, userId } = await setup("Sync");
    const first = await request(links.codex.rest).post(`${base}/sync`).send({
      entries: [
        turn("codex:rollout-1:t1", "John: what identity for clients? Answer: Better Auth, one organisation_id per client."),
        turn("memory:NOW.md", "Handoff: Indago kick-off first.", "2026-10-26T08:00:00.000Z", "memory_file"),
      ],
    });
    expect(first.status).toBe(200);
    const body = first.body as MemorySyncResult;
    expect(body.bankName).toBe("greatstone-john");
    expect(body.entries.map((entry) => entry.outcome)).toEqual(["added", "added"]);

    const [scope] = await ctx.db.select().from(memoryScopes).where(eq(memoryScopes.kind, "person"));
    expect(scope).toMatchObject({ companyId, bankId: "greatstone-john", tag: `scope:person:${userId}` });
    // Facts carry when they happened and where they came from.
    expect(fake.docs).toHaveLength(2);
    expect(fake.docs[0]).toMatchObject({ bankId: "greatstone-john", timestamp: "2026-10-25T14:05:00.000Z" });
    expect(fake.docs[0].tags).toContain(`scope:person:${userId}`);
    const rows = await ctx.db.select().from(memoryRecords);
    expect(rows.find((row) => row.sourceId === "codex:rollout-1:t1")).toMatchObject({
      sourceKind: "sync:codex",
      status: "unreviewed",
      entryType: "observation",
      evidence: expect.objectContaining({ syncedFrom: "codex", occurredAt: "2026-10-25T14:05:00.000Z", origin: { app: "codex", sessionId: "rollout-1" } }),
    });

    // The same text again: nothing new reaches the engine.
    const again = await request(links.claude_code.rest).post(`${base}/sync`).send({
      entries: [turn("memory:NOW.md", "Handoff: Indago kick-off first.", "2026-10-26T08:00:00.000Z", "memory_file")],
    });
    expect(again.body.entries[0].outcome).toBe("unchanged");
    expect(fake.docs).toHaveLength(2);

    // The file changed: one live entry, the old one superseded (history, not a duplicate).
    const changed = await request(links.claude_code.rest).post(`${base}/sync`).send({
      entries: [turn("memory:NOW.md", "Handoff: Indago interview on 9 Nov.", "2026-10-26T09:00:00.000Z", "memory_file")],
    });
    expect(changed.body.entries[0].outcome).toBe("revised");
    const versions = (await ctx.db.select().from(memoryRecords)).filter((row) => row.sourceId === "memory:NOW.md");
    expect(versions.map((row) => row.status).sort()).toEqual(["superseded", "unreviewed"]);
    const live = versions.find((row) => row.status === "unreviewed")!;
    expect(live.effectiveFrom?.toISOString()).toBe("2026-10-26T09:00:00.000Z");
    // A revise queues its retain for the outbox drain, in the same bank, dated when the file changed.
    const queued = (await ctx.db.select().from(memoryIngestOutbox)).filter((row) => row.recordId === live.id);
    expect(queued).toHaveLength(1);
    expect(queued[0].payload).toMatchObject({ bankId: "greatstone-john", timestamp: "2026-10-26T09:00:00.000Z" });
  });

  it("lets Claude recall what Codex did, by default and through my_work", async () => {
    const { links, base } = await setup("Recall");
    await request(links.codex.rest).post(`${base}/sync`).send({
      entries: [turn("codex:rollout-9:t4", "Codex last session: fixed the payment report and opened PR 981.")],
    });
    const plain = await request(links.claude_code.rest).post(`${base}/recall`).send({ query: "what did Codex do last session" });
    expect(plain.status).toBe(200);
    expect(JSON.stringify(plain.body.results)).toContain("payment report");

    const viaTool = await callTool(links.claude_code.tools, "memory_recall", { query: "payment report", scopes: ["my_work"] });
    expect(viaTool.status).toBe(200);
    expect(JSON.stringify(viaTool.body)).toContain("payment report");
    const byBank = await callTool(links.claude_code.tools, "memory_recall", { query: "payment report", scopes: ["greatstone-john"] });
    expect(JSON.stringify(byBank.body)).toContain("payment report");
  });

  it("lets GSAM agents read it by name only, never by default, and never write or sync", async () => {
    const { links, base, companyId, factory, tools } = await setup("Agents");
    await request(links.codex.rest).post(`${base}/sync`).send({ entries: [turn("codex:r:t1", "Decision: Better Auth for client identity.")] });
    const scope = (await ctx.db.select().from(memoryScopes)).find((row) => row.kind === "person")!;

    const agent = await seedAgent(companyId, "Trestle");
    const agentActor = { type: "agent", agentId: agent.id, companyId, runId: null, source: "agent_key" } as never;
    const asAgent = routeApp(ctx.db, agentActor, factory);
    const plain = await request(asAgent).post(`${base}/recall`).send({ query: "client identity" });
    expect(JSON.stringify(plain.body.results)).not.toContain("Better Auth");
    const named = await request(asAgent).post(`${base}/recall`).send({ query: "client identity", scopeIds: [scope.id] });
    expect(named.status).toBe(200);
    expect(JSON.stringify(named.body.results)).toContain("Better Auth");
    // Through the MCP tools, from a live run, by bank name.
    const [task] = await ctx.db.insert(issues).values({ companyId, title: "Trestle task", status: "in_progress", priority: "medium" }).returning();
    const [liveRun] = await ctx.db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, status: "running", contextSnapshot: { issueId: task.id } }).returning();
    const runActor = { type: "agent", source: "agent_jwt", agentId: agent.id, companyId, runId: liveRun.id } as never;
    const byBank = await callTool(routeApp(ctx.db, runActor, tools), "memory_recall", { query: "client identity", scopes: ["greatstone-john"] });
    expect(JSON.stringify(byBank.body)).toContain("Better Auth");

    expect((await request(asAgent).post(`${base}/records`).send({ scopeId: scope.id, content: "An agent note" })).status).toBe(404);
    expect((await request(asAgent).post(`${base}/sync`).send({ entries: [turn("x", "y")] })).status).toBe(404);
  });

  it("keeps another person's apps out of John's work", async () => {
    const { links, base, companyId, factory } = await setup("Others");
    await request(links.codex.rest).post(`${base}/sync`).send({ entries: [turn("codex:r:t1", "Decision: Better Auth for client identity.")] });
    const scope = (await ctx.db.select().from(memoryScopes)).find((row) => row.kind === "person")!;
    await ctx.db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "user-ben", status: "active", membershipRole: "operator", updatedAt: new Date() });
    const bens = await seedAgent(companyId, "Ben's codex", { memoryConnection: { app: "codex", createdByUserId: "user-ben" } });
    await grant(companyId, bens.id, "memory:contribute", null);
    const asBen = routeApp(ctx.db, { type: "agent", agentId: bens.id, companyId, runId: null, source: "agent_key", keyScope: { kind: "memory_only" } } as never, factory);
    expect(JSON.stringify((await request(asBen).post(`${base}/recall`).send({ query: "client identity" })).body)).not.toContain("Better Auth");
    expect((await request(asBen).post(`${base}/recall`).send({ query: "client identity", scopeIds: [scope.id] })).status).toBe(404);
  });

  it("refuses to make a person scope through the scope route", async () => {
    const { board, base } = await setup("NoCreate");
    const res = await request(board).post(`${base}/scopes`).send({ kind: "person", name: "Someone's work" });
    expect(res.status).toBe(400);
  });

  it("holds back what still looks like a secret and stops at the daily cap, reporting it once", async () => {
    process.env.GSAM_MEMORY_SYNC_DAILY_CAP = "2";
    const { links, base } = await setup("Cap");
    const res = await request(links.codex.rest).post(`${base}/sync`).send({
      entries: [
        turn("codex:c:1", "First decision."),
        turn("codex:c:2", "Key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"),
        turn("codex:c:3", "Second decision."),
        turn("codex:c:4", "Third decision."),
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.entries.map((entry: { outcome: string }) => entry.outcome)).toEqual(["added", "held_back", "added", "capped"]);
    expect(res.body).toMatchObject({ usedToday: 2, dailyCap: 2, capReached: true });
    expect(JSON.stringify(res.body)).not.toContain("sk-ant");

    const later = await request(links.codex.rest).post(`${base}/sync`).send({ entries: [turn("codex:c:5", "Fourth decision.")] });
    expect(later.body.entries[0].outcome).toBe("capped");
    const alerts = (await ctx.db.select().from(memoryOperations)).filter((row) => row.operation === "sync_daily_cap");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].detail).toMatchObject({ dailyCap: 2, usedToday: 2 });
  });

  it("feeds people's comments, card answers and closed tasks from GSAM, once, every two hours", async () => {
    const { links, base, companyId, userId, fake } = await setup("Feed");
    // The scope exists once one of John's apps has called.
    await request(links.claude_code.rest).get(`${base}/scopes`);
    const agent = await seedAgent(companyId, "Everest");
    const [issue] = await ctx.db
      .insert(issues)
      .values({ companyId, title: "Client identity for the portal", status: "done", priority: "high", identifier: "TST-9", completedAt: new Date("2026-10-25T16:00:00Z") })
      .returning();
    await ctx.db.insert(issueComments).values([
      { companyId, issueId: issue.id, authorUserId: userId, body: "Decision: Better Auth, one organisation_id per client.", createdAt: new Date("2026-10-25T14:00:00Z") },
      { companyId, issueId: issue.id, authorAgentId: agent.id, body: "Agent chatter that is not fed.", createdAt: new Date("2026-10-25T14:10:00Z") },
    ]);
    await ctx.db.insert(issueThreadInteractions).values({
      companyId,
      issueId: issue.id,
      kind: "request_confirmation",
      status: "accepted",
      title: "Use Better Auth?",
      payload: {} as never,
      result: { accepted: true } as never,
      resolvedByUserId: userId,
      resolvedAt: new Date("2026-10-25T15:00:00Z"),
    });

    const now = new Date("2026-10-26T00:00:00Z");
    await runScheduledMemoryPersonFeed(ctx.db, { engine: fake.engine, now });
    const fed = (await ctx.db.select().from(memoryRecords)).filter((row) => row.sourceKind === "sync:gsam");
    expect(fed).toHaveLength(1);
    expect(fed[0].content).toContain("John Prempeh commented on TST-9");
    expect(fed[0].content).toContain("Better Auth, one organisation_id");
    expect(fed[0].content).toContain("accepted a request confirmation card");
    expect(fed[0].content).toContain('TST-9 "Client identity for the portal" was done');
    expect(fed[0].content).not.toContain("Agent chatter");
    expect(fed[0].effectiveFrom?.toISOString()).toBe("2026-10-25T14:00:00.000Z");

    // Within two hours: no pass. After: nothing new, so nothing added.
    await runScheduledMemoryPersonFeed(ctx.db, { engine: fake.engine, now: new Date(now.getTime() + 60_000) });
    await runScheduledMemoryPersonFeed(ctx.db, { engine: fake.engine, now: new Date(now.getTime() + 3 * 3_600_000) });
    expect((await ctx.db.select().from(memoryRecords)).filter((row) => row.sourceKind === "sync:gsam")).toHaveLength(1);
    const passes = (await ctx.db.select().from(memoryOperations)).filter((row) => row.operation === "person_feed");
    expect(passes).toHaveLength(2);
  });

  it("never stores again what a person deleted, but lets a source back after retention removed it", async () => {
    const { links, base } = await setup("Deleted");
    const send = (sourceId: string, content: string) =>
      request(links.codex.rest).post(`${base}/sync`).send({ entries: [turn(sourceId, content)] });
    await send("codex:d:1", "Something John deleted.");
    await send("codex:d:2", "Something retention removed.");
    const rows = await ctx.db.select().from(memoryRecords);
    for (const [sourceId, actorId] of [["codex:d:1", "user-john"], ["codex:d:2", "memory-retention"]] as const) {
      const row = rows.find((candidate) => candidate.sourceId === sourceId)!;
      await ctx.db.update(memoryRecords).set({ status: "deleted", content: null, evidence: null }).where(eq(memoryRecords.id, row.id));
      await ctx.db.insert(memoryReviewEvents).values({ companyId: row.companyId, recordId: row.id, scopeId: row.scopeId, action: "delete", actorType: actorId === "memory-retention" ? "system" : "user", actorId });
    }
    expect((await send("codex:d:1", "Something John deleted, changed.")).body.entries[0].outcome).toBe("deleted_before");
    expect((await send("codex:d:2", "Something retention removed.")).body.entries[0].outcome).toBe("added");
  });
});
