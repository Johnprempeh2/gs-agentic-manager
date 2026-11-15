import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type express from "express";
import request from "supertest";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  issueComments,
  issues,
  principalPermissionGrants,
} from "@greatstone/db";
import { eq } from "drizzle-orm";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { createApp } from "../app.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { describeEmbeddedPostgres, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

/**
 * The safety floor for a second person (Ben, an operator) beside the owner
 * (John). Runs on the real app with real sessions, so each rule is checked
 * the way a signed-in operator meets it. Each `it` goes red when its guard
 * is removed.
 */
describeEmbeddedPostgres("operator safety floor (Ben joins as an operator)", () => {
  let app: express.Express | undefined;
  let root: string | undefined;
  afterAll(async () => {
    await (app?.locals.paperclipShutdown as (() => Promise<void>) | undefined)?.();
    if (root) await rm(root, { recursive: true, force: true });
  });
  const ctx = useEmbeddedPostgres("paperclip-operator-floor-");
  const companyId = randomUUID();
  const johnId = `user-john-${randomUUID()}`;
  const benId = `user-ben-${randomUUID()}`;
  const agentA = randomUUID();
  const agentB = randomUUID();
  const SESSION = "x-test-session";

  function as(who: "john" | "ben", method: "get" | "post" | "patch" | "delete", url: string, body?: unknown) {
    let req = request(app!)[method](url)
      .set("Host", "127.0.0.1")
      .set("Origin", "http://127.0.0.1")
      .set(SESSION, who)
      .timeout(15_000);
    if (body !== undefined) req = req.send(body as object);
    return req;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperclip-operator-floor-"));
    app = await createApp(ctx.db, {
      uiMode: "none", serverPort: 0,
      storageService: createStorageService(createLocalDiskStorageProvider(join(root, "storage"))),
      deploymentMode: "authenticated", deploymentExposure: "private",
      allowedHostnames: ["127.0.0.1"], bindHost: "127.0.0.1", authReady: true,
      companyDeletionEnabled: true, instanceId: `operator-floor-${randomUUID()}`,
      localPluginDir: join(root, "plugins"), managedPluginAutoInstall: [],
      decisionServiceOptions: { wakeOriginAgent: async () => undefined },
      resolveSession: async (req) => {
        const who = req.header(SESSION);
        const userId = who === "john" ? johnId : who === "ben" ? benId : null;
        return userId
          ? { session: { id: `s-${who}`, userId }, user: { id: userId, name: who === "john" ? "John" : "Ben That", email: null } }
          : null;
      },
    });
    await instanceSettingsService(ctx.db).updateExperimental({ enableAgentChat: true });
    await ctx.db.insert(companies).values({
      id: companyId, name: "Greatstone", issuePrefix: `G${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    for (const [id, name, role] of [[johnId, "John", "owner"], [benId, "Ben That", "operator"]] as const) {
      await ctx.db.insert(authUsers).values({
        id, name, email: `${id}@floor.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
      });
      await ctx.db.insert(companyMemberships).values({
        companyId, principalType: "user", principalId: id, status: "active", membershipRole: role, updatedAt: new Date(),
      });
      await ensureHumanRoleDefaultGrants(ctx.db, { companyId, principalId: id, membershipRole: role, grantedByUserId: null });
    }
    for (const [id, name] of [[agentA, "Agent A"], [agentB, "Agent B"]] as const) {
      await ctx.db.insert(agents).values({
        id, companyId, name, role: "general", adapterType: "process", adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: false } }, status: "idle",
      });
    }
  }, 60_000);

  it("refuses an operator approving their own request, and a hire without agents:create", async () => {
    const own = await as("ben", "post", `/api/companies/${companyId}/approvals`, {
      type: "request_board_approval", payload: { title: "Ben asks" },
    });
    expect(own.status).toBe(201);
    const self = await as("ben", "post", `/api/approvals/${own.body.id}/approve`, {});
    expect(self.status).toBe(403);
    expect(self.body.details?.code ?? self.body.code).toBe("approval_self_decision");
    // The owner may decide it.
    expect((await as("john", "post", `/api/approvals/${own.body.id}/approve`, {})).status).toBe(200);

    const hire = await as("john", "post", `/api/companies/${companyId}/approvals`, {
      type: "hire_agent", payload: { name: "Shadow", adapterType: "process", adapterConfig: {} },
    });
    expect(hire.status).toBe(201);
    expect((await as("ben", "post", `/api/approvals/${hire.body.id}/approve`, {})).status).toBe(403);
  });

  it("records the caller as the actor on POST /activity, whatever the body claims", async () => {
    const res = await as("ben", "post", `/api/companies/${companyId}/activity`, {
      actorType: "agent", actorId: agentA, agentId: agentA, action: "forged.entry", entityType: "company", entityId: companyId,
    });
    expect(res.status).toBe(201);
    const [row] = await ctx.db.select().from(activityLog).where(eq(activityLog.action, "forged.entry"));
    expect(row).toMatchObject({ actorType: "user", actorId: benId, agentId: null });
  });

  it("keeps company export, secrets and budgets for owners and admins", async () => {
    expect((await as("ben", "post", `/api/companies/${companyId}/exports/preview`, {})).status).toBe(403);
    expect((await as("ben", "post", `/api/companies/${companyId}/secrets`, { name: "X", value: "v" })).status).toBe(403);
    expect((await as("ben", "patch", `/api/companies/${companyId}/budgets`, { budgetMonthlyCents: 100 })).status).toBe(403);
    expect((await as("ben", "post", `/api/companies/${companyId}/secret-provider-configs`, {
      provider: "local_encrypted", displayName: "Mine", config: {},
    })).status).toBe(403);
    expect((await as("john", "patch", `/api/companies/${companyId}/budgets`, { budgetMonthlyCents: 100 })).status).toBe(200);
  });

  it("lets only owners and admins hard delete a task; an operator cancels instead", async () => {
    const created = await as("ben", "post", `/api/companies/${companyId}/issues`, { title: "Ben's task" });
    expect(created.status).toBe(201);
    expect((await as("ben", "delete", `/api/issues/${created.body.id}`)).status).toBe(403);
    expect((await as("ben", "patch", `/api/issues/${created.body.id}`, { status: "cancelled" })).status).toBe(200);
    expect((await as("john", "delete", `/api/issues/${created.body.id}`)).status).toBe(200);
  });

  it("keeps a review waiting on John out of Ben's hands", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [{ id: randomUUID(), type: "review", participants: [{ type: "user", userId: johnId }] }],
    })!;
    const stage = policy.stages[0]!;
    const [issue] = await ctx.db.insert(issues).values({
      companyId, title: "Waits on John", status: "in_review", assigneeUserId: johnId, createdByUserId: benId,
      executionPolicy: policy,
      executionState: {
        status: "pending", currentStageId: stage.id, currentStageIndex: 0, currentStageType: "review",
        currentParticipant: { type: "user", userId: johnId }, returnAssignee: { type: "user", userId: benId },
        completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
      },
    }).returning();
    const res = await as("ben", "patch", `/api/issues/${issue!.id}`, { status: "todo" });
    expect(res.status).toBe(403);
    const [after] = await ctx.db.select().from(issues).where(eq(issues.id, issue!.id));
    expect(after!.executionState).toMatchObject({ status: "pending" });
  });

  it("keeps John's agent chat private from Ben: no read, no post, no search", async () => {
    const opened = await as("john", "post", `/api/companies/${companyId}/chats/${agentA}`);
    expect(opened.status).toBe(200);
    const chatId = opened.body.id as string;
    await ctx.db.insert(issueComments).values({ companyId, issueId: chatId, body: "zebra-secret-plan", authorUserId: johnId });

    expect((await as("ben", "get", `/api/issues/${chatId}`)).status).toBe(404);
    expect((await as("ben", "get", `/api/issues/${chatId}/comments`)).status).toBe(404);
    expect((await as("ben", "post", `/api/issues/${chatId}/comments`, { body: "hello", clientRequestId: randomUUID() })).status).toBe(404);
    const listed = await as("ben", "get", `/api/companies/${companyId}/issues?q=zebra-secret-plan`);
    expect(listed.status).toBe(200);
    expect((listed.body as Array<{ id: string }>).map((row) => row.id)).not.toContain(chatId);
    const searched = await as("ben", "get", `/api/companies/${companyId}/search?q=zebra-secret-plan`);
    expect(searched.status).toBe(200);
    expect(JSON.stringify(searched.body)).not.toContain(chatId);

    expect((await as("john", "get", `/api/issues/${chatId}`)).status).toBe(200);
  });

  it("holds Ben to the agents the owner picked for him", async () => {
    await ctx.db.insert(principalPermissionGrants).values({
      companyId, principalType: "user", principalId: benId, permissionKey: "agents:allowlist",
      scope: { agentIds: [agentA] }, grantedByUserId: johnId,
    });
    try {
      expect((await as("ben", "post", `/api/agents/${agentB}/wakeup`, { source: "on_demand" })).status).toBe(403);
      expect((await as("ben", "post", `/api/companies/${companyId}/chats/${agentB}`)).status).toBe(403);
      const assign = await as("ben", "post", `/api/companies/${companyId}/issues`, { title: "For B", assigneeAgentId: agentB });
      expect(assign.status).toBe(403);
      expect((await as("ben", "post", `/api/companies/${companyId}/chats/${agentA}`)).status).toBe(200);
    } finally {
      await ctx.db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.permissionKey, "agents:allowlist"));
    }
  });
});
