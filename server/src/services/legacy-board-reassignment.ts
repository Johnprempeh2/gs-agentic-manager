import { and, asc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { companies, issueThreadInteractions, issues, routineRevisions, routines } from "@greatstone/db";
import { LEGACY_BOARD_USER_ID, primaryOwnerUserId } from "./board-identity.js";

/**
 * Move open work from the legacy `local-board` user to a real owner. Used by
 * the one-off `scripts/reassign-local-board-work.ts` (each company's primary
 * owner, dry run unless `apply` is set) and by the retire route in
 * `legacy-board-retirement.ts` (the calling owner, in its own transaction).
 * Running it again finds nothing left to move.
 *
 * The issue half is written for any user: the member handover
 * (`member-handover.ts`) uses `findOpenWorkForUser` and the `fromUserId`
 * argument of the rebind helpers to move a departing person's work.
 *
 * Routines are moved too, whatever their status: `routines.responsibleUserId`
 * and the latest revision's responsible user (column and snapshot), because a
 * routine fires new work as that user.
 */

const CLOSED_STATUSES = ["done", "cancelled"];

type Principal = { type?: unknown; userId?: unknown; agentId?: unknown; [key: string]: unknown };

export type LegacyBoardReassignmentCompany = {
  companyId: string;
  companyName: string;
  ownerUserId: string | null;
  issues: Array<{ id: string; identifier: string | null }>;
  interactionCount: number;
  routines: LegacyBoardRoutine[];
};

export function isUserPrincipal(value: unknown, userId: string): value is Principal {
  return Boolean(value && typeof value === "object"
    && (value as Principal).type === "user"
    && (value as Principal).userId === userId);
}

function isLegacyBoardPrincipal(value: unknown): value is Principal {
  return isUserPrincipal(value, LEGACY_BOARD_USER_ID);
}

function rebindPrincipal<T>(value: T, ownerId: string, fromUserId: string): T {
  return isUserPrincipal(value, fromUserId) ? ({ ...value, userId: ownerId } as T) : value;
}

function principalKey(value: Principal) {
  return value.type === "agent" ? `agent:${String(value.agentId)}` : `user:${String(value.userId)}`;
}

export function rebindExecutionState(state: unknown, ownerId: string, fromUserId: string = LEGACY_BOARD_USER_ID): unknown {
  if (!state || typeof state !== "object") return state;
  const record = state as Record<string, unknown>;
  return {
    ...record,
    currentParticipant: rebindPrincipal(record.currentParticipant, ownerId, fromUserId),
    returnAssignee: rebindPrincipal(record.returnAssignee, ownerId, fromUserId),
  };
}

export function rebindExecutionPolicy(policy: unknown, ownerId: string, fromUserId: string = LEGACY_BOARD_USER_ID): unknown {
  if (!policy || typeof policy !== "object") return policy;
  const record = policy as Record<string, unknown>;
  if (!Array.isArray(record.stages)) return policy;
  return {
    ...record,
    stages: record.stages.map((stage) => {
      if (!stage || typeof stage !== "object") return stage;
      const stageRecord = stage as Record<string, unknown>;
      if (!Array.isArray(stageRecord.participants)) return stage;
      // The owner may already be a participant: keep one entry per principal.
      const seen = new Set<string>();
      const participants = (stageRecord.participants as Principal[])
        .map((participant) => rebindPrincipal(participant, ownerId, fromUserId))
        .filter((participant) => {
          const key = principalKey(participant);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      return { ...stageRecord, participants };
    }),
  };
}

/** How an open issue still names `local-board`. */
export type LegacyBoardIssueRole =
  | "assignee"
  | "responsible"
  | "current_reviewer"
  | "return_assignee"
  | "review_participant";

export type LegacyBoardOpenIssue = {
  id: string;
  identifier: string | null;
  title: string;
  roles: LegacyBoardIssueRole[];
};

/** A routine (any status) whose responsible user, or latest revision's, is `local-board`. */
export type LegacyBoardRoutine = {
  id: string;
  title: string;
  status: string;
};

/** The open work in one company that still names `local-board`. */
export type LegacyBoardWork = {
  issues: Array<LegacyBoardOpenIssue & {
    assigneeUserId: string | null;
    responsibleUserId: string | null;
    executionState: unknown;
    executionPolicy: unknown;
  }>;
  interactionIds: string[];
  routines: Array<LegacyBoardRoutine & {
    responsibleUserId: string | null;
    latestRevisionId: string | null;
  }>;
};

type DbReader = Pick<Db, "select">;
type DbWriter = Pick<Db, "select" | "update">;

/** The open issues and pending asks in one company that name a user. */
export type OpenWorkForUser = {
  issues: Array<LegacyBoardOpenIssue & {
    status: string;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
    responsibleUserId: string | null;
    conversationUserId: string | null;
    executionState: unknown;
    executionPolicy: unknown;
  }>;
  interactionIds: string[];
};

function issueRolesForUser(row: {
  assigneeUserId: string | null;
  responsibleUserId: string | null;
  executionState: unknown;
  executionPolicy: unknown;
}, userId: string): LegacyBoardIssueRole[] {
  const roles: LegacyBoardIssueRole[] = [];
  if (row.assigneeUserId === userId) roles.push("assignee");
  if (row.responsibleUserId === userId) roles.push("responsible");
  const state = row.executionState && typeof row.executionState === "object"
    ? row.executionState as Record<string, unknown>
    : null;
  if (state && isUserPrincipal(state.currentParticipant, userId)) roles.push("current_reviewer");
  if (state && isUserPrincipal(state.returnAssignee, userId)) roles.push("return_assignee");
  const policy = row.executionPolicy && typeof row.executionPolicy === "object"
    ? row.executionPolicy as Record<string, unknown>
    : null;
  const stages = Array.isArray(policy?.stages) ? policy.stages : [];
  const inPolicy = stages.some((stage) => {
    const participants = stage && typeof stage === "object" ? (stage as Record<string, unknown>).participants : null;
    return Array.isArray(participants) && participants.some((participant) => isUserPrincipal(participant, userId));
  });
  if (inPolicy) roles.push("review_participant");
  return roles;
}

/** Read-only: the open issues and pending asks in a company that name `userId`. */
export async function findOpenWorkForUser(db: DbReader, companyId: string, userId: string): Promise<OpenWorkForUser> {
  const userText = `%${JSON.stringify(userId)}%`;
  const openRows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
      responsibleUserId: issues.responsibleUserId,
      conversationUserId: issues.conversationUserId,
      executionState: issues.executionState,
      executionPolicy: issues.executionPolicy,
    })
    .from(issues)
    .where(and(
      eq(issues.companyId, companyId),
      notInArray(issues.status, CLOSED_STATUSES),
      or(
        eq(issues.assigneeUserId, userId),
        eq(issues.responsibleUserId, userId),
        sql`${issues.executionState}::text like ${userText}`,
        sql`${issues.executionPolicy}::text like ${userText}`,
      ),
    ))
    .orderBy(asc(issues.issueNumber), asc(issues.id));
  const interactionRows = await db
    .select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .where(and(
      eq(issueThreadInteractions.companyId, companyId),
      eq(issueThreadInteractions.status, "pending"),
      eq(issueThreadInteractions.addresseeUserId, userId),
    ));
  return {
    // The text match can hit a mention that is not a principal; keep only
    // issues where the user really holds a role.
    issues: openRows
      .map((row) => ({ ...row, roles: issueRolesForUser(row, userId) }))
      .filter((row) => row.roles.length > 0),
    interactionIds: interactionRows.map((row) => row.id),
  };
}

function legacyBoardIssueRoles(row: {
  assigneeUserId: string | null;
  responsibleUserId: string | null;
  executionState: unknown;
  executionPolicy: unknown;
}): LegacyBoardIssueRole[] {
  const roles: LegacyBoardIssueRole[] = [];
  if (row.assigneeUserId === LEGACY_BOARD_USER_ID) roles.push("assignee");
  if (row.responsibleUserId === LEGACY_BOARD_USER_ID) roles.push("responsible");
  const state = row.executionState && typeof row.executionState === "object"
    ? row.executionState as Record<string, unknown>
    : null;
  if (state && isLegacyBoardPrincipal(state.currentParticipant)) roles.push("current_reviewer");
  if (state && isLegacyBoardPrincipal(state.returnAssignee)) roles.push("return_assignee");
  const policy = row.executionPolicy && typeof row.executionPolicy === "object"
    ? row.executionPolicy as Record<string, unknown>
    : null;
  const stages = Array.isArray(policy?.stages) ? policy.stages : [];
  const inPolicy = stages.some((stage) => {
    const participants = stage && typeof stage === "object" ? (stage as Record<string, unknown>).participants : null;
    return Array.isArray(participants) && participants.some(isLegacyBoardPrincipal);
  });
  if (inPolicy) roles.push("review_participant");
  return roles;
}

/** Read-only: the open issues and pending asks in a company that name `local-board`. */
export async function findLegacyBoardWork(db: DbReader, companyId: string): Promise<LegacyBoardWork> {
  const legacyText = `%"${LEGACY_BOARD_USER_ID}"%`;
  const openRows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      assigneeUserId: issues.assigneeUserId,
      responsibleUserId: issues.responsibleUserId,
      executionState: issues.executionState,
      executionPolicy: issues.executionPolicy,
    })
    .from(issues)
    .where(and(
      eq(issues.companyId, companyId),
      notInArray(issues.status, CLOSED_STATUSES),
      or(
        eq(issues.assigneeUserId, LEGACY_BOARD_USER_ID),
        eq(issues.responsibleUserId, LEGACY_BOARD_USER_ID),
        sql`${issues.executionState}::text like ${legacyText}`,
        sql`${issues.executionPolicy}::text like ${legacyText}`,
      ),
    ))
    .orderBy(asc(issues.issueNumber), asc(issues.id));
  const interactionRows = await db
    .select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .where(and(
      eq(issueThreadInteractions.companyId, companyId),
      eq(issueThreadInteractions.status, "pending"),
      eq(issueThreadInteractions.addresseeUserId, LEGACY_BOARD_USER_ID),
    ));
  // Routines fire new work as their responsible user, so every routine counts
  // whatever its status: a paused routine resumed later must not bring
  // local-board back. A routine fires as its latest revision's responsible
  // user first (column, then snapshot), so that revision is checked too.
  const routineRows = await db
    .select({
      id: routines.id,
      title: routines.title,
      status: routines.status,
      responsibleUserId: routines.responsibleUserId,
      latestRevisionId: routines.latestRevisionId,
      revisionResponsibleUserId: routineRevisions.responsibleUserId,
      revisionSnapshotResponsibleUserId: sql<string | null>`${routineRevisions.snapshot} -> 'routine' ->> 'responsibleUserId'`,
    })
    .from(routines)
    .leftJoin(routineRevisions, and(
      eq(routineRevisions.id, routines.latestRevisionId),
      eq(routineRevisions.companyId, routines.companyId),
    ))
    .where(and(
      eq(routines.companyId, companyId),
      or(
        eq(routines.responsibleUserId, LEGACY_BOARD_USER_ID),
        eq(routineRevisions.responsibleUserId, LEGACY_BOARD_USER_ID),
        sql`${routineRevisions.snapshot} -> 'routine' ->> 'responsibleUserId' = ${LEGACY_BOARD_USER_ID}`,
      ),
    ))
    .orderBy(asc(routines.title), asc(routines.id));
  return {
    // The text match can hit a mention that is not a principal; keep only
    // issues where local-board really holds a role.
    issues: openRows
      .map((row) => ({ ...row, roles: legacyBoardIssueRoles(row) }))
      .filter((row) => row.roles.length > 0),
    interactionIds: interactionRows.map((row) => row.id),
    routines: routineRows.map(({ id, title, status, responsibleUserId, latestRevisionId }) => ({
      id,
      title,
      status,
      responsibleUserId,
      latestRevisionId,
    })),
  };
}

