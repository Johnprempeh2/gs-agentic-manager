import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueReadStates,
  issues,
  principalPermissionGrants,
  userTourDismissals,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { onboardingQuestRoutes } from "../routes/onboarding-quest.js";
import { accessService } from "../services/access.ts";
import { grantsForHumanRole } from "../services/company-member-roles.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { issueService } from "../services/issues.ts";

// Getting started (14 Nov 2026): steps tick from real records, "What you control"
// follows real access, practice items stay out of everyone's work and never wake an
// agent, and finishing archives them.

const mockAdapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "x", provider: "test", model: "test",
})));
vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })) };
});

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("Getting started quest", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("gsam-onboarding-quest-");
    db = createDb(tempDb.connectionString);
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  async function seed(leadName = "Everest") {
    const companyId = randomUUID();
    const leadId = randomUUID();
    const john = `john-${randomUUID()}`;
    const ben = `ben-${randomUUID()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Greatstone",
      issuePrefix: `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const now = new Date();
    await db.insert(authUsers).values([
      { id: john, name: "John Prempeh", email: `${john}@example.com`, createdAt: now, updatedAt: now },
      { id: ben, name: "Ben That", email: `${ben}@example.com`, createdAt: now, updatedAt: now },
    ]);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: john, membershipRole: "owner", status: "active", createdAt: new Date("2026-01-01") },
      { companyId, principalType: "user", principalId: ben, membershipRole: "operator", status: "active" },
    ]);
    await db.insert(agents).values({
      id: leadId,
      companyId,
      name: leadName,
      role: "ceo",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 2 } },
      permissions: {},
    });
    // Role grants as a real join writes them.
    await accessService(db).setPrincipalGrants(companyId, "user", john, grantsForHumanRole("owner"), john);
    await accessService(db).setPrincipalGrants(companyId, "user", ben, grantsForHumanRole("operator"), john);
    const members = await db.select().from(companyMemberships).where(eq(companyMemberships.companyId, companyId));
    const memberId = (userId: string) => members.find((m) => m.principalId === userId)!.id;
    return { companyId, leadId, john, ben, johnMemberId: memberId(john), benMemberId: memberId(ben) };
  }

  function app(userId: string, companyId: string) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as any).actor = {
        type: "board", source: "session", userId, companyIds: [companyId], isInstanceAdmin: false,
        memberships: [{ companyId, status: "active", membershipRole: "operator" }],
      };
      next();
    });
    server.use("/api", onboardingQuestRoutes(db));
    server.use(errorHandler);
    return server;
  }

  const steps = (body: any) => Object.fromEntries(body.chapters.flatMap((c: any) => c.steps.map((s: any) => [s.key, s.doneAt])));
  const step = (body: any, key: string) => body.chapters.flatMap((c: any) => c.steps).find((s: any) => s.key === key);

  it("names the company's own lead agent in the Messages steps, and ticks when the person messages it", async () => {
    // GRE-6121: a fresh install's only agent is the owner's CEO, not Everest.
    const { companyId, leadId, ben } = await seed("Ada");
    const benApp = app(ben, companyId);
    const started = await request(benApp).post(`/api/companies/${companyId}/onboarding/me/start`).expect(200);
    expect(step(started.body, "message-everest").title).toBe("Send Ada a message");
    expect(step(started.body, "message-everest").body).toContain("Open Ada's chat");
    expect(step(started.body, "open-messages").body).toContain("Ada's chat is always first");
    expect(JSON.stringify(started.body.chapters)).not.toMatch(/Everest|\{lead\}/);

    const chat = await issueService(db).create(companyId, {
      title: "Chat", status: "todo", priority: "medium", assigneeAgentId: leadId,
      conversationAgentId: leadId, conversationUserId: ben, conversationState: "active",
    } as any);
    await db.insert(issueComments).values({ companyId, issueId: chat.id, authorUserId: ben, body: "What is on my plate today?" });
    const after = await request(benApp).get(`/api/companies/${companyId}/onboarding/me`).expect(200);
    expect(steps(after.body)["message-everest"]).toBeTruthy();
  });

  it("opens for a new member, ticks each step only from the real thing, and archives the practice task when finished", async () => {
    const { companyId, leadId, ben } = await seed();
    const benApp = app(ben, companyId);

    const before = await request(benApp).get(`/api/companies/${companyId}/onboarding/me`).expect(200);
    expect(before.body.autoOpen).toBe(true);
    expect(before.body.startedAt).toBeNull();
    // A step cannot be marked before the quest starts.
    await request(benApp).post(`/api/companies/${companyId}/onboarding/me/visits`).send({ step: "open-desk" }).expect(422);

    const started = await request(benApp).post(`/api/companies/${companyId}/onboarding/me/start`).expect(200);
    expect(started.body.autoOpen).toBe(false);
    const practiceId = started.body.practiceIssueId as string;
    expect(practiceId).toBeTruthy();
    // Starting twice keeps one practice task.
    const again = await request(benApp).post(`/api/companies/${companyId}/onboarding/me/start`).expect(200);
    expect(again.body.practiceIssueId).toBe(practiceId);
    expect(Object.values(steps(started.body)).every((doneAt) => doneAt === null)).toBe(true);
    // Greatstone's own lead is Everest, so its people still read "Everest".
    expect(step(started.body, "message-everest").title).toBe("Send Everest a message");
    // Operators do not see the owner's chapter, nor the steps waiting on PR B.
    expect(started.body.chapters.map((c: any) => c.key)).toEqual(["find-your-way", "your-work", "what-you-control"]);

    // Event steps cannot be marked by the app: only the records count.
    await request(benApp).post(`/api/companies/${companyId}/onboarding/me/visits`).send({ step: "message-everest" }).expect(422);
    // Visit steps that are not this person's are refused too.
    await request(benApp).post(`/api/companies/${companyId}/onboarding/me/visits`).send({ step: "open-members" }).expect(422);

    // The real things.
    await db.insert(userTourDismissals).values({ userId: ben, tourKey: "welcome", tourVersion: 1 });
    const chat = await issueService(db).create(companyId, {
      title: "Chat", status: "todo", priority: "medium", assigneeAgentId: leadId,
      conversationAgentId: leadId, conversationUserId: ben, conversationState: "active",
    } as any);
    await db.insert(issueComments).values({ companyId, issueId: chat.id, authorUserId: ben, body: "What is on my plate today?" });
    await db.insert(issueReadStates).values({ companyId, issueId: practiceId, userId: ben });
    await db.insert(issueComments).values({ companyId, issueId: practiceId, authorUserId: ben, body: "Started on this." });
    for (const step of ["open-messages", "open-desk", "open-deliverables", "open-releases", "read-control"]) {
      const res = await request(benApp).post(`/api/companies/${companyId}/onboarding/me/visits`).send({ step });
      // An operator only sees Website releases with website:view; skip the step when it is not theirs.
      if (step === "open-releases" && res.status === 422) continue;
      expect(res.status).toBe(200);
    }
    const nearly = await request(benApp).get(`/api/companies/${companyId}/onboarding/me`).expect(200);
    const nearlySteps = steps(nearly.body);
    for (const key of ["welcome-tour", "message-everest", "open-assigned-task", "reply-practice", "open-messages", "open-desk", "open-deliverables", "read-control"]) {
      expect(nearlySteps[key], key).toBeTruthy();
    }
    expect(nearlySteps["finish-practice"]).toBeNull();
    expect(nearly.body.finishedAt).toBeNull();
    expect(nearly.body.chapters.find((c: any) => c.key === "find-your-way").badge).toBe(true);
    expect(nearly.body.chapters.find((c: any) => c.key === "your-work").badge).toBe(false);

    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, practiceId));
    const finished = await request(benApp).get(`/api/companies/${companyId}/onboarding/me`).expect(200);
    expect(finished.body.done).toBe(finished.body.total);
    expect(finished.body.finishedAt).toBeTruthy();
    expect(finished.body.practiceArchived).toBe(true);
    const practice = await db.select().from(issues).where(eq(issues.id, practiceId)).then((rows) => rows[0]!);
    expect(practice.hiddenAt).not.toBeNull();
  });

  it("says what an operator can and cannot do, and names the owner to ask; an owner sees the rest", async () => {
    const { companyId, leadId, john, ben } = await seed();
    const op = await request(app(ben, companyId)).get(`/api/companies/${companyId}/onboarding/me`).expect(200);
    expect(op.body.roleLabel).toBe("Operator");
    const opCan = op.body.control.can.map((l: any) => l.key);
    const opCannot = op.body.control.cannot.map((l: any) => l.key);
    expect(opCan).toEqual(expect.arrayContaining(["read", "act", "assign"]));
    expect(opCannot).toEqual(expect.arrayContaining(["invite", "access", "agents", "company", "website-deploy"]));
    expect(op.body.control.askFirst).toEqual([{ name: "John Prempeh", role: "Owner" }]);
    expect(opCannot).toContain("self-approve");
    expect(opCan).not.toContain("agent-list"); // no allow-list: every agent

    // The owner's per-person agent allow-list is read back in plain words.
    await db.insert(principalPermissionGrants).values({
      companyId, principalType: "user", principalId: ben, permissionKey: "agents:allowlist", scope: { agentIds: [leadId] },
    });
    const listed = await request(app(ben, companyId)).get(`/api/companies/${companyId}/onboarding/me`).expect(200);
    expect(listed.body.control.can).toContainEqual({ key: "agent-list", text: "Wake and give work to these agents only: Everest" });

    const owner = await request(app(john, companyId)).get(`/api/companies/${companyId}/onboarding/me`).expect(200);
    expect(owner.body.roleLabel).toBe("Owner");
    expect(owner.body.autoOpen).toBe(false); // joined before launch
    expect(owner.body.control.can.map((l: any) => l.key)).toEqual(expect.arrayContaining(["invite", "access", "agents", "company", "self-approve"]));
    expect(owner.body.control.askFirst).toEqual([]);
    expect(owner.body.chapters.map((c: any) => c.key)).toContain("running-the-team");
  });

  it("keeps practice work out of everyone's lists and never wakes an agent, even when one is named", async () => {
    const { companyId, leadId, john, ben } = await seed();
    const started = await request(app(ben, companyId)).post(`/api/companies/${companyId}/onboarding/me/start`).expect(200);
    const practiceId = started.body.practiceIssueId as string;
    const svc = issueService(db);
    expect((await svc.list(companyId)).map((i) => i.id)).not.toContain(practiceId);
    expect((await svc.list(companyId, { assigneeUserId: ben })).map((i) => i.id)).not.toContain(practiceId);
    expect((await svc.list(companyId, { assigneeUserId: john })).map((i) => i.id)).not.toContain(practiceId);

    const commentId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId, issueId: practiceId, authorUserId: ben, body: "@Everest can you help?" });
    const heartbeat = heartbeatService(db);
    const wakes = [
      { source: "automation", triggerDetail: "system", reason: "issue_comment_mentioned", payload: { issueId: practiceId, commentId },
        requestedByActorType: "user", requestedByActorId: ben,
        contextSnapshot: { issueId: practiceId, commentId, wakeCommentId: commentId, source: "comment.mention" } },
      { source: "assignment", triggerDetail: "system", reason: "issue_assigned", payload: { issueId: practiceId } },
      { source: "on_demand", triggerDetail: "manual", reason: "manual", payload: { issueId: practiceId }, requestedByActorType: "user", requestedByActorId: ben },
    ] as const;
    for (const opts of wakes) {
      expect(await heartbeat.wakeup(leadId, opts as any), opts.reason).toBeNull();
    }
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, leadId))).toHaveLength(0);
    const skipped = await db.select({ reason: agentWakeupRequests.reason }).from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, leadId));
    expect(skipped.every((row) => row.reason === "issue_onboarding_practice")).toBe(true);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("clears practice items on request, replays from scratch, and lets only people managing access read a member's progress", async () => {
    const { companyId, john, ben, benMemberId, johnMemberId } = await seed();
    const benApp = app(ben, companyId);
    const first = await request(benApp).post(`/api/companies/${companyId}/onboarding/me/start`).expect(200);
    await request(benApp).post(`/api/companies/${companyId}/onboarding/me/visits`).send({ step: "open-desk" }).expect(200);

    const cleared = await request(benApp).post(`/api/companies/${companyId}/onboarding/me/practice/clear`).expect(200);
    expect(cleared.body.practiceArchived).toBe(true);
    const old = await db.select().from(issues).where(eq(issues.id, first.body.practiceIssueId)).then((rows) => rows[0]!);
    expect(old.hiddenAt).not.toBeNull();
    expect(old.status).toBe("cancelled");

    const skipped = await request(benApp).post(`/api/companies/${companyId}/onboarding/me/chapters`).send({ chapter: "your-work", skipped: true }).expect(200);
    expect(skipped.body.chapters.find((c: any) => c.key === "your-work").skipped).toBe(true);
    await request(benApp).post(`/api/companies/${companyId}/onboarding/me/chapters`).send({ chapter: "nope", skipped: true }).expect(422);

    const replayed = await request(benApp).post(`/api/companies/${companyId}/onboarding/me/replay`).expect(200);
    expect(replayed.body.practiceIssueId).not.toBe(first.body.practiceIssueId);
    expect(steps(replayed.body)["open-desk"]).toBeNull();
    expect(replayed.body.chapters.every((c: any) => !c.skipped)).toBe(true);

    const seen = await request(app(john, companyId)).get(`/api/companies/${companyId}/members/${benMemberId}/onboarding`).expect(200);
    expect(seen.body.startedAt).toBe(replayed.body.startedAt);
    await request(benApp).get(`/api/companies/${companyId}/members/${johnMemberId}/onboarding`).expect(403);

    const agentApp = express();
    agentApp.use((req, _res, next) => { (req as any).actor = { type: "agent", agentId: randomUUID(), companyId }; next(); });
    agentApp.use("/api", onboardingQuestRoutes(db));
    agentApp.use(errorHandler);
    await request(agentApp).get(`/api/companies/${companyId}/onboarding/me`).expect(403);
    expect((await db.execute(sql`select 1`)).length).toBeGreaterThan(0);
  });
});
