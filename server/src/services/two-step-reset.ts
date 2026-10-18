import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { authUsers, companyMemberships, instanceUserRoles } from "@greatstone/db";
import { normalizeHumanRole } from "./company-member-roles.js";

/**
 * Who may reset another person's two-step sign-in (lost phone and backup
 * codes). A reset signs the person out and lets them in with the password
 * alone, so it is held to the same bar as removing them, and it never reaches
 * further than the caller's own organisation:
 *
 * - an instance admin may reset anyone but themselves;
 * - a company owner or admin may reset someone below their own role in that
 *   company, when that person belongs to no other organisation and is not an
 *   instance admin.
 */

export type TwoStepResetActor = {
  type: string;
  userId?: string | null;
  source?: string | null;
  isInstanceAdmin?: boolean;
};

export type MemberTwoStepControls = {
  enabled: boolean;
  canReset: boolean;
  resetReason: string | null;
};

type Member = { id: string; principalType: string; principalId: string; membershipRole: string | null; status: string };

const ROLE_RANK: Record<string, number> = { viewer: 1, operator: 2, admin: 3, owner: 4 };

function rank(role: string | null | undefined) {
  return ROLE_RANK[normalizeHumanRole(role, "operator")];
}

type Caller = { kind: "instance_admin" } | { kind: "member"; role: string } | { kind: "none" };

async function resolveCaller(db: Db, actor: TwoStepResetActor, companyId: string): Promise<Caller> {
  if (actor.type !== "board") return { kind: "none" };
  if (actor.source === "local_implicit" || actor.isInstanceAdmin) return { kind: "instance_admin" };
  if (!actor.userId) return { kind: "none" };
  const membership = await db
    .select({ role: companyMemberships.membershipRole, status: companyMemberships.status })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, actor.userId),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (membership?.status !== "active") return { kind: "none" };
  const role = normalizeHumanRole(membership.role, "operator");
  return role === "owner" || role === "admin" ? { kind: "member", role } : { kind: "none" };
}

async function refusal(
  db: Db,
  input: { actor: TwoStepResetActor; companyId: string; member: Member; caller: Caller },
): Promise<string | null> {
  const { actor, companyId, member, caller } = input;
  if (member.principalType !== "user") return "Only people have two-step sign-in.";
  if (actor.userId && member.principalId === actor.userId) {
    return "To change your own two-step sign-in, use your profile.";
  }
  if (caller.kind === "instance_admin") return null;
  if (caller.kind === "none") return "Only a company owner or admin can reset two-step sign-in.";
  if (rank(member.membershipRole) >= rank(caller.role)) {
    return "You can only reset two-step sign-in for people below your role.";
  }
  const targetAdmin = await db
    .select({ id: instanceUserRoles.id })
    .from(instanceUserRoles)
    .where(and(eq(instanceUserRoles.userId, member.principalId), eq(instanceUserRoles.role, "instance_admin")))
    .then((rows) => rows[0] ?? null);
  if (targetAdmin) return "Only an instance admin can reset an instance admin.";
  const elsewhere = await db
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, member.principalId),
        eq(companyMemberships.status, "active"),
        ne(companyMemberships.companyId, companyId),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (elsewhere) return "This person also belongs to another organisation. Ask an instance admin to reset it.";
  return null;
}

export async function twoStepResetRefusal(
  db: Db,
  input: { actor: TwoStepResetActor; companyId: string; member: Member },
): Promise<string | null> {
  const caller = await resolveCaller(db, input.actor, input.companyId);
  return refusal(db, { ...input, caller });
}

/** Per member row: whether two-step sign-in is on and whether this viewer may reset it. */
export async function describeMemberTwoStepControls(
  db: Db,
  input: { actor: TwoStepResetActor; companyId: string; members: Member[] },
): Promise<Map<string, MemberTwoStepControls>> {
  const result = new Map<string, MemberTwoStepControls>();
  const userIds = [...new Set(input.members.filter((m) => m.principalType === "user").map((m) => m.principalId))];
  if (userIds.length === 0) return result;
  const enabledRows = await db
    .select({ id: authUsers.id, enabled: authUsers.twoFactorEnabled })
    .from(authUsers)
    .where(inArray(authUsers.id, userIds));
  const enabledById = new Map(enabledRows.map((row) => [row.id, row.enabled]));
  const caller = await resolveCaller(db, input.actor, input.companyId);
  for (const member of input.members) {
    const enabled = enabledById.get(member.principalId) === true;
    // Only rows with two-step on can be reset; skip the checks for the rest.
    const resetReason = enabled
      ? await refusal(db, { actor: input.actor, companyId: input.companyId, member, caller })
      : "Two-step sign-in is off for this person.";
    result.set(member.id, { enabled, canReset: enabled && !resetReason, resetReason });
  }
  return result;
}
