import { and, desc, eq, isNull, ne } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  activityLog,
  authAccounts,
  authSessions,
  boardApiKeys,
  companyMemberships,
  instanceUserRoles,
} from "@greatstone/db";
import type { DeploymentMode } from "@greatstone/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { LEGACY_BOARD_USER_ID, isActiveCompanyOwner } from "./board-identity.js";
import {
  findLegacyBoardWork,
  moveLegacyBoardWork,
  type LegacyBoardOpenIssue,
  type LegacyBoardRoutine,
} from "./legacy-board-reassignment.js";

/**
 * Retire (and restore) the legacy `local-board` account in one company, for
 * an instance that switched from `local_trusted` to `authenticated` mode.
 *
 * Retire moves local-board's open work and its routines (any status) to the
 * calling owner (reusing `legacy-board-reassignment.ts`), suspends its company membership (the role
 * stays `owner`: suspension needs no role change, and `isActiveCompanyOwner`
 * already ignores a suspended owner), revokes its board API keys and ends its
 * sign-in sessions. Comments, approvals and activity it authored are not
 * touched, and the owner alias in `board-identity.ts` keeps working for
 * historical items because it depends on the viewer's ownership, not on
 * local-board's membership.
 *
 * The instance admin role local-board was given in `local_trusted` mode is
 * kept when local-board has no sign-in account (the normal case: it never had
 * a password), because with its keys revoked and sessions ended nothing can
 * act as it. Only when a sign-in account exists is the role removed, so a
 * fresh sign-in could not act as an instance admin; restore gives it back.
 *
 * Board API keys and sessions belong to the user, not to one company, so
 * revoking them is instance-wide.
 */

export const LEGACY_BOARD_RETIRED_ACTION = "company_member.legacy_board_retired";
export const LEGACY_BOARD_RESTORED_ACTION = "company_member.legacy_board_restored";

export type LegacyBoardActor = {
  type: string;
  userId?: string | null;
  source?: string | null;
};

export type LegacyBoardInstanceAdminChange = "not_held" | "kept" | "removed";

export type LegacyBoardRetirementReport = {
  dryRun: boolean;
  companyId: string;
  legacyUserId: typeof LEGACY_BOARD_USER_ID;
  membershipId: string;
  moveToUserId: string;
  issueCount: number;
  issues: LegacyBoardOpenIssue[];
  pendingRequestCount: number;
  routineCount: number;
  routines: LegacyBoardRoutine[];
  switchOff: {
    membershipStatus: { from: string; to: "suspended" };
    boardKeysRevoked: number;
    sessionsEnded: number;
    instanceAdmin: LegacyBoardInstanceAdminChange;
  };
};

export type LegacyBoardRestoreReport = {
  companyId: string;
  legacyUserId: typeof LEGACY_BOARD_USER_ID;
  membershipId: string;
  membershipStatus: { from: string; to: "active" };
  instanceAdminRestored: boolean;
};

export type LegacyBoardControls = {
  status: string;
  canRetire: boolean;
  canRestore: boolean;
};

const TRUSTED_MODE_MESSAGE =
  "The legacy local-board account can only be retired or restored in authenticated mode. In local_trusted mode it is the board itself, so it stays.";

/** The checks every retire and restore call makes before reading anything else. */
export async function assertCanManageLegacyBoard(
  db: Pick<Db, "select">,
  input: { companyId: string; deploymentMode: DeploymentMode; actor: LegacyBoardActor },
): Promise<string> {
  if (input.deploymentMode !== "authenticated") throw conflict(TRUSTED_MODE_MESSAGE);
  const { actor } = input;
  if (actor.type !== "board" || (actor.source !== "session" && actor.source !== "board_key") || !actor.userId) {
    throw forbidden("Sign in as a company owner to retire or restore the legacy board account.");
  }
  if (actor.userId === LEGACY_BOARD_USER_ID) {
    throw forbidden("The legacy board account cannot retire or restore itself.");
  }
  if (!(await isActiveCompanyOwner(db, input.companyId, actor.userId))) {
    throw forbidden("Only an active company owner can retire or restore the legacy board account.");
  }
  return actor.userId;
}

async function loadLegacyMembership(db: Pick<Db, "select">, companyId: string, forUpdate: boolean) {
  const query = db
    .select({
      id: companyMemberships.id,
      status: companyMemberships.status,
      membershipRole: companyMemberships.membershipRole,
    })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, LEGACY_BOARD_USER_ID),
    ))
    .limit(1);
  const [row] = forUpdate ? await query.for("update") : await query;
  if (!row) throw notFound("This company has no legacy local-board membership.");
  return row;
}

