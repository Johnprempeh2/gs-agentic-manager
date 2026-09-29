// Password re-check for release, rollback and "Promote to Stable" (GRE-133,
// design GRE-124 section 1). This is the one shared check; the release
// routes (GRE-121) and the promote route (GRE-127) call
// `assertReleaseReauth(req, action, releaseReauth(db))` right after their
// board guard.
//
// - Agents never pass: the check starts with the board-only guard.
// - `local_trusted` has no log-in, so the board-only guard is the whole check
//   (the implicit local board, source `local_implicit`).
// - Login mode (`authenticated`): the signed-in board user first calls
//   `POST /api/reauth { password, action }` and gets a token. The action
//   request sends it in the `X-GSAM-Reauth` header. A token is good for one
//   action of the named kind, for the same user and session, for 5 minutes.
//
// Tokens and failure counts live in memory: a restart asks for the password
// again, which is the safe side.
import { createHash, randomBytes } from "node:crypto";
import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { authAccounts } from "@greatstone/db";
import { verifyPassword as verifyPasswordHash } from "better-auth/crypto";
import { forbidden } from "../errors.js";
import { assertBoard } from "../routes/authz.js";

export const RELEASE_REAUTH_ACTIONS = ["release", "rollback", "promote"] as const;
export type ReleaseReauthAction = (typeof RELEASE_REAUTH_ACTIONS)[number];

export const RELEASE_REAUTH_HEADER = "x-gsam-reauth";
export const RELEASE_REAUTH_TTL_MS = 5 * 60 * 1000;
export const RELEASE_REAUTH_MAX_FAILURES = 5;
export const RELEASE_REAUTH_LOCKOUT_MS = 15 * 60 * 1000;

export function isReleaseReauthAction(value: unknown): value is ReleaseReauthAction {
  return typeof value === "string" && (RELEASE_REAUTH_ACTIONS as readonly string[]).includes(value);
}

type TokenEntry = {
  userId: string;
  sessionId: string | null;
  action: ReleaseReauthAction;
  expiresAt: number;
};

type FailureEntry = { count: number; firstAt: number };

export type ReleaseReauthOptions = {
  verifyPassword: (userId: string, password: string) => Promise<boolean>;
  now?: () => number;
};

export type ReleaseReauthResult =
  | { ok: true; token: string; action: ReleaseReauthAction; expiresAt: string }
  | { ok: false; reason: "invalid_password" | "locked" };

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function createReleaseReauth(opts: ReleaseReauthOptions) {
  const now = opts.now ?? Date.now;
  const tokens = new Map<string, TokenEntry>();
  const failures = new Map<string, FailureEntry>();

  function prune() {
    const t = now();
    for (const [key, entry] of tokens) if (entry.expiresAt <= t) tokens.delete(key);
    for (const [key, entry] of failures) if (entry.firstAt + RELEASE_REAUTH_LOCKOUT_MS <= t) failures.delete(key);
  }

  function isLocked(userId: string) {
    const entry = failures.get(userId);
    return !!entry && entry.count >= RELEASE_REAUTH_MAX_FAILURES && entry.firstAt + RELEASE_REAUTH_LOCKOUT_MS > now();
  }

  async function issue(input: {
    userId: string;
    sessionId: string | null;
    action: ReleaseReauthAction;
    password: string;
  }): Promise<ReleaseReauthResult> {
    prune();
    if (isLocked(input.userId)) return { ok: false, reason: "locked" };
    const valid = input.password.length > 0 && (await opts.verifyPassword(input.userId, input.password));
    if (!valid) {
      const entry = failures.get(input.userId) ?? { count: 0, firstAt: now() };
      entry.count += 1;
      failures.set(input.userId, entry);
      return { ok: false, reason: isLocked(input.userId) ? "locked" : "invalid_password" };
    }
    failures.delete(input.userId);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now() + RELEASE_REAUTH_TTL_MS;
    tokens.set(hashToken(token), {
      userId: input.userId,
      sessionId: input.sessionId,
      action: input.action,
      expiresAt,
    });
    return { ok: true, token, action: input.action, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Uses up the token when it matches; a token is never good twice. */
  function consume(token: string, expected: { userId: string; sessionId: string | null; action: ReleaseReauthAction }) {
    prune();
    const key = hashToken(token);
    const entry = tokens.get(key);
    if (!entry) return false;
    if (entry.userId !== expected.userId) return false;
    if (entry.sessionId !== expected.sessionId) return false;
    if (entry.action !== expected.action) return false;
    tokens.delete(key);
    return true;
  }

  return { issue, consume };
}

export type ReleaseReauth = ReturnType<typeof createReleaseReauth>;

/** Checks the password against the user's email-and-password account. */
export function credentialPasswordVerifier(db: Db) {
  return async (userId: string, password: string) => {
    const account = await db
      .select({ password: authAccounts.password })
      .from(authAccounts)
      .where(and(eq(authAccounts.userId, userId), eq(authAccounts.providerId, "credential")))
      .then((rows) => rows[0] ?? null);
    if (!account?.password) return false;
    return verifyPasswordHash({ hash: account.password, password });
  };
}

let shared: ReleaseReauth | null = null;

/** One instance per process, so the token from `POST /api/reauth` is seen by every route. */
export function releaseReauth(db: Db): ReleaseReauth {
  if (!shared) shared = createReleaseReauth({ verifyPassword: credentialPasswordVerifier(db) });
  return shared;
}

export const REAUTH_REQUIRED_CODE = "reauth_required";

/**
 * The shared guard. Call it after the route's own company and board checks.
 * Throws 403 unless the actor may do `action` now.
 */
export function assertReleaseReauth(req: Request, action: ReleaseReauthAction, reauth: ReleaseReauth) {
  assertBoard(req);
  const actor = req.actor;
  // local_trusted: no log-in exists, so the board-only guard is the check.
  if (actor.source === "local_implicit") return;
  if (actor.source !== "session" || !actor.userId) {
    throw forbidden(`Sign in to the app in a browser to ${action}; a board key cannot`, { code: REAUTH_REQUIRED_CODE });
  }
  const token = req.header(RELEASE_REAUTH_HEADER);
  const expected = { userId: actor.userId, sessionId: actor.sessionId ?? null, action };
  if (!token || !reauth.consume(token, expected)) {
    throw forbidden(`Enter your password again to ${action}`, { code: REAUTH_REQUIRED_CODE });
  }
}