/** Point a revision snapshot's responsible user at `ownerId` when it names `local-board`. */
export function rebindRoutineSnapshot<T>(snapshot: T, ownerId: string): T {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const record = snapshot as Record<string, unknown>;
  const routine = record.routine;
  if (!routine || typeof routine !== "object") return snapshot;
  if ((routine as Record<string, unknown>).responsibleUserId !== LEGACY_BOARD_USER_ID) return snapshot;
  return { ...record, routine: { ...(routine as Record<string, unknown>), responsibleUserId: ownerId } } as T;
}

/** Write half of the move: rebind the found work to `ownerId`. Run it inside a transaction. */
export async function moveLegacyBoardWork(
  tx: DbWriter,
  companyId: string,
  ownerId: string,
  work: LegacyBoardWork,
): Promise<void> {
  const now = new Date();
  for (const row of work.issues) {
    await tx.update(issues).set({
      assigneeUserId: row.assigneeUserId === LEGACY_BOARD_USER_ID ? ownerId : row.assigneeUserId,
      responsibleUserId: row.responsibleUserId === LEGACY_BOARD_USER_ID ? ownerId : row.responsibleUserId,
      executionState: rebindExecutionState(row.executionState, ownerId) as never,
      executionPolicy: rebindExecutionPolicy(row.executionPolicy, ownerId) as never,
      updatedAt: now,
    }).where(and(eq(issues.companyId, companyId), eq(issues.id, row.id)));
  }
  if (work.interactionIds.length > 0) {
    await tx.update(issueThreadInteractions).set({ addresseeUserId: ownerId, updatedAt: now }).where(and(
      eq(issueThreadInteractions.companyId, companyId),
      eq(issueThreadInteractions.status, "pending"),
      eq(issueThreadInteractions.addresseeUserId, LEGACY_BOARD_USER_ID),
      inArray(issueThreadInteractions.id, work.interactionIds),
    ));
  }
  for (const routine of work.routines) {
    // Only local-board is replaced; a routine already on a real user keeps it.
    await tx.update(routines).set({ responsibleUserId: ownerId, updatedAt: now }).where(and(
      eq(routines.companyId, companyId),
      eq(routines.id, routine.id),
      eq(routines.responsibleUserId, LEGACY_BOARD_USER_ID),
    ));
    if (!routine.latestRevisionId) continue;
    const [revision] = await tx
      .select({ responsibleUserId: routineRevisions.responsibleUserId, snapshot: routineRevisions.snapshot })
      .from(routineRevisions)
      .where(and(
        eq(routineRevisions.companyId, companyId),
        eq(routineRevisions.routineId, routine.id),
        eq(routineRevisions.id, routine.latestRevisionId),
      ));
    if (!revision) continue;
    const snapshot = rebindRoutineSnapshot(revision.snapshot, ownerId);
    const columnIsLegacy = revision.responsibleUserId === LEGACY_BOARD_USER_ID;
    if (!columnIsLegacy && snapshot === revision.snapshot) continue;
    await tx.update(routineRevisions).set({
      responsibleUserId: columnIsLegacy ? ownerId : revision.responsibleUserId,
      snapshot,
    }).where(and(
      eq(routineRevisions.companyId, companyId),
      eq(routineRevisions.id, routine.latestRevisionId),
    ));
  }
}

export async function reassignLegacyBoardWork(
  db: Db,
  options: { apply: boolean; companyId?: string | null },
): Promise<LegacyBoardReassignmentCompany[]> {
  const companyRows = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(options.companyId ? eq(companies.id, options.companyId) : undefined);

  const report: LegacyBoardReassignmentCompany[] = [];
  for (const company of companyRows) {
    const ownerId = await primaryOwnerUserId(db, company.id);
    if (!ownerId) {
      report.push({ companyId: company.id, companyName: company.name, ownerUserId: null, issues: [], interactionCount: 0, routines: [] });
      continue;
    }
    const work = await findLegacyBoardWork(db, company.id);
    report.push({
      companyId: company.id,
      companyName: company.name,
      ownerUserId: ownerId,
      issues: work.issues.map((row) => ({ id: row.id, identifier: row.identifier })),
      interactionCount: work.interactionIds.length,
      routines: work.routines.map(({ id, title, status }) => ({ id, title, status })),
    });
    if (
      !options.apply
      || (work.issues.length === 0 && work.interactionIds.length === 0 && work.routines.length === 0)
    ) continue;

    await db.transaction(async (tx) => {
      await moveLegacyBoardWork(tx, company.id, ownerId, work);
    });
  }
  return report;
}
