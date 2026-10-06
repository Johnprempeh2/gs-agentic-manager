import { randomUUID } from "node:crypto";
import request from "supertest";
import { expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  heartbeatRuns,
  issues,
  memoryConflicts,
  memoryExtractedFacts,
  memoryIngestOutbox,
  memoryLinkLeads,
  memoryOperations,
  memoryRecords,
  memoryRelationships,
  memoryReviewEvents,
  memoryScopes,
  memorySettings,
  principalPermissionGrants,
  runIdentityContexts,
} from "@greatstone/db";
import type {
  MemoryActivityCounts,
  MemoryGraph,
  MemoryGraphEdgeDetail,
  MemoryLinkCheckResult,
  MemoryLinkLeadList,
  MemoryRelationship,
  MemoryScope,
} from "@greatstone/shared";
import { memoryRoutes } from "../routes/memory.js";
import { memoryToolRoutes } from "../routes/memory-tools.js";
import type { MemoryEngine } from "../services/memory-gateway/engine.js";
import {
  findLinkLeads,
  resetMemoryLinkCheckSchedule,
  runScheduledMemoryLinkChecks,
  MEMORY_LINK_CHECK_INTERVAL_MS,
} from "../services/memory-gateway/link-check.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

// Memory linking (6 Oct 2026): the agent `memory_link` tool and `relatedTo`,
// the link check and its leads, and what the graph shows of both. Synthetic
// Kestrel Works fixtures only.

function fakeEngine(): MemoryEngine {
  return {
    async retain() {},
    async recall() {
      return [];
    },
    async deleteDocument() {},
  };
}

it("findLinkLeads pairs records on a shared subject only, skips known pairs and common terms", () => {
  const base = { scopeKind: "organization", title: null, sourceKind: null, sourceId: null };
  const records = [
    { ...base, id: "a", scopeId: "org", content: "Kestrel Works retainer is GBP 4,000 a month.", entities: ["Kestrel Works"], topics: ["retainer"] },
    { ...base, id: "b", scopeId: "org", content: "Kestrel Works renewal quotes GBP 4,000 a month.", entities: ["kestrel works "], topics: [] },
    { ...base, id: "c", scopeId: "org", content: "Alder Bakery opens at 7am.", entities: ["Alder Bakery"], topics: ["retainer"] },
    { ...base, id: "d", scopeId: "client-1", scopeKind: "client", content: "Kestrel Works client note.", entities: ["Kestrel Works"], topics: [] },
  ];
  const leads = findLinkLeads(records);
  expect(leads.map((lead) => `${lead.from.id}-${lead.to.id}`)).toEqual(["a-b"]);
  expect(leads[0]!.basis).toEqual({ entities: ["kestrel works"], topics: [], values: ["GBP 4,000 a month"], sameSource: false });
  // A single shared topic is not enough; a client record never pairs outside its scope.
  expect(findLinkLeads(records, { known: new Set(["a:b"]) })).toEqual([]);
  // A term on most records says nothing about a pair.
  const crowd = Array.from({ length: 10 }, (_, i) => ({ ...base, id: `r${i}`, scopeId: "org", content: "x", entities: ["Greatstone"], topics: [] }));
  expect(findLinkLeads(crowd)).toEqual([]);
});

