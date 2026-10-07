import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DeploymentMode } from "@greatstone/shared";
import {
  activityLog,
  authAccounts,
  authSessions,
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  issueComments,
  issueThreadInteractions,
  issues,
  principalPermissionGrants,
  routineRevisions,
  routines,
} from "@greatstone/db";
import { reassignLegacyBoardWork } from "../services/legacy-board-reassignment.js";
import { errorHandler } from "../middleware/index.js";
import { accessRoutes } from "../routes/access.js";
import { legacyBoardRoutes } from "../routes/legacy-board.js";
import { LEGACY_BOARD_USER_ID, viewerPrincipalUserIds } from "../services/board-identity.js";
import {
  LEGACY_BOARD_RETIRED_ACTION,
  LEGACY_BOARD_RESTORED_ACTION,
  retireLegacyBoard,
} from "../services/legacy-board-retirement.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const JOHN = "UGJwnXKO0P0yBvVh4krv4LH3EThDwrRP";
const BEN = "ben-admin";

type Actor = Express.Request["actor"];

function sessionActor(userId: string, companyId: string, role: string): Actor {
  return {
    type: "board",
    userId,
    source: "session",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: role, status: "active" }],
  } as Actor;
}

describeEmbeddedPostgres("retiring the legacy local-board account", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-legacy-board-retire-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(issueComments);
    await db.delete(issueThreadInteractions);
    await db.update(routines).set({ latestRevisionId: null });
    await db.delete(routineRevisions);
    await db.delete(routines);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(boardApiKeys);
    await db.delete(authSessions);
    await db.delete(authAccounts);
    await db.delete(instanceUserRoles);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
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
    app.use("/api", legacyBoardRoutes(db, { deploymentMode }));
    app.use(errorHandler);
    return app;
  }

  /** The live shape: local-board (owner, instance admin), John (owner), Ben (admin). */
  async function seed() {
    const companyId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: companyId, name: "GRE Co", issuePrefix: "GRE", requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values([
      { id: LEGACY_BOARD_USER_ID, name: "John Prempeh (legacy)", email: "local@paperclip.local", emailVerified: true, createdAt: now, updatedAt: now },
      { id: JOHN, name: "John Prempeh", email: "john@example.com", emailVerified: true, createdAt: now, updatedAt: now },
      { id: BEN, name: "Ben", email: "ben@example.com", emailVerified: true, createdAt: now, updatedAt: now },
    ]);
    const at = (minutes: number) => new Date(Date.UTC(2026, 8, 1, 9, minutes));
    const [legacyMembership] = await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: LEGACY_BOARD_USER_ID, status: "active", membershipRole: "owner", createdAt: at(0) },
      { companyId, principalType: "user", principalId: JOHN, status: "active", membershipRole: "owner", createdAt: at(1) },
      { companyId, principalType: "user", principalId: BEN, status: "active", membershipRole: "admin", createdAt: at(2) },
    ]).returning({ id: companyMemberships.id });
    await db.insert(instanceUserRoles).values({ userId: LEGACY_BOARD_USER_ID, role: "instance_admin" });
    await db.insert(boardApiKeys).values([
      { userId: LEGACY_BOARD_USER_ID, name: "old cli", keyHash: `hash-${randomUUID()}` },
      { userId: LEGACY_BOARD_USER_ID, name: "old script", keyHash: `hash-${randomUUID()}` },
      { userId: LEGACY_BOARD_USER_ID, name: "already revoked", keyHash: `hash-${randomUUID()}`, revokedAt: at(5) },
      { userId: JOHN, name: "john cli", keyHash: `hash-${randomUUID()}` },
    ]);
    await db.insert(authSessions).values({
      id: randomUUID(), userId: LEGACY_BOARD_USER_ID, token: randomUUID(),
      expiresAt: new Date(Date.now() + 86_400_000), createdAt: now, updatedAt: now,
    });

    const openId = randomUUID();
    const closedId = randomUUID();
    await db.insert(issues).values([
      {
        id: openId, companyId, identifier: "GRE-800", issueNumber: 800, title: "Waits on the board",
        status: "in_review", priority: "high", assigneeUserId: LEGACY_BOARD_USER_ID, responsibleUserId: LEGACY_BOARD_USER_ID,
      },
      {
        id: closedId, companyId, identifier: "GRE-1", issueNumber: 1, title: "Finished long ago",
        status: "done", priority: "low", assigneeUserId: LEGACY_BOARD_USER_ID,
      },
    ]);
    await db.insert(issueThreadInteractions).values({
      companyId, issueId: openId, kind: "ask_user_questions", status: "pending", title: "Which month?",
      addresseeUserId: LEGACY_BOARD_USER_ID, createdByUserId: LEGACY_BOARD_USER_ID,
      payload: { version: 1, questions: [{ id: "month", prompt: "Which month?", selectionMode: "single", options: [{ id: "sep", label: "September" }] }] },
    });
    await db.insert(issueComments).values({
      companyId, issueId: closedId, authorUserId: LEGACY_BOARD_USER_ID, body: "Signed off by the old board.",
    });
    await db.insert(activityLog).values({
      companyId, actorType: "user", actorId: LEGACY_BOARD_USER_ID, action: "issue.updated",
      entityType: "issue", entityId: closedId,
    });
    return { companyId, openId, closedId, legacyMembershipId: legacyMembership!.id };
  }

  /**
   * Routines as live: an active one on local-board (column and revision), a
   * paused one whose latest revision names local-board only in its snapshot,
   * and one on Ben that must not move.
   */
  async function seedRoutines(companyId: string) {
    const make = async (title: string, status: string, responsibleUserId: string, revision: {
      column: string | null;
      snapshot: string | null;
    }) => {
      const [routine] = await db.insert(routines).values({
        companyId, title, status, responsibleUserId, createdByUserId: responsibleUserId,
      }).returning();
      const [rev] = await db.insert(routineRevisions).values({
        companyId, routineId: routine!.id, revisionNumber: 1, title,
        responsibleUserId: revision.column,
        snapshot: {
          version: 1,
          routine: { id: routine!.id, companyId, title, status, responsibleUserId: revision.snapshot },
          triggers: [],
        } as never,
      }).returning();
      await db.update(routines).set({ latestRevisionId: rev!.id }).where(eq(routines.id, routine!.id));
      return { routineId: routine!.id, revisionId: rev!.id };
    };
    const digest = await make("Daily digest", "active", LEGACY_BOARD_USER_ID, {
      column: LEGACY_BOARD_USER_ID, snapshot: LEGACY_BOARD_USER_ID,
    });
    const audit = await make("Monthly audit", "paused", LEGACY_BOARD_USER_ID, {
      column: null, snapshot: LEGACY_BOARD_USER_ID,
    });
    const bens = await make("Ben's check", "active", BEN, { column: BEN, snapshot: BEN });
    return { digest, audit, bens };
  }

  async function routineOwners(ids: { routineId: string; revisionId: string }) {
    const [routine] = await db.select().from(routines).where(eq(routines.id, ids.routineId));
    const [revision] = await db.select().from(routineRevisions).where(eq(routineRevisions.id, ids.revisionId));
    return {
      routine: routine?.responsibleUserId,
      revision: revision?.responsibleUserId ?? null,
      snapshot: (revision?.snapshot as { routine?: { responsibleUserId?: string | null } } | undefined)?.routine?.responsibleUserId ?? null,
    };
  }

  async function legacyMembershipStatus(companyId: string) {
    const [row] = await db.select({ status: companyMemberships.status, role: companyMemberships.membershipRole })
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, LEGACY_BOARD_USER_ID)));
    return row;
  }

  it("lists what would change on a dry run and writes nothing", async () => {
    const { companyId, openId } = await seed();
    const res = await request(createApp(sessionActor(JOHN, companyId, "owner")))
      .post(`/api/companies/${companyId}/legacy-board/retire`)
      .send({ dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      dryRun: true,
      moveToUserId: JOHN,
      issueCount: 1,
      pendingRequestCount: 1,
      switchOff: {
        membershipStatus: { from: "active", to: "suspended" },
        boardKeysRevoked: 2,
        sessionsEnded: 1,
        instanceAdmin: "kept",
      },
    });
    expect(res.body.issues).toEqual([
      { id: openId, identifier: "GRE-800", title: "Waits on the board", roles: ["assignee", "responsible"] },
    ]);

    expect((await legacyMembershipStatus(companyId))?.status).toBe("active");
    const [open] = await db.select().from(issues).where(eq(issues.id, openId));
    expect(open?.assigneeUserId).toBe(LEGACY_BOARD_USER_ID);
    const liveKeys = await db.select().from(boardApiKeys).where(eq(boardApiKeys.userId, LEGACY_BOARD_USER_ID));
    expect(liveKeys.filter((key) => !key.revokedAt)).toHaveLength(2);
    expect(await db.select().from(authSessions)).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, LEGACY_BOARD_RETIRED_ACTION))).toEqual([]);
  });

  it("retires: moves work, suspends, revokes keys, ends sessions, logs, keeps history", async () => {
    const { companyId, openId, closedId, legacyMembershipId } = await seed();
    const app = createApp(sessionActor(JOHN, companyId, "owner"));
    const res = await request(app).post(`/api/companies/${companyId}/legacy-board/retire`).send({ dryRun: false });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: false, issueCount: 1, pendingRequestCount: 1 });

    const [open] = await db.select().from(issues).where(eq(issues.id, openId));
    expect(open?.assigneeUserId).toBe(JOHN);
    expect(open?.responsibleUserId).toBe(JOHN);
    const [ask] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, openId));
    expect(ask?.addresseeUserId).toBe(JOHN);

    // Suspended, role kept: suspension needs no role change.
    expect(await legacyMembershipStatus(companyId)).toEqual({ status: "suspended", role: "owner" });
    const legacyKeys = await db.select().from(boardApiKeys).where(eq(boardApiKeys.userId, LEGACY_BOARD_USER_ID));
    expect(legacyKeys.every((key) => key.revokedAt)).toBe(true);
    const [johnKey] = await db.select().from(boardApiKeys).where(eq(boardApiKeys.userId, JOHN));
    expect(johnKey?.revokedAt).toBeNull();
    expect(await db.select().from(authSessions).where(eq(authSessions.userId, LEGACY_BOARD_USER_ID))).toEqual([]);
    // No sign-in account, so the instance admin role is left alone.
    expect(await db.select().from(instanceUserRoles).where(eq(instanceUserRoles.userId, LEGACY_BOARD_USER_ID))).toHaveLength(1);

    const [logged] = await db.select().from(activityLog).where(eq(activityLog.action, LEGACY_BOARD_RETIRED_ACTION));
    expect(logged).toMatchObject({ actorId: JOHN, entityId: legacyMembershipId });
    expect(logged?.details).toMatchObject({
      issueCount: 1, issueIdentifiers: ["GRE-800"], pendingRequestCount: 1,
      boardKeysRevoked: 2, sessionsEnded: 1, instanceAdmin: "kept",
    });

    // History stays: closed work, comments and old activity still name local-board.
    const [closed] = await db.select().from(issues).where(eq(issues.id, closedId));
    expect(closed?.assigneeUserId).toBe(LEGACY_BOARD_USER_ID);
    const [comment] = await db.select().from(issueComments);
    expect(comment?.authorUserId).toBe(LEGACY_BOARD_USER_ID);
    expect(await db.select().from(activityLog).where(eq(activityLog.actorId, LEGACY_BOARD_USER_ID))).toHaveLength(1);
    const [legacyUser] = await db.select().from(authUsers).where(eq(authUsers.id, LEGACY_BOARD_USER_ID));
    expect(legacyUser?.name).toBe("John Prempeh (legacy)");

    // The owner alias still covers historical local-board items.
    expect(await viewerPrincipalUserIds(db, companyId, JOHN)).toEqual([JOHN, LEGACY_BOARD_USER_ID]);

    // A second retire is refused.
    const again = await request(app).post(`/api/companies/${companyId}/legacy-board/retire`).send({ dryRun: false });
    expect(again.status).toBe(409);
  });

  it("moves routines of any status, and their latest revision, to the owner", async () => {
    const { companyId } = await seed();
    const { digest, audit, bens } = await seedRoutines(companyId);
    const app = createApp(sessionActor(JOHN, companyId, "owner"));

    const dry = await request(app).post(`/api/companies/${companyId}/legacy-board/retire`).send({ dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.routineCount).toBe(2);
    expect(dry.body.routines).toEqual([
      { id: digest.routineId, title: "Daily digest", status: "active" },
      { id: audit.routineId, title: "Monthly audit", status: "paused" },
    ]);
    // The dry run writes nothing.
    expect(await routineOwners(digest)).toEqual({
      routine: LEGACY_BOARD_USER_ID, revision: LEGACY_BOARD_USER_ID, snapshot: LEGACY_BOARD_USER_ID,
    });

    const res = await request(app).post(`/api/companies/${companyId}/legacy-board/retire`).send({ dryRun: false });
    expect(res.status).toBe(200);
    expect(res.body.routineCount).toBe(2);
    expect(await routineOwners(digest)).toEqual({ routine: JOHN, revision: JOHN, snapshot: JOHN });
    // The column stays empty; the snapshot it falls back to now names John.
    expect(await routineOwners(audit)).toEqual({ routine: JOHN, revision: null, snapshot: JOHN });
    expect(await routineOwners(bens)).toEqual({ routine: BEN, revision: BEN, snapshot: BEN });

    const [logged] = await db.select().from(activityLog).where(eq(activityLog.action, LEGACY_BOARD_RETIRED_ACTION));
    expect(logged?.details).toMatchObject({
      routineCount: 2,
      routineIds: [digest.routineId, audit.routineId],
      routineTitles: ["Daily digest", "Monthly audit"],
    });

    // Running the move again finds nothing left.
    const [again] = await reassignLegacyBoardWork(db, { apply: true, companyId });
    expect(again?.routines).toEqual([]);
  });

  it("the one-off reassignment moves routines too, and a second run finds none", async () => {
    const { companyId } = await seed();
    const { digest } = await seedRoutines(companyId);
    const [dry] = await reassignLegacyBoardWork(db, { apply: false, companyId });
    expect(dry?.routines.map((routine) => routine.title)).toEqual(["Daily digest", "Monthly audit"]);
    expect((await routineOwners(digest)).routine).toBe(LEGACY_BOARD_USER_ID);

    await reassignLegacyBoardWork(db, { apply: true, companyId });
    expect(await routineOwners(digest)).toEqual({ routine: JOHN, revision: JOHN, snapshot: JOHN });
    const [second] = await reassignLegacyBoardWork(db, { apply: true, companyId });
    expect(second).toMatchObject({ issues: [], interactionCount: 0, routines: [] });
  });

  it("keeps local-board out of pickers after retire but keeps its name for history", async () => {
    const { companyId } = await seed();
    await db.insert(principalPermissionGrants).values({
      companyId, principalType: "user", principalId: JOHN, permissionKey: "users:manage_permissions",
    });
    const app = createApp(sessionActor(JOHN, companyId, "owner"));

    const before = await request(app).get(`/api/companies/${companyId}/members`);
    expect(before.status).toBe(200);
    expect(before.body.access.legacyBoard).toEqual({ status: "active", canRetire: true, canRestore: false });

    await request(app).post(`/api/companies/${companyId}/legacy-board/retire`).send({ dryRun: false }).expect(200);

    const directory = await request(app).get(`/api/companies/${companyId}/user-directory`);
    expect(directory.status).toBe(200);
    const legacy = directory.body.users.find((user: { principalId: string }) => user.principalId === LEGACY_BOARD_USER_ID);
    expect(legacy).toMatchObject({ status: "suspended", user: { name: "John Prempeh (legacy)" } });
    const assignable = directory.body.users
      .filter((user: { status: string }) => user.status === "active")
      .map((user: { principalId: string }) => user.principalId);
    expect(assignable).not.toContain(LEGACY_BOARD_USER_ID);
    expect(assignable).toEqual(expect.arrayContaining([JOHN, BEN]));

    const after = await request(app).get(`/api/companies/${companyId}/members`);
    expect(after.body.access.legacyBoard).toEqual({ status: "suspended", canRetire: false, canRestore: true });
  });

  it("refuses in local_trusted mode", async () => {
    const { companyId } = await seed();
    const actor = {
      type: "board", userId: LEGACY_BOARD_USER_ID, source: "local_implicit", isInstanceAdmin: true,
    } as Actor;
    const res = await request(createApp(actor, "local_trusted"))
      .post(`/api/companies/${companyId}/legacy-board/retire`)
      .send({ dryRun: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("authenticated mode");
    expect((await legacyMembershipStatus(companyId))?.status).toBe("active");
  });

  it("refuses for an admin who is not an owner", async () => {
    const { companyId } = await seed();
    const res = await request(createApp(sessionActor(BEN, companyId, "admin")))
      .post(`/api/companies/${companyId}/legacy-board/retire`)
      .send({ dryRun: false });
    expect(res.status).toBe(403);
    expect((await legacyMembershipStatus(companyId))?.status).toBe("active");
  });

  it("refuses when acting as local-board, even with a board API key", async () => {
    const { companyId } = await seed();
    const actor = {
      type: "board", userId: LEGACY_BOARD_USER_ID, source: "board_key", isInstanceAdmin: true,
      companyIds: [companyId], memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    } as Actor;
    const res = await request(createApp(actor))
      .post(`/api/companies/${companyId}/legacy-board/retire`)
      .send({ dryRun: false });
    expect(res.status).toBe(403);
    expect((await legacyMembershipStatus(companyId))?.status).toBe("active");
  });

  it("only ever targets local-board: a chosen user id is refused", async () => {
    const { companyId } = await seed();
    const res = await request(createApp(sessionActor(JOHN, companyId, "owner")))
      .post(`/api/companies/${companyId}/legacy-board/retire`)
      .send({ dryRun: false, userId: BEN });
    expect(res.status).toBe(400);
    const [ben] = await db.select().from(companyMemberships).where(eq(companyMemberships.principalId, BEN));
    expect(ben?.status).toBe("active");
  });

  it("refuses when it would leave the company with no active owner", async () => {
    const { companyId } = await seed();
    await db.update(companyMemberships).set({ membershipRole: "admin" }).where(eq(companyMemberships.principalId, JOHN));
    await expect(retireLegacyBoard(db, { companyId, ownerUserId: JOHN, dryRun: false }))
      .rejects.toMatchObject({ status: 409 });
    expect((await legacyMembershipStatus(companyId))?.status).toBe("active");
    // Through the route the caller is refused first, as John is no longer an owner.
    const res = await request(createApp(sessionActor(JOHN, companyId, "admin")))
      .post(`/api/companies/${companyId}/legacy-board/retire`)
      .send({ dryRun: false });
    expect(res.status).toBe(403);
  });

  it("removes the instance admin role only when local-board has a sign-in account, and restore gives it back", async () => {
    const { companyId } = await seed();
    const now = new Date();
    await db.insert(authAccounts).values({
      id: randomUUID(), issuer: "local:credential", accountId: LEGACY_BOARD_USER_ID, providerId: "credential",
      userId: LEGACY_BOARD_USER_ID, createdAt: now, updatedAt: now,
    });
    const app = createApp(sessionActor(JOHN, companyId, "owner"));

    const dry = await request(app).post(`/api/companies/${companyId}/legacy-board/retire`).send({ dryRun: true });
    expect(dry.body.switchOff.instanceAdmin).toBe("removed");
    await request(app).post(`/api/companies/${companyId}/legacy-board/retire`).send({ dryRun: false }).expect(200);
    expect(await db.select().from(instanceUserRoles).where(eq(instanceUserRoles.userId, LEGACY_BOARD_USER_ID))).toEqual([]);

    const restored = await request(app).post(`/api/companies/${companyId}/legacy-board/restore`).send({});
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ membershipStatus: { from: "suspended", to: "active" }, instanceAdminRestored: true });
    expect(await db.select().from(instanceUserRoles).where(eq(instanceUserRoles.userId, LEGACY_BOARD_USER_ID))).toHaveLength(1);
  });

  it("restores the membership but not the moved work, owner only", async () => {
    const { companyId, openId } = await seed();
    const john = createApp(sessionActor(JOHN, companyId, "owner"));
    await request(john).post(`/api/companies/${companyId}/legacy-board/retire`).send({ dryRun: false }).expect(200);

    const benTry = await request(createApp(sessionActor(BEN, companyId, "admin")))
      .post(`/api/companies/${companyId}/legacy-board/restore`)
      .send({});
    expect(benTry.status).toBe(403);
    expect((await legacyMembershipStatus(companyId))?.status).toBe("suspended");

    const res = await request(john).post(`/api/companies/${companyId}/legacy-board/restore`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ instanceAdminRestored: false });
    expect(await legacyMembershipStatus(companyId)).toEqual({ status: "active", role: "owner" });
    const [open] = await db.select().from(issues).where(eq(issues.id, openId));
    expect(open?.assigneeUserId).toBe(JOHN);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, LEGACY_BOARD_RESTORED_ACTION))).toHaveLength(1);

    const twice = await request(john).post(`/api/companies/${companyId}/legacy-board/restore`).send({});
    expect(twice.status).toBe(409);
  });
});
