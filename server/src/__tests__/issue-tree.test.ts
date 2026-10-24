import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companyMemberships, createDb, issueRelations, issueThreadInteractions, issues, projects } from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueTreeRoutes } from "../routes/issue-tree.js";
import { issueTreeService } from "../services/issue-tree.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue tree tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("task tree route", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-tree-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function appFor(companyIds: string[], limits?: { maxNodes: number; maxDepth: number }) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "session",
        userId: "ben",
        companyIds,
        memberships: companyIds.map((companyId) => ({ companyId, status: "active", membershipRole: "owner" })),
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueTreeRoutes(db, limits ? issueTreeService(db, limits) : undefined));
    app.use(errorHandler);
    return app;
  }

  async function company(prefix: string) {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: prefix, issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({
      companyId: id, principalType: "user", principalId: "ben", status: "active", membershipRole: "member",
    });
    return id;
  }

  async function task(companyId: string, values: Partial<typeof issues.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(issues).values({ id, companyId, title: values.title ?? `Task ${id.slice(0, 4)}`, status: "todo", ...values });
    return id;
  }

  it("returns the subtree with counts, blockers and what is needed", async () => {
    const companyId = await company("GRE");
    const root = await task(companyId, { title: "Launch", status: "in_progress", issueNumber: 7, identifier: "GRE-7" });
    const design = await task(companyId, { parentId: root, status: "done" });
    const build = await task(companyId, { parentId: root, status: "blocked", unblockDescriptor: { owner: "board", action: "Approve the budget" } });
    const dns = await task(companyId, { parentId: design, status: "todo", title: "DNS", assigneeUserId: "ben" });
    await task(companyId, { parentId: root, status: "done", hiddenAt: new Date() });
    await task(companyId, { parentId: root, status: "cancelled" });
    const elsewhere = await task(companyId, { title: "Vendor contract", status: "in_progress" });
    await db.insert(issueRelations).values([
      { companyId, issueId: dns, relatedIssueId: build, type: "blocks" },
      { companyId, issueId: elsewhere, relatedIssueId: build, type: "blocks" },
    ]);

    const res = await request(appFor([companyId])).get("/api/issues/GRE-7/tree").expect(200);
    expect(res.body.rootId).toBe(root);
    expect(res.body.truncated).toBe(false);
    expect(res.body.nodes[0]).toMatchObject({ id: root, parentId: null, depth: 0, childCount: 2, doneChildCount: 1 });
    const byId = new Map(res.body.nodes.map((node: { id: string }) => [node.id, node]));
    expect(byId.size).toBe(5);
    expect(byId.get(build)).toMatchObject({
      parentId: root,
      depth: 1,
      blockedByIds: [dns, elsewhere].sort(),
      unblockAction: "Approve the budget",
    });
    expect(byId.get(dns)).toMatchObject({ parentId: design, depth: 2, assigneeUserId: "ben" });
    expect(res.body.externalBlockers).toEqual([
      expect.objectContaining({ id: elsewhere, title: "Vendor contract", status: "in_progress" }),
    ]);
  });

  it("names the card a blocked task waits on and the root blocker outside the tree", async () => {
    const companyId = await company("GRE");
    const root = await task(companyId, { status: "blocked", issueNumber: 9, identifier: "GRE-9" });
    const leaf = await task(companyId, {
      parentId: root,
      status: "blocked",
      unblockDescriptor: { owner: { userId: "john" }, action: "Send the Turnstile keys" },
    });
    // GRE-9 waits on a task outside the tree, which waits on another one
    // further away that waits on John's answer to a card.
    const middle = await task(companyId, { status: "blocked", title: "Release" });
    const far = await task(companyId, { status: "blocked", title: "Staging upload" });
    await db.insert(issueRelations).values([
      { companyId, issueId: middle, relatedIssueId: root, type: "blocks" },
      { companyId, issueId: far, relatedIssueId: middle, type: "blocks" },
    ]);
    await db.insert(issueThreadInteractions).values([
      {
        companyId,
        issueId: far,
        kind: "request_confirmation",
        status: "pending",
        title: "Approve the staging upload",
        addresseeUserId: "john",
        payload: { version: 1, prompt: "Approve?" } as never,
        createdAt: new Date("2026-10-24T10:00:00Z"),
      },
      {
        companyId,
        issueId: far,
        kind: "request_confirmation",
        status: "pending",
        title: "A later card",
        payload: { version: 1, prompt: "Later?" } as never,
        createdAt: new Date("2026-10-24T11:00:00Z"),
      },
      {
        companyId,
        issueId: leaf,
        kind: "ask_user_questions",
        status: "accepted",
        title: "Already answered",
        payload: { version: 1, questions: [] } as never,
      },
    ]);

    const res = await request(appFor([companyId])).get("/api/issues/GRE-9/tree").expect(200);
    const byId = new Map(res.body.nodes.map((node: { id: string }) => [node.id, node]));
    expect(byId.get(leaf)).toMatchObject({
      unblockAction: "Send the Turnstile keys",
      unblockOwner: { userId: "john" },
      pendingCard: null,
    });
    expect(byId.get(root)).toMatchObject({ blockedByIds: [middle], rootBlockerId: far });
    const external = new Map(res.body.externalBlockers.map((blocker: { id: string }) => [blocker.id, blocker]));
    expect(external.get(far)).toMatchObject({
      title: "Staging upload",
      waitReason: {
        unblockAction: null,
        pendingCard: expect.objectContaining({ title: "Approve the staging upload", addresseeUserId: "john" }),
      },
    });
  });

  it("stays inside the company", async () => {
    const companyA = await company("AAA");
    const companyB = await company("BBB");
    const rootB = await task(companyB, { issueNumber: 1, identifier: "BBB-1" });
    const rootA = await task(companyA);
    // A child row pointing across companies is never followed.
    await task(companyB, { parentId: rootA, title: "Foreign child" });

    await request(appFor([companyA])).get(`/api/issues/${rootB}/tree`).expect(404);
    await request(appFor([companyA])).get("/api/issues/BBB-1/tree").expect(404);
    const res = await request(appFor([companyA])).get(`/api/issues/${rootA}/tree`).expect(200);
    expect(res.body.nodes).toHaveLength(1);
  });

  it("cuts a big or deep tree and says so", async () => {
    const companyId = await company("GRE");
    const root = await task(companyId);
    for (let index = 0; index < 4; index += 1) await task(companyId, { parentId: root });
    const wide = await request(appFor([companyId], { maxNodes: 3, maxDepth: 5 })).get(`/api/issues/${root}/tree`).expect(200);
    expect(wide.body.nodes).toHaveLength(3);
    expect(wide.body.truncated).toBe(true);
    expect(wide.body.limits).toEqual({ maxNodes: 3, maxDepth: 5 });
    // Sub-task counts still tell the truth about what was cut.
    expect(wide.body.nodes[0].childCount).toBe(4);

    let parent = root;
    const chain: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      parent = await task(companyId, { parentId: parent });
      chain.push(parent);
    }
    const chainRoot = chain[0]!;
    const deep = await request(appFor([companyId], { maxNodes: 50, maxDepth: 2 })).get(`/api/issues/${chainRoot}/tree`).expect(200);
    expect(deep.body.nodes.map((node: { depth: number }) => node.depth)).toEqual([0, 1, 2]);
    expect(deep.body.truncated).toBe(true);

    const whole = await request(appFor([companyId], { maxNodes: 50, maxDepth: 5 })).get(`/api/issues/${chainRoot}/tree`).expect(200);
    expect(whole.body.truncated).toBe(false);
    expect(whole.body.nodes).toHaveLength(4);
  });
  // GRE-2290: the tree shows every blocking link, however far it goes.
  describe("blocking links", () => {
    type Link = { blockerId: string; blockedId: string };
    const linksOf = (body: { blockLinks: Link[] }) =>
      body.blockLinks.map((link) => `${link.blockerId}>${link.blockedId}`).sort();

    it("follows a chain out of the tree to its end, with no depth limit", async () => {
      const companyId = await company("GRE");
      const root = await task(companyId, { status: "in_progress", issueNumber: 1, identifier: "GRE-1" });
      const card = await task(companyId, { parentId: root, status: "blocked" });
      // card <- c1 <- c2 <- ... <- c15, all outside the tree.
      const chain: string[] = [];
      let blocked = card;
      for (let hop = 0; hop < 15; hop += 1) {
        const blocker = await task(companyId, { status: hop === 14 ? "todo" : "blocked", title: `Hop ${hop}` });
        await db.insert(issueRelations).values({ companyId, issueId: blocker, relatedIssueId: blocked, type: "blocks" });
        chain.push(blocker);
        blocked = blocker;
      }
      // A finished blocker is not a link any more.
      const finished = await task(companyId, { status: "done" });
      await db.insert(issueRelations).values({ companyId, issueId: finished, relatedIssueId: chain[14]!, type: "blocks" });

      const res = await request(appFor([companyId])).get("/api/issues/GRE-1/tree").expect(200);
      expect(res.body.externalBlockers.map((row: { id: string }) => row.id).sort()).toEqual([...chain].sort());
      const expected = chain.map((id, hop) => `${id}>${hop === 0 ? card : chain[hop - 1]}`).sort();
      expect(linksOf(res.body)).toEqual(expected);
    });

    it("shows every blocker of a task and every task a blocker holds up", async () => {
      const companyId = await company("GRE");
      const root = await task(companyId, { status: "in_progress", issueNumber: 2, identifier: "GRE-2" });
      const target = await task(companyId, { parentId: root, status: "blocked" });
      const blockerA = await task(companyId, { parentId: root, status: "todo" });
      const blockerB = await task(companyId, { status: "in_progress" });
      await db.insert(issueRelations).values([
        { companyId, issueId: blockerA, relatedIssueId: target, type: "blocks" },
        { companyId, issueId: blockerB, relatedIssueId: target, type: "blocks" },
      ]);
      // blockerA also holds up 20 tasks outside the tree.
      const heldUp: string[] = [];
      for (let index = 0; index < 20; index += 1) {
        const id = await task(companyId, { status: "blocked", title: `Held ${index}` });
        heldUp.push(id);
        await db.insert(issueRelations).values({ companyId, issueId: blockerA, relatedIssueId: id, type: "blocks" });
      }

      const res = await request(appFor([companyId])).get("/api/issues/GRE-2/tree").expect(200);
      const links = linksOf(res.body);
      expect(links).toContain(`${blockerA}>${target}`);
      expect(links).toContain(`${blockerB}>${target}`);
      for (const id of heldUp) expect(links).toContain(`${blockerA}>${id}`);
      expect(res.body.externalBlockers).toHaveLength(21);
    });

    it("keeps both tasks of a loop and ends the walk", async () => {
      const companyId = await company("GRE");
      const root = await task(companyId, { status: "blocked", issueNumber: 3, identifier: "GRE-3" });
      const outsideA = await task(companyId, { status: "blocked" });
      const outsideB = await task(companyId, { status: "blocked" });
      await db.insert(issueRelations).values([
        { companyId, issueId: outsideA, relatedIssueId: root, type: "blocks" },
        { companyId, issueId: outsideB, relatedIssueId: outsideA, type: "blocks" },
        { companyId, issueId: outsideA, relatedIssueId: outsideB, type: "blocks" },
        // And the tree's root blocks the far end, closing a second loop.
        { companyId, issueId: root, relatedIssueId: outsideB, type: "blocks" },
      ]);

      const res = await request(appFor([companyId])).get("/api/issues/GRE-3/tree").expect(200);
      expect(linksOf(res.body)).toEqual(
        [`${outsideA}>${root}`, `${outsideB}>${outsideA}`, `${outsideA}>${outsideB}`, `${root}>${outsideB}`].sort(),
      );
      expect(res.body.externalBlockers).toHaveLength(2);
    });

    it("names the project of a task from another project, inside the company only", async () => {
      const companyId = await company("GRE");
      const other = await company("OTH");
      const website = randomUUID();
      await db.insert(projects).values({ id: website, companyId, name: "Website" });
      const root = await task(companyId, { status: "blocked", issueNumber: 4, identifier: "GRE-4" });
      const fromWebsite = await task(companyId, { status: "todo", projectId: website, title: "Landing page" });
      const foreign = await task(other, { status: "todo" });
      await db.insert(issueRelations).values([
        { companyId, issueId: fromWebsite, relatedIssueId: root, type: "blocks" },
        // A row that points across companies is never followed.
        { companyId, issueId: foreign, relatedIssueId: fromWebsite, type: "blocks" },
      ]);

      const res = await request(appFor([companyId])).get("/api/issues/GRE-4/tree").expect(200);
      expect(res.body.externalBlockers).toEqual([
        expect.objectContaining({ id: fromWebsite, projectId: website, projectName: "Website" }),
      ]);
      expect(linksOf(res.body)).toEqual([`${fromWebsite}>${root}`]);
    });
  });
});
