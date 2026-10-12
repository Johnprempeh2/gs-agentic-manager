import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { companyMemberships } from "@greatstone/db";
import { reviewEscalationUserId } from "./issue-execution-policy.js";
import { LEGACY_BOARD_USER_ID } from "./board-identity.js";

export { LEGACY_BOARD_USER_ID };

/**
 * The real user a review escalates to (GRE-870). Issues created before the
 * board signed in name the `local-board` sentinel as their responsible user;
 * escalating to it leaves a review no signed-in user can approve. When the
 * company has exactly one active human owner, that owner is the board and
 * gets the review. Otherwise the stored id stays (local_trusted mode, where
 * `local-board` is the real actor, or an ambiguous company).
 *
 * Returns `undefined` when the issue's own escalation id needs no binding.
 */
export async function resolveReviewEscalationUserId(
  db: Db,
  issue: { companyId: string; responsibleUserId?: string | null; createdByUserId?: string | null },
): Promise<string | undefined> {
  if (reviewEscalationUserId(issue) !== LEGACY_BOARD_USER_ID) return undefined;
  const owners = await db
    .select({ userId: companyMemberships.principalId })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.companyId, issue.companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.status, "active"),
      eq(companyMemberships.membershipRole, "owner"),
      ne(companyMemberships.principalId, LEGACY_BOARD_USER_ID),
    ))
    .limit(2);
  return owners.length === 1 ? owners[0]!.userId : undefined;
}
