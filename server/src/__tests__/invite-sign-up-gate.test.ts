/**
 * Unit coverage for the invite-backed sign-up gate: the invite predicate, the
 * token pre-checks, and the hook's wiring on a Better Auth mount (in-memory
 * adapter, stubbed app database). The end-to-end matrix against a real
 * Postgres lives in `invite-sign-up-when-closed.integration.test.ts`.
 */

import express from "express";
import request from "supertest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { toNodeHandler } from "better-auth/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@greatstone/db";
import {
  INVITE_SIGN_UP_TOKEN_HEADER,
  inviteAdmitsHumanSignUp,
  inviteSignUpGatePlugin,
  inviteTokenAdmitsHumanSignUp,
} from "../auth/invite-sign-up-gate.js";
import { logger } from "../middleware/logger.js";

const ORIGIN = "http://127.0.0.1:42019";
const TOKEN = "pcp_invite_unit-test-token-0123456789abcdefghijklmnopq";
const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const FUTURE = new Date(NOW + 60 * 60 * 1000);

function pendingInvite(overrides: Partial<Parameters<typeof inviteAdmitsHumanSignUp>[0]> = {}) {
  return {
    inviteType: "company_join",
    allowedJoinTypes: "human",
    companyId: "company-1",
    revokedAt: null,
    acceptedAt: null,
    expiresAt: FUTURE,
    ...overrides,
  } as Parameters<typeof inviteAdmitsHumanSignUp>[0];
}

/** An app `db` whose single invite lookup answers with `rows`, or throws. */
function stubDb(result: { rows?: unknown[]; error?: Error }) {
  const select = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "where", "limit"]) chain[method] = vi.fn(() => chain);
    chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      (result.error ? Promise.reject(result.error) : Promise.resolve(result.rows ?? [])).then(resolve, reject);
    return chain;
  });
  return { db: { select } as unknown as Db, select };
}

function createApp(db: Db) {
  const auth = betterAuth({
    secret: "better-auth-secret-for-invite-gate-unit-tests",
    baseURL: ORIGIN,
    trustedOrigins: [ORIGIN],
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    emailAndPassword: { enabled: true, disableSignUp: false },
    rateLimit: { enabled: false },
    advanced: { useSecureCookies: false },
    plugins: [inviteSignUpGatePlugin({ db })],
  });
  const app = express();
  app.all("/api/auth/*splat", (req, res, next) => {
    void Promise.resolve(toNodeHandler(auth)(req, res)).catch(next);
  });
  return { app, auth };
}

function signUp(app: express.Express, token?: string) {
  const pending = request(app).post("/api/auth/sign-up/email").set("origin", ORIGIN);
  if (token !== undefined) pending.set(INVITE_SIGN_UP_TOKEN_HEADER, token);
  return pending.send({ email: "ben@example.com", password: "a-long-enough-password", name: "Ben" });
}

const DISABLED_BODY = {
  code: "EMAIL_PASSWORD_SIGN_UP_DISABLED",
  message: "Email and password sign up is not enabled",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("inviteAdmitsHumanSignUp", () => {
  it("admits a pending human or both company invite, and a pending bootstrap invite", () => {
    expect(inviteAdmitsHumanSignUp(pendingInvite(), NOW)).toBe(true);
    expect(inviteAdmitsHumanSignUp(pendingInvite({ allowedJoinTypes: "both" }), NOW)).toBe(true);
    expect(
      inviteAdmitsHumanSignUp(pendingInvite({ inviteType: "bootstrap_ceo", companyId: null }), NOW),
    ).toBe(true);
  });

  it.each([
    ["revoked", { revokedAt: new Date(NOW - 1) }],
    ["accepted", { acceptedAt: new Date(NOW - 1) }],
    ["expired", { expiresAt: new Date(NOW - 1) }],
    ["expiring this instant", { expiresAt: new Date(NOW) }],
    ["agent-only", { allowedJoinTypes: "agent" }],
    ["a company invite with no company", { companyId: null }],
    ["an unknown invite type", { inviteType: "something_else" }],
    ["an unknown join type", { allowedJoinTypes: "robot" }],
  ])("refuses an invite that is %s", (_label, overrides) => {
    expect(inviteAdmitsHumanSignUp(pendingInvite(overrides as never), NOW)).toBe(false);
  });
});

describe("inviteTokenAdmitsHumanSignUp", () => {
  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["blank", "   "],
    ["overlong", `pcp_invite_${"a".repeat(300)}`],
  ])("refuses a %s token without querying the database", async (_label, token) => {
    const { db, select } = stubDb({ rows: [pendingInvite()] });
    await expect(inviteTokenAdmitsHumanSignUp(db, token as string | null | undefined, NOW)).resolves.toBe(false);
    expect(select).not.toHaveBeenCalled();
  });

  it("refuses a token that names no invite", async () => {
    const { db } = stubDb({ rows: [] });
    await expect(inviteTokenAdmitsHumanSignUp(db, TOKEN, NOW)).resolves.toBe(false);
  });

  it("admits a trimmed token that names a pending human invite", async () => {
    const { db, select } = stubDb({ rows: [pendingInvite()] });
    await expect(inviteTokenAdmitsHumanSignUp(db, `  ${TOKEN}  `, NOW)).resolves.toBe(true);
    expect(select).toHaveBeenCalledTimes(1);
  });
});

describe("inviteSignUpGatePlugin on a Better Auth mount", () => {
  it("refuses a sign-up with no token with Better Auth's disabled sign-up error", async () => {
    const { db, select } = stubDb({ rows: [pendingInvite()] });
    const response = await signUp(createApp(db).app);
    expect(response.status).toBe(400);
    expect(response.body).toEqual(DISABLED_BODY);
    expect(select).not.toHaveBeenCalled();
  });

  it("refuses a token that does not admit a human", async () => {
    const { db } = stubDb({ rows: [pendingInvite({ allowedJoinTypes: "agent" })] });
    const response = await signUp(createApp(db).app, TOKEN);
    expect(response.status).toBe(400);
    expect(response.body).toEqual(DISABLED_BODY);
  });

  it("lets a valid human invite through to Better Auth's normal sign-up", async () => {
    const { db } = stubDb({ rows: [pendingInvite()] });
    const response = await signUp(createApp(db).app, TOKEN);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.user.email).toBe("ben@example.com");
  });

  it("fails closed, without logging the token, when the invite cannot be checked", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    const { db } = stubDb({ error: new Error(`database unavailable while reading ${TOKEN}`) });
    const response = await signUp(createApp(db).app, TOKEN);
    expect(response.status).toBe(400);
    expect(response.body).toEqual(DISABLED_BODY);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(TOKEN);
  });

  it("gates a direct server-side auth.api.signUpEmail call too", async () => {
    const { db } = stubDb({ rows: [pendingInvite()] });
    const { auth } = createApp(db);
    await expect(
      auth.api.signUpEmail({
        body: { email: "server@example.com", password: "a-long-enough-password", name: "Server" },
      }),
    ).rejects.toMatchObject({ body: { code: "EMAIL_PASSWORD_SIGN_UP_DISABLED" } });
  });

  it("does not touch sign-in", async () => {
    const { db, select } = stubDb({ rows: [] });
    const response = await request(createApp(db).app)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email: "nobody@example.com", password: "a-long-enough-password" });
    expect(response.status).toBe(401);
    expect(select).not.toHaveBeenCalled();
  });
});
