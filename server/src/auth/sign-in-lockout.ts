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
 * Counts are kept in the database (`sign_in_lockout`), so a restart does not
 * give a guesser a fresh start. Rows are keyed by a SHA-256 of the normalised
 * email, and rows idle for longer than the window and the lock are removed as
 * new failures come in. The refusal is the same whether or not the email has
 * an account, so it says nothing about which accounts exist.
 */

import { createHash } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { eq, lt } from "drizzle-orm";
import { authSignInLockouts, type Db } from "@greatstone/db";
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

type Entry = { failures: number[]; lockedUntil: number };

/** Where the counts live: the database in the app, memory in unit tests. */
export interface SignInLockoutStore {
  get(key: string): Promise<Entry | null>;
  set(key: string, entry: Entry, at: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Removes entries last written before `before`. */
  prune(before: number): Promise<void>;
}

// Upper bound on entries in memory so a flood of made-up addresses cannot grow
// the map without limit. The oldest entries go first.
const MAX_TRACKED_ACCOUNTS = 10_000;

export function memorySignInLockoutStore(): SignInLockoutStore {
  const entries = new Map<string, { entry: Entry; at: number }>();
  return {
    async get(key) {
      return entries.get(key)?.entry ?? null;
    },
    async set(key, entry, at) {
      entries.delete(key);
      entries.set(key, { entry, at });
      if (entries.size > MAX_TRACKED_ACCOUNTS) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
    },
    async delete(key) {
      entries.delete(key);
    },
    async prune(before) {
      for (const [key, value] of entries) if (value.at < before) entries.delete(key);
    },
  };
}

export function databaseSignInLockoutStore(db: Db): SignInLockoutStore {
  return {
    async get(key) {
      const row = await db
        .select()
        .from(authSignInLockouts)
        .where(eq(authSignInLockouts.accountKey, key))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      return {
        failures: Array.isArray(row.failureTimes) ? row.failureTimes.filter((t) => typeof t === "number") : [],
        lockedUntil: row.lockedUntil?.getTime() ?? 0,
      };
    },
    async set(key, entry, at) {
      const values = {
        failureTimes: entry.failures,
        lockedUntil: entry.lockedUntil > 0 ? new Date(entry.lockedUntil) : null,
        updatedAt: new Date(at),
      };
      await db
        .insert(authSignInLockouts)
        .values({ accountKey: key, ...values })
        .onConflictDoUpdate({ target: authSignInLockouts.accountKey, set: values });
    },
    async delete(key) {
      await db.delete(authSignInLockouts).where(eq(authSignInLockouts.accountKey, key));
    },
    async prune(before) {
      await db.delete(authSignInLockouts).where(lt(authSignInLockouts.updatedAt, new Date(before)));
    },
  };
}

export function createSignInLockout(
  options: SignInLockoutOptions = DEFAULT_SIGN_IN_LOCKOUT,
  store: SignInLockoutStore = memorySignInLockoutStore(),
) {
  const now = options.now ?? Date.now;
  const keepMs = Math.max(options.windowMs, options.lockMs);

  function key(email: unknown): string | null {
    if (typeof email !== "string") return null;
    const normalized = email.trim().toLowerCase();
    if (normalized.length === 0 || normalized.length > 320) return null;
    return createHash("sha256").update(normalized).digest("hex");
  }

  return {
    /** Milliseconds the account stays locked, or 0 when sign-in may proceed. */
    async lockedFor(email: unknown): Promise<number> {
      const k = key(email);
      if (!k) return 0;
      const entry = await store.get(k);
      if (!entry) return 0;
      const remaining = entry.lockedUntil - now();
      return remaining > 0 ? remaining : 0;
    },
    async recordFailure(email: unknown): Promise<void> {
      const k = key(email);
      if (!k) return;
      const at = now();
      const entry = (await store.get(k)) ?? { failures: [], lockedUntil: 0 };
      entry.failures = entry.failures.filter((t) => at - t < options.windowMs);
      entry.failures.push(at);
      if (entry.failures.length >= options.maxFailures) {
        entry.lockedUntil = at + options.lockMs;
        entry.failures = [];
        logger.warn({ lockMinutes: Math.round(options.lockMs / 60000) }, "sign-in locked for an account after repeated wrong passwords");
      }
      await store.set(k, entry, at);
      await store.prune(at - keepMs);
    },
    async recordSuccess(email: unknown): Promise<void> {
      const k = key(email);
      if (k) await store.delete(k);
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

export function signInLockoutPlugin(lockout: SignInLockout) {
  return {
    id: "gsam-sign-in-lockout",
    hooks: {
      before: [
        {
          matcher: (context) => context.path === SIGN_IN_EMAIL_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const remaining = await lockout.lockedFor((ctx.body as { email?: unknown } | undefined)?.email);
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
              await lockout.recordFailure(email);
            } else if (!(returned instanceof Error)) {
              await lockout.recordSuccess(email);
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
