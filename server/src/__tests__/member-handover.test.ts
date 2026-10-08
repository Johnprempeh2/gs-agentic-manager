import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { DeploymentMode } from "@greatstone/shared";
import {
  activityLog,
  agents,
  aiProviderDefaults,
  authSessions,
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  heartbeatRuns,
  instanceUserRoles,
  issueThreadInteractions,
  issues,
  principalPermissionGrants,
  routineRevisions,
  routines,
} from "@greatstone/db";
import { errorHandler } from "../middleware/index.js";
import { accessRoutes } from "../routes/access.js";
import { memberHandoverRoutes } from "../routes/member-handover.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { LEGACY_BOARD_USER_ID } from "../services/board-identity.js";
import { MEMBER_HANDED_OVER_ACTION } from "../services/member-handover.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const JOHN = "john-owner";
const OWEN = "owen-owner";
const BEN = "ben-admin";
const CARA = "cara-leaving";
const DAN = "dan-successor";

type Actor = Express.Request["actor"];

function sessionActor(userId: string, companyId: string, role: string, extra: Partial<Actor> = {}): Actor {
  return {
    type: "board",
    userId,
    source: "session",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: role, status: "active" }],
    ...extra,
  } as Actor;
}

describeEmbeddedPostgres("hand over and remove a person", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "gsam-handover-tests-"));
    vi.stubEnv("GSAM_HOME", home);
    vi.stubEnv("GSAM_INSTANCE_ID", "member-handover-fixture");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-member-handover-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.execute(sql`truncate table ${companies}, ${authUsers}, ${instanceUserRoles}, ${boardApiKeys}, ${authSessions}, ${activityLog} cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  function createApp(actor: Actor, deploymentMode: DeploymentMode = "authenticated") {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", accessRoutes(db, {
      deploymentMode,
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }));
    app.use("/api", memberHandoverRoutes(db, { deploymentMode }));
    app.use(errorHandler);
    return app;
  }

  async function personalAccount(companyId: string, userId: string, name: string) {
    return aiConnectionService(db).save(companyId, userId, {
      provider: "anthropic", method: "api_key", ownership: "personal", name, apiKey: "fixture", agentIds: [], allAgents: true,
    }, `fixture-${name}`);
  }

  async function sharedAccount(companyId: string, userId: string, name: string) {
    return aiConnectionService(db).save(companyId, userId, {
      provider: "anthropic", method: "api_key", ownership: "shared", name, apiKey: "fixture", agentIds: [], allAgents: true,
    }, `fixture-${name}`);
  }

  /**
   * John and Owen own the company, Ben is an admin, Cara is leaving and Dan
   * takes over. Cara has open work, a pending question, an active routine,
   * the company default, a queued run, her own AI account (one agent is bound
   * to it), a memory right, a permission, a board API key and a session.
   */
  async function seed(prefix = "GRE") {
    const companyId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: companyId, name: `${prefix} Co`, issuePrefix: prefix, requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: CARA,
    });
    await db.insert(authUsers).values([JOHN, OWEN, BEN, CARA, DAN, LEGACY_BOARD_USER_ID].map((id) => ({
      id, name: id === CARA ? "Cara Leaving" : id === DAN ? "Dan Successor" : id, email: `${id}@example.com`,
      emailVerified: true, createdAt: now, updatedAt: now,
    })));
    const at = (minutes: number) => new Date(Date.UTC(2026, 8, 1, 9, minutes));
    const memberships = await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: LEGACY_BOARD_USER_ID, status: "active", membershipRole: "owner", createdAt: at(0) },
      { companyId, principalType: "user", principalId: JOHN, status: "active", membershipRole: "owner", createdAt: at(1) },
      { companyId, principalType: "user", principalId: OWEN, status: "active", membershipRole: "owner", createdAt: at(2) },
      { companyId, principalType: "user", principalId: BEN, status: "active", membershipRole: "admin", createdAt: at(3) },
      { companyId, principalType: "user", principalId: CARA, status: "active", membershipRole: "operator", createdAt: at(4) },
      { companyId, principalType: "user", principalId: DAN, status: "active", membershipRole: "operator", createdAt: at(5) },
    ]).returning({ id: companyMemberships.id, principalId: companyMemberships.principalId });
    const memberId = (userId: string) => memberships.find((row) => row.principalId === userId)!.id;
    await db.insert(instanceUserRoles).values({ userId: LEGACY_BOARD_USER_ID, role: "instance_admin" });

    const caraAccount = await personalAccount(companyId, CARA, "Cara Claude");
    await personalAccount(companyId, DAN, "Dan Claude");

    const nova = randomUUID();
    const iris = randomUUID();
    await db.insert(agents).values([
      {
        id: nova, companyId, name: "Nova", adapterType: "claude_local", status: "active",
        runtimeConfig: { aiConnection: { provider: "anthropic", method: "api_key", mode: "responsible_user" } },
      },
      {
        id: iris, companyId, name: "Iris", adapterType: "claude_local", status: "active",
        runtimeConfig: { aiConnection: { provider: "anthropic", method: "api_key", mode: "delegated", connectionId: caraAccount.connectionId, grantId: caraAccount.grantId } },
      },
    ]);

    const ownWork = randomUUID();
    const agentWork = randomUUID();
    const closedWork = randomUUID();
    await db.insert(issues).values([
      {
        id: ownWork, companyId, identifier: "GRE-10", issueNumber: 10, title: "Cara's own task",
        status: "in_progress", priority: "high", assigneeUserId: CARA, responsibleUserId: CARA,
      },
      {
        id: agentWork, companyId, identifier: "GRE-11", issueNumber: 11, title: "Nova works, Cara reviews",
        status: "in_review", priority: "medium", assigneeAgentId: nova, responsibleUserId: CARA,
        executionState: { currentParticipant: { type: "user", userId: CARA }, returnAssignee: { type: "agent", agentId: nova } },
      },
      {
        id: closedWork, companyId, identifier: "GRE-1", issueNumber: 1, title: "Finished",
        status: "done", priority: "low", assigneeUserId: CARA,
      },
    ]);
    await db.insert(issueThreadInteractions).values({
      companyId, issueId: agentWork, kind: "ask_user_questions", status: "pending", title: "Which month?",
      addresseeUserId: CARA, createdByUserId: JOHN,
      payload: { version: 1, questions: [{ id: "month", prompt: "Which month?", selectionMode: "single", options: [{ id: "sep", label: "September" }] }] },
    });

    const routineId = randomUUID();
    const revisionId = randomUUID();
    await db.insert(routines).values({
      id: routineId, companyId, title: "Daily digest", assigneeAgentId: nova, status: "active",
      responsibleUserId: CARA, latestRevisionId: revisionId,
    });
    await db.insert(routineRevisions).values({
      id: revisionId, companyId, routineId, revisionNumber: 1, title: "Daily digest", responsibleUserId: CARA,
      snapshot: {
        version: 1,
        routine: {
          id: routineId, projectId: null, goalId: null, parentIssueId: null, title: "Daily digest", description: null,
          assigneeAgentId: nova, priority: "medium", status: "active", concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed", activityGatePolicy: "always", activityGateScope: "company", variables: [],
          env: null, responsibleUserId: CARA,
        },
        triggers: [],
      } as never,
    });
    await db.insert(heartbeatRuns).values({ companyId, agentId: nova, status: "queued", responsibleUserId: CARA, contextSnapshot: { responsibleUserId: CARA } });

    await db.insert(principalPermissionGrants).values([
      { companyId, principalType: "user", principalId: CARA, permissionKey: "memory:contribute" },
      { companyId, principalType: "user", principalId: CARA, permissionKey: "tasks:assign" },
      { companyId, principalType: "user", principalId: JOHN, permissionKey: "users:manage_permissions" },
      { companyId, principalType: "user", principalId: BEN, permissionKey: "users:manage_permissions" },
    ]);
    await db.insert(boardApiKeys).values([
      { userId: CARA, name: "cara cli", keyHash: `hash-${randomUUID()}` },
      { userId: JOHN, name: "john cli", keyHash: `hash-${randomUUID()}` },
    ]);
    await db.insert(authSessions).values({
      id: randomUUID(), userId: CARA, token: randomUUID(), expiresAt: new Date(Date.now() + 86_400_000), createdAt: now, updatedAt: now,
    });
    return { companyId, memberId, nova, iris, ownWork, agentWork, closedWork, routineId, revisionId, caraAccount };
  }

  const handover = (app: express.Express, companyId: string, memberId: string, body: Record<string, unknown>) =>
    request(app).post(`/api/companies/${companyId}/members/${memberId}/handover`).send(body);

  async function snapshot(companyId: string) {
    const [issueRows, members, grants, keys, sessionRows, permissions, routineRows, revisionRows, runs, agentRows, company, logs] = await Promise.all([
      db.select().from(issues).where(eq(issues.companyId, companyId)),
      db.select().from(companyMemberships).where(eq(companyMemberships.companyId, companyId)),
      db.select().from(connectionGrants).where(eq(connectionGrants.companyId, companyId)),
      db.select().from(boardApiKeys),
      db.select().from(authSessions),
      db.select().from(principalPermissionGrants),
      db.select().from(routines),
      db.select().from(routineRevisions),
      db.select().from(heartbeatRuns),
      db.select().from(agents),
      db.select().from(companies).where(eq(companies.id, companyId)),
      db.select().from(activityLog),
    ]);
    const sort = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
    return JSON.stringify([issueRows, members, grants, keys, sessionRows, permissions, routineRows, revisionRows, runs, agentRows, company, logs].map((rows) => sort(rows as Array<{ id: string }>)));
  }

  it("lists everything that depends on the person, grouped, with a recommendation, and a dry run writes nothing", async () => {
    const seeded = await seed();
    const before = await snapshot(seeded.companyId);
    const res = await handover(createApp(sessionActor(JOHN, seeded.companyId, "owner")), seeded.companyId, seeded.memberId(CARA), {
      successorUserId: DAN, dryRun: true,
    });
    expect(res.status).toBe(200);
    const plan = res.body;
    expect(plan.dryRun).toBe(true);
    expect(plan.blockers).toEqual([]);
    const byRef = new Map(plan.items.map((item: { ref: string }) => [item.ref, item]));
    const move = { type: "move_to_user", userId: DAN };

    expect(byRef.get(`issue:${seeded.ownWork}`)).toMatchObject({ group: "work", roles: ["assignee", "responsible"], recommended: move, link: "/issues/GRE-10" });
    expect(byRef.get(`issue:${seeded.agentWork}`)).toMatchObject({ group: "work", roles: ["responsible", "current_reviewer"], recommended: move });
    expect(byRef.has(`issue:${seeded.closedWork}`)).toBe(false);
    expect(plan.items.filter((item: { kind: string }) => item.kind === "interaction")).toHaveLength(1);
    expect(byRef.get(`routine:${seeded.routineId}`)).toMatchObject({ group: "routines", recommended: move });
    expect(byRef.get("company_default")).toMatchObject({ recommended: move });
    expect(byRef.get("queued_runs")).toMatchObject({ count: 1, planned: move });
    // Nova runs on the responsible person's default: Dan has one, so nothing to change.
    expect(byRef.get(`agent:${seeded.nova}`)).toMatchObject({ group: "agents", recommended: { type: "keep_ai_setting" }, blocker: null });
    // Iris is bound to Cara's own account, which is revoked: switch to the responsible person's default.
    expect(byRef.get(`agent:${seeded.iris}`)).toMatchObject({ recommended: { type: "use_personal_default" }, blocker: null });
    expect(byRef.get(`grant:${seeded.caraAccount.grantId}`)).toMatchObject({ group: "connections", kind: "ai_connection", planned: { type: "revoke" } });
    expect(byRef.get("memory_grants")).toMatchObject({ count: 1, planned: { type: "remove" } });
    expect(byRef.get("permission_grants")).toMatchObject({ count: 1 });
    expect(byRef.get("membership")).toMatchObject({ planned: { type: "archive" } });
    expect(byRef.get("board_api_keys")).toMatchObject({ count: 1, planned: { type: "revoke" } });
    expect(byRef.get("sessions")).toMatchObject({ count: 1, planned: { type: "end" } });
    expect(plan.reconnect).toEqual([expect.objectContaining({ kind: "ai", name: "Cara Claude" })]);
    expect(plan.counts).toMatchObject({ issues: 2, interactions: 1, routines: 1, queuedRuns: 1, agentsRepointed: 1, connectionsRevoked: 1 });

    expect(await snapshot(seeded.companyId)).toBe(before);
  });

  it("executes: moves the work, repoints agents, revokes access, creates the handover task and logs it", async () => {
    const seeded = await seed();
    const { companyId } = seeded;
    const res = await handover(createApp(sessionActor(JOHN, companyId, "owner")), companyId, seeded.memberId(CARA), {
      successorUserId: DAN, dryRun: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(false);

    const [own] = await db.select().from(issues).where(eq(issues.id, seeded.ownWork));
    expect(own).toMatchObject({ assigneeUserId: DAN, responsibleUserId: DAN, status: "in_progress" });
    const [agentWork] = await db.select().from(issues).where(eq(issues.id, seeded.agentWork));
    expect(agentWork).toMatchObject({ assigneeAgentId: seeded.nova, responsibleUserId: DAN });
    expect((agentWork!.executionState as Record<string, unknown>).currentParticipant).toEqual({ type: "user", userId: DAN });
    const [closed] = await db.select().from(issues).where(eq(issues.id, seeded.closedWork));
    expect(closed?.assigneeUserId).toBe(CARA);
    const [ask] = await db.select().from(issueThreadInteractions);
    expect(ask?.addresseeUserId).toBe(DAN);

    const [routine] = await db.select().from(routines).where(eq(routines.id, seeded.routineId));
    expect(routine?.responsibleUserId).toBe(DAN);
    const [revision] = await db.select().from(routineRevisions).where(eq(routineRevisions.id, seeded.revisionId));
    expect(revision?.responsibleUserId).toBe(DAN);
    expect((revision?.snapshot as { routine: { responsibleUserId: string } }).routine.responsibleUserId).toBe(DAN);
    const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(company?.defaultResponsibleUserId).toBe(DAN);
    const [run] = await db.select().from(heartbeatRuns);
    expect(run?.responsibleUserId).toBe(DAN);
    expect(run?.contextSnapshot).toMatchObject({ responsibleUserId: DAN });

    const [iris] = await db.select().from(agents).where(eq(agents.id, seeded.iris));
    expect(iris?.runtimeConfig.aiConnection).toEqual({ provider: "anthropic", method: "api_key", mode: "responsible_user" });
    const [caraGrant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, seeded.caraAccount.grantId));
    expect(caraGrant?.status).toBe("revoked");

    const [membership] = await db.select().from(companyMemberships).where(eq(companyMemberships.principalId, CARA));
    expect(membership?.status).toBe("archived");
    expect(await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, CARA))).toEqual([]);
    const [caraKey] = await db.select().from(boardApiKeys).where(eq(boardApiKeys.userId, CARA));
    expect(caraKey?.revokedAt).not.toBeNull();
    const [johnKey] = await db.select().from(boardApiKeys).where(eq(boardApiKeys.userId, JOHN));
    expect(johnKey?.revokedAt).toBeNull();
    expect(await db.select().from(authSessions).where(eq(authSessions.userId, CARA))).toEqual([]);

    // The handover task for Dan.
    expect(res.body.handoverIssue).toMatchObject({ title: "Handover from Cara Leaving" });
    const [task] = await db.select().from(issues).where(eq(issues.id, res.body.handoverIssue.id));
    expect(task).toMatchObject({ assigneeUserId: DAN, responsibleUserId: DAN, status: "todo" });
    expect(task?.description).toContain("[GRE-10 Cara's own task](/GRE/issues/GRE-10)");
    expect(task?.description).toContain("## You need to reconnect");
    expect(task?.description).toContain("Cara Claude");

    const [logged] = await db.select().from(activityLog).where(eq(activityLog.action, MEMBER_HANDED_OVER_ACTION));
    expect(logged).toMatchObject({ actorId: JOHN, entityId: seeded.memberId(CARA) });
    expect(logged?.details).toMatchObject({
      principalId: CARA,
      successorUserId: DAN,
      membershipStatus: { from: "active", to: "archived" },
      counts: { issues: 2, interactions: 1, routines: 1, queuedRuns: 1, agentsRepointed: 1, connectionsRevoked: 1, memoryGrantsRemoved: 1, permissionGrantsRemoved: 1, boardKeysRevoked: 1, sessionsEnded: 1 },
    });

    // A second handover is refused.
    const again = await handover(createApp(sessionActor(JOHN, companyId, "owner")), companyId, seeded.memberId(CARA), { successorUserId: DAN, dryRun: true });
    expect(again.status).toBe(403);
  });

  it("keeps routines and agents running afterwards: the firing responsible person has a working AI account", async () => {
    const seeded = await seed();
    const { companyId } = seeded;
    const ai = aiConnectionService(db);
    const select = (agentId: string, userId: string, binding: Record<string, unknown>) => ai.select({
      companyId, userId, agentId, adapterType: "claude_local", binding: binding as never,
    });
    await handover(createApp(sessionActor(JOHN, companyId, "owner")), companyId, seeded.memberId(CARA), {
      successorUserId: DAN, dryRun: false,
    }).expect(200);

    // What routine firing reads: the latest revision, then its snapshot, then the routine.
    const [routine] = await db.select().from(routines).where(eq(routines.id, seeded.routineId));
    const [revision] = await db.select().from(routineRevisions).where(eq(routineRevisions.id, routine!.latestRevisionId!));
    const firingUser = revision?.responsibleUserId ?? routine?.responsibleUserId;
    expect(firingUser).toBe(DAN);
    const [nova] = await db.select().from(agents).where(eq(agents.id, seeded.nova));
    await expect(select(seeded.nova, firingUser!, nova!.runtimeConfig.aiConnection as Record<string, unknown>))
      .resolves.toMatchObject({ attribution: { responsibleUserId: DAN } });
    const [iris] = await db.select().from(agents).where(eq(agents.id, seeded.iris));
    await expect(select(seeded.iris, DAN, iris!.runtimeConfig.aiConnection as Record<string, unknown>))
      .resolves.toMatchObject({ attribution: { responsibleUserId: DAN } });
    // Without the handover these runs would stop at configuration: the old person is gone.
    await expect(select(seeded.nova, CARA, nova!.runtimeConfig.aiConnection as Record<string, unknown>))
      .rejects.toThrow("not an active company member");
  });

  it("blocks when an agent would be left without an AI account, then offers a shared one", async () => {
    const seeded = await seed();
    const { companyId } = seeded;
    await db.delete(aiProviderDefaults).where(and(eq(aiProviderDefaults.companyId, companyId), eq(aiProviderDefaults.userId, DAN)));
    const app = createApp(sessionActor(JOHN, companyId, "owner"));
    const before = await snapshot(companyId);

    const dry = await handover(app, companyId, seeded.memberId(CARA), { successorUserId: DAN, dryRun: true });
    expect(dry.status).toBe(200);
    const nova = dry.body.items.find((item: { ref: string }) => item.ref === `agent:${seeded.nova}`);
    expect(nova.blocker).toContain("would have no AI account");
    expect(dry.body.blockers.length).toBeGreaterThanOrEqual(2);

    const blocked = await handover(app, companyId, seeded.memberId(CARA), { successorUserId: DAN, dryRun: false });
    expect(blocked.status).toBe(422);
    expect(blocked.body.details?.code ?? blocked.body.code).toBe("member_handover_blocked");
    expect(await snapshot(companyId)).toBe(before);

    const shared = await sharedAccount(companyId, JOHN, "Company Claude");
    const withShared = await handover(app, companyId, seeded.memberId(CARA), { successorUserId: DAN, dryRun: true });
    const novaShared = withShared.body.items.find((item: { ref: string }) => item.ref === `agent:${seeded.nova}`);
    expect(novaShared).toMatchObject({ blocker: null, recommended: { type: "use_shared_connection", grantId: shared.grantId } });
    expect(withShared.body.blockers).toEqual([]);

    await handover(app, companyId, seeded.memberId(CARA), { successorUserId: DAN, dryRun: false }).expect(200);
    const [agent] = await db.select().from(agents).where(eq(agents.id, seeded.nova));
    expect(agent?.runtimeConfig.aiConnection).toMatchObject({ mode: "shared", grantId: shared.grantId });
    await expect(aiConnectionService(db).select({
      companyId, userId: DAN, agentId: seeded.nova, adapterType: "claude_local", binding: agent!.runtimeConfig.aiConnection as never,
    })).resolves.toBeTruthy();
  });

  it("applies overrides: another person, an agent, close and leave", async () => {
    const seeded = await seed();
    const { companyId } = seeded;
    // An unknown item or a refused choice is a blocker, not a silent skip.
    const bad = await handover(createApp(sessionActor(JOHN, companyId, "owner")), companyId, seeded.memberId(CARA), {
      successorUserId: DAN, dryRun: true,
      overrides: [{ itemRef: "routine:nope", toUserId: BEN }, { itemRef: `routine:${seeded.routineId}`, action: "leave" }],
    });
    expect(bad.body.blockers.join(" ")).toContain('Unknown item "routine:nope"');
    expect(bad.body.blockers.join(" ")).toContain("This routine is active");

    // The routine runs as Nova, so Ben needs an AI account of his own first.
    const withoutAccount = await handover(createApp(sessionActor(JOHN, companyId, "owner")), companyId, seeded.memberId(CARA), {
      successorUserId: DAN, dryRun: true, overrides: [{ itemRef: `routine:${seeded.routineId}`, toUserId: BEN }],
    });
    expect(withoutAccount.body.blockers.join(" ")).toContain("Nova would have no AI account");
    await personalAccount(companyId, BEN, "Ben Claude");

    const res = await handover(createApp(sessionActor(JOHN, companyId, "owner")), companyId, seeded.memberId(CARA), {
      successorUserId: DAN,
      dryRun: false,
      overrides: [
        { itemRef: `issue:${seeded.ownWork}`, toAgentId: seeded.nova },
        { itemRef: `routine:${seeded.routineId}`, toUserId: BEN },
        { itemRef: "company_default", action: "clear" },
        { itemRef: `issue:${seeded.agentWork}`, action: "close" },
      ],
    });
    expect(res.status).toBe(200);
    const [own] = await db.select().from(issues).where(eq(issues.id, seeded.ownWork));
    expect(own).toMatchObject({ assigneeAgentId: seeded.nova, assigneeUserId: null, responsibleUserId: DAN, status: "todo" });
    const [agentWork] = await db.select().from(issues).where(eq(issues.id, seeded.agentWork));
    expect(agentWork?.status).toBe("cancelled");
    const [routine] = await db.select().from(routines).where(eq(routines.id, seeded.routineId));
    expect(routine?.responsibleUserId).toBe(BEN);
    const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(company?.defaultResponsibleUserId).toBeNull();
  });

  it("enforces who may hand over whom", async () => {
    const seeded = await seed();
    const { companyId } = seeded;
    const ben = createApp(sessionActor(BEN, companyId, "admin"));
    // An admin can hand over an operator.
    expect((await handover(ben, companyId, seeded.memberId(CARA), { successorUserId: DAN, dryRun: true })).status).toBe(200);
    // Only an owner can hand over an owner or admin.
    const owner = await handover(ben, companyId, seeded.memberId(OWEN), { successorUserId: DAN, dryRun: true });
    expect(owner.status).toBe(403);
    expect(owner.body.error).toContain("Only an owner");
    // Nobody hands over themselves.
    const self = await handover(createApp(sessionActor(JOHN, companyId, "owner")), companyId, seeded.memberId(JOHN), { successorUserId: DAN, dryRun: true });
    expect(self.status).toBe(403);
    // Operators cannot run it at all.
    const dan = await handover(createApp(sessionActor(DAN, companyId, "operator")), companyId, seeded.memberId(CARA), { successorUserId: JOHN, dryRun: true });
    expect(dan.status).toBe(403);
    // The successor must be an active person who is not leaving.
    const toSelf = await handover(createApp(sessionActor(JOHN, companyId, "owner")), companyId, seeded.memberId(CARA), { successorUserId: CARA, dryRun: true });
    expect(toSelf.status).toBe(422);
    const toStranger = await handover(createApp(sessionActor(JOHN, companyId, "owner")), companyId, seeded.memberId(CARA), { successorUserId: "nobody", dryRun: true });
    expect(toStranger.status).toBe(422);

    // Never the last active owner (local-board does not count).
    await db.update(companyMemberships).set({ membershipRole: "admin" }).where(eq(companyMemberships.principalId, OWEN));
    const instanceAdmin = createApp({
      type: "board", userId: "root", source: "session", isInstanceAdmin: true, companyIds: [companyId], memberships: [],
    } as unknown as Actor);
    const last = await handover(instanceAdmin, companyId, seeded.memberId(JOHN), { successorUserId: DAN, dryRun: true });
    expect(last.status).toBe(403);
    expect(last.body.error).toContain("last active owner");

    // The members list carries the controls the page shows.
    const list = await request(createApp(sessionActor(BEN, companyId, "admin"))).get(`/api/companies/${companyId}/members`);
    expect(list.status).toBe(200);
    const row = (userId: string) => list.body.members.find((member: { principalId: string }) => member.principalId === userId);
    expect(row(CARA).handover).toMatchObject({ canHandOver: true, canRestore: false });
    expect(row(JOHN).handover).toMatchObject({ canHandOver: false });
    expect(row(BEN).handover.handOverReason).toContain("yourself");
  });

  it("removes an instance admin role only with an owner's confirmation", async () => {
    const seeded = await seed();
    const { companyId } = seeded;
    await db.insert(instanceUserRoles).values({ userId: CARA, role: "instance_admin" });
    const john = createApp(sessionActor(JOHN, companyId, "owner"));
    const dry = await handover(john, companyId, seeded.memberId(CARA), { successorUserId: DAN, dryRun: true });
    expect(dry.body.blockers.join(" ")).toContain("instance admin");
    const ben = await handover(createApp(sessionActor(BEN, companyId, "admin")), companyId, seeded.memberId(CARA), {
      successorUserId: DAN, dryRun: true, removeInstanceAdmin: true,
    });
    expect(ben.body.blockers.join(" ")).toContain("Only an owner can remove an instance admin role");
    await handover(john, companyId, seeded.memberId(CARA), { successorUserId: DAN, dryRun: false, removeInstanceAdmin: true }).expect(200);
    expect(await db.select().from(instanceUserRoles).where(eq(instanceUserRoles.userId, CARA))).toEqual([]);

    const restored = await request(john).post(`/api/companies/${companyId}/members/${seeded.memberId(CARA)}/restore`).send({});
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ instanceAdminRestored: true, membershipStatus: { from: "archived", to: "active" } });
    expect(await db.select().from(instanceUserRoles).where(eq(instanceUserRoles.userId, CARA))).toHaveLength(1);
  });

  it("restores access only: membership and permissions come back, memory rights and moved work do not", async () => {
    const seeded = await seed();
    const { companyId } = seeded;
    const john = createApp(sessionActor(JOHN, companyId, "owner"));
    await handover(john, companyId, seeded.memberId(CARA), { successorUserId: DAN, dryRun: false }).expect(200);

    const archivedList = await request(john).get(`/api/companies/${companyId}/members?includeArchived=true`);
    const caraRow = archivedList.body.members.find((member: { principalId: string }) => member.principalId === CARA);
    expect(caraRow).toMatchObject({ status: "archived", handover: { canRestore: true } });

    const dan = await request(createApp(sessionActor(DAN, companyId, "operator")))
      .post(`/api/companies/${companyId}/members/${seeded.memberId(CARA)}/restore`).send({});
    expect(dan.status).toBe(403);

    const res = await request(john).post(`/api/companies/${companyId}/members/${seeded.memberId(CARA)}/restore`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ membershipStatus: { from: "archived", to: "active" }, permissionGrantsRestored: 1 });
    const grants = await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, CARA));
    expect(grants.map((grant) => grant.permissionKey)).toEqual(["tasks:assign"]);
    const [own] = await db.select().from(issues).where(eq(issues.id, seeded.ownWork));
    expect(own?.assigneeUserId).toBe(DAN);

    const twice = await request(john).post(`/api/companies/${companyId}/members/${seeded.memberId(CARA)}/restore`).send({});
    expect(twice.status).toBe(409);
  });

  it("hands over the legacy local-board account through the same flow, and refuses it in local_trusted mode", async () => {
    const seeded = await seed();
    const { companyId } = seeded;
    await db.insert(issues).values({
      companyId, identifier: "GRE-800", issueNumber: 800, title: "Waits on the board",
      status: "in_review", priority: "high", assigneeUserId: LEGACY_BOARD_USER_ID, responsibleUserId: LEGACY_BOARD_USER_ID,
    });
    await db.insert(boardApiKeys).values({ userId: LEGACY_BOARD_USER_ID, name: "old cli", keyHash: `hash-${randomUUID()}` });

    const trusted = await handover(
      createApp({ type: "board", userId: LEGACY_BOARD_USER_ID, source: "local_implicit", isInstanceAdmin: true } as Actor, "local_trusted"),
      companyId, seeded.memberId(LEGACY_BOARD_USER_ID), { successorUserId: JOHN, dryRun: true },
    );
    expect(trusted.status).toBe(403);
    expect(trusted.body.error).toContain("local_trusted");

    const john = createApp(sessionActor(JOHN, companyId, "owner"));
    const list = await request(john).get(`/api/companies/${companyId}/members`);
    const legacyRow = list.body.members.find((member: { principalId: string }) => member.principalId === LEGACY_BOARD_USER_ID);
    expect(legacyRow.handover).toMatchObject({ canHandOver: true });

    const dry = await handover(john, companyId, seeded.memberId(LEGACY_BOARD_USER_ID), { successorUserId: JOHN, dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.blockers).toEqual([]);
    expect(dry.body.items.find((item: { ref: string }) => item.ref === "instance_admin")).toMatchObject({ planned: { type: "keep" } });
    expect(dry.body.items.find((item: { ref: string }) => item.ref === "membership")).toMatchObject({ planned: { type: "suspend" } });

    await handover(john, companyId, seeded.memberId(LEGACY_BOARD_USER_ID), { successorUserId: JOHN, dryRun: false }).expect(200);
    const [task] = await db.select().from(issues).where(eq(issues.identifier, "GRE-800"));
    expect(task).toMatchObject({ assigneeUserId: JOHN, responsibleUserId: JOHN });
    const [legacy] = await db.select().from(companyMemberships).where(eq(companyMemberships.principalId, LEGACY_BOARD_USER_ID));
    expect(legacy).toMatchObject({ status: "suspended", membershipRole: "owner" });
    const [legacyKey] = await db.select().from(boardApiKeys).where(eq(boardApiKeys.userId, LEGACY_BOARD_USER_ID));
    expect(legacyKey?.revokedAt).not.toBeNull();
    expect(await db.select().from(instanceUserRoles).where(eq(instanceUserRoles.userId, LEGACY_BOARD_USER_ID))).toHaveLength(1);

    const restored = await request(john).post(`/api/companies/${companyId}/members/${seeded.memberId(LEGACY_BOARD_USER_ID)}/restore`).send({});
    expect(restored.status).toBe(200);
    expect(restored.body.membershipStatus).toEqual({ from: "suspended", to: "active" });
  });
});
