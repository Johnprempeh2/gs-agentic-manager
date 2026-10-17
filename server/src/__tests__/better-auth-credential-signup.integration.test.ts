/**
 * End-to-end coverage for the credential sign-up and sign-in that a
 * self-hosted install depends on, driven through the real Better Auth mount
 * against the real Drizzle schema and a migrated Postgres.
 *
 * The other Better Auth suites mount either a stub handler or the in-memory
 * adapter, so neither notices when Better Auth's `account` model grows a field
 * the Drizzle table does not have. The Drizzle adapter validates the model
 * against the schema on every write and throws
 * `The field "<name>" does not exist in the "account" Drizzle schema`, which
 * the mount turns into a 500 with an empty body — a fresh install cannot
 * create its first user at all. This suite is the one that fails when that
 * happens.
 */

import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { authAccounts, authTwoFactors, authUsers, createDb } from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  createBetterAuthHandler,
  createBetterAuthInstance,
  resolveBetterAuthSession,
} from "../auth/better-auth.js";
import { resetTwoStepSignIn } from "../auth/reset-password.js";
import { clearTwoStepRequirementCache, twoStepRequiredGuard } from "../auth/two-step-requirement.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import type { Config } from "../config.js";

const ORIGIN = "http://127.0.0.1:41999";
const EMAIL = "founder@example.com";
const PASSWORD = "correct-horse-battery-staple";

// The issuer Better Auth stamps on an email/password account:
// `createLocalAccountIssuer("credential")`. Sign-in matches on it, so a row
// written with anything else is a row nobody can sign in as.
const CREDENTIAL_ISSUER = "local:credential";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function testConfig(): Config {
  // Only the auth-relevant fields are read by `createBetterAuthInstance`; the
  // rest of `Config` describes storage, backups, and scheduling that the Better
  // Auth instance never looks at.
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    authBaseUrlMode: "explicit",
    authPublicBaseUrl: ORIGIN,
    authDisableSignUp: false,
    allowedHostnames: ["127.0.0.1"],
    port: 41999,
  } as unknown as Config;
}

