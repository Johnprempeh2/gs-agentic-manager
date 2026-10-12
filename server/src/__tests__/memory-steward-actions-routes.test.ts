import request from "supertest";
import { expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agentApiKeys,
  agents,
  authUsers,
  companyMemberships,
  heartbeatRuns,
  memoryConflicts,
  memoryExtractedFacts,
  memoryIngestOutbox,
  memoryOperations,
  memoryRecords,
  memoryRelationships,
  memoryReviewEvents,
  memoryScopes,
  memoryScopeStewards,
  memorySettings,
  principalPermissionGrants,
  projects,
} from "@greatstone/db";
import type { MemoryReviewQueue, MemoryScope, MemoryScopeSteward } from "@greatstone/shared";
import { memoryRoutes } from "../routes/memory.js";
import type { MemoryEngine, MemoryEngineDocument } from "../services/memory-gateway/engine.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

function fakeEngine(): MemoryEngine {
  const docs: MemoryEngineDocument[] = [];
  return {
    async retain(doc) {
      docs.push(doc);
    },
    async recall(req) {
      const words = req.query.toLowerCase().split(/\W+/).filter(Boolean);
      return docs
        .filter((doc) => doc.bankId === req.bankId && doc.tags.some((tag) => req.tags.includes(tag)))
        .filter((doc) => words.some((word) => doc.content.toLowerCase().includes(word)))
        .map((doc) => ({ documentId: doc.documentId, text: doc.content, score: 0.9, unitId: `unit-${doc.documentId}`, factType: "world" }))
        .slice(0, req.limit);
    },
    async deleteDocument() {},
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

describeEmbeddedPostgres("shared memory M1: stewards, review queue and card actions (GRE-1089)", () => {
  const ctx = useEmbeddedPostgres("gsam-memory-stewards-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(memoryScopeStewards);
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
      await db.delete(agentApiKeys);
      await db.delete(heartbeatRuns);
      await db.delete(projects);
      await db.delete(agents);
      await db.delete(authUsers);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function setup(name: string) {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, name);
    const { companyId } = seeded;
    const engine = fakeEngine();
    const factory = (db: typeof ctx.db) => memoryRoutes(db, { engine });
    const board = routeApp(ctx.db, seeded.actor, factory);
    const person = async (userId: string, displayName: string) => {
      await ctx.db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "operator", updatedAt: new Date() });
      await ctx.db.insert(authUsers).values({ id: userId, name: displayName, email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
      return routeApp(ctx.db, { ...seeded.actor, userId, memberships: [{ companyId, membershipRole: "operator", status: "active" }] }, factory);
    };
    const asAgent = (agentId: string) =>
      routeApp(ctx.db, { type: "agent", agentId, companyId, runId: null, source: "agent_key" } as never, factory);
    const base = `/api/companies/${companyId}/memory`;
    expect((await request(board).patch(`${base}/settings`).send({ enabled: true, retainMode: "chunks" })).status).toBe(200);
    const org = ((await request(board).get(`${base}/scopes`)).body as MemoryScope[]).find((scope) => scope.kind === "organization")!;
    const [mason] = await ctx.db
      .insert(agents)
      .values({ companyId, name: "Mason", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
      .returning();
    await ctx.db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: mason.id, permissionKey: "memory:contribute", scope: null });
    const steward = await person("user-steward", "Sam");
    const backup = await person("user-backup", "Bea");
    const outsider = await person("user-outsider", "Olu");
    expect(
      (await request(board).put(`${base}/stewards/${org.id}`).send({ primaryUserId: "user-steward", backupUserId: "user-backup" })).status,
    ).toBe(200);
    return { ...seeded, board, steward, backup, outsider, mason, agent: asAgent(mason.id), base, org };
  }

  async function contribute(app: ReturnType<typeof routeApp>, base: string, body: Record<string, unknown>) {
    const res = await request(app).post(`${base}/records`).send(body);
    expect(res.status).toBe(201);
    return res.body.record as { id: string; version: number };
  }

  async function deniedReasons(actorId: string) {
    const rows = await ctx.db.select().from(memoryOperations).where(eq(memoryOperations.actorId, actorId));
    return rows.filter((row) => row.outcome === "denied").map((row) => (row.detail as { reason?: string } | null)?.reason);
  }

  const act = (app: ReturnType<typeof routeApp>, base: string, recordId: string, body: Record<string, unknown>) =>
    request(app).post(`${base}/records/${recordId}/steward-action`).send(body);

  it("owner or admin sets stewards; client scopes stay with the owner", async () => {
    const { board, steward, base, org, userId } = await setup("Stewards");
    const client = (await request(board).post(`${base}/scopes`).send({ kind: "client", name: "Kestrel Works" })).body as MemoryScope;

    const list = (await request(board).get(`${base}/stewards`)).body.scopes as MemoryScopeSteward[];
    expect(list.find((s) => s.scopeId === org.id)).toMatchObject({ ownerOnly: false, primaryUserId: "user-steward", backupUserId: "user-backup" });
    expect(list.find((s) => s.scopeId === client.id)).toMatchObject({ ownerOnly: true, primaryUserId: userId, backupUserId: null });

    const byOperator = await request(steward).put(`${base}/stewards/${org.id}`).send({ primaryUserId: "user-steward", backupUserId: null });
    expect(byOperator.status).toBe(403);
    expect(await deniedReasons("user-steward")).toContain("not_owner_or_admin");

    const onClient = await request(board).put(`${base}/stewards/${client.id}`).send({ primaryUserId: "user-steward", backupUserId: null });
    expect(onClient.status).toBe(403);
    expect(onClient.body.error).toMatch(/route to the company owner/);

    expect((await request(board).put(`${base}/stewards/${org.id}`).send({ primaryUserId: "user-nobody", backupUserId: null })).status).toBe(400);
    expect((await request(board).put(`${base}/stewards/${org.id}`).send({ primaryUserId: "user-steward", backupUserId: "user-steward" })).status).toBe(400);
  });

  it("the queue lists what the caller may review, with age, conflicts, the current card and filters", async () => {
    const { board, steward, outsider, agent, mason, base, org } = await setup("Queue");
    const approved = await contribute(agent, base, { scopeId: org.id, content: "Stand-up is at 09:30.", topics: ["stand-up"] });
    expect((await request(board).post(`${base}/records/${approved.id}/review`).send({ action: "approve", reason: "Yes" })).status).toBe(200);
    const challenger = await contribute(agent, base, { scopeId: org.id, content: "Stand-up is at 10:00.", topics: ["stand-up"] });
    const overdue = await contribute(agent, base, { scopeId: org.id, content: "Office closes at 18:00.", topics: ["office"] });
    const expired = await contribute(agent, base, { scopeId: org.id, content: "Parking is on level 2.", topics: ["parking"] });
    const pricing = await contribute(agent, base, { scopeId: org.id, content: "Retainer is GBP 4,000.", topics: ["retainer"], decisionClass: "pricing" });
    await ctx.db.update(memoryRecords).set({ createdAt: new Date(Date.now() - 8 * DAY_MS) }).where(eq(memoryRecords.id, overdue.id));
    await ctx.db.update(memoryRecords).set({ createdAt: new Date(Date.now() - 31 * DAY_MS) }).where(eq(memoryRecords.id, expired.id));

    const queue = (await request(steward).get(`${base}/review-queue`)).body as MemoryReviewQueue;
    // Pricing is owner-only: never in a steward's queue. Expired last, then oldest first.
    expect(queue.items.map((item) => item.proposal.id)).toEqual([overdue.id, challenger.id, expired.id]);
    expect(queue.items.map((item) => item.ageFlag)).toEqual(["overdue", "fresh", "expired"]);
    const challenge = queue.items.find((item) => item.proposal.id === challenger.id)!;
    expect(challenge.current?.id).toBe(approved.id);
    expect(challenge.conflictIds).toHaveLength(1);
    // An agent key with no key row on file: the generic key label.
    expect(challenge.proposer).toEqual({ type: "agent", id: mason.id, name: "Mason", app: "Agent API key" });
    expect(challenge.allowed).toEqual({ confirm: true, edit_and_confirm: true, reject: true, merge: true });
    expect(challenge.blockedReason).toBeNull();
    expect(queue.items.find((item) => item.proposal.id === overdue.id)!.current).toBeNull();
    expect(queue.facets.people).toEqual([{ type: "agent", id: mason.id, name: "Mason", count: 3 }]);
    expect(queue.facets.scopes).toEqual([{ id: org.id, name: org.name, count: 3 }]);

    const ownerQueue = (await request(board).get(`${base}/review-queue`)).body as MemoryReviewQueue;
    expect(ownerQueue.items.map((item) => item.proposal.id)).toContain(pricing.id);

    const filtered = async (query: string) =>
      ((await request(steward).get(`${base}/review-queue?${query}`)).body as MemoryReviewQueue).items.map((item) => item.proposal.id);
    expect(await filtered("age=overdue")).toEqual([overdue.id]);
    expect(await filtered("conflict=true")).toEqual([challenger.id]);
    expect(await filtered(`person=agent:${mason.id}`)).toHaveLength(3);
    expect(await filtered("person=user:someone-else")).toEqual([]);
    expect((await request(steward).get(`${base}/review-queue?age=ancient`)).status).toBe(400);

    // A person who is not a steward has nothing to review.
    expect(((await request(outsider).get(`${base}/review-queue`)).body as MemoryReviewQueue).items).toEqual([]);
  });

  it("shows the app a proposal came through, and filters by it (GRE-1124)", async () => {
    const { board, steward, agent, mason, base, org, companyId, actor } = await setup("Apps");
    const [key] = await ctx.db
      .insert(agentApiKeys)
      .values({ agentId: mason.id, companyId, name: "ChatGPT", keyHash: "hash-chatgpt", responsibleUserId: "user-backup", scopeConfig: { kind: "memory_only" } })
      .returning();
    const viaChatGpt = routeApp(
      ctx.db,
      { type: "agent", agentId: mason.id, companyId, keyId: key!.id, keyScope: { kind: "memory_only" }, runId: null, source: "agent_key" } as never,
      (db) => memoryRoutes(db, { engine: fakeEngine() }),
    );
    const fromApp = await contribute(viaChatGpt, base, { scopeId: org.id, content: "Invoices go out on the 1st.", topics: ["invoicing"] });
    const fromKey = await contribute(agent, base, { scopeId: org.id, content: "Parking is on level 2.", topics: ["parking"] });
    const fromWeb = await contribute(board, base, { scopeId: org.id, content: "Office closes at 18:00.", topics: ["office"] });

    const events = await ctx.db.select().from(memoryReviewEvents).where(eq(memoryReviewEvents.recordId, fromApp.id));
    expect(events.find((event) => event.action === "contribute")).toMatchObject({ app: "memory_key", sessionId: key!.id });

    const queue = (await request(steward).get(`${base}/review-queue`)).body as MemoryReviewQueue;
    const byId = (id: string) => queue.items.find((item) => item.proposal.id === id)!;
    expect(byId(fromApp.id).proposer).toEqual({ type: "agent", id: mason.id, name: "Mason", app: "ChatGPT" });
    expect(byId(fromKey.id).proposer.app).toBe("Agent API key");
    // GSAM's own screens add no label: the person is the identity.
    expect(byId(fromWeb.id).proposer.app).toBeNull();
    expect(queue.facets.apps).toEqual(expect.arrayContaining([{ app: "ChatGPT", count: 1 }, { app: "Agent API key", count: 1 }]));
    expect(queue.facets.apps).toHaveLength(2);

    const filtered = async (app: string) =>
      ((await request(steward).get(`${base}/review-queue?app=${encodeURIComponent(app)}`)).body as MemoryReviewQueue).items.map((item) => item.proposal.id);
    expect(await filtered("ChatGPT")).toEqual([fromApp.id]);

    // An edit keeps the proposer's app; the editor's own app sits on editedBy.
    const stewardByKey = routeApp(
      ctx.db,
      { ...actor, userId: "user-steward", memberships: [{ companyId, membershipRole: "operator", status: "active" }], source: "board_key", keyId: "board-key-1" } as never,
      (db) => memoryRoutes(db, { engine: fakeEngine() }),
    );
    const edit = await act(stewardByKey, base, fromApp.id, { action: "edit_and_confirm", expectedVersion: fromApp.version, content: "Invoices go out on the 1st working day.", reason: "Clearer" });
    expect(edit.status).toBe(200);
    const edited = ((await request(board).get(`${base}/review-queue`)).body as MemoryReviewQueue).items.find((item) => item.proposal.id === edit.body.newRecord.id)!;
    expect(edited.proposer).toMatchObject({ type: "agent", id: mason.id, app: "ChatGPT" });
    expect(edited.editedBy).toMatchObject({ type: "user", id: "user-steward", name: "Sam", app: "Board API key" });
    const ownerFiltered = async (app: string) =>
      ((await request(board).get(`${base}/review-queue?app=${encodeURIComponent(app)}`)).body as MemoryReviewQueue).items.map((item) => item.proposal.id);
    expect(await ownerFiltered("ChatGPT")).toEqual([edited.proposal.id]);
    expect(await ownerFiltered("Board API key")).toEqual([edited.proposal.id]);
  });

  it("refuses confirming your own proposal", async () => {
    const { steward, base, org, companyId } = await setup("OwnProposal");
    await ctx.db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: "user-steward", permissionKey: "memory:contribute", scope: null });
    const own = await contribute(steward, base, { scopeId: org.id, content: "Lunch is at 12:30.", topics: ["lunch"] });
    const item = ((await request(steward).get(`${base}/review-queue`)).body as MemoryReviewQueue).items.find((i) => i.proposal.id === own.id)!;
    expect(item.allowed.confirm).toBe(false);
    expect(item.blockedReason).toBe("You proposed this card. Someone else must confirm it.");

    const res = await act(steward, base, own.id, { action: "confirm", expectedVersion: own.version, reason: "mine" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/You proposed this card/);
    expect(await deniedReasons("user-steward")).toContain("own_proposal");
  });

  it("edit and confirm makes a new version by the editor; neither the editor nor the proposer can confirm it", async () => {
    const { board, steward, backup, base, org, userId } = await setup("OwnEdit");
    const proposal = await contribute(board, base, { scopeId: org.id, content: "Invoices go out on the 1st.", topics: ["invoicing"] });

    const edit = await act(steward, base, proposal.id, {
      action: "edit_and_confirm",
      expectedVersion: proposal.version,
      content: "Invoices go out on the 1st working day.",
      reason: "More precise",
    });
    expect(edit.status).toBe(200);
    expect(edit.body.record.status).toBe("superseded");
    const next = edit.body.newRecord;
    expect(next).toMatchObject({ status: "unreviewed", contributorUserId: "user-steward", supersedesId: proposal.id, version: proposal.version + 1 });

    const item = ((await request(board).get(`${base}/review-queue`)).body as MemoryReviewQueue).items.find((i) => i.proposal.id === next.id)!;
    expect(item.proposer.id).toBe(userId);
    expect(item.editedBy).toMatchObject({ type: "user", id: "user-steward", name: "Sam" });
    expect(item.blockedReason).toMatch(/You proposed this card/);

    const byEditor = await act(steward, base, next.id, { action: "confirm", expectedVersion: next.version, reason: "ok" });
    expect(byEditor.status).toBe(403);
    expect(byEditor.body.error).toMatch(/You edited this card/);
    expect(await deniedReasons("user-steward")).toContain("own_edit");
    const byProposer = await act(board, base, next.id, { action: "confirm", expectedVersion: next.version, reason: "ok" });
    expect(byProposer.status).toBe(403);
    expect(await deniedReasons(userId)).toContain("own_proposal");

    const byBackup = await act(backup, base, next.id, { action: "confirm", expectedVersion: next.version, reason: "Confirmed" });
    expect(byBackup.status).toBe(200);
    expect(byBackup.body.record.status).toBe("approved");
    const events = await ctx.db.select().from(memoryReviewEvents).where(eq(memoryReviewEvents.recordId, proposal.id));
    expect(events.map((event) => event.action)).toContain("edit");
    // The new version is queued for the engine.
    const outbox = await ctx.db.select().from(memoryIngestOutbox).where(eq(memoryIngestOutbox.recordId, next.id));
    expect(outbox.map((entry) => entry.op)).toEqual(["retain"]);
  });

  it("the older review, supersede and conflict routes refuse the original proposer and any earlier editor", async () => {
    const { board, steward, backup, agent, base, org, userId } = await setup("ChainOnOldRoutes");
    const edit = async (app: ReturnType<typeof routeApp>, record: { id: string; version: number }, content: string) => {
      const res = await act(app, base, record.id, { action: "edit_and_confirm", expectedVersion: record.version, content, reason: "Clearer" });
      expect(res.status).toBe(200);
      return res.body.newRecord as { id: string; version: number };
    };

    // The owner proposes, a steward edits: the owner is not the current contributor but still wrote it.
    const proposal = await contribute(board, base, { scopeId: org.id, content: "Expenses are filed by the 5th.", topics: ["expenses"] });
    const edited = await edit(steward, proposal, "Expenses are filed by the 5th working day.");
    const byProposer = await request(board).post(`${base}/records/${edited.id}/review`).send({ action: "approve", reason: "ok" });
    expect(byProposer.status).toBe(403);
    expect(byProposer.body.error).toMatch(/their own entry/);

    // An agent proposes a challenge to a confirmed card; the owner edits it, then a steward edits it again.
    const approved = await contribute(agent, base, { scopeId: org.id, content: "Stand-up is at 09:30.", topics: ["stand-up"] });
    expect((await request(board).post(`${base}/records/${approved.id}/review`).send({ action: "approve", reason: "Yes" })).status).toBe(200);
    const challenger = await contribute(agent, base, { scopeId: org.id, content: "Stand-up is at 10:00.", topics: ["stand-up"] });
    const ownerEdit = await edit(board, challenger, "Stand-up is at 10:00 sharp.");
    const latest = await edit(backup, ownerEdit, "Stand-up is at 10:00 on weekdays.");

    const approve = await request(board).post(`${base}/records/${latest.id}/review`).send({ action: "approve", reason: "ok" });
    expect(approve.status).toBe(403);
    const supersede = await request(board).post(`${base}/records/${approved.id}/supersede`).send({ replacementRecordId: latest.id, reason: "Moved" });
    expect(supersede.status).toBe(403);
    const [open] = await ctx.db.select().from(memoryConflicts).where(eq(memoryConflicts.recordId, latest.id));
    expect(open).toBeDefined();
    const settle = await request(board).post(`${base}/conflicts/${open!.id}/resolve`).send({ resolution: "not_a_conflict", reason: "Fine" });
    expect(settle.status).toBe(403);
    expect((await deniedReasons(userId)).filter((reason) => reason === "own_entry")).toHaveLength(4);
  });

  it("checks the whole edit history, beyond 50 versions, and refuses when it cannot be read", async () => {
    const { board, steward, base, org, companyId, userId } = await setup("LongChain");
    // The owner wrote version 1; 59 edits by other people follow.
    let previous = (await ctx.db
      .insert(memoryRecords)
      .values({ companyId, scopeId: org.id, kind: "fact", status: "superseded", content: "Version 1", contributorUserId: userId, version: 1, retainMode: "chunks" })
      .returning())[0]!;
    for (let version = 2; version <= 60; version += 1) {
      const [next] = await ctx.db
        .insert(memoryRecords)
        .values({
          companyId,
          scopeId: org.id,
          kind: "fact",
          status: version === 60 ? "unreviewed" : "superseded",
          content: `Version ${version}`,
          contributorUserId: version % 2 === 0 ? "user-backup" : "user-outsider",
          supersedesId: previous.id,
          version,
          retainMode: "chunks",
        })
        .returning();
      await ctx.db.insert(memoryReviewEvents).values({
        companyId, recordId: previous.id, scopeId: org.id, action: "edit", actorType: "user", actorId: "user-backup", userId: "user-backup", relatedRecordId: next!.id,
      });
      previous = next!;
    }
    const latest = previous;

    const viaSteward = await act(board, base, latest.id, { action: "confirm", expectedVersion: latest.version, reason: "ok" });
    expect(viaSteward.status).toBe(403);
    expect(viaSteward.body.error).toMatch(/You proposed this card/);
    expect((await request(board).post(`${base}/records/${latest.id}/review`).send({ action: "approve", reason: "ok" })).status).toBe(403);
    const item = ((await request(board).get(`${base}/review-queue`)).body as MemoryReviewQueue).items.find((i) => i.proposal.id === latest.id)!;
    expect(item.proposer.id).toBe(userId);
    expect(item.allowed.confirm).toBe(false);

    // A loop in the history cannot be fully checked: refuse rather than guess.
    const [first] = await ctx.db.select().from(memoryRecords).where(eq(memoryRecords.content, "Version 1"));
    await ctx.db.update(memoryRecords).set({ supersedesId: latest.id }).where(eq(memoryRecords.id, first!.id));
    await ctx.db.insert(memoryReviewEvents).values({
      companyId, recordId: latest.id, scopeId: org.id, action: "edit", actorType: "user", actorId: "user-backup", userId: "user-backup", relatedRecordId: first!.id,
    });
    const looped = await act(steward, base, latest.id, { action: "confirm", expectedVersion: latest.version, reason: "ok" });
    expect(looped.status).toBe(403);
    expect(looped.body.error).toMatch(/cannot be fully checked/);
    expect(await deniedReasons("user-steward")).toContain("incomplete_history");
  });

  it("refuses a stale version with 409 and logs it", async () => {
    const { steward, backup, agent, base, org } = await setup("Stale");
    const proposal = await contribute(agent, base, { scopeId: org.id, content: "Desk booking opens at 08:00.", topics: ["desks"] });
    const edit = await act(backup, base, proposal.id, { action: "edit_and_confirm", expectedVersion: proposal.version, content: "Desk booking opens at 07:30.", reason: "Changed" });
    expect(edit.status).toBe(200);

    // The steward still has the old card open.
    const stale = await act(steward, base, proposal.id, { action: "confirm", expectedVersion: proposal.version, reason: "ok" });
    expect(stale.status).toBe(409);
    const wrongVersion = await act(steward, base, edit.body.newRecord.id, { action: "reject", expectedVersion: proposal.version, reason: "no" });
    expect(wrongVersion.status).toBe(409);
    expect(wrongVersion.body.error).toMatch(/changed since you opened it/);
    expect(await deniedReasons("user-steward")).toEqual(expect.arrayContaining(["not_unreviewed", "stale_version"]));
  });

  it("refuses a person who is not the steward, and owner-only cards for stewards", async () => {
    const { steward, outsider, agent, board, base, org } = await setup("NotSteward");
    const proposal = await contribute(agent, base, { scopeId: org.id, content: "The kitchen is cleaned on Fridays.", topics: ["kitchen"] });
    const res = await act(outsider, base, proposal.id, { action: "confirm", expectedVersion: proposal.version, reason: "ok" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("You are not the steward for this scope.");
    expect(await deniedReasons("user-outsider")).toContain("not_steward");

    const pricing = await contribute(agent, base, { scopeId: org.id, content: "Day rate is GBP 900.", topics: ["rates"], decisionClass: "pricing" });
    const byStewardOnPricing = await act(steward, base, pricing.id, { action: "reject", expectedVersion: pricing.version, reason: "no" });
    expect(byStewardOnPricing.status).toBe(403);
    expect(byStewardOnPricing.body.error).toMatch(/company owner/);
    expect((await act(board, base, pricing.id, { action: "confirm", expectedVersion: pricing.version, reason: "Signed off" })).status).toBe(200);
  });

  it("confirm replaces the card it challenges; reject and merge close a proposal with events", async () => {
    const { board, steward, agent, base, org } = await setup("Actions");
    const approved = await contribute(agent, base, { scopeId: org.id, content: "Stand-up is at 09:30.", topics: ["stand-up"] });
    await request(board).post(`${base}/records/${approved.id}/review`).send({ action: "approve", reason: "Yes" });
    const challenger = await contribute(agent, base, { scopeId: org.id, content: "Stand-up is at 10:00.", topics: ["stand-up"] });

    const confirmed = await act(steward, base, challenger.id, { action: "confirm", expectedVersion: challenger.version, reason: "Moved" });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.record).toMatchObject({ status: "approved", supersedesId: approved.id });
    const [old] = await ctx.db.select().from(memoryRecords).where(eq(memoryRecords.id, approved.id));
    expect(old.status).toBe("superseded");

    const dup = await contribute(agent, base, { scopeId: org.id, content: "Stand-up starts at ten.", topics: ["daily meeting"] });
    const merged = await act(steward, base, dup.id, { action: "merge", expectedVersion: dup.version, intoRecordId: challenger.id, reason: "Same thing" });
    expect(merged.status).toBe(200);
    expect(merged.body.record).toMatchObject({ status: "superseded", supersededById: challenger.id });
    const rels = await ctx.db.select().from(memoryRelationships).where(eq(memoryRelationships.fromRecordId, dup.id));
    expect(rels.map((rel) => [rel.toRecordId, rel.type])).toEqual([[challenger.id, "same_subject"]]);

    const wrong = await contribute(agent, base, { scopeId: org.id, content: "The office has a pool.", topics: ["facilities"] });
    const rejected = await act(steward, base, wrong.id, { action: "reject", expectedVersion: wrong.version, reason: "Not true" });
    expect(rejected.status).toBe(200);
    expect(rejected.body.record.status).toBe("disputed");

    const actions = (await ctx.db.select().from(memoryReviewEvents)).filter((event) => event.actorId === "user-steward").map((event) => event.action);
    expect(actions).toEqual(expect.arrayContaining(["supersede", "superseded_by", "merge", "reject"]));
    expect(((await request(steward).get(`${base}/review-queue`)).body as MemoryReviewQueue).items).toEqual([]);
  });

  it("recall ranks an expired proposal after a fresh one", async () => {
    const { board, agent, base, org } = await setup("RecallExpiry");
    // The engine returns the older one first; only the expiry moves it down.
    const old = await contribute(agent, base, { scopeId: org.id, content: "Badges are green.", topics: ["badge colour"] });
    const fresh = await contribute(agent, base, { scopeId: org.id, content: "Badges are blue.", topics: ["badges"] });
    await ctx.db.update(memoryRecords).set({ createdAt: new Date(Date.now() - 40 * DAY_MS) }).where(eq(memoryRecords.id, old.id));
    const recall = await request(board).post(`${base}/recall`).send({ query: "badges" });
    expect(recall.status).toBe(200);
    expect(recall.body.results.map((hit: { record: { id: string } }) => hit.record.id)).toEqual([fresh.id, old.id]);
  });
});
