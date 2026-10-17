/**
 * Per-account lockout for email and password sign-in.
 *
 * Better Auth's own rate limit counts attempts per client address, so a guesser
 * spread over many addresses is never slowed down. This plugin also counts
 * failed sign-ins per account: after `maxFailures` wrong passwords for one
 * email inside `windowMs`, every sign-in for that email is refused for
 * `lockMs`, even with the right password. A successful sign-in clears the
 * count.
 *
 * Counts live in memory: one client instance is one server process, and a
 * restart clearing them only gives a guesser one more window. The refusal is
 * the same whether or not the email has an account, so it says nothing about
 * which accounts exist.
 */

import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { logger } from "../middleware/logger.js";

const SIGN_IN_EMAIL_PATH = "/sign-in/email";

export type SignInLockoutOptions = {
  maxFailures: number;
  windowMs: number;
  lockMs: number;
  now?: () => number;
};

export const DEFAULT_SIGN_IN_LOCKOUT: SignInLockoutOptions = {
  maxFailures: 10,
  windowMs: 15 * 60 * 1000,
  lockMs: 15 * 60 * 1000,
};

// Upper bound on tracked emails so a flood of made-up addresses cannot grow
// the map without limit. The oldest entries go first.
const MAX_TRACKED_ACCOUNTS = 10_000;

type Entry = { failures: number[]; lockedUntil: number };

export function createSignInLockout(options: SignInLockoutOptions = DEFAULT_SIGN_IN_LOCKOUT) {
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();

  function key(email: unknown): string | null {
    if (typeof email !== "string") return null;
    const normalized = email.trim().toLowerCase();
    return normalized.length > 0 && normalized.length <= 320 ? normalized : null;
  }

  return {
    /** Milliseconds the account stays locked, or 0 when sign-in may proceed. */
    lockedFor(email: unknown): number {
      const k = key(email);
      if (!k) return 0;
      const entry = entries.get(k);
      if (!entry) return 0;
      const remaining = entry.lockedUntil - now();
      return remaining > 0 ? remaining : 0;
    },
    recordFailure(email: unknown): void {
      const k = key(email);
      if (!k) return;
      const at = now();
      const entry = entries.get(k) ?? { failures: [], lockedUntil: 0 };
      entry.failures = entry.failures.filter((t) => at - t < options.windowMs);
      entry.failures.push(at);
      if (entry.failures.length >= options.maxFailures) {
        entry.lockedUntil = at + options.lockMs;
        entry.failures = [];
        logger.warn({ lockMinutes: Math.round(options.lockMs / 60000) }, "sign-in locked for an account after repeated wrong passwords");
      }
      entries.delete(k);
      entries.set(k, entry);
      if (entries.size > MAX_TRACKED_ACCOUNTS) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
    },
    recordSuccess(email: unknown): void {
      const k = key(email);
      if (k) entries.delete(k);
    },
  };
}

export type SignInLockout = ReturnType<typeof createSignInLockout>;

export function signInLockedError(remainingMs: number) {
  const minutes = Math.max(1, Math.ceil(remainingMs / 60000));
  return APIError.from("TOO_MANY_REQUESTS", {
    message: `Too many wrong passwords for this account. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    code: "SIGN_IN_LOCKED",
  });
}

function isUnauthorized(value: unknown): boolean {
  return value instanceof Error && (value as { statusCode?: number }).statusCode === 401;
}

export function signInLockoutPlugin(lockout: SignInLockout = createSignInLockout()) {
  return {
    id: "gsam-sign-in-lockout",
    hooks: {
      before: [
        {
          matcher: (context) => context.path === SIGN_IN_EMAIL_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const remaining = lockout.lockedFor((ctx.body as { email?: unknown } | undefined)?.email);
            if (remaining > 0) throw signInLockedError(remaining);
          }),
        },
      ],
      after: [
        {
          matcher: (context) => context.path === SIGN_IN_EMAIL_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const email = (ctx.body as { email?: unknown } | undefined)?.email;
            const returned = ctx.context.returned;
            if (isUnauthorized(returned)) {
              lockout.recordFailure(email);
            } else if (!(returned instanceof Error)) {
              lockout.recordSuccess(email);
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