function base32Decode(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of value.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** RFC 6238 code for now, as an authenticator app would show it. */
function totpCode(totpUri: string): string {
  const secret = new URL(totpUri).searchParams.get("secret") ?? "";
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const digest = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0xf;
  const binary = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(binary).padStart(6, "0");
}

function cookieHeader(response: request.Response): string {
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

function sessionCookies(response: request.Response): string[] {
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return cookies.filter((cookie) => cookie.includes("session_token"));
}

describeEmbeddedPostgres("Better Auth credential sign-up against the real schema", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: express.Express;
  const originalEnv = {
    secret: process.env.BETTER_AUTH_SECRET,
    rateLimit: process.env.GSAM_AUTH_RATE_LIMIT_ENABLED,
  };

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "better-auth-secret-for-credential-signup-tests";
    // The rate limiter is on by default in `authenticated` mode and would score
    // the sign-up and sign-in this suite issues back to back.
    process.env.GSAM_AUTH_RATE_LIMIT_ENABLED = "false";

    database = await startEmbeddedPostgresTestDatabase("paperclip-better-auth-signup-");
    db = createDb(database.connectionString);

    const auth = createBetterAuthInstance(db, testConfig(), [ORIGIN]);
    app = express();
    // The actor and the two-step guard run in front of everything, as in
    // `createApp`. Better Auth is mounted with no body parser in front of it:
    // it reads the raw request body itself.
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: (req) => resolveBetterAuthSession(auth, req) }));
    app.use(twoStepRequiredGuard(db));
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
    // Stands in for every other board route.
    app.get("/api/companies", (req, res) => {
      if (req.actor.type !== "board") {
        res.status(401).json({ error: "Board authentication required" });
        return;
      }
      res.json([]);
    });
    app.use(errorHandler);
  }, 30_000);

  afterAll(async () => {
    await database?.cleanup();
    if (originalEnv.secret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalEnv.secret;
    if (originalEnv.rateLimit === undefined) delete process.env.GSAM_AUTH_RATE_LIMIT_ENABLED;
    else process.env.GSAM_AUTH_RATE_LIMIT_ENABLED = originalEnv.rateLimit;
  });

  async function signUpWithTwoStep(email: string) {
    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email, password: PASSWORD, name: "Two Step" });
    const session = cookieHeader(signUp);
    const enable = await request(app)
      .post("/api/auth/two-factor/enable")
      .set("origin", ORIGIN)
      .set("cookie", session)
      .send({ password: PASSWORD });
    // Confirming the first code replaces the session with a fresh one.
    const confirm = await request(app)
      .post("/api/auth/two-factor/verify-totp")
      .set("origin", ORIGIN)
      .set("cookie", session)
      .send({ code: totpCode(enable.body.totpURI) });
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(200);
    return { session: cookieHeader(confirm) || session, userId: signUp.body.user.id as string };
  }

  it("creates the user and its credential account, then signs that user in", async () => {
    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email: EMAIL, password: PASSWORD, name: "Founder" });

    // A missing `account` column fails here with a 500 and an empty body.
    expect(signUp.status).toBe(200);
    expect(signUp.body?.user?.email).toBe(EMAIL);

    // Sign-up has to leave a usable account row behind. A half-created user —
    // a `user` row with no `account` — cannot sign in, cannot sign up again,
    // and cannot reset its password.
    const accounts = await db.select().from(authAccounts);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      providerId: "credential",
      issuer: CREDENTIAL_ISSUER,
    });
    expect(accounts[0]?.password).toBeTruthy();

    const signIn = await request(app)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email: EMAIL, password: PASSWORD });

    expect(signIn.status).toBe(200);
    expect(signIn.body?.user?.email).toBe(EMAIL);
    expect(sessionCookies(signIn).length).toBeGreaterThan(0);
  });

  it("turns on two-step sign-in, then asks for the app code at sign-in", async () => {
    const email = "two-step@example.com";
    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email, password: PASSWORD, name: "Two Step" });
    expect(signUp.status).toBe(200);
    const session = cookieHeader(signUp);

    const enable = await request(app)
      .post("/api/auth/two-factor/enable")
      .set("origin", ORIGIN)
      .set("cookie", session)
      .send({ password: PASSWORD });
    expect(enable.status, JSON.stringify(enable.body)).toBe(200);
    expect(enable.body.totpURI).toMatch(/^otpauth:\/\/totp\/GSAM/);
    expect(enable.body.backupCodes).toHaveLength(10);

    // Not on until the first code is confirmed.
    const [beforeConfirm] = await db.select().from(authUsers).where(eq(authUsers.email, email));
    expect(beforeConfirm?.twoFactorEnabled).toBe(false);

    const confirm = await request(app)
      .post("/api/auth/two-factor/verify-totp")
      .set("origin", ORIGIN)
      .set("cookie", session)
      .send({ code: totpCode(enable.body.totpURI) });
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(200);
    const [afterConfirm] = await db.select().from(authUsers).where(eq(authUsers.email, email));
    expect(afterConfirm?.twoFactorEnabled).toBe(true);
    expect(await db.select().from(authTwoFactors).where(eq(authTwoFactors.userId, afterConfirm!.id))).toHaveLength(1);

    // The right password alone no longer gives a session.
    const signIn = await request(app)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email, password: PASSWORD });
    expect(signIn.status).toBe(200);
    expect(signIn.body?.twoFactorRedirect).toBe(true);
    expect(sessionCookies(signIn).filter((cookie) => !/Max-Age=0/i.test(cookie))).toHaveLength(0);

    const wrongCode = await request(app)
      .post("/api/auth/two-factor/verify-totp")
      .set("origin", ORIGIN)
      .set("cookie", cookieHeader(signIn))
      .send({ code: "000000" === totpCode(enable.body.totpURI) ? "111111" : "000000" });
    expect(wrongCode.status).toBe(401);

    const verify = await request(app)
      .post("/api/auth/two-factor/verify-totp")
      .set("origin", ORIGIN)
      .set("cookie", cookieHeader(signIn))
      .send({ code: totpCode(enable.body.totpURI) });
    expect(verify.status, JSON.stringify(verify.body)).toBe(200);
    expect(sessionCookies(verify).length).toBeGreaterThan(0);

    // A backup code also finishes a sign-in, once.
    const again = await request(app)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email, password: PASSWORD });
    const backup = await request(app)
      .post("/api/auth/two-factor/verify-backup-code")
      .set("origin", ORIGIN)
      .set("cookie", cookieHeader(again))
      .send({ code: enable.body.backupCodes[0] });
    expect(backup.status, JSON.stringify(backup.body)).toBe(200);
    expect(sessionCookies(backup).length).toBeGreaterThan(0);
  });

  it("holds a password-only session at setup while two-step sign-in is required, and a reset clears it", async () => {
    const withTwoStep = await signUpWithTwoStep("required-on@example.com");
    const plainSignUp = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email: "required-off@example.com", password: PASSWORD, name: "No Two Step" });
    const plain = cookieHeader(plainSignUp);
    expect((await request(app).get("/api/companies").set("cookie", plain)).status).toBe(200);

    await instanceSettingsService(db).updateGeneral({ requireTwoStepSignIn: true });
    clearTwoStepRequirementCache();
    try {
      const blocked = await request(app).get("/api/companies").set("cookie", plain);
      expect(blocked.status).toBe(403);
      expect(blocked.body?.details?.code).toBe("TWO_STEP_SETUP_REQUIRED");
      // Setup itself stays reachable.
      const enable = await request(app)
        .post("/api/auth/two-factor/enable")
        .set("origin", ORIGIN)
        .set("cookie", plain)
        .send({ password: PASSWORD });
      expect(enable.status, JSON.stringify(enable.body)).toBe(200);

      // A session with two-step sign-in on is not held, and cannot turn it off.
      expect((await request(app).get("/api/companies").set("cookie", withTwoStep.session)).status).toBe(200);
      const disable = await request(app)
        .post("/api/auth/two-factor/disable")
        .set("origin", ORIGIN)
        .set("cookie", withTwoStep.session)
        .send({ password: PASSWORD });
      expect(disable.status).toBe(403);
      const [stillOn] = await db.select().from(authUsers).where(eq(authUsers.id, withTwoStep.userId));
      expect(stillOn?.twoFactorEnabled).toBe(true);

      // Lost phone: the reset clears the key and signs the person out.
      const reset = await resetTwoStepSignIn(db, { userId: withTwoStep.userId });
      expect(reset).toMatchObject({ wasEnabled: true });
      expect(reset.sessionsRevoked).toBeGreaterThan(0);
      expect(await db.select().from(authTwoFactors).where(eq(authTwoFactors.userId, withTwoStep.userId))).toHaveLength(0);
      expect((await request(app).get("/api/companies").set("cookie", withTwoStep.session)).status).toBe(401);
      const signIn = await request(app)
        .post("/api/auth/sign-in/email")
        .set("origin", ORIGIN)
        .send({ email: "required-on@example.com", password: PASSWORD });
      expect(signIn.body?.twoFactorRedirect).toBeUndefined();
      const held = await request(app).get("/api/companies").set("cookie", cookieHeader(signIn));
      expect(held.status).toBe(403);
    } finally {
      await instanceSettingsService(db).updateGeneral({ requireTwoStepSignIn: false });
      clearTwoStepRequirementCache();
    }
  });

  it("locks an account after ten wrong passwords, even for the right one", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const wrong = await request(app)
        .post("/api/auth/sign-in/email")
        .set("origin", ORIGIN)
        .send({ email: EMAIL, password: `wrong-password-${attempt}` });
      expect(wrong.status).toBe(401);
    }

    const locked = await request(app)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email: EMAIL.toUpperCase(), password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.body?.code).toBe("SIGN_IN_LOCKED");
    expect(sessionCookies(locked)).toHaveLength(0);
  });
});