describeEmbeddedPostgres("memory linking (agent links, link check, graph)", () => {
  const ctx = useEmbeddedPostgres("gsam-memory-links-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(memoryLinkLeads);
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
      await db.delete(runIdentityContexts);
      await db.delete(heartbeatRuns);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
      resetMemoryLinkCheckSchedule();
    },
  });

  async function seedRun(companyId: string, name: string) {
    const [agent] = await ctx.db
      .insert(agents)
      .values({ companyId, name, role: "engineer", status: "running", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
      .returning();
    const issueId = randomUUID();
    await ctx.db.insert(issues).values({ id: issueId, companyId, title: `${name} task`, status: "in_progress", priority: "medium" });
    const runId = randomUUID();
    await ctx.db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: agent.id, status: "running", contextSnapshot: { issueId } });
    return { agentId: agent.id, runId };
  }

  async function grant(companyId: string, agentId: string, permissionKey: string, scope: Record<string, unknown> | null = null) {
    await ctx.db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: agentId, permissionKey, scope });
  }

  async function setup(name: string) {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, name);
    const engine = fakeEngine();
    const board = routeApp(ctx.db, seeded.actor, (db) => memoryRoutes(db, { engine }));
    const base = `/api/companies/${seeded.companyId}/memory`;
    expect((await request(board).patch(`${base}/settings`).send({ enabled: true, retainMode: "chunks" })).status).toBe(200);
    const org = ((await request(board).get(`${base}/scopes`)).body as MemoryScope[]).find((scope) => scope.kind === "organization")!;
    const client = (await request(board).post(`${base}/scopes`).send({ kind: "client", name: "Kestrel Works client" })).body as MemoryScope;
    /** An agent calling the REST routes with a plain agent key. */
    const asAgent = (agentId: string) =>
      routeApp(ctx.db, { type: "agent", agentId, companyId: seeded.companyId, runId: null, source: "agent_key" } as never, (db) =>
        memoryRoutes(db, { engine }),
      );
    /** An agent's task run calling the MCP memory tools. */
    const asRun = (agentId: string, runId: string) =>
      routeApp(ctx.db, { type: "agent", source: "agent_jwt", agentId, companyId: seeded.companyId, runId } as never, (db) =>
        memoryToolRoutes(db, { engine }),
      );
    return { ...seeded, board, base, org, client, asAgent, asRun };
  }

  async function contribute(app: ReturnType<typeof routeApp>, base: string, body: Record<string, unknown>) {
    const res = await request(app).post(`${base}/records`).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.record as { id: string; scopeId: string };
  }

  let rpcId = 0;
  function callTool(app: ReturnType<typeof routeApp>, name: string, args: Record<string, unknown>) {
    return request(app).post("/api/mcp/memory-tools").send({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } });
  }

  async function ok<T>(app: ReturnType<typeof routeApp>, url: string): Promise<T> {
    const res = await request(app).get(url);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as T;
  }

  it("memory_link links two readable records with the agent as author and the run as source", async () => {
    const f = await setup("Link tool");
    const mason = await seedRun(f.companyId, "Mason");
    await grant(f.companyId, mason.agentId, "memory:contribute");
    const price = await contribute(f.board, f.base, { scopeId: f.org.id, content: "Kestrel Works retainer is GBP 4,000 a month." });
    const pack = await contribute(f.board, f.base, { scopeId: f.org.id, content: "Kestrel onboarding pack quotes the retainer." });
    const app = f.asRun(mason.agentId, mason.runId);

    const list = await request(app).post("/api/mcp/memory-tools").send({ jsonrpc: "2.0", id: ++rpcId, method: "tools/list" });
    const linkTool = list.body.result.tools.find((tool: { name: string }) => tool.name === "memory_link");
    expect(linkTool.description).toMatch(/reason/);

    const res = await callTool(app, "memory_link", { fromRecordId: pack.id, toRecordId: price.id, type: "supports", reason: "The pack quotes this price" });
    expect(res.body.result.isError, JSON.stringify(res.body)).toBeUndefined();
    expect(res.body.result.structuredContent).toMatchObject({
      fromRecordId: pack.id,
      toRecordId: price.id,
      type: "supports",
      authorAgentId: mason.agentId,
      authorUserId: null,
      runId: mason.runId,
      sourceKind: "run",
      sourceId: mason.runId,
      note: "The pack quotes this price",
    });
    const [audit] = await ctx.db
      .select()
      .from(memoryOperations)
      .where(and(eq(memoryOperations.operation, "memory_link"), eq(memoryOperations.outcome, "ok")));
    expect(audit).toMatchObject({ actorType: "agent", actorId: mason.agentId, runId: mason.runId, recordId: pack.id });
    expect(audit!.detail).toMatchObject({ type: "supports", toRecordId: price.id, via: "memory_link" });
    expect(JSON.stringify(audit!.detail)).not.toContain("quotes this price");

    // The same link twice is refused; the graph shows it as a stated edge.
    const again = await callTool(app, "memory_link", { fromRecordId: pack.id, toRecordId: price.id, type: "supports", reason: "Again" });
    expect(again.body.result).toMatchObject({ isError: true, content: [{ text: "This relationship already exists" }] });
    const graph = await ok<MemoryGraph>(f.board, `${f.base}/graph`);
    expect(graph.edges).toEqual([
      expect.objectContaining({ from: pack.id, to: price.id, type: "supports", kind: "explicit", author: expect.objectContaining({ agentId: mason.agentId, name: "Mason" }), basis: null }),
    ]);

    // Arguments cannot carry an author.
    const forged = await callTool(app, "memory_link", { fromRecordId: pack.id, toRecordId: price.id, type: "refines", reason: "x", authorAgentId: randomUUID() });
    expect(forged.body.result.content[0].text).toMatch(/Invalid arguments/);
  });

  it("memory_link is refused without a contribute grant and across a hidden or client scope", async () => {
    const f = await setup("Link refusals");
    const ridge = await seedRun(f.companyId, "Ridge");
    const price = await contribute(f.board, f.base, { scopeId: f.org.id, content: "Kestrel Works retainer is GBP 4,000 a month." });
    const pack = await contribute(f.board, f.base, { scopeId: f.org.id, content: "Kestrel onboarding pack." });
    const secret = await contribute(f.board, f.base, { scopeId: f.client.id, content: "Kestrel care plan is GBP 120.", topics: ["care plan"] });
    const app = f.asRun(ridge.agentId, ridge.runId);

    // Reads org memory by default, but may not contribute there.
    const noGrant = await callTool(app, "memory_link", { fromRecordId: pack.id, toRecordId: price.id, type: "supports", reason: "x" });
    expect(noGrant.body.result).toMatchObject({ isError: true, content: [{ text: "You do not have the right to add relationships in this scope" }] });

    // A client record it cannot read is the same 404 as a missing one, grant or not.
    await grant(f.companyId, ridge.agentId, "memory:contribute");
    const hidden = await callTool(app, "memory_link", { fromRecordId: pack.id, toRecordId: secret.id, type: "same_subject", reason: "x" });
    expect(hidden.body.result).toMatchObject({ isError: true, content: [{ text: "Memory record not found" }] });
    const missing = await callTool(app, "memory_link", { fromRecordId: pack.id, toRecordId: randomUUID(), type: "same_subject", reason: "x" });
    expect(missing.body.result.content[0].text).toBe("Memory record not found");

    // Even with read and contribute on the client scope, a client record links only inside it.
    await ctx.db.delete(principalPermissionGrants);
    await grant(f.companyId, ridge.agentId, "memory:contribute", { memoryScopeIds: [f.org.id, f.client.id] });
    await grant(f.companyId, ridge.agentId, "memory:read", { memoryScopeIds: [f.client.id] });
    const across = await callTool(app, "memory_link", { fromRecordId: secret.id, toRecordId: price.id, type: "same_subject", reason: "x" });
    expect(across.body.result).toMatchObject({ isError: true, content: [{ text: "A client or restricted entry can only be linked to entries in its own scope" }] });

    expect(await ctx.db.select().from(memoryRelationships)).toEqual([]);
    const denied = await ctx.db
      .select()
      .from(memoryOperations)
      .where(and(eq(memoryOperations.operation, "memory_link"), eq(memoryOperations.outcome, "denied")));
    expect(denied.map((row) => (row.detail as { reason?: string } | null)?.reason ?? "not_found").sort()).toEqual(
      ["cross_boundary", "no_contribute_right", "not_found", "not_found"].sort(),
    );
  });

  it("memory_contribute links the new entry to relatedTo records, and saves nothing when one is refused", async () => {
    const f = await setup("Related to");
    const mason = await seedRun(f.companyId, "Mason");
    const price = await contribute(f.board, f.base, { scopeId: f.org.id, content: "Kestrel Works retainer is GBP 4,000 a month." });
    const secret = await contribute(f.board, f.base, { scopeId: f.client.id, content: "Kestrel care plan.", topics: ["care plan"] });
    const app = f.asRun(mason.agentId, mason.runId);

    // Without the org grant the link to an org entry is refused and no note is saved.
    const before = (await ctx.db.select().from(memoryRecords)).length;
    const refused = await callTool(app, "memory_contribute", { content: "Kestrel asked to keep the retainer.", relatedTo: [price.id] });
    expect(refused.body.result).toMatchObject({ isError: true });
    const hidden = await callTool(app, "memory_contribute", { content: "x", relatedTo: [secret.id] });
    expect(hidden.body.result.content[0].text).toBe("Memory record not found");
    expect((await ctx.db.select().from(memoryRecords)).length).toBe(before);

    await grant(f.companyId, mason.agentId, "memory:contribute");
    const saved = await callTool(app, "memory_contribute", {
      content: "Kestrel asked to keep the retainer at GBP 4,000.",
      relatedTo: [{ recordId: price.id, type: "supports", reason: "Client confirmed on the call" }],
    });
    expect(saved.body.result.isError, JSON.stringify(saved.body)).toBeUndefined();
    const result = saved.body.result.structuredContent;
    expect(result.record.scopeKind).toBe("agent");
    expect(result.links).toEqual([expect.objectContaining({ recordId: price.id, type: "supports", error: null })]);
    const [rel] = await ctx.db.select().from(memoryRelationships);
    expect(rel).toMatchObject({ fromRecordId: result.record.id, toRecordId: price.id, authorAgentId: mason.agentId, runId: mason.runId, note: "Client confirmed on the call" });

    // A plain id defaults to same_subject with a standard note.
    const plain = await callTool(app, "memory_contribute", { content: "Kestrel retainer reviewed in October.", relatedTo: [price.id] });
    expect(plain.body.result.structuredContent.links).toEqual([expect.objectContaining({ type: "same_subject", error: null })]);
  });

  it("the link check proposes shared-subject pairs, never across a client scope, and is idempotent", async () => {
    const f = await setup("Check");
    const a = await contribute(f.board, f.base, { scopeId: f.org.id, content: "Kestrel Works retainer is GBP 4,000 a month.", entities: ["Kestrel Works"], topics: ["retainer"] });
    const b = await contribute(f.board, f.base, { scopeId: f.org.id, content: "Kestrel Works renewal call booked.", entities: ["Kestrel Works"] });
    const unrelated = await contribute(f.board, f.base, { scopeId: f.org.id, content: "Alder Bakery opens at 7am.", entities: ["Alder Bakery"] });
    const c1 = await contribute(f.board, f.base, { scopeId: f.client.id, content: "Kestrel Works care plan is GBP 120.", entities: ["Kestrel Works"], topics: ["care plan"] });
    const c2 = await contribute(f.board, f.base, { scopeId: f.client.id, content: "Kestrel Works care plan renews in May.", entities: ["Kestrel Works"], topics: ["care plan"] });

    const first = await request(f.board).post(`${f.base}/link-check`).send({});
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body as MemoryLinkCheckResult).toMatchObject({ recordsChecked: 5, proposed: 2 });
    const leads = await ctx.db.select().from(memoryLinkLeads);
    const pairs = leads.map((lead) => [lead.fromRecordId, lead.toRecordId].sort().join(":")).sort();
    expect(pairs).toEqual([[a.id, b.id].sort().join(":"), [c1.id, c2.id].sort().join(":")].sort());
    expect(pairs.join()).not.toContain(unrelated.id);
    // The client records share "Kestrel Works" with the org ones, but never pair with them.
    for (const lead of leads) expect(lead.fromScopeId).toBe(lead.toScopeId);

    // Running again, or on the schedule, proposes nothing new.
    const second = await request(f.board).post(`${f.base}/link-check`).send({});
    expect(second.body.proposed).toBe(0);
    expect(await ctx.db.select().from(memoryLinkLeads)).toHaveLength(2);

    // The owner's graph shows the leads as inferred edges with their basis.
    const graph = await ok<MemoryGraph>(f.board, `${f.base}/graph`);
    const orgLead = graph.edges.find((edge) => edge.origin === "link_check" && [edge.from, edge.to].includes(a.id))!;
    expect(orgLead).toMatchObject({
      type: "same_subject",
      kind: "inferred",
      author: { actorType: "system", name: "Link check" },
      basis: { entities: ["kestrel works"], topics: [], values: [], sameSource: false },
    });
    const detail = await ok<MemoryGraphEdgeDetail>(f.board, `${f.base}/graph/edges/${orgLead.id}`);
    expect(detail).toMatchObject({ sharedTerms: ["kestrel works"], leadId: orgLead.id.slice(4) });
    expect(detail.meaning).toMatch(/not proof/);

    // Only the owner or a memory admin runs it by hand.
    const agent = await seedRun(f.companyId, "Ridge");
    expect((await request(f.asAgent(agent.agentId)).post(`${f.base}/link-check`).send({})).status).toBe(403);
  });

  it("a restricted reader sees no lead, edge or count that touches a hidden record", async () => {
    const f = await setup("Restricted");
    const outsider = await seedRun(f.companyId, "Outsider");
    const mason = await seedRun(f.companyId, "Mason");
    await grant(f.companyId, mason.agentId, "memory:contribute");
    await contribute(f.board, f.base, { scopeId: f.client.id, title: "Hidden label", content: "Kestrel Works care plan.", entities: ["Kestrel Works"], topics: ["care plan"] });
    await contribute(f.board, f.base, { scopeId: f.client.id, content: "Kestrel Works care plan renewal.", entities: ["Kestrel Works"], topics: ["renewal"] });
    const orgRecord = await contribute(f.board, f.base, { scopeId: f.org.id, content: "Kestrel retainer.", entities: ["Kestrel retainer"] });

    // Mason links a note in his own working notes to the org record: a stated cross-scope link.
    const app = f.asRun(mason.agentId, mason.runId);
    const note = await callTool(app, "memory_contribute", {
      content: "Kestrel retainer draft thoughts.",
      entities: ["Kestrel retainer"],
      relatedTo: [{ recordId: orgRecord.id, type: "refines", reason: "Draft builds on it" }],
    });
    const noteId = note.body.result.structuredContent.record.id as string;
    expect((await request(f.board).post(`${f.base}/link-check`).send({})).status).toBe(200);

    const owner = await ok<MemoryGraph>(f.board, `${f.base}/graph`);
    expect(owner.edges.filter((edge) => edge.origin === "link_check")).toHaveLength(1);
    expect(owner.edges.some((edge) => edge.type === "refines" && edge.from === noteId)).toBe(true);

    // The outsider reads org memory only: no client lead, no edge to Mason's notes.
    const reader = f.asAgent(outsider.agentId);
    const graph = await ok<MemoryGraph>(reader, `${f.base}/graph`);
    const ids = new Set(graph.nodes.map((node) => node.id));
    expect([...ids]).toEqual([orgRecord.id]);
    expect(graph.edges).toEqual([]);
    expect(JSON.stringify(graph)).not.toContain("Hidden label");
    const leads = await ok<MemoryLinkLeadList>(reader, `${f.base}/link-leads?state=all`);
    expect(leads.leads).toEqual([]);
    const ownerLeads = await ok<MemoryLinkLeadList>(f.board, `${f.base}/link-leads`);
    expect(ownerLeads.leads).toHaveLength(1);
    expect((await request(reader).get(`${f.base}/graph/edges/lnk:${ownerLeads.leads[0]!.id}`)).status).toBe(404);
    const rels = await ok<MemoryRelationship[]>(reader, `${f.base}/records/${orgRecord.id}/relationships`);
    expect(rels).toEqual([]);
    const counts = await ok<MemoryActivityCounts>(reader, `${f.base}/activity/counts`);
    expect(counts.contributors.every((row) => row.relationshipsStatedCount === 0)).toBe(true);
    // Mason sees his own link.
    const masonView = await ok<MemoryRelationship[]>(f.asAgent(mason.agentId), `${f.base}/records/${orgRecord.id}/relationships`);
    expect(masonView.map((rel) => rel.fromRecordId)).toEqual([noteId]);
    // A reader cannot act on a lead it cannot see.
    const confirm = await request(reader).post(`${f.base}/link-leads/${ownerLeads.leads[0]!.id}/confirm`).send({ reason: "x" });
    expect(confirm.status).toBe(404);
  });

  it("a confirmed lead becomes a stated link with its basis; a dismissed one is never proposed again", async () => {
    const f = await setup("Review");
    const everest = await seedRun(f.companyId, "Everest");
    const ridge = await seedRun(f.companyId, "Ridge");
    await grant(f.companyId, everest.agentId, "memory:approve");
    const a = await contribute(f.board, f.base, { scopeId: f.org.id, content: "Kestrel Works retainer is GBP 4,000 a month.", entities: ["Kestrel Works"] });
    const b = await contribute(f.board, f.base, { scopeId: f.org.id, content: "Kestrel Works invoice for GBP 4,000 a month.", entities: ["Kestrel Works"] });
    const c = await contribute(f.board, f.base, { scopeId: f.org.id, content: "Alder Bakery opens at 7am.", entities: ["Alder Bakery"], sourceKind: "issue", sourceId: "AB-1" });
    const d = await contribute(f.board, f.base, { scopeId: f.org.id, content: "Alder Bakery menu photos.", sourceKind: "issue", sourceId: "AB-1" });
    await request(f.board).post(`${f.base}/link-check`).send({});
    const { leads } = await ok<MemoryLinkLeadList>(f.board, `${f.base}/link-leads`);
    expect(leads).toHaveLength(2);
    const ab = leads.find((lead) => [lead.fromRecordId, lead.toRecordId].includes(a.id))!;
    const cd = leads.find((lead) => [lead.fromRecordId, lead.toRecordId].includes(c.id))!;
    expect(ab.basis).toEqual({ entities: ["kestrel works"], topics: [], values: ["GBP 4,000 a month"], sameSource: false });
    expect(cd.basis).toMatchObject({ sameSource: true });
    expect([cd.fromRecordId, cd.toRecordId].sort()).toEqual([c.id, d.id].sort());

    // An agent without a review right cannot confirm.
    const refused = await request(f.asAgent(ridge.agentId)).post(`${f.base}/link-leads/${ab.id}/confirm`).send({ reason: "Same client" });
    expect(refused.status).toBe(403);

    // Everest (memory:approve) confirms: a stated link with Everest as author and the basis kept.
    const confirmed = await request(f.asAgent(everest.agentId)).post(`${f.base}/link-leads/${ab.id}/confirm`).send({ type: "supports", reason: "Invoice matches the retainer" });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body).toMatchObject({ state: "confirmed", relationshipId: expect.any(String) });
    const graph = await ok<MemoryGraph>(f.board, `${f.base}/graph`);
    const stated = graph.edges.find((edge) => edge.id === `rel:${confirmed.body.relationshipId}`)!;
    expect(stated).toMatchObject({
      type: "supports",
      kind: "explicit",
      author: expect.objectContaining({ agentId: everest.agentId }),
      source: { kind: "memory_link_lead", id: ab.id },
      basis: ab.basis,
    });
    expect(graph.edges.some((edge) => edge.id === `lnk:${ab.id}`)).toBe(false);
    expect((await request(f.board).post(`${f.base}/link-leads/${ab.id}/dismiss`).send({ reason: "x" })).status).toBe(409);

    // John dismisses the other; the check never proposes it again.
    expect((await request(f.board).post(`${f.base}/link-leads/${cd.id}/dismiss`).send({ reason: "Different subjects" })).status).toBe(200);
    expect((await request(f.board).post(`${f.base}/link-check`).send({})).body.proposed).toBe(0);
    expect((await ok<MemoryGraph>(f.board, `${f.base}/graph`)).edges.filter((edge) => edge.origin === "link_check")).toEqual([]);
    const ops = await ctx.db.select().from(memoryOperations).where(eq(memoryOperations.companyId, f.companyId));
    expect(ops.map((op) => op.operation)).toEqual(expect.arrayContaining(["link_check", "link_lead_confirm", "link_lead_dismiss"]));

    // Deleting an end closes its leads and clears the terms they matched on.
    await ctx.db.delete(memoryLinkLeads);
    await request(f.board).post(`${f.base}/link-check`).send({});
    const [fresh] = await ctx.db.select().from(memoryLinkLeads);
    expect(fresh).toBeDefined();
    expect((await request(f.board).post(`${f.base}/records/${c.id}/delete`).send({ reason: "Wrong" })).status).toBe(200);
    const [closed] = await ctx.db.select().from(memoryLinkLeads).where(eq(memoryLinkLeads.id, fresh!.id));
    expect(closed).toMatchObject({ state: "dismissed", resolution: "record_deleted", basis: { entities: [], topics: [], values: [], sameSource: false } });
  });

  it("the scheduler runs the check once per interval for each company with memory on", async () => {
    const f = await setup("Schedule");
    await contribute(f.board, f.base, { scopeId: f.org.id, content: "Kestrel Works retainer.", entities: ["Kestrel Works"] });
    await contribute(f.board, f.base, { scopeId: f.org.id, content: "Kestrel Works renewal.", entities: ["Kestrel Works"] });
    const now = new Date();
    const first = await runScheduledMemoryLinkChecks(ctx.db, now);
    expect(first.ran).toBeGreaterThanOrEqual(1);
    expect(await ctx.db.select().from(memoryLinkLeads).where(eq(memoryLinkLeads.companyId, f.companyId))).toHaveLength(1);
    expect((await runScheduledMemoryLinkChecks(ctx.db, new Date(now.getTime() + 60_000))).ran).toBe(0);
    // After a restart the last pass is read back from the audit table.
    resetMemoryLinkCheckSchedule();
    expect((await runScheduledMemoryLinkChecks(ctx.db, new Date(now.getTime() + 60_000))).ran).toBe(0);
    expect((await runScheduledMemoryLinkChecks(ctx.db, new Date(now.getTime() + MEMORY_LINK_CHECK_INTERVAL_MS + 1))).ran).toBeGreaterThanOrEqual(1);
    const [run] = await ctx.db
      .select()
      .from(memoryOperations)
      .where(and(eq(memoryOperations.companyId, f.companyId), eq(memoryOperations.operation, "link_check")));
    expect(run).toMatchObject({ actorType: "system", actorId: "memory-link-check", scopeIds: [] });
  });
});
