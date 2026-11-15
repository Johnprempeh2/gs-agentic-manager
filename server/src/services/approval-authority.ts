import { and, asc, eq, ne } from "drizzle-orm";
import { authUsers, companyMemberships, heartbeatRuns, issues, type Db } from "@greatstone/db";
import { forbidden } from "../errors.js";
import { authorizationDeniedDetails, type authorizationService } from "./authorization.js";
import { isActiveCompanyOwner, LEGACY_BOARD_USER_ID } from "./board-identity.js";

type Access = Pick<ReturnType<typeof authorizationService>, "decide">;
type DecideActor = Parameters<Access["decide"]>[0]["actor"];

export const APPROVAL_SELF_DECISION_CODE = "approval_self_decision";

/**
 * A person never approves what they asked for (the owner excepted), and a
 * hire needs the right to create agents, like the hire routes. Every path
 * that approves an approval calls this.
 */
export async function assertCanApproveAsPerson(
  db: Pick<Db, "select">,
  access: Access,
  actor: DecideActor,
  approval: { type: string; companyId: string; requestedByUserId: string | null },
) {
  const userId = actor.userId ?? null;
  if (
    userId &&
    approval.requestedByUserId === userId &&
    actor.source !== "local_implicit" &&
    !(await isActiveCompanyOwner(db, approval.companyId, userId))
  ) {
    throw forbidden("You asked for this, so someone else must approve it.", { code: APPROVAL_SELF_DECISION_CODE });
  }
  if (approval.type === "hire_agent") {
    const decision = await access.decide({
      actor,
      action: "agents:create",
      resource: { type: "company", companyId: approval.companyId },
    });
    if (!decision.allowed) throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  }
}

type Reader = Pick<Db, "select">;

/** The company's owner: the earliest active owner who is a real person. */
export async function companyOwnerUserId(db: Reader, companyId: string): Promise<string | null> {
  const rows = await db
    .select({ userId: companyMemberships.principalId })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.status, "active"),
      eq(companyMemberships.membershipRole, "owner"),
      ne(companyMemberships.principalId, LEGACY_BOARD_USER_ID),
    ))
    .orderBy(asc(companyMemberships.createdAt));
  return rows[0]?.userId ?? null;
}

async function activeRole(db: Reader, companyId: string, userId: string) {
  const [row] = await db
    .select({ role: companyMemberships.membershipRole })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId),
      eq(companyMemberships.status, "active"),
    ));
  return row?.role ?? null;
}

/**
 * Who decides a new approval. Raised by an agent working on a task a person
 * owns or is assigned: that person. Anything else: the owner.
 */
export async function routeApprovalTo(
  db: Reader,
  companyId: string,
  input: { requestedByAgentId?: string | null; issueIds?: string[]; runId?: string | null },
): Promise<string | null> {
  if (input.requestedByAgentId) {
    let issueId = input.issueIds?.[0] ?? null;
    if (!issueId && input.runId) {
      const [run] = await db
        .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, companyId)));
      const snapshotIssue = (run?.contextSnapshot as { issueId?: unknown } | null)?.issueId;
      issueId = typeof snapshotIssue === "string" ? snapshotIssue : null;
    }
    if (issueId) {
      const [issue] = await db
        .select({ assigneeUserId: issues.assigneeUserId, createdByUserId: issues.createdByUserId })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
      const person = issue?.assigneeUserId ?? issue?.createdByUserId ?? null;
      if (person && person !== LEGACY_BOARD_USER_ID) {
        const role = await activeRole(db, companyId, person);
        if (role && role !== "viewer") return person;
      }
    }
  }
  return companyOwnerUserId(db, companyId);
}

/**
 * Types with their own named deciders (the operator, budget approvers, a
 * person holding website:publish or website:commerce): those rules decide,
 * routing does not add to them.
 */
const SELF_ROUTED_TYPES = new Set([
  "budget_override_required",
  "budget_top_up",
  "ai_route_change",
  "website_publish",
  "commerce_refund_request",
  "commerce_publish_request",
  "commerce_change_request",
  "website_access_change",
]);

export const APPROVAL_ROUTED_ELSEWHERE_CODE = "approval_routed_elsewhere";

/**
 * Owners and admins decide anything; anyone else decides only what is routed
 * to them. Rows from before routing (no approver) are for owners and admins.
 */
export async function assertMayDecideRouted(
  db: Reader,
  actor: DecideActor,
  approval: { type: string; companyId: string; approverUserId?: string | null },
) {
  if (SELF_ROUTED_TYPES.has(approval.type)) return;
  if (actor.source === "local_implicit" || actor.isInstanceAdmin) return;
  const userId = actor.userId ?? null;
  if (!userId) throw forbidden("A person decides approvals.");
  if (approval.approverUserId && approval.approverUserId === userId) return;
  const role = await activeRole(db, approval.companyId, userId);
  if (role === "owner" || role === "admin") return;
  throw forbidden("This approval is waiting on someone else. Escalate or ask them.", {
    code: APPROVAL_ROUTED_ELSEWHERE_CODE,
  });
}

/** A person's name for comments and cards; never their id. */
export async function personName(db: Reader, userId: string | null | undefined): Promise<string> {
  if (!userId) return "someone";
  const [row] = await db.select({ name: authUsers.name, email: authUsers.email }).from(authUsers).where(eq(authUsers.id, userId));
  return row?.name?.trim() || row?.email || "someone";
}
