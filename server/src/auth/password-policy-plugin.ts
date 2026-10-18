/**
 * Holds every new password to the shared rule (`passwordProblem` in
 * `@greatstone/shared`): at least 12 characters, not a well-known password,
 * not built from the account's email. Better Auth's own check stops only
 * passwords under 8 characters.
 *
 * A `before` hook on each endpoint that sets a password, so it runs after
 * Better Auth's rate limit and origin check and after the invite sign-up gate.
 * Existing passwords keep working; the rule applies when one is set.
 */

import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { passwordProblem } from "@greatstone/shared";

const SIGN_UP_EMAIL_PATH = "/sign-up/email";
/** Endpoints whose body carries the new password as `newPassword`. */
const NEW_PASSWORD_PATHS = new Set(["/change-password", "/reset-password"]);

export function weakPasswordError(message: string) {
  return APIError.from("BAD_REQUEST", { message, code: "WEAK_PASSWORD" });
}

export function passwordPolicyPlugin() {
  return {
    id: "gsam-password-policy",
    hooks: {
      before: [
        {
          matcher: (context) => context.path === SIGN_UP_EMAIL_PATH || NEW_PASSWORD_PATHS.has(context.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const body = (ctx.body ?? {}) as { password?: unknown; newPassword?: unknown; email?: unknown };
            const password = ctx.path === SIGN_UP_EMAIL_PATH ? body.password : body.newPassword;
            // A missing or non-string password is left to Better Auth's own
            // body validation, which refuses it with its usual error.
            if (typeof password !== "string") return;
            const problem = passwordProblem(password, {
              email: typeof body.email === "string" ? body.email : null,
            });
            if (problem) throw weakPasswordError(problem);
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
