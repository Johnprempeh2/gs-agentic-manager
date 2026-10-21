import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companyMemberships, createDb, issueRelations, issues } from "@greatstone/db";
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
});
