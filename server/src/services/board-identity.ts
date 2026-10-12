import { and, asc, eq, ne } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { companyMemberships } from "@greatstone/db";
import type { DeploymentMode } from "@greatstone/shared";

/**
 * The implicit board actor of `local_trusted` mode. After a switch to
 * `authenticated` mode it is still a company owner, and older work still
 * names it as assignee, reviewer or responsible user, but nobody can sign in
 * as it.
 */
export const LEGACY_BOARD_USER_ID = "local-board";

type DbReader = Pick<Db, "select">;

// Set once at startup from the server config. Tests and anything that never
// sets it keep the `local_trusted` behaviour: `local-board` stays as it is.
let currentDeploymentMode: DeploymentMode = "local_trusted";

export function setBoardIdentityDeploymentMode(mode: DeploymentMode) {
  currentDeploymentMode = mode;
}

export function boardIdentityDeploymentMode(): DeploymentMode {
  return currentDeploymentMode;
}

/** True when the user holds an active owner membership in this company. */
export async function isActiveCompanyOwner(db: DbReader, companyId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId),
      eq(companyMemberships.status, "active"),
      eq(companyMemberships.membershipRole, "owner"),
    ))
    .limit(1);
  return rows.length > 0;
}

/**
 * Every user id the viewer answers for in this company: their own id, plus
 * `local-board` when the viewer is a signed-in active owner of the company.
 * Admins and other members never inherit `local-board`, and ownership of one
 * company never carries to another.
 */
export async function viewerPrincipalUserIds(db: DbReader, companyId: string, viewerUserId: string): Promise<string[]> {
  if (!viewerUserId || viewerUserId === LEGACY_BOARD_USER_ID) return [viewerUserId];
  return (await isActiveCompanyOwner(db, companyId, viewerUserId))
    ? [viewerUserId, LEGACY_BOARD_USER_ID]
    : [viewerUserId];
}

/**
 * Whether the viewer counts as `targetUserId` (the assignee, reviewer,
 * approver or current participant) in this company. The single rule for the
 * `local-board` alias: an exact match, or an active owner of the company
 * standing in for `local-board`.
 */
export async function userMatchesPrincipal(
  db: DbReader,
  companyId: string,
  viewerUserId: string | null | undefined,
  targetUserId: string | null | undefined,
): Promise<boolean> {
  if (!viewerUserId || !targetUserId) return false;
  if (viewerUserId === targetUserId) return true;
  if (targetUserId !== LEGACY_BOARD_USER_ID) return false;
  return isActiveCompanyOwner(db, companyId, viewerUserId);
}

/** The synchronous check once the viewer's ids are loaded. */
export function principalIdsInclude(viewerUserIds: readonly string[], targetUserId: string | null | undefined): boolean {
  return Boolean(targetUserId) && viewerUserIds.includes(targetUserId!);
}

/**
 * The company's primary owner as a real user: the earliest active owner
 * membership that is not `local-board`. Null when there is none.
 */
export async function primaryOwnerUserId(db: DbReader, companyId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: companyMemberships.principalId })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.status, "active"),
      eq(companyMemberships.membershipRole, "owner"),
      ne(companyMemberships.principalId, LEGACY_BOARD_USER_ID),
    ))
    .orderBy(asc(companyMemberships.createdAt), asc(companyMemberships.id))
    .limit(1);
  return row?.userId ?? null;
}

/**
 * A default "the board" user id for new work. In `authenticated` mode a
 * `local-board` default becomes the company's primary owner, so new work goes
 * to someone who can sign in. In `local_trusted` mode, or when the company
 * has no real owner yet, the id is returned unchanged.
 */
export async function bindLegacyBoardUserId(
  db: DbReader,
  companyId: string,
  userId: string | null | undefined,
  mode: DeploymentMode = currentDeploymentMode,
): Promise<string | null> {
  if (!userId) return userId ?? null;
  if (userId !== LEGACY_BOARD_USER_ID || mode !== "authenticated") return userId;
  return (await primaryOwnerUserId(db, companyId)) ?? userId;
}
