import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type express from "express";
import request from "supertest";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  approvals,
  authSignInEvents,
  authUsers,
  companies,
  companyMemberships,
  issueThreadInteractions,
  issues,
} from "@greatstone/db";
import { and, eq } from "drizzle-orm";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { createApp } from "../app.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { describeEmbeddedPostgres, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

/**
 * Ownership, Desk and escalation for a second person (Ben, an operator)
 * beside the owner (John), on the real app with real sessions.
 */
describeEmbeddedPostgres("owner, Desk and escalation (Ben joins as an operator)", () => {
  let app: express.Express | undefined;
  let root: string | undefined;
  afterAll(async () => {
    await (app?.locals.paperclipShutdown as (() => Promise<void>) | undefined)?.();
    if (root) await rm(root, { recursive: true, force: true });
  });
  const ctx = useEmbeddedPostgres("paperclip-owner-desk-");
  const companyId = randomUUID();
  const johnId = `user-john-${randomUUID()}`;
  const benId = `user-ben-${randomUUID()}`;
  const agentId = randomUUID();
  const token = `pcp_desk_${randomBytes(24).toString("hex")}`;
  const SESSION = "x-test-session";

  function as(who: "john" | "ben" | "agent", method: "get" | "post" | "patch", url: string, body?: unknown) {
    let req = request(app!)[method](url).set("Host", "127.0.0.1").timeout(15_000);
    req = who === "agent" ? req.set("Authorization", `Bearer ${token}`) : req.set("Origin", "http://127.0.0.1").set(SESSION, who);
    if (body !== undefined) req = req.send(body as object);
    return req;
  }

  async function benTask(title: string) {
    const [task] = await ctx.db.insert(issues).values({
      companyId, title, status: "in_progress", assigneeAgentId: agentId, createdByUserId: benId,
    }).returning();
    return task!;
  }

  async function agentAsksOn(taskId: string) {
    const res = await as("agent", "post", `/api/companies/${companyId}/approvals`, {
      type: "request_board_approval", payload: { title: "Send the proposal?" }, issueIds: [taskId],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; approverUserId: string | null };
  }

  const feed = (who: "john" | "ben", query = "") =>
    as(who, "get", `/api/companies/${companyId}/decisions-feed${query}`).then((res) => {
      expect(res.status).toBe(200);
      return res.body.cards as Array<{ items: Array<{ subject: { id: string } }>; routedTo?: { userId: string; name: string } | null }>;
    });
  const cardFor = (cards: Awaited<ReturnType<typeof feed>>, approvalId: string) =>
    cards.find((card) => card.items.some((item) => item.subject.id === approvalId));

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperclip-owner-desk-"));
    app = await createApp(ctx.db, {
      uiMode: "none", serverPort: 0,
      storageService: createStorageService(createLocalDiskStorageProvider(join(root, "storage"))),
      deploymentMode: "authenticated", deploymentExposure: "private",
      allowedHostnames: ["127.0.0.1"], bindHost: "127.0.0.1", authReady: true,
      companyDeletionEnabled: true, instanceId: `owner-desk-${randomUUID()}`,
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
      id: companyId, name: "Greatstone", issuePrefix: `D${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    for (const [id, name, role] of [[johnId, "John", "owner"], [benId, "Ben That", "operator"]] as const) {
      await ctx.db.insert(authUsers).values({
        id, name, email: `${id}@desk.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
      });
      await ctx.db.insert(companyMemberships).values({
        companyId, principalType: "user", principalId: id, status: "active", membershipRole: role, updatedAt: new Date(),
      });
      await ensureHumanRoleDefaultGrants(ctx.db, { companyId, principalId: id, membershipRole: role, grantedByUserId: null });
    }
    await ctx.db.insert(agents).values({
      id: agentId, companyId, name: "Helper", role: "general", adapterType: "process", adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false } }, status: "idle",
    });
    await ctx.db.insert(companyMemberships).values({
      companyId, principalType: "agent", principalId: agentId, status: "active", membershipRole: "member", updatedAt: new Date(),
    });
    await ctx.db.insert(agentApiKeys).values({
      agentId, companyId, name: "desk", responsibleUserId: benId, keyHash: createHash("sha256").update(token).digest("hex"),
    });
  }, 60_000);

  it("routes an agent's approval on Ben's task to Ben, who may decide it; anything else goes to John", async () => {
    const asked = await agentAsksOn((await benTask("Ben's proposal")).id);
    expect(asked.approverUserId).toBe(benId);
    expect(cardFor(await feed("ben"), asked.id)?.routedTo ?? null).toBeNull();
    expect((await as("ben", "post", `/api/approvals/${asked.id}/approve`, {})).status).toBe(200);

    const bens = await as("ben", "post", `/api/companies/${companyId}/approvals`, {
      type: "request_board_approval", payload: { title: "Ben asks John" },
    });
    expect(bens.body.approverUserId).toBe(johnId);
    // Not his to decide (and his own request besides).
    expect((await as("ben", "post", `/api/approvals/${bens.body.id}/reject`, {})).status).toBe(403);
    expect(cardFor(await feed("ben"), bens.body.id)).toBeUndefined();
  });

  it("shows John everything, Ben's cards marked as Ben's; a John decision on them is a take over", async () => {
    const asked = await agentAsksOn((await benTask("Ben's second task")).id);
    const johnCard = cardFor(await feed("john"), asked.id);
    expect(johnCard?.routedTo).toEqual({ userId: benId, name: "Ben That" });
    // John opens Ben's Desk and sees it as Ben does.
    expect(cardFor(await feed("john", `?member=${benId}`), asked.id)?.routedTo ?? null).toBeNull();
    expect((await as("ben", "get", `/api/companies/${companyId}/decisions-feed?member=${johnId}`)).status).toBe(403);

    expect((await as("john", "post", `/api/approvals/${asked.id}/approve`, {})).status).toBe(200);
    const [row] = await ctx.db.select().from(approvals).where(eq(approvals.id, asked.id));
    expect(row).toMatchObject({ decidedByUserId: johnId, decidedOnBehalfOfUserId: benId });
    const comments = await as("ben", "get", `/api/approvals/${asked.id}/comments`);
    expect(JSON.stringify(comments.body)).toContain("took this over");
    const logged = await ctx.db.select().from(activityLog).where(and(eq(activityLog.action, "approval.taken_over"), eq(activityLog.entityId, asked.id)));
    expect(logged).toHaveLength(1);
  });

  it("escalates an approval to John with a required note, onto John's Desk", async () => {
    const asked = await agentAsksOn((await benTask("Needs John")).id);
    expect((await as("ben", "post", `/api/approvals/${asked.id}/escalate`, { note: "" })).status).toBe(400);
    const escalated = await as("ben", "post", `/api/approvals/${asked.id}/escalate`, { note: "Client money, not mine to say" });
    expect(escalated.status).toBe(200);
    expect(escalated.body).toMatchObject({ approverUserId: johnId, escalatedByUserId: benId });
    const johnCard = cardFor(await feed("john"), asked.id);
    expect(johnCard).toBeDefined();
    expect(johnCard!.routedTo ?? null).toBeNull();
    expect(cardFor(await feed("ben"), asked.id)).toBeUndefined();
    expect(await ctx.db.select().from(activityLog).where(eq(activityLog.action, "approval.escalated"))).toHaveLength(1);
  });

  it("escalates a task to John: assigned to him, a card on his Desk, and logged", async () => {
    const task = await benTask("Stuck on access");
    const res = await as("ben", "post", `/api/issues/${task.id}/escalate`, { note: "Needs the owner's login" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ assigneeUserId: johnId, assigneeAgentId: null });
    const [ask] = await ctx.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, task.id));
    expect(ask).toMatchObject({ kind: "request_confirmation", addresseeUserId: johnId, status: "pending" });
    const cards = await feed("john");
    expect(cards.some((card) => card.items.some((item) => item.subject.id === ask!.id))).toBe(true);
  });

  it("lets the reviewer hand their review to John, and nobody else", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [{ id: randomUUID(), type: "review", participants: [{ type: "user", userId: benId }] }],
    })!;
    const stage = policy.stages[0]!;
    const [task] = await ctx.db.insert(issues).values({
      companyId, title: "Ben reviews", status: "in_review", assigneeUserId: benId, createdByUserId: johnId,
      executionPolicy: policy,
      executionState: {
        status: "pending", currentStageId: stage.id, currentStageIndex: 0, currentStageType: "review",
        currentParticipant: { type: "user", userId: benId }, returnAssignee: { type: "agent", agentId },
        completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
      },
    }).returning();
    const res = await as("ben", "post", `/api/issues/${task!.id}/escalate`, { note: "Too close to call" });
    expect(res.status).toBe(200);
    expect(res.body.executionState.currentParticipant).toEqual({ type: "user", userId: johnId });
    expect(res.body.status).toBe("in_review");
    // John can now decide it as the reviewer.
    const done = await as("john", "patch", `/api/issues/${task!.id}`, { status: "done", comment: "Approved" });
    expect(done.status).toBe(200);
  });

  it("shows John Ben's trail, sign-ins included, and keeps it from Ben", async () => {
    await ctx.db.insert(authSignInEvents).values({ userId: benId, outcome: "signed_in", ipAddress: null, userAgent: "Safari", createdAt: new Date() });
    const trail = await as("john", "get", `/api/companies/${companyId}/members/${benId}/activity`);
    expect(trail.status).toBe(200);
    const types = new Set((trail.body.entries as Array<{ type: string }>).map((entry) => entry.type));
    expect(types).toEqual(expect.objectContaining({}));
    expect([...types]).toEqual(expect.arrayContaining(["escalation", "decision", "sign_in"]));
    const onlySignIns = await as("john", "get", `/api/companies/${companyId}/members/${benId}/activity?types=sign_in`);
    expect((onlySignIns.body.entries as Array<{ type: string }>).every((entry) => entry.type === "sign_in")).toBe(true);
    expect((await as("ben", "get", `/api/companies/${companyId}/members/${johnId}/activity`)).status).toBe(403);
  });
});
