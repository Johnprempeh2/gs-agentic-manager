import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, companyMemberships, createDb, issueThreadInteractions, issues } from "@greatstone/db";
import { issueService } from "../services/issues.js";
import { reassignLegacyBoardWork } from "../services/legacy-board-reassignment.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  LEGACY_BOARD_USER_ID,
  bindLegacyBoardUserId,
  boardIdentityDeploymentMode,
  primaryOwnerUserId,
  setBoardIdentityDeploymentMode,
  userMatchesPrincipal,
  viewerPrincipalUserIds,
} from "../services/board-identity.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const JOHN = "john-real-login";
const BEN = "ben-admin";
const STRANGER = "other-company-owner";

describeEmbeddedPostgres("local-board stands for the company's owners", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-board-identity-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    setBoardIdentityDeploymentMode("local_trusted");
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** The live company: local-board first, then John (owner) and Ben (admin). */
  async function seed() {
    const companyId = randomUUID();
    const elsewhereId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "GRE Co", issuePrefix: "GRE", requireBoardApprovalForNewAgents: false },
      { id: elsewhereId, name: "Else Co", issuePrefix: "ELS", requireBoardApprovalForNewAgents: false },
    ]);
    const at = (minutes: number) => new Date(Date.UTC(2026, 8, 1, 9, minutes));
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: LEGACY_BOARD_USER_ID, status: "active", membershipRole: "owner", createdAt: at(0) },
      { companyId, principalType: "user", principalId: JOHN, status: "active", membershipRole: "owner", createdAt: at(1) },
      { companyId, principalType: "user", principalId: BEN, status: "active", membershipRole: "admin", createdAt: at(2) },
      { companyId: elsewhereId, principalType: "user", principalId: STRANGER, status: "active", membershipRole: "owner", createdAt: at(0) },
    ]);
    return { companyId, elsewhereId };
  }

  it("lets an active owner answer for local-board, and nobody else", async () => {
    const { companyId, elsewhereId } = await seed();

    expect(await viewerPrincipalUserIds(db, companyId, JOHN)).toEqual([JOHN, LEGACY_BOARD_USER_ID]);
    expect(await viewerPrincipalUserIds(db, companyId, BEN)).toEqual([BEN]);
    expect(await viewerPrincipalUserIds(db, companyId, STRANGER)).toEqual([STRANGER]);
    expect(await viewerPrincipalUserIds(db, companyId, LEGACY_BOARD_USER_ID)).toEqual([LEGACY_BOARD_USER_ID]);

    expect(await userMatchesPrincipal(db, companyId, JOHN, LEGACY_BOARD_USER_ID)).toBe(true);
    expect(await userMatchesPrincipal(db, companyId, JOHN, JOHN)).toBe(true);
    expect(await userMatchesPrincipal(db, companyId, BEN, LEGACY_BOARD_USER_ID)).toBe(false);
    // Owning one company never carries to another.
    expect(await userMatchesPrincipal(db, companyId, STRANGER, LEGACY_BOARD_USER_ID)).toBe(false);
    expect(await userMatchesPrincipal(db, elsewhereId, JOHN, LEGACY_BOARD_USER_ID)).toBe(false);
    // The alias only covers local-board, never another real user.
    expect(await userMatchesPrincipal(db, companyId, JOHN, BEN)).toBe(false);
    expect(await userMatchesPrincipal(db, companyId, null, LEGACY_BOARD_USER_ID)).toBe(false);
  });

  it("drops the alias when the owner membership is no longer active", async () => {
    const { companyId } = await seed();
    await db.update(companyMemberships).set({ status: "suspended" });
    expect(await userMatchesPrincipal(db, companyId, JOHN, LEGACY_BOARD_USER_ID)).toBe(false);
  });

  it("picks the earliest real owner as the primary owner", async () => {
    const { companyId, elsewhereId } = await seed();
    expect(await primaryOwnerUserId(db, companyId)).toBe(JOHN);
    expect(await primaryOwnerUserId(db, elsewhereId)).toBe(STRANGER);
    expect(await primaryOwnerUserId(db, randomUUID())).toBeNull();
  });

  it("sends new local-board defaults to the real owner in authenticated mode only", async () => {
    const { companyId } = await seed();

    expect(boardIdentityDeploymentMode()).toBe("local_trusted");
    expect(await bindLegacyBoardUserId(db, companyId, LEGACY_BOARD_USER_ID)).toBe(LEGACY_BOARD_USER_ID);

    setBoardIdentityDeploymentMode("authenticated");
    expect(await bindLegacyBoardUserId(db, companyId, LEGACY_BOARD_USER_ID)).toBe(JOHN);
    // A real user, or no user, is never changed.
    expect(await bindLegacyBoardUserId(db, companyId, BEN)).toBe(BEN);
    expect(await bindLegacyBoardUserId(db, companyId, null)).toBeNull();
    // No real owner yet: keep local-board rather than guess.
    expect(await bindLegacyBoardUserId(db, randomUUID(), LEGACY_BOARD_USER_ID)).toBe(LEGACY_BOARD_USER_ID);
  });

  it("gives a new sub-task of an old local-board task to the real owner once sign-in is on", async () => {
    const { companyId } = await seed();
    const parentId = randomUUID();
    await db.insert(issues).values({
      id: parentId, companyId, identifier: "GRE-1", issueNumber: 1, title: "Old board task",
      status: "in_progress", priority: "medium", responsibleUserId: LEGACY_BOARD_USER_ID,
    });

    const trusted = await issueService(db).create(companyId, { title: "Local child", parentId, status: "todo" });
    expect(trusted.responsibleUserId).toBe(LEGACY_BOARD_USER_ID);

    setBoardIdentityDeploymentMode("authenticated");
    const signedIn = await issueService(db).create(companyId, { title: "Signed-in child", parentId, status: "todo" });
    expect(signedIn.responsibleUserId).toBe(JOHN);
  });

  it("moves open local-board work to the primary owner only with --apply, once, leaving closed work", async () => {
    const { companyId } = await seed();
    const policy = {
      mode: "normal",
      commentRequired: true,
      stages: [{ id: randomUUID(), type: "review", approvalsNeeded: 1, participants: [{ id: randomUUID(), type: "user", userId: LEGACY_BOARD_USER_ID, agentId: null }] }],
    };
    const openId = randomUUID();
    const closedId = randomUUID();
    await db.insert(issues).values([
      {
        id: openId, companyId, identifier: "GRE-800", issueNumber: 800, title: "Waits on the board",
        status: "in_review", priority: "high", assigneeUserId: LEGACY_BOARD_USER_ID, responsibleUserId: LEGACY_BOARD_USER_ID,
        executionPolicy: policy,
        executionState: {
          status: "pending", currentStageId: policy.stages[0]!.id, currentStageIndex: 0, currentStageType: "review",
          currentParticipant: { type: "user", userId: LEGACY_BOARD_USER_ID, agentId: null },
          returnAssignee: { type: "user", userId: BEN, agentId: null },
          completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
        },
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

    const dryRun = await reassignLegacyBoardWork(db, { apply: false });
    const dryCompany = dryRun.find((row) => row.companyId === companyId);
    expect(dryCompany).toEqual(expect.objectContaining({ ownerUserId: JOHN, interactionCount: 1 }));
    expect(dryCompany?.issues.map((issue) => issue.id)).toEqual([openId]);
    const [untouched] = await db.select().from(issues).where(eq(issues.id, openId));
    expect(untouched?.assigneeUserId).toBe(LEGACY_BOARD_USER_ID);

    await reassignLegacyBoardWork(db, { apply: true, companyId });
    const [moved] = await db.select().from(issues).where(eq(issues.id, openId));
    expect(moved?.assigneeUserId).toBe(JOHN);
    expect(moved?.responsibleUserId).toBe(JOHN);
    expect(moved?.executionState).toEqual(expect.objectContaining({
      currentParticipant: expect.objectContaining({ type: "user", userId: JOHN }),
      returnAssignee: expect.objectContaining({ userId: BEN }),
    }));
    expect((moved?.executionPolicy as typeof policy).stages[0]!.participants).toEqual([
      expect.objectContaining({ type: "user", userId: JOHN }),
    ]);
    const [closed] = await db.select().from(issues).where(eq(issues.id, closedId));
    expect(closed?.assigneeUserId).toBe(LEGACY_BOARD_USER_ID);
    const [ask] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, openId));
    expect(ask?.addresseeUserId).toBe(JOHN);

    const again = await reassignLegacyBoardWork(db, { apply: true, companyId });
    expect(again[0]).toEqual(expect.objectContaining({ issues: [], interactionCount: 0 }));
  });
});