async function countOtherActiveOwners(db: Pick<Db, "select">, companyId: string) {
  const rows = await db
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.status, "active"),
      eq(companyMemberships.membershipRole, "owner"),
      ne(companyMemberships.principalId, LEGACY_BOARD_USER_ID),
    ));
  return rows.length;
}

async function loadCredentialState(db: Pick<Db, "select">) {
  // One query at a time: this also runs inside the retire transaction.
  const keys = await db.select({ id: boardApiKeys.id }).from(boardApiKeys)
    .where(and(eq(boardApiKeys.userId, LEGACY_BOARD_USER_ID), isNull(boardApiKeys.revokedAt)));
  const sessions = await db.select({ id: authSessions.id }).from(authSessions)
    .where(eq(authSessions.userId, LEGACY_BOARD_USER_ID));
  const accounts = await db.select({ id: authAccounts.id }).from(authAccounts)
    .where(eq(authAccounts.userId, LEGACY_BOARD_USER_ID));
  const adminRoles = await db.select({ id: instanceUserRoles.id }).from(instanceUserRoles)
    .where(and(eq(instanceUserRoles.userId, LEGACY_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")));
  const instanceAdmin: LegacyBoardInstanceAdminChange = adminRoles.length === 0
    ? "not_held"
    : accounts.length > 0 ? "removed" : "kept";
  return { boardKeyCount: keys.length, sessionCount: sessions.length, instanceAdmin };
}

async function buildReport(
  db: Pick<Db, "select">,
  companyId: string,
  moveToUserId: string,
  membership: { id: string; status: string },
  dryRun: boolean,
) {
  if (membership.status !== "active") {
    throw conflict(`The legacy local-board account is already ${membership.status}. Restore it before retiring it again.`);
  }
  if ((await countOtherActiveOwners(db, companyId)) === 0) {
    throw conflict("Retiring the legacy local-board account would leave this company with no active owner.");
  }
  const work = await findLegacyBoardWork(db, companyId);
  const credentials = await loadCredentialState(db);
  const report: LegacyBoardRetirementReport = {
    dryRun,
    companyId,
    legacyUserId: LEGACY_BOARD_USER_ID,
    membershipId: membership.id,
    moveToUserId,
    issueCount: work.issues.length,
    issues: work.issues.map(({ id, identifier, title, roles }) => ({ id, identifier, title, roles })),
    pendingRequestCount: work.interactionIds.length,
    routineCount: work.routines.length,
    routines: work.routines.map(({ id, title, status }) => ({ id, title, status })),
    switchOff: {
      membershipStatus: { from: membership.status, to: "suspended" },
      boardKeysRevoked: credentials.boardKeyCount,
      sessionsEnded: credentials.sessionCount,
      instanceAdmin: credentials.instanceAdmin,
    },
  };
  return { report, work };
}

/**
 * Dry run (no writes) or retire. The caller must already have passed
 * `assertCanManageLegacyBoard`; `ownerUserId` is the owner it returned.
 */
export async function retireLegacyBoard(
  db: Db,
  input: { companyId: string; ownerUserId: string; dryRun: boolean },
): Promise<LegacyBoardRetirementReport> {
  const { companyId, ownerUserId } = input;
  if (input.dryRun) {
    const membership = await loadLegacyMembership(db, companyId, false);
    return (await buildReport(db, companyId, ownerUserId, membership, true)).report;
  }

  const publications: ActivityPublication[] = [];
  const report = await db.transaction(async (tx) => {
    const membership = await loadLegacyMembership(tx, companyId, true);
    const { report, work } = await buildReport(tx, companyId, ownerUserId, membership, false);
    const now = new Date();

    await moveLegacyBoardWork(tx, companyId, ownerUserId, work);
    await tx.update(companyMemberships)
      .set({ status: "suspended", updatedAt: now })
      .where(eq(companyMemberships.id, membership.id));
    await tx.update(boardApiKeys)
      .set({ revokedAt: now })
      .where(and(eq(boardApiKeys.userId, LEGACY_BOARD_USER_ID), isNull(boardApiKeys.revokedAt)));
    await tx.delete(authSessions).where(eq(authSessions.userId, LEGACY_BOARD_USER_ID));
    if (report.switchOff.instanceAdmin === "removed") {
      await tx.delete(instanceUserRoles).where(and(
        eq(instanceUserRoles.userId, LEGACY_BOARD_USER_ID),
        eq(instanceUserRoles.role, "instance_admin"),
      ));
    }

    await logActivity(tx as unknown as Db, {
      companyId,
      actorType: "user",
      actorId: ownerUserId,
      action: LEGACY_BOARD_RETIRED_ACTION,
      entityType: "company_membership",
      entityId: membership.id,
      details: {
        principalId: LEGACY_BOARD_USER_ID,
        movedTo: ownerUserId,
        issueCount: report.issueCount,
        issueIdentifiers: report.issues.map((issue) => issue.identifier ?? issue.id),
        pendingRequestCount: report.pendingRequestCount,
        routineCount: report.routineCount,
        routineIds: report.routines.map((routine) => routine.id),
        routineTitles: report.routines.map((routine) => routine.title),
        boardKeysRevoked: report.switchOff.boardKeysRevoked,
        sessionsEnded: report.switchOff.sessionsEnded,
        instanceAdmin: report.switchOff.instanceAdmin,
        instanceAdminRemoved: report.switchOff.instanceAdmin === "removed",
      },
    }, publications);
    return report;
  });
  for (const publication of publications) publishActivity(publication);
  return report;
}

/**
 * Reverse the membership change (and the instance admin removal, if retire
 * made one). Moved work, revoked keys and ended sessions stay as they are.
 */
export async function restoreLegacyBoard(
  db: Db,
  input: { companyId: string; ownerUserId: string },
): Promise<LegacyBoardRestoreReport> {
  const { companyId, ownerUserId } = input;
  const publications: ActivityPublication[] = [];
  const report = await db.transaction(async (tx): Promise<LegacyBoardRestoreReport> => {
    const membership = await loadLegacyMembership(tx, companyId, true);
    if (membership.status !== "suspended") {
      throw conflict(`The legacy local-board account is ${membership.status}, not retired, so there is nothing to restore.`);
    }
    const [lastRetire] = await tx
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, LEGACY_BOARD_RETIRED_ACTION),
        eq(activityLog.entityId, membership.id),
      ))
      .orderBy(desc(activityLog.createdAt))
      .limit(1);
    const retireRemovedAdmin = (lastRetire?.details as Record<string, unknown> | null)?.instanceAdminRemoved === true;
    let instanceAdminRestored = false;
    if (retireRemovedAdmin) {
      const existing = await tx.select({ id: instanceUserRoles.id }).from(instanceUserRoles).where(and(
        eq(instanceUserRoles.userId, LEGACY_BOARD_USER_ID),
        eq(instanceUserRoles.role, "instance_admin"),
      ));
      if (existing.length === 0) {
        await tx.insert(instanceUserRoles).values({ userId: LEGACY_BOARD_USER_ID, role: "instance_admin" });
        instanceAdminRestored = true;
      }
    }
    await tx.update(companyMemberships)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(companyMemberships.id, membership.id));
    await logActivity(tx as unknown as Db, {
      companyId,
      actorType: "user",
      actorId: ownerUserId,
      action: LEGACY_BOARD_RESTORED_ACTION,
      entityType: "company_membership",
      entityId: membership.id,
      details: { principalId: LEGACY_BOARD_USER_ID, instanceAdminRestored },
    }, publications);
    return {
      companyId,
      legacyUserId: LEGACY_BOARD_USER_ID,
      membershipId: membership.id,
      membershipStatus: { from: membership.status, to: "active" },
      instanceAdminRestored,
    };
  });
  for (const publication of publications) publishActivity(publication);
  return report;
}

/**
 * What the Members page may offer for the local-board row: nothing outside
 * authenticated mode, and retire or restore only to an active owner who is
 * not local-board.
 */
export async function describeLegacyBoardControls(
  db: Pick<Db, "select">,
  input: {
    companyId: string;
    deploymentMode: DeploymentMode;
    actor: LegacyBoardActor;
    legacyMembershipStatus: string | null;
  },
): Promise<LegacyBoardControls | null> {
  if (input.deploymentMode !== "authenticated" || !input.legacyMembershipStatus) return null;
  let allowed = false;
  try {
    await assertCanManageLegacyBoard(db, input);
    allowed = true;
  } catch {
    allowed = false;
  }
  return {
    status: input.legacyMembershipStatus,
    canRetire: allowed && input.legacyMembershipStatus === "active",
    canRestore: allowed && input.legacyMembershipStatus === "suspended",
  };
}
