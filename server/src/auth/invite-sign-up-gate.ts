/**
 * Invite-backed sign-up while public sign-up is closed.
 *
 * With `authDisableSignUp` set, nobody may create an account through
 * `POST /api/auth/sign-up/email`, which also stopped a person holding a valid
 * company invite from creating the account they need to accept it. This plugin
 * moves that rule from Better Auth's own `emailAndPassword.disableSignUp`
 * switch into a `before` hook on the sign-up endpoint, so that:
 *
 * - a sign-up with no invite token, or with a token that does not name a
 *   pending, unexpired, unrevoked invite admitting a human, is refused with the
 *   exact error Better Auth's disabled sign-up returns (same status, code and
 *   message), so the response says nothing about which invites exist;
 * - a sign-up carrying such a token goes through Better Auth's normal sign-up.
 *
 * Creating the account does not accept or consume the invite. The invite
 * landing page accepts it afterwards through `POST /api/invites/:token/accept`
 * exactly as before, which is where the role is granted.
 *
 * The hook runs inside Better Auth's own pipeline, after its rate limiter and
 * origin check, so both still apply to every sign-up attempt. The token is
 * read from a request header so Better Auth's sign-up body is untouched; it is
 * never logged.
 */

import { eq } from "drizzle-orm";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { Db } from "@greatstone/db";
import { invites } from "@greatstone/db";
import { INVITE_SIGN_UP_TOKEN_HEADER } from "@greatstone/shared";
import { hashInviteToken } from "../lib/invite-token-hash.js";
import { logger } from "../middleware/logger.js";

export { INVITE_SIGN_UP_TOKEN_HEADER };

/** Better Auth's path for the email and password sign-up endpoint. */
const SIGN_UP_EMAIL_PATH = "/sign-up/email";

// Invite tokens are `pcp_invite_` plus 43 base64url characters, and bootstrap
// tokens `pcp_bootstrap_` plus 48 hex characters. Anything far longer is not
// a token, so it is refused before it is hashed.
const MAX_INVITE_TOKEN_LENGTH = 256;

/**
 * The refusal Better Auth itself returns when email sign-up is disabled
 * (`better-auth/dist/api/routes/sign-up.mjs`). Kept identical so a refused
 * invite-backed sign-up is indistinguishable from any other refused sign-up.
 */
export function signUpDisabledError() {
  return APIError.from("BAD_REQUEST", {
    message: "Email and password sign up is not enabled",
    code: "EMAIL_PASSWORD_SIGN_UP_DISABLED",
  });
}

type InviteSignUpCandidate = Pick<
  typeof invites.$inferSelect,
  "inviteType" | "allowedJoinTypes" | "companyId" | "revokedAt" | "acceptedAt" | "expiresAt"
>;

/**
 * Whether an invite admits a new human account right now. Mirrors the checks
 * `POST /api/invites/:token/accept` makes for a human join: the invite must not
 * be revoked, accepted or expired, and a company invite must allow human joins
 * and carry its company. A bootstrap invite is always a human invite.
 */
export function inviteAdmitsHumanSignUp(invite: InviteSignUpCandidate, nowMs: number = Date.now()): boolean {
  if (invite.revokedAt) return false;
  if (invite.acceptedAt) return false;
  if (invite.expiresAt.getTime() <= nowMs) return false;
  if (invite.allowedJoinTypes !== "human" && invite.allowedJoinTypes !== "both") return false;
  if (invite.inviteType === "bootstrap_ceo") return true;
  if (invite.inviteType === "company_join") return Boolean(invite.companyId);
  return false;
}

/** Looks the token up by its stored hash and applies {@link inviteAdmitsHumanSignUp}. */
export async function inviteTokenAdmitsHumanSignUp(
  db: Db,
  rawToken: string | null | undefined,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const token = rawToken?.trim() ?? "";
  if (!token || token.length > MAX_INVITE_TOKEN_LENGTH) return false;
  const invite = await db
    .select({
      inviteType: invites.inviteType,
      allowedJoinTypes: invites.allowedJoinTypes,
      companyId: invites.companyId,
      revokedAt: invites.revokedAt,
      acceptedAt: invites.acceptedAt,
      expiresAt: invites.expiresAt,
    })
    .from(invites)
    .where(eq(invites.tokenHash, hashInviteToken(token)))
    .then((rows) => rows[0] ?? null);
  return invite ? inviteAdmitsHumanSignUp(invite, nowMs) : false;
}

/**
 * Registered only when GSAM's `authDisableSignUp` is true; Better Auth's own
 * `disableSignUp` is then left false so this hook is the single gate.
 */
export function inviteSignUpGatePlugin(deps: { db: Db }) {
  return {
    id: "gsam-invite-sign-up-gate",
    hooks: {
      before: [
        {
          // `path` is the endpoint's declared path, not the request URL, so
          // every route into the endpoint is covered, including a direct
          // server-side `auth.api.signUpEmail` call (which carries no token).
          matcher: (context) => context.path === SIGN_UP_EMAIL_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const token = ctx.headers?.get(INVITE_SIGN_UP_TOKEN_HEADER) ?? null;
            let admitted = false;
            try {
              admitted = await inviteTokenAdmitsHumanSignUp(deps.db, token);
            } catch (error) {
              // Fail closed. Log the failure class only: a database error can
              // echo query parameters, and the token must never reach a log.
              logger.error(
                { errorName: error instanceof Error ? error.name : typeof error },
                "invite sign-up gate could not check the invite; sign-up refused",
              );
              admitted = false;
            }
            if (!admitted) throw signUpDisabledError();
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
