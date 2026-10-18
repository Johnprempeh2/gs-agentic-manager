import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, companyMemberships, createDb, issues, principalPermissionGrants } from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { __clearIssueListResponseCacheForTests, issueRoutes } from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue list filter tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue list priority, creator and due date filters", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-list-deadline-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    __clearIssueListResponseCacheForTests();
    await db.delete(issues);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string, agentId?: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = agentId
        ? { type: "agent", agentId, companyId, source: "agent_key" }
        : {
            type: "board",
            userId: "cloud-user-1",
            companyIds: [companyId],
            memberships: [{ companyId, membershipRole: "owner", status: "active", principalId: "cloud-user-1" }],
            source: "cloud_tenant",
            isInstanceAdmin: false,
          };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, {}));
    app.use(errorHandler);
    return app;
  }

  async function seed() {
    const companyId = randomUUID();
    const leadId = randomUUID();
    const otherId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Deadlines",
      issuePrefix: `D${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: "cloud-user-1",
      membershipRole: "owner",
      grantedByUserId: null,
    });
    const agentRow = (id: string, name: string) => ({
      id,
      companyId,
      name,
      role: "engineer",
      status: "active" as const,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agents).values([agentRow(leadId, "Lead"), agentRow(otherId, "Other")]);
    await db.insert(issues).values([
      { companyId, title: "Late and urgent", status: "todo", priority: "critical", dueDate: "2020-01-01", createdByAgentId: leadId },
      { companyId, title: "Late but done", status: "done", priority: "high", dueDate: "2020-01-02", createdByAgentId: leadId },
      { companyId, title: "Due later", status: "in_progress", priority: "high", dueDate: "2099-12-31", createdByAgentId: otherId },
      { companyId, title: "No date", status: "todo", priority: "low" },
    ]);
    return { companyId, leadId };
  }

  const titles = (body: Array<{ title: string }>) => body.map((issue) => issue.title).sort();

  it("filters by one or more priorities", async () => {
    const { companyId } = await seed();
    const res = await request(createApp(companyId)).get(`/api/companies/${companyId}/issues?priority=critical,high`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(titles(res.body)).toEqual(["Due later", "Late and urgent", "Late but done"]);
  });

  it("rejects an unknown priority", async () => {
    const { companyId } = await seed();
    const res = await request(createApp(companyId)).get(`/api/companies/${companyId}/issues?priority=urgent`);
    expect(res.status).toBe(400);
  });

  it("lists only open overdue tasks", async () => {
    const { companyId } = await seed();
    const res = await request(createApp(companyId)).get(`/api/companies/${companyId}/issues?overdue=true`);
    expect(res.status).toBe(200);
    expect(titles(res.body)).toEqual(["Late and urgent"]);
  });

  it("lists tasks due on or before a date", async () => {
    const { companyId } = await seed();
    const res = await request(createApp(companyId)).get(`/api/companies/${companyId}/issues?dueBefore=2020-01-02`);
    expect(res.status).toBe(200);
    expect(titles(res.body)).toEqual(["Late and urgent", "Late but done"]);
    const bad = await request(createApp(companyId)).get(`/api/companies/${companyId}/issues?dueBefore=soon`);
    expect(bad.status).toBe(400);
  });

  it("lets an agent list the tasks it created with createdByAgentId=me", async () => {
    const { companyId, leadId } = await seed();
    const res = await request(createApp(companyId, leadId)).get(`/api/companies/${companyId}/issues?createdByAgentId=me`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(titles(res.body)).toEqual(["Late and urgent", "Late but done"]);
    const board = await request(createApp(companyId)).get(`/api/companies/${companyId}/issues?createdByAgentId=me`);
    expect(board.status).toBe(400);
  });
});
