import { and, eq, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { companies, issueThreadInteractions, issues } from "@greatstone/db";
import { LEGACY_BOARD_USER_ID, primaryOwnerUserId } from "./board-identity.js";

/**
 * One-off clean-up behind `scripts/reassign-local-board-work.ts`: move open
 * work from the legacy `local-board` user to each company's primary owner.
 * Never called by the server. Dry run unless `apply` is set; running it again
 * finds nothing left to move.
 */

const CLOSED_STATUSES = ["done", "cancelled"];

type Principal = { type?: unknown; userId?: unknown; agentId?: unknown; [key: string]: unknown };

export type LegacyBoardReassignmentCompany = {
  companyId: string;
  companyName: string;
  ownerUserId: string | null;
  issues: Array<{ id: string; identifier: string | null }>;
  interactionCount: number;
};

function isLegacyBoardPrincipal(value: unknown): value is Principal {
  return Boolean(value && typeof value === "object"
    && (value as Principal).type === "user"
    && (value as Principal).userId === LEGACY_BOARD_USER_ID);
}

function rebindPrincipal<T>(value: T, ownerId: string): T {
  return isLegacyBoardPrincipal(value) ? ({ ...value, userId: ownerId } as T) : value;
}

function principalKey(value: Principal) {
  return value.type === "agent" ? `agent:${String(value.agentId)}` : `user:${String(value.userId)}`;
}

export function rebindExecutionState(state: unknown, ownerId: string): unknown {
  if (!state || typeof state !== "object") return state;
  const record = state as Record<string, unknown>;
  return {
    ...record,
    currentParticipant: rebindPrincipal(record.currentParticipant, ownerId),
    returnAssignee: rebindPrincipal(record.returnAssignee, ownerId),
  };
}

export function rebindExecutionPolicy(policy: unknown, ownerId: string): unknown {
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
        .map((participant) => rebindPrincipal(participant, ownerId))
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

export async function reassignLegacyBoardWork(
  db: Db,
  options: { apply: boolean; companyId?: string | null },
): Promise<LegacyBoardReassignmentCompany[]> {
  const companyRows = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(options.companyId ? eq(companies.id, options.companyId) : undefined);

  const legacyText = `%"${LEGACY_BOARD_USER_ID}"%`;
  const report: LegacyBoardReassignmentCompany[] = [];
  for (const company of companyRows) {
    const ownerId = await primaryOwnerUserId(db, company.id);
    if (!ownerId) {
      report.push({ companyId: company.id, companyName: company.name, ownerUserId: null, issues: [], interactionCount: 0 });
      continue;
    }
    const openRows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        assigneeUserId: issues.assigneeUserId,
        responsibleUserId: issues.responsibleUserId,
        executionState: issues.executionState,
        executionPolicy: issues.executionPolicy,
      })
      .from(issues)
      .where(and(
        eq(issues.companyId, company.id),
        notInArray(issues.status, CLOSED_STATUSES),
        or(
          eq(issues.assigneeUserId, LEGACY_BOARD_USER_ID),
          eq(issues.responsibleUserId, LEGACY_BOARD_USER_ID),
          sql`${issues.executionState}::text like ${legacyText}`,
          sql`${issues.executionPolicy}::text like ${legacyText}`,
        ),
      ));
    const interactionWhere = and(
      eq(issueThreadInteractions.companyId, company.id),
      eq(issueThreadInteractions.status, "pending"),
      eq(issueThreadInteractions.addresseeUserId, LEGACY_BOARD_USER_ID),
    );
    const interactionRows = await db
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(interactionWhere);

    report.push({
      companyId: company.id,
      companyName: company.name,
      ownerUserId: ownerId,
      issues: openRows.map((row) => ({ id: row.id, identifier: row.identifier })),
      interactionCount: interactionRows.length,
    });
    if (!options.apply || (openRows.length === 0 && interactionRows.length === 0)) continue;

    await db.transaction(async (tx) => {
      const now = new Date();
      for (const row of openRows) {
        await tx.update(issues).set({
          assigneeUserId: row.assigneeUserId === LEGACY_BOARD_USER_ID ? ownerId : row.assigneeUserId,
          responsibleUserId: row.responsibleUserId === LEGACY_BOARD_USER_ID ? ownerId : row.responsibleUserId,
          executionState: rebindExecutionState(row.executionState, ownerId) as typeof row.executionState,
          executionPolicy: rebindExecutionPolicy(row.executionPolicy, ownerId) as typeof row.executionPolicy,
          updatedAt: now,
        }).where(and(eq(issues.companyId, company.id), eq(issues.id, row.id)));
      }
      if (interactionRows.length > 0) {
        await tx.update(issueThreadInteractions).set({ addresseeUserId: ownerId, updatedAt: now }).where(interactionWhere);
      }
    });
  }
  return report;
}
