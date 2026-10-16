import { and, desc, eq, isNull, notInArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@greatstone/db";
import { issueRecoveryActions, issues } from "@greatstone/db";
import type { IssueStatus, RecoveryHold, RecoveryHoldList } from "@greatstone/shared";
import { executionBlockerPredicate } from "./execution-blocker.js";

/** Holds read per list; the oldest beyond this wait for the next clear-up. */
export const RECOVERY_HOLD_LIST_LIMIT = 200;

/** Every open task in the company that is held until someone records what its last run did. */
export async function listRecoveryHolds(db: Db, companyId: string): Promise<RecoveryHoldList> {
  const rows = await db
    .select({
      action: issueRecoveryActions,
      issueId: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
    })
    .from(issueRecoveryActions)
    .innerJoin(
      issues,
      and(eq(issues.id, issueRecoveryActions.sourceIssueId), eq(issues.companyId, issueRecoveryActions.companyId)),
    )
    .where(
      and(
        eq(issueRecoveryActions.companyId, companyId),
        executionBlockerPredicate(),
        isNull(issues.hiddenAt),
        notInArray(issues.status, ["done", "cancelled"]),
      ),
    )
    .orderBy(desc(issueRecoveryActions.updatedAt), desc(issueRecoveryActions.id))
    .limit(RECOVERY_HOLD_LIST_LIMIT * 2);

  const seen = new Set<string>();
  const holds: RecoveryHold[] = [];
  for (const row of rows) {
    // The newest hold on a task is the one that blocks it.
    if (seen.has(row.issueId)) continue;
    seen.add(row.issueId);
    const evidence = row.action.evidence ?? {};
    const runId = z.string().guid().safeParse(evidence.runId ?? evidence.sourceRunId);
    holds.push({
      issue: {
        id: row.issueId,
        identifier: row.identifier,
        title: row.title,
        status: row.status as IssueStatus,
      },
      assigneeAgentId: row.assigneeAgentId,
      recoveryActionId: row.action.id,
      runId: runId.success ? runId.data : null,
      cause: row.action.cause,
      nextAction: row.action.nextAction,
      heldSince: row.action.createdAt.toISOString(),
      needsWorkspaceRepair: evidence.workspaceRestoreFailure != null,
    });
    if (holds.length >= RECOVERY_HOLD_LIST_LIMIT) break;
  }
  holds.sort((a, b) => a.heldSince.localeCompare(b.heldSince));
  return { holds };
}
