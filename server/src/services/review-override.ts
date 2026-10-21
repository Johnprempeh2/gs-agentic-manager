import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@greatstone/db";
import { agents, authUsers } from "@greatstone/db";
import type { IssueExecutionStagePrincipal, PermissionKey } from "@greatstone/shared";
import { forbidden, unprocessable } from "../errors.js";
import { isActiveCompanyOwner, LEGACY_BOARD_USER_ID } from "./board-identity.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";

/**
 * Decide a review stage that waits on someone else. The company owner always
 * holds it; anyone with users:manage_permissions can grant it to other people.
 * People only: agents and agent keys can never use it, even if granted.
 */
export const REVIEW_OVERRIDE_PERMISSION = "reviews:override" satisfies PermissionKey;

/** Extra PATCH /issues/:id fields. Server-only so agent tool schemas never offer them. */
export const issueReviewOverrideFieldsSchema = z.object({
  /** Approve (status done) or request changes (status in_progress) on the waiting reviewer's behalf. */
  reviewOverride: z.boolean().optional(),
  /** Required with reviewOverride: why the override was needed. */
  overrideReason: z.string().max(2000).optional(),
});

export type ReviewOverride = {
  actorUserId: string;
  reviewer: IssueExecutionStagePrincipal;
  outcome: "approved" | "changes_requested";
  reason: string;
};

type ReviewOverrideActor = {
  type: "board" | "agent" | "none";
  userId?: string;
  source?: string;
};

export async function authorizeReviewOverride(input: {
  db: Pick<Db, "select">;
  access: { hasPermission: (companyId: string, principalType: "user", principalId: string, key: PermissionKey) => Promise<boolean> };
  actor: ReviewOverrideActor;
  companyId: string;
  executionState: unknown;
  requestedStatus: unknown;
  reason: unknown;
}): Promise<ReviewOverride | null> {
  const { actor, companyId } = input;
  if (actor.type !== "board" || !actor.userId) {
    throw forbidden("Only a person can approve or send back a review on someone else's behalf. Agents cannot.");
  }
  const userId = actor.userId;
  const allowed =
    actor.source === "local_implicit" ||
    (await isActiveCompanyOwner(input.db, companyId, userId)) ||
    (await input.access.hasPermission(companyId, "user", userId, REVIEW_OVERRIDE_PERMISSION));
  if (!allowed) {
    throw forbidden(
      "Only the company owner, or someone given the right to approve or send back reviews on someone else's behalf, can do this.",
    );
  }
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) throw unprocessable("Give a reason for approving or sending back on the reviewer's behalf.");

  const state = parseIssueExecutionState(input.executionState);
  const reviewer = state?.status === "pending" ? state.currentParticipant : null;
  if (!reviewer) throw unprocessable("No review is waiting on anyone, so there is nothing to decide on their behalf.");
  // Deciding your own review needs no override.
  if (reviewer.type === "user" && reviewer.userId === userId) return null;

  const outcome =
    input.requestedStatus === "done" ? "approved"
    : input.requestedStatus === "in_progress" ? "changes_requested"
    : null;
  if (!outcome) {
    throw unprocessable("A review override approves (status done) or requests changes (status in_progress).");
  }
  return { actorUserId: userId, reviewer, outcome, reason };
}

async function userName(db: Pick<Db, "select">, userId: string | null | undefined) {
  if (!userId) return "someone";
  if (userId === LEGACY_BOARD_USER_ID) return "the board";
  const [row] = await db
    .select({ name: authUsers.name, email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .limit(1);
  return row?.name?.trim() || row?.email || userId;
}

async function principalName(db: Pick<Db, "select">, principal: IssueExecutionStagePrincipal) {
  if (principal.type === "user") return userName(db, principal.userId);
  if (!principal.agentId) return "an agent";
  const [row] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, principal.agentId)).limit(1);
  return row?.name ?? principal.agentId;
}

/** "Approved by John Prempeh (review override, reviewer was Ben Kafui Mensah): reason" */
export async function describeReviewOverride(db: Pick<Db, "select">, override: ReviewOverride): Promise<string> {
  const [actorName, reviewerName] = await Promise.all([
    userName(db, override.actorUserId),
    principalName(db, override.reviewer),
  ]);
  return reviewOverrideText({ outcome: override.outcome, actorName, reviewerName, reason: override.reason });
}

export function reviewOverrideText(input: {
  outcome: ReviewOverride["outcome"];
  actorName: string;
  reviewerName: string;
  reason: string;
}) {
  const verb = input.outcome === "approved" ? "Approved" : "Changes requested";
  return `${verb} by ${input.actorName} (review override, reviewer was ${input.reviewerName}): ${input.reason}`;
}
