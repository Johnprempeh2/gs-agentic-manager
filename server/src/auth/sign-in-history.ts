/**
 * Each person's recent sign-in attempts, so Profile can show "wrong password
 * from an address you do not know" or "password right, waiting for the code".
 * Either means someone else has tried, or knows, the password.
 *
 * Only attempts on an existing account are kept (emails with no account are
 * never stored), and rows older than `SIGN_IN_HISTORY_DAYS` are removed for a
 * person as their new rows come in. Recording never blocks or fails sign-in.
 */

import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { and, desc, eq, gte, lt, ne, sql } from "drizzle-orm";
import { authSignInEvents, authUsers, type Db } from "@greatstone/db";
import { logger } from "../middleware/logger.js";

export const SIGN_IN_HISTORY_DAYS = 90;

export type SignInOutcome = "signed_in" | "wrong_password" | "code_needed";

const SIGN_IN_EMAIL_PATH = "/sign-in/email";
const TWO_STEP_VERIFY_PATHS = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code"]);

/**
 * What a sign-in step's result means for the history, or null to record
 * nothing. A code step counts only inside a sign-in (`fromSignIn`: the request
 * carries Better Auth's two-step cookie), not when a signed-in person confirms
 * their first code while turning two-step sign-in on.
 */
export function signInOutcome(
  path: string,
  returned: unknown,
  hasNewSession: boolean,
  fromSignIn = true,
): SignInOutcome | null {
  if (path === SIGN_IN_EMAIL_PATH) {
    if (returned instanceof Error) {
      return (returned as { statusCode?: number }).statusCode === 401 ? "wrong_password" : null;
    }
    if ((returned as { twoFactorRedirect?: unknown } | null)?.twoFactorRedirect === true) return "code_needed";
    return hasNewSession ? "signed_in" : null;
  }
  if (TWO_STEP_VERIFY_PATHS.has(path)) {
    return fromSignIn && !(returned instanceof Error) && hasNewSession ? "signed_in" : null;
  }
  return null;
}

export function signInHistoryService(db: Db) {
  return {
    async record(input: {
      userId: string;
      outcome: SignInOutcome;
      ipAddress: string | null;
      userAgent: string | null;
      now?: Date;
    }) {
      const now = input.now ?? new Date();
      await db.insert(authSignInEvents).values({
        userId: input.userId,
        outcome: input.outcome,
        ipAddress: input.ipAddress?.slice(0, 100) ?? null,
        userAgent: input.userAgent?.slice(0, 500) ?? null,
        createdAt: now,
      });
      const cutoff = new Date(now.getTime() - SIGN_IN_HISTORY_DAYS * 86_400_000);
      await db
        .delete(authSignInEvents)
        .where(and(eq(authSignInEvents.userId, input.userId), lt(authSignInEvents.createdAt, cutoff)));
    },

    async recent(userId: string, limit = 20) {
      return db
        .select({
          id: authSignInEvents.id,
          outcome: authSignInEvents.outcome,
          ipAddress: authSignInEvents.ipAddress,
          userAgent: authSignInEvents.userAgent,
          createdAt: authSignInEvents.createdAt,
        })
        .from(authSignInEvents)
        .where(eq(authSignInEvents.userId, userId))
        .orderBy(desc(authSignInEvents.createdAt))
        .limit(limit);
    },

    /**
     * Instance-wide attempts that did not finish (wrong passwords and
     * passwords held at the two-step code), newest first, with whose account
     * they were on, plus counts of each outcome since `since`. For instance
     * admins only.
     */
    async unfinishedAcrossInstance(since: Date, limit = 50) {
      const [events, counts] = await Promise.all([
        db
          .select({
            id: authSignInEvents.id,
            outcome: authSignInEvents.outcome,
            ipAddress: authSignInEvents.ipAddress,
            userAgent: authSignInEvents.userAgent,
            createdAt: authSignInEvents.createdAt,
            userId: authSignInEvents.userId,
            email: authUsers.email,
            name: authUsers.name,
          })
          .from(authSignInEvents)
          .innerJoin(authUsers, eq(authUsers.id, authSignInEvents.userId))
          .where(ne(authSignInEvents.outcome, "signed_in"))
          .orderBy(desc(authSignInEvents.createdAt))
          .limit(limit),
        db
          .select({ outcome: authSignInEvents.outcome, count: sql<number>`count(*)::int` })
          .from(authSignInEvents)
          .where(gte(authSignInEvents.createdAt, since))
          .groupBy(authSignInEvents.outcome),
      ]);
      const counted = Object.fromEntries(counts.map((row) => [row.outcome, Number(row.count)]));
      return {
        counts: {
          signedIn: counted.signed_in ?? 0,
          wrongPassword: counted.wrong_password ?? 0,
          codeNeeded: counted.code_needed ?? 0,
        },
        events,
      };
    },
  };
}

export function signInHistoryPlugin(db: Db, clientIpHeader: string) {
  const history = signInHistoryService(db);
  return {
    id: "gsam-sign-in-history",
    hooks: {
      after: [
        {
          matcher: (context) => context.path === SIGN_IN_EMAIL_PATH || TWO_STEP_VERIFY_PATHS.has(context.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const newSession = ctx.context.newSession as { user?: { id?: string } } | null | undefined;
            const fromSignIn = /(?:^|[;\s])[^=;\s]*two_factor=/.test(ctx.headers?.get("cookie") ?? "");
            const outcome = signInOutcome(ctx.path ?? "", ctx.context.returned, Boolean(newSession?.user?.id), fromSignIn);
            if (!outcome) return;
            try {
              let userId = newSession?.user?.id ?? null;
              if (!userId) {
                const email = (ctx.body as { email?: unknown } | undefined)?.email;
                if (typeof email !== "string" || !email.trim()) return;
                const [user] = await db
                  .select({ id: authUsers.id })
                  .from(authUsers)
                  .where(eq(sql`lower(${authUsers.email})`, email.trim().toLowerCase()))
                  .limit(1);
                userId = user?.id ?? null;
              }
              if (!userId) return;
              await history.record({
                userId,
                outcome,
                ipAddress: ctx.headers?.get(clientIpHeader) ?? null,
                userAgent: ctx.headers?.get("user-agent") ?? null,
              });
            } catch (error) {
              logger.warn({ err: error }, "Could not record a sign-in attempt");
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
