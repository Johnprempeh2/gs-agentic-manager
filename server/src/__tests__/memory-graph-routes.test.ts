import request from "supertest";
import { expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  heartbeatRuns,
  memoryConflicts,
  memoryExtractedFacts,
  memoryIngestOutbox,
  memoryOperations,
  memoryRecords,
  memoryRelationships,
  memoryReviewEvents,
  memoryScopes,
  memorySettings,
  principalPermissionGrants,
  projects,
} from "@greatstone/db";
import type {
  MemoryActivityCounts,
  MemoryActivityFeed,
  MemoryGraph,
  MemoryGraphEdgeDetail,
  MemoryGraphNodeDetail,
  MemoryScope,
} from "@greatstone/shared";
import { memoryRoutes } from "../routes/memory.js";
import type { MemoryEngine, MemoryEngineDocument } from "../services/memory-gateway/engine.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

// Memory graph and contribution activity read API (GRE-864, plan section 8).
// Synthetic Kestrel Works fixtures only.

function fakeEngine(): MemoryEngine {
  const docs: MemoryEngineDocument[] = [];
  return {
    async retain(doc) {
      const index = docs.findIndex((existing) => existing.documentId === doc.documentId);
      if (index >= 0) docs.splice(index, 1);
      docs.push(doc);
    },
    async recall(req) {
      const words = req.query.toLowerCase().split(/\W+/).filter(Boolean);
      return docs
        .filter((doc) => doc.bankId === req.bankId && doc.tags.some((tag) => req.tags.includes(tag)))
        .filter((doc) => words.some((word) => doc.content.toLowerCase().includes(word)))
        .map((doc) => ({ documentId: doc.documentId, text: doc.content, score: 0.5, unitId: `unit-${doc.documentId}`, factType: "world" }))
        .slice(0, req.limit);
    },
    async deleteDocument(bankId, documentId) {
      const index = docs.findIndex((doc) => doc.bankId === bankId && doc.documentId === documentId);
      if (index >= 0) docs.splice(index, 1);
    },
  };
}

