import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { companies, companyMemberships, instanceUserRoles } from "@greatstone/db";
import type { DeploymentMode } from "@greatstone/shared";
import { ensureHumanRoleDefaultGrants } from "./services/principal-access-compatibility.js";

const LOCAL_BOARD_USER_ID = "local-board";
const CLAIM_TTL_MS = 1000 * 60 * 60 * 24;

type ChallengeStatus = "available" | "claimed" | "expired" | "invalid";

type ClaimChallenge = {
  token: string;
  code: string;
  createdAt: Date;
  expiresAt: Date;
  claimedAt: Date | null;
  claimedByUserId: string | null;
};

let activeChallenge: ClaimChallenge | null = null;

function createChallenge(now = new Date()): ClaimChallenge {
  return {
    token: randomBytes(24).toString("hex"),
    code: randomBytes(12).toString("hex"),
    createdAt: now,
    expiresAt: new Date(now.getTime() + CLAIM_TTL_MS),
    claimedAt: null,
    claimedByUserId: null,
  };
}

function getChallengeStatus(token: string, code: string | undefined): ChallengeStatus {
  if (!activeChallenge) return "invalid";
  if (activeChallenge.token !== token) return "invalid";
  if (activeChallenge.code !== (code ?? "")) return "invalid";
  if (activeChallenge.claimedAt) return "claimed";
  if (activeChallenge.expiresAt.getTime() <= Date.now()) return "expired";
  return "available";
}

export async function initializeBoardClaimChallenge(
  db: Db,
  opts: { deploymentMode: DeploymentMode },
): Promise<void> {
  if (opts.deploymentMode !== "authenticated") {
    activeChallenge = null;
    return;
  }

  const admins = await db
    .select({ userId: instanceUserRoles.userId })
    .from(instanceUserRoles)
    .where(eq(instanceUserRoles.role, "instance_admin"));

  const onlyLocalBoardAdmin = admins.length === 1 && admins[0]?.userId === LOCAL_BOARD_USER_ID;
  if (!onlyLocalBoardAdmin) {
    activeChallenge = null;
    return;
  }

  if (!activeChallenge || activeChallenge.expiresAt.getTime() <= Date.now() || activeChallenge.claimedAt) {
    activeChallenge = createChallenge();
  }
}

export function getBoardClaimWarningUrl(host: string, port: number): string | null {
  if (!activeChallenge) return null;
  if (activeChallenge.claimedAt || activeChallenge.expiresAt.getTime() <= Date.now()) return null;
  const visibleHost = host === "0.0.0.0" ? "localhost" : host;
  return `http://${visibleHost}:${port}/board-claim/${activeChallenge.token}?code=${activeChallenge.code}`;
}

export function inspectBoardClaimChallenge(token: string, code: string | undefined) {
  const status = getChallengeStatus(token, code);
  return {
    status,
    requiresSignIn: true,
    expiresAt: activeChallenge?.expiresAt?.toISOString() ?? null,
    claimedByUserId: activeChallenge?.claimedByUserId ?? null,
  };
}

export async function claimBoardOwnership(
  db: Db,
  opts: { token: string; code: string | undefined; userId: string },
): Promise<{ status: ChallengeStatus; claimedByUserId?: string }> {
  const status = getChallengeStatus(opts.token, opts.code);
  if (status !== "available") return { status };

  const claimedCompanyIds: string[] = [];
  await db.transaction(async (tx) => {
    const existingTargetAdmin = await tx
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, opts.userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null);
    if (!existingTargetAdmin) {
      await tx.insert(instanceUserRoles).values({
        userId: opts.userId,
        role: "instance_admin",
      });
    }

    await tx
      .delete(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")));

    const allCompanies = await tx.select({ id: companies.id }).from(companies);
    for (const company of allCompanies) {
      claimedCompanyIds.push(company.id);
      const existing = await tx
        .select({ id: companyMemberships.id, status: companyMemberships.status })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, company.id),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, opts.userId),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!existing) {
        await tx.insert(companyMemberships).values({
          companyId: company.id,
          principalType: "user",
          principalId: opts.userId,
          status: "active",
          membershipRole: "owner",
        });
        continue;
      }

      if (existing.status !== "active") {
        await tx
          .update(companyMemberships)
          .set({ status: "active", membershipRole: "owner", updatedAt: new Date() })
          .where(eq(companyMemberships.id, existing.id));
      }
    }

    // Personal accounts connected before sign-in belong to the board identity.
    // Hand them and their defaults to the claimer, or every agent would need
    // its accounts connected again. A connection the claimer already holds
    // keeps theirs.
    await tx.execute(sql`
      UPDATE connection_grants g SET subject_user_id = ${opts.userId}, updated_at = now()
      WHERE g.kind = 'user' AND g.subject_user_id = ${LOCAL_BOARD_USER_ID}
        AND NOT EXISTS (SELECT 1 FROM connection_grants o WHERE o.connection_id = g.connection_id AND o.subject_user_id = ${opts.userId})`);
    // The stored key belongs to whoever owns the grant (credential() checks
    // it), and the grant's creator is who may reconnect it: move both, or the
    // handed-over account stops resolving and cannot be repaired.
    await tx.execute(sql`
      UPDATE company_secrets s SET owner_user_id = ${opts.userId}, updated_at = now()
      WHERE s.scope = 'user' AND s.owner_user_id = ${LOCAL_BOARD_USER_ID}
        AND EXISTS (
          SELECT 1 FROM connection_grants g, jsonb_array_elements(g.credential_secret_refs) r
          WHERE g.kind = 'user' AND g.subject_user_id = ${opts.userId} AND (r->>'secretId')::uuid = s.id
        )`);
    await tx.execute(sql`
      UPDATE connection_grants SET created_by_user_id = ${opts.userId}, updated_at = now()
      WHERE kind = 'user' AND subject_user_id = ${opts.userId} AND created_by_user_id = ${LOCAL_BOARD_USER_ID}`);
    for (const [table, sameSlot] of [
      [sql`ai_provider_defaults`, sql`o.provider = d.provider`],
      [sql`ai_connection_defaults`, sql`o.provider = d.provider AND o.method = d.method`],
    ]) {
      await tx.execute(sql`
        UPDATE ${table} d SET user_id = ${opts.userId}, updated_at = now()
        WHERE d.user_id = ${LOCAL_BOARD_USER_ID}
          AND EXISTS (SELECT 1 FROM connection_grants g WHERE g.id = d.grant_id AND g.subject_user_id = ${opts.userId})
          AND NOT EXISTS (SELECT 1 FROM ${table} o WHERE o.company_id = d.company_id AND o.user_id = ${opts.userId} AND ${sameSlot})`);
    }
  });

  for (const companyId of claimedCompanyIds) {
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: opts.userId,
      membershipRole: "owner",
      grantedByUserId: opts.userId,
    });
  }

  if (activeChallenge && activeChallenge.token === opts.token) {
    activeChallenge.claimedAt = new Date();
    activeChallenge.claimedByUserId = opts.userId;
  }

  return { status: "claimed", claimedByUserId: opts.userId };
}
