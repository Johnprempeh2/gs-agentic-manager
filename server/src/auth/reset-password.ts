import { and, eq, sql } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { authAccounts, authSessions, authTwoFactors, authUsers, type Db } from "@greatstone/db";

/** Better Auth's default `minPasswordLength`; sign-up refuses anything shorter. */
export const MIN_RESET_PASSWORD_LENGTH = 8;
/** Better Auth's default `maxPasswordLength`. */
export const MAX_RESET_PASSWORD_LENGTH = 128;

export type ResetCredentialPasswordResult = {
  userId: string;
  email: string;
  sessionsRevoked: number;
};

export class ResetCredentialPasswordError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_password" | "user_not_found" | "no_password_sign_in",
  ) {
    super(message);
    this.name = "ResetCredentialPasswordError";
  }
}

/**
 * The operator's way back in when a board user of an `authenticated` install
 * has lost their password (GRE-125). Runs against the database directly, so it
 * needs shell access to the host rather than a session.
 *
 * Writes a new Better Auth hash onto the user's email/password account and
 * deletes every session the user holds, so each device signs in again with the
 * new password. Running it twice with the same password leaves the same state.
 */
export async function resetCredentialPassword(
  db: Db,
  input: { email: string; newPassword: string },
): Promise<ResetCredentialPasswordResult> {
  const email = input.email.trim().toLowerCase();
  const password = input.newPassword;
  if (password.length < MIN_RESET_PASSWORD_LENGTH || password.length > MAX_RESET_PASSWORD_LENGTH) {
    throw new ResetCredentialPasswordError(
      `Password must be ${MIN_RESET_PASSWORD_LENGTH}-${MAX_RESET_PASSWORD_LENGTH} characters.`,
      "invalid_password",
    );
  }

  const user = await db
    .select({ id: authUsers.id, email: authUsers.email })
    .from(authUsers)
    .where(sql`lower(${authUsers.email}) = ${email}`)
    .then((rows) => rows[0] ?? null);
  if (!user) {
    throw new ResetCredentialPasswordError(`No user with email ${email}.`, "user_not_found");
  }

  const passwordHash = await hashPassword(password);
  const now = new Date();
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(authAccounts)
      .set({ password: passwordHash, updatedAt: now })
      .where(and(eq(authAccounts.userId, user.id), eq(authAccounts.providerId, "credential")))
      .returning({ id: authAccounts.id });
    if (updated.length === 0) {
      throw new ResetCredentialPasswordError(
        `User ${user.email} has no email/password sign-in to reset.`,
        "no_password_sign_in",
      );
    }
    const revoked = await tx
      .delete(authSessions)
      .where(eq(authSessions.userId, user.id))
      .returning({ id: authSessions.id });
    return { userId: user.id, email: user.email, sessionsRevoked: revoked.length };
  });
}

export type ResetTwoStepSignInResult = {
  userId: string;
  email: string;
  /** False when the person did not have two-step sign-in on. */
  wasEnabled: boolean;
  sessionsRevoked: number;
};

/**
 * Clears a person's two-step sign-in when they have lost their phone and
 * their backup codes. Removes the authenticator key and backup codes, turns
 * the flag off and signs them out everywhere, so their next sign-in is with
 * the password only (and, when the instance requires it, goes straight to
 * setting two-step sign-in up again). Used by the member reset route and by
 * `gsam auth reset-two-step` on the host.
 */
export async function resetTwoStepSignIn(
  db: Db,
  input: { userId: string } | { email: string },
): Promise<ResetTwoStepSignInResult> {
  const user = await db
    .select({ id: authUsers.id, email: authUsers.email, enabled: authUsers.twoFactorEnabled })
    .from(authUsers)
    .where(
      "userId" in input
        ? eq(authUsers.id, input.userId)
        : sql`lower(${authUsers.email}) = ${input.email.trim().toLowerCase()}`,
    )
    .then((rows) => rows[0] ?? null);
  if (!user) {
    throw new ResetCredentialPasswordError(
      "userId" in input ? "User not found." : `No user with email ${input.email.trim().toLowerCase()}.`,
      "user_not_found",
    );
  }
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(authTwoFactors)
      .where(eq(authTwoFactors.userId, user.id))
      .returning({ id: authTwoFactors.id });
    await tx
      .update(authUsers)
      .set({ twoFactorEnabled: false, updatedAt: new Date() })
      .where(eq(authUsers.id, user.id));
    const revoked = await tx
      .delete(authSessions)
      .where(eq(authSessions.userId, user.id))
      .returning({ id: authSessions.id });
    return {
      userId: user.id,
      email: user.email,
      wasEnabled: user.enabled || removed.length > 0,
      sessionsRevoked: revoked.length,
    };
  });
}