describeEmbeddedPostgres("memory graph and contribution activity (GRE-864)", () => {
  const ctx = useEmbeddedPostgres("gsam-memory-graph-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(memoryExtractedFacts);
      await db.delete(memoryConflicts);
      await db.delete(memoryRelationships);
      await db.delete(memoryReviewEvents);
      await db.delete(memoryIngestOutbox);
      await db.delete(memoryOperations);
      await db.delete(memoryRecords);
      await db.delete(memoryScopes);
      await db.delete(memorySettings);
      await db.delete(principalPermissionGrants);
      await db.delete(heartbeatRuns);
      await db.delete(projects);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function seedAgent(companyId: string, name: string) {
    const [agent] = await ctx.db
      .insert(agents)
      .values({ companyId, name, role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
      .returning();
    return agent;
  }

  async function grant(companyId: string, agentId: string, permissionKey: string, scope: Record<string, unknown> | null = null) {
    await ctx.db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: agentId, permissionKey, scope });
  }

  async function setup(name: string, options: { enable?: boolean } = {}) {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, name);
    const engine = fakeEngine();
    const factory = (db: typeof ctx.db) => memoryRoutes(db, { engine });
    const board = routeApp(ctx.db, seeded.actor, factory);
    const asAgent = (agentId: string) =>
      routeApp(ctx.db, { type: "agent", agentId, companyId: seeded.companyId, runId: null, source: "agent_key" } as never, factory);
    const base = `/api/companies/${seeded.companyId}/memory`;
    if (options.enable === false) return { ...seeded, board, asAgent, base, org: null as unknown as MemoryScope };
    expect((await request(board).patch(`${base}/settings`).send({ enabled: true, retainMode: "chunks" })).status).toBe(200);
    const scopes = (await request(board).get(`${base}/scopes`)).body as MemoryScope[];
    const org = scopes.find((scope) => scope.kind === "organization")!;
    return { ...seeded, board, asAgent, base, org };
  }

  async function contribute(app: ReturnType<typeof routeApp>, base: string, body: Record<string, unknown>) {
    const res = await request(app).post(`${base}/records`).send(body);
    expect(res.status).toBe(201);
    return res.body.record as { id: string };
  }

  async function ok<T>(app: ReturnType<typeof routeApp>, url: string): Promise<T> {
    const res = await request(app).get(url);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as T;
  }

  /**
   * Kestrel Works fixture in the organization scope:
   * - `price` (approved, by Mason) and `newPrice` (Mason) that conflicts with it (inferred edge);
   * - `release` (approved) superseded by `newRelease` (by Everest), approved by the owner;
   * - `onboarding` supports `price`, stated by Everest.
   */
  async function seedOrgFixture(name: string) {
    const env = await setup(name);
    const { board, asAgent, base, org, companyId } = env;
    const mason = await seedAgent(companyId, "Mason");
    const everest = await seedAgent(companyId, "Everest");
    await grant(companyId, mason.id, "memory:contribute");
    await grant(companyId, everest.id, "memory:contribute");
    await grant(companyId, everest.id, "memory:approve");

    const price = await contribute(asAgent(mason.id), base, {
      scopeId: org.id,
      title: "Kestrel retainer",
      content: "Kestrel Works retainer is GBP 4,000 a month.",
      entities: ["Kestrel Works"],
      topics: ["retainer price"],
      sourceKind: "issue",
      sourceId: "KW-1",
    });
    expect((await request(board).post(`${base}/records/${price.id}/review`).send({ action: "approve", reason: "Contract" })).status).toBe(200);
    const newPrice = await contribute(asAgent(mason.id), base, {
      scopeId: org.id,
      content: "Kestrel Works retainer is GBP 2,500 a month.",
      entities: ["Kestrel Works"],
      topics: ["retainer price"],
    });

    const release = await contribute(board, base, { scopeId: org.id, content: "Kestrel releases ship on Fridays.", topics: ["release day"] });
    expect((await request(asAgent(everest.id)).post(`${base}/records/${release.id}/review`).send({ action: "dispute", reason: "Moved" })).status).toBe(200);
    const newRelease = await contribute(asAgent(everest.id), base, {
      scopeId: org.id,
      content: "Kestrel releases ship on Tuesdays.",
      topics: ["release cadence"],
      sourceKind: "document_revision",
      sourceId: "doc-7",
    });
    const superseded = await request(board)
      .post(`${base}/records/${release.id}/supersede`)
      .send({ replacementRecordId: newRelease.id, reason: "Release day moved" });
    expect(superseded.status).toBe(200);

    const onboarding = await contribute(asAgent(everest.id), base, {
      scopeId: org.id,
      content: "Kestrel onboarding pack quotes the monthly retainer.",
      topics: ["onboarding"],
    });
    const relationship = await request(asAgent(everest.id))
      .post(`${base}/relationships`)
      .send({ fromRecordId: onboarding.id, toRecordId: price.id, type: "supports", note: "Pack quotes the price", sourceKind: "issue", sourceId: "KW-2" });
    expect(relationship.status).toBe(201);

    return { ...env, mason, everest, price, newPrice, release, newRelease, onboarding, relationshipId: relationship.body.id as string };
  }

  it("answers empty views with a normal 200, and 404 while memory is off", async () => {
    const off = await setup("Off", { enable: false });
    expect((await request(off.board).get(`${off.base}/graph`)).status).toBe(404);
    expect((await request(off.board).get(`${off.base}/activity`)).status).toBe(404);
    expect((await request(off.board).get(`${off.base}/activity/counts`)).status).toBe(404);

    const { board, base } = await setup("Empty");
    const graph = await ok<MemoryGraph>(board, `${base}/graph`);
    expect(graph).toMatchObject({ nodes: [], edges: [], truncated: false });
    expect(graph.note).toMatch(/does not prove/);
    expect(await ok<MemoryActivityFeed>(board, `${base}/activity`)).toEqual({ items: [], nextCursor: null });
    const counts = await ok<MemoryActivityCounts>(board, `${base}/activity/counts`);
    expect(counts.contributors).toEqual([]);
    expect(counts.note).toMatch(/activity only/);
    // A filter that matches nothing is also a normal empty answer.
    expect((await ok<MemoryGraph>(board, `${base}/graph?q=nothing-matches-this`)).nodes).toEqual([]);
    expect((await request(board).get(`${base}/graph?status=bogus`)).status).toBe(400);
  });

  it("builds the graph only from stored relationships, supersession and the conflict check", async () => {
    const f = await seedOrgFixture("Graph");
    const graph = await ok<MemoryGraph>(f.board, `${f.base}/graph`);
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(
      [f.price.id, f.newPrice.id, f.release.id, f.newRelease.id, f.onboarding.id].sort(),
    );
    const byType = Object.fromEntries(graph.edges.map((edge) => [edge.type, edge]));
    expect(graph.edges).toHaveLength(3);
    expect(byType.supports).toMatchObject({
      id: `rel:${f.relationshipId}`,
      from: f.onboarding.id,
      to: f.price.id,
      kind: "explicit",
      origin: "relationship",
      author: { actorType: "agent", agentId: f.everest.id, name: "Everest" },
      source: { kind: "issue", id: "KW-2" },
    });
    expect(byType.supersedes).toMatchObject({
      id: `sup:${f.newRelease.id}`,
      from: f.newRelease.id,
      to: f.release.id,
      kind: "explicit",
      origin: "supersession",
      author: { actorType: "user", userId: f.userId },
    });
    expect(byType.possible_conflict).toMatchObject({
      from: f.newPrice.id,
      to: f.price.id,
      kind: "inferred",
      origin: "conflict_check",
      author: { actorType: "system", name: "Conflict check" },
    });
    // The release supersession closed its conflict, so it is not also an inferred edge.
    expect(graph.edges.filter((edge) => edge.kind === "inferred")).toHaveLength(1);
    const price = graph.nodes.find((node) => node.id === f.price.id)!;
    expect(price).toMatchObject({
      status: "approved",
      title: "Kestrel retainer",
      scopeName: "Organization",
      contributor: { actorType: "agent", agentId: f.mason.id, name: "Mason" },
      source: { kind: "issue", id: "KW-1" },
      openConflictCount: 1,
    });

    // Filters: agent, review status, text search, scope. Edges never dangle.
    const masons = await ok<MemoryGraph>(f.board, `${f.base}/graph?agentId=${f.mason.id}`);
    expect(masons.nodes.map((node) => node.id).sort()).toEqual([f.price.id, f.newPrice.id].sort());
    expect(masons.edges.map((edge) => edge.type)).toEqual(["possible_conflict"]);
    const approved = await ok<MemoryGraph>(f.board, `${f.base}/graph?status=approved`);
    expect(approved.nodes.map((node) => node.id).sort()).toEqual([f.price.id, f.newRelease.id].sort());
    expect(approved.edges).toEqual([]);
    const search = await ok<MemoryGraph>(f.board, `${f.base}/graph?q=tuesdays`);
    expect(search.nodes.map((node) => node.id)).toEqual([f.newRelease.id]);
    // Searching the source issue id finds the memory (plan 8.3.3, GRE-914).
    const bySource = await ok<MemoryGraph>(f.board, `${f.base}/graph?q=kw-1`);
    expect(bySource.nodes.map((node) => node.id)).toContain(f.price.id);
    expect((await ok<MemoryGraph>(f.board, `${f.base}/graph?q=%25`)).nodes).toEqual([]);
    expect((await ok<MemoryGraph>(f.board, `${f.base}/graph?scopeId=${f.org.id}`)).nodes).toHaveLength(5);
    const limited = await ok<MemoryGraph>(f.board, `${f.base}/graph?limit=2`);
    expect(limited.truncated).toBe(true);
    const kept = new Set(limited.nodes.map((node) => node.id));
    expect(limited.edges.every((edge) => kept.has(edge.from) && kept.has(edge.to))).toBe(true);
  });

  it("gives node and edge detail with the three provenance roles kept apart", async () => {
    const f = await seedOrgFixture("Detail");
    // A recall links an engine-extracted fact to the record and its contributor.
    expect((await request(f.asAgent(f.mason.id)).post(`${f.base}/recall`).send({ query: "4,000" })).status).toBe(200);

    const detail = await ok<MemoryGraphNodeDetail>(f.board, `${f.base}/graph/nodes/${f.price.id}`);
    expect(detail.record).toMatchObject({ id: f.price.id, content: "Kestrel Works retainer is GBP 4,000 a month." });
    expect(detail.provenance.contributor).toMatchObject({ actorType: "agent", agentId: f.mason.id, name: "Mason" });
    expect(detail.provenance.reviewers).toEqual([
      expect.objectContaining({ action: "approve", actor: expect.objectContaining({ actorType: "user", userId: f.userId }), reason: "Contract" }),
    ]);
    expect(detail.provenance.extraction.facts).toEqual([
      expect.objectContaining({ recordId: f.price.id, engineUnitId: `unit-${f.price.id}`, contributorAgentId: f.mason.id }),
    ]);
    expect(detail.edges.map((edge) => edge.type).sort()).toEqual(["possible_conflict", "supports"]);
    expect(detail.neighbours.map((node) => node.id).sort()).toEqual([f.newPrice.id, f.onboarding.id].sort());

    // The challenger's conflict check is a check, not a review step.
    const challenger = await ok<MemoryGraphNodeDetail>(f.board, `${f.base}/graph/nodes/${f.newPrice.id}`);
    expect(challenger.provenance.reviewers).toEqual([]);
    expect(challenger.provenance.checks).toEqual([expect.objectContaining({ action: "conflict_flagged", relatedRecordId: f.price.id })]);

    // Supersession chain in both directions.
    const replaced = await ok<MemoryGraphNodeDetail>(f.board, `${f.base}/graph/nodes/${f.release.id}`);
    expect(replaced.chain.map((node) => node.id)).toEqual([f.release.id, f.newRelease.id]);
    expect(replaced.provenance.reviewers.map((step) => step.action)).toEqual(["dispute", "superseded_by"]);
    expect(replaced.provenance.reviewers[0].actor).toMatchObject({ agentId: f.everest.id, name: "Everest" });

    const rel = await ok<MemoryGraphEdgeDetail>(f.board, `${f.base}/graph/edges/rel:${f.relationshipId}`);
    expect(rel).toMatchObject({ edge: { type: "supports", kind: "explicit" }, from: { id: f.onboarding.id }, to: { id: f.price.id }, statedNote: "Pack quotes the price" });
    expect(rel.meaning).toMatch(/stated/);
    const sup = await ok<MemoryGraphEdgeDetail>(f.board, `${f.base}/graph/edges/sup:${f.newRelease.id}`);
    expect(sup.meaning).toMatch(/replaced/);
    const conflictEdge = detail.edges.find((edge) => edge.type === "possible_conflict")!;
    const cfl = await ok<MemoryGraphEdgeDetail>(f.board, `${f.base}/graph/edges/${conflictEdge.id}`);
    expect(cfl).toMatchObject({ edge: { kind: "inferred" }, conflictState: "open", sharedTerms: expect.arrayContaining(["retainer price"]) });
    expect(cfl.meaning).toMatch(/not proof/);

    for (const bad of ["rel:not-a-uuid", `xyz:${f.relationshipId}`, `sup:${f.price.id}`, "nothing"]) {
      expect((await request(f.board).get(`${f.base}/graph/edges/${bad}`)).status).toBe(404);
    }
    expect((await request(f.board).get(`${f.base}/graph/nodes/not-a-uuid`)).status).toBe(404);
  });

  it("feeds activity by agent and date with history, and counts that match the drill-down", async () => {
    const f = await seedOrgFixture("Activity");
    const feed = await ok<MemoryActivityFeed>(f.board, `${f.base}/activity`);
    expect(feed.items).toHaveLength(5);
    const created = feed.items.map((item) => new Date(item.record.createdAt).getTime());
    expect([...created].sort((a, b) => b - a)).toEqual(created);
    const newRelease = feed.items.find((item) => item.record.id === f.newRelease.id)!;
    expect(newRelease).toMatchObject({
      scopeName: "Organization",
      contributor: { agentId: f.everest.id, name: "Everest" },
      source: { kind: "document_revision", id: "doc-7" },
      record: { status: "approved", supersedesId: f.release.id },
    });
    expect(newRelease.history.map((event) => event.action)).toEqual(["contribute", "supersede"]);

    // Paging covers every record once.
    const first = await ok<MemoryActivityFeed>(f.board, `${f.base}/activity?limit=2`);
    const second = await ok<MemoryActivityFeed>(f.board, `${f.base}/activity?limit=2&cursor=${first.nextCursor}`);
    const third = await ok<MemoryActivityFeed>(f.board, `${f.base}/activity?limit=2&cursor=${second.nextCursor}`);
    expect(third.nextCursor).toBeNull();
    expect([...first.items, ...second.items, ...third.items].map((item) => item.record.id)).toEqual(feed.items.map((item) => item.record.id));

    // Date window: `to` is exclusive.
    const future = new Date(Date.now() + 60_000).toISOString();
    expect((await ok<MemoryActivityFeed>(f.board, `${f.base}/activity?from=${future}`)).items).toEqual([]);
    expect((await ok<MemoryActivityFeed>(f.board, `${f.base}/activity?to=${future}`)).items).toHaveLength(5);

    const counts = await ok<MemoryActivityCounts>(f.board, `${f.base}/activity/counts`);
    // Sorted by name, never by count.
    expect(counts.contributors.map((row) => row.contributor.name ?? row.contributor.userId)).toEqual(
      ["Everest", "Mason", f.userId].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
    );
    const everest = counts.contributors.find((row) => row.contributor.agentId === f.everest.id)!;
    expect(everest).toMatchObject({
      contributionCount: 2,
      contributionCountByStatus: { approved: 1, unreviewed: 1, disputed: 0, superseded: 0, deleted: 0 },
      relationshipsStatedCount: 1,
      reviewActionCount: 1,
    });
    const owner = counts.contributors.find((row) => row.contributor.userId === f.userId)!;
    expect(owner).toMatchObject({ contributionCount: 1, reviewActionCount: 2 });
    for (const row of counts.contributors) {
      const url = row.contributor.agentId ? `agentId=${row.contributor.agentId}` : `userId=${encodeURIComponent(row.contributor.userId!)}`;
      const drill = await ok<MemoryActivityFeed>(f.board, `${f.base}/activity?${url}&limit=200`);
      expect(drill.items).toHaveLength(row.contributionCount);
    }
    // No field speaks of quality or rank.
    const keys = counts.contributors.flatMap((row) => Object.keys(row));
    expect(keys.filter((key) => /score|rank|quality/i.test(key))).toEqual([]);

    // A deleted record stays in the feed as a tombstone and leaves the graph.
    expect((await request(f.board).post(`${f.base}/records/${f.newPrice.id}/delete`).send({ reason: "Wrong" })).status).toBe(200);
    const after = await ok<MemoryActivityFeed>(f.board, `${f.base}/activity?status=deleted`);
    expect(after.items).toEqual([expect.objectContaining({ record: expect.objectContaining({ id: f.newPrice.id, content: null }) })]);
    const graph = await ok<MemoryGraph>(f.board, `${f.base}/graph`);
    expect(graph.nodes.map((node) => node.id)).not.toContain(f.newPrice.id);
    expect(graph.edges.some((edge) => edge.type === "possible_conflict")).toBe(false);
  });

  it("shows a restricted caller no hidden node, edge, label, count or feed row", async () => {
    const f = await seedOrgFixture("Restricted");
    const outsider = await seedAgent(f.companyId, "Outsider");
    const client = await request(f.board).post(`${f.base}/scopes`).send({ kind: "client", name: "Kestrel Works client" });
    const hiddenA = await contribute(f.board, f.base, { scopeId: client.body.id, title: "Hidden label", content: "Kestrel care plan is GBP 120.", topics: ["care plan"] });
    const hiddenC = await contribute(f.board, f.base, { scopeId: client.body.id, content: "Kestrel asked for a call.", entryType: "observation" });
    const rel = await request(f.board).post(`${f.base}/relationships`).send({ fromRecordId: hiddenC.id, toRecordId: hiddenA.id, type: "same_subject" });
    expect(rel.status).toBe(201);

    // The owner sees the client scope.
    const full = await ok<MemoryGraph>(f.board, `${f.base}/graph`);
    expect(full.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([hiddenA.id, hiddenC.id]));
    const ownerCounts = await ok<MemoryActivityCounts>(f.board, `${f.base}/activity/counts`);
    expect(ownerCounts.contributors.find((row) => row.contributor.userId === f.userId)!.contributionCount).toBe(3);

    // An agent without a client grant: org records only, nothing about the client scope.
    const app = f.asAgent(outsider.id);
    const graph = await ok<MemoryGraph>(app, `${f.base}/graph`);
    expect(graph.nodes.map((node) => node.id)).not.toEqual(expect.arrayContaining([hiddenA.id]));
    expect(graph.nodes).toHaveLength(5);
    expect(graph.scopes.map((scope) => scope.id)).not.toContain(client.body.id);
    const body = JSON.stringify(graph);
    expect(body).not.toContain("Hidden label");
    expect(body).not.toContain("Kestrel Works client");
    expect(body).not.toContain(hiddenA.id);
    const ids = new Set(graph.nodes.map((node) => node.id));
    expect(graph.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to))).toBe(true);

    // Naming the hidden scope gives an empty view, not an error and not a leak.
    expect((await ok<MemoryGraph>(app, `${f.base}/graph?scopeId=${client.body.id}`)).nodes).toEqual([]);
    expect((await ok<MemoryActivityFeed>(app, `${f.base}/activity?scopeId=${client.body.id}`)).items).toEqual([]);

    // Detail of a hidden node or edge is the same 404 as a missing one.
    expect((await request(app).get(`${f.base}/graph/nodes/${hiddenA.id}`)).status).toBe(404);
    expect((await request(app).get(`${f.base}/graph/edges/rel:${rel.body.id}`)).status).toBe(404);
    expect((await request(app).get(`${f.base}/graph/nodes/${crypto.randomUUID()}`)).status).toBe(404);

    // Feed and counts leave the hidden records out entirely.
    const feed = await ok<MemoryActivityFeed>(app, `${f.base}/activity?limit=200`);
    expect(feed.items.map((item) => item.record.id)).not.toContain(hiddenA.id);
    expect(feed.items).toHaveLength(5);
    expect((await ok<MemoryActivityFeed>(app, `${f.base}/activity?cursor=${hiddenA.id}`)).items).toEqual([]);
    const counts = await ok<MemoryActivityCounts>(app, `${f.base}/activity/counts`);
    const owner = counts.contributors.find((row) => row.contributor.userId === f.userId)!;
    expect(owner.contributionCount).toBe(1);
    expect(owner.relationshipsStatedCount).toBe(0);
    expect(counts.contributors.reduce((sum, row) => sum + row.contributionCount, 0)).toBe(5);

    // Another agent's working notes stay hidden too.
    const notes = (await request(f.asAgent(f.mason.id)).get(`${f.base}/scopes`)).body as MemoryScope[];
    const masonNotes = notes.find((scope) => scope.kind === "agent")!;
    const note = await contribute(f.asAgent(f.mason.id), f.base, { scopeId: masonNotes.id, content: "Draft idea for Kestrel." });
    expect((await ok<MemoryGraph>(app, `${f.base}/graph`)).nodes.map((node) => node.id)).not.toContain(note.id);
    expect((await ok<MemoryGraph>(f.asAgent(f.mason.id), `${f.base}/graph`)).nodes.map((node) => node.id)).toContain(note.id);

    // Every read leaves an audit row; denied detail reads are logged as denied.
    const ops = await ctx.db.select().from(memoryOperations).where(eq(memoryOperations.actorId, outsider.id));
    expect(ops.filter((op) => op.outcome === "denied").map((op) => op.operation)).toEqual(
      expect.arrayContaining(["graph_node", "graph_edge"]),
    );
  });
});
