import { and, eq, sql } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { authAccounts, authSessions, authUsers, type Db } from "@greatstone/db";

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
