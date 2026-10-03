/**
 * Invite-backed sign-up while public sign-up is closed (`authDisableSignUp`).
 *
 * Runs the real Better Auth mount, the real actor middleware and the real
 * invite routes against a migrated Postgres, and proves:
 *
 * - a sign-up with no invite, or with an unknown, expired, revoked, already
 *   accepted or agent-only invite, is refused exactly as Better Auth's own
 *   closed sign-up refuses it (same status, same body);
 * - a valid human (or `both`) company invite, and a bootstrap invite, let the
 *   invitee create an account without consuming the invite, and the normal
 *   accept call then grants the invite's role;
 * - with sign-up open nothing changes, with or without a token;
 * - sign-in and Better Auth's rate limiting are untouched.
 */

import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  invites,
} from "@greatstone/db";
import { INVITE_SIGN_UP_TOKEN_HEADER } from "@greatstone/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import type { Config } from "../config.js";

vi.hoisted(() => {
  process.env.GSAM_HOME = "/tmp/paperclip-test-home";
  process.env.GSAM_INSTANCE_ID = "vitest";
  process.env.GSAM_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.GSAM_IN_WORKTREE = "false";
});

const ORIGIN = "http://127.0.0.1:41997";
const PASSWORD = "a-long-enough-password";
const OWNER_EMAIL = "owner@example.com";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

function authConfig(disableSignUp: boolean): Config {
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    authBaseUrlMode: "explicit",
    authPublicBaseUrl: ORIGIN,
    authDisableSignUp: disableSignUp,
    allowedHostnames: ["127.0.0.1"],
    port: 41997,
  } as unknown as Config;
}

function sessionCookie(response: request.Response): string {
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

describeEmbeddedPostgres("invite-backed sign-up while public sign-up is closed", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: Db;
  let betterAuthModule!: typeof import("../auth/better-auth.js");
  let accessModule!: typeof import("../routes/access.js");
  let actorModule!: typeof import("../middleware/auth.js");
  let errorModule!: typeof import("../middleware/error-handler.js");
  let hashModule!: typeof import("../lib/invite-token-hash.js");
  let closedApp!: express.Express;
  let openApp!: express.Express;
  let referenceApp!: express.Express;
  let companyId = "";
  let ownerCookie = "";
  const envKeys = ["BETTER_AUTH_SECRET", "GSAM_AUTH_RATE_LIMIT_ENABLED"] as const;
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

  /** GSAM's mount: Better Auth, then the actor middleware and the invite routes. */
  function buildApp(disableSignUp: boolean) {
    const auth = betterAuthModule.createBetterAuthInstance(db, authConfig(disableSignUp), [ORIGIN]);
    const app = express();
    app.all("/api/auth/{*authPath}", betterAuthModule.createBetterAuthHandler(auth));
    app.use(express.json());
    app.use(
      actorModule.actorMiddleware(db, {
        deploymentMode: "authenticated",
        resolveSession: (req) => betterAuthModule.resolveBetterAuthSession(auth, req),
      }),
    );
    app.use(
      "/api",
      accessModule.accessRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        bindHost: "127.0.0.1",
        allowedHostnames: ["127.0.0.1"],
      }),
    );
    app.use(errorModule.errorHandler);
    return app;
  }

  /** Better Auth's own closed sign-up, as GSAM configured it before this change. */
  function buildReferenceApp() {
    const auth = betterAuth({
      baseURL: ORIGIN,
      secret: process.env.BETTER_AUTH_SECRET!,
      trustedOrigins: [ORIGIN],
      database: drizzleAdapter(db, {
        provider: "pg",
        schema: {
          user: authUsers,
          session: authSessions,
          account: authAccounts,
          verification: authVerifications,
        },
      }),
      emailAndPassword: { enabled: true, requireEmailVerification: false, disableSignUp: true },
      rateLimit: { enabled: false },
      advanced: betterAuthModule.buildBetterAuthAdvancedOptions({ disableSecureCookies: true }),
    });
    const app = express();
    app.all("/api/auth/{*authPath}", betterAuthModule.createBetterAuthHandler(auth));
    return app;
  }

  function signUp(app: express.Express, email: string, token?: string, ip?: string) {
    const pending = request(app).post("/api/auth/sign-up/email").set("origin", ORIGIN);
    if (token !== undefined) pending.set(INVITE_SIGN_UP_TOKEN_HEADER, token);
    if (ip) pending.set("x-forwarded-for", ip);
    return pending.send({ email, password: PASSWORD, name: "Invitee" });
  }

  async function referenceRefusal(email: string) {
    const reference = await signUp(referenceApp, email);
    expect(reference.status).toBe(400);
    expect(reference.body).toMatchObject({ code: "EMAIL_PASSWORD_SIGN_UP_DISABLED" });
    return reference;
  }

  async function expectRefusedLikeBetterAuth(response: request.Response, email: string) {
    const reference = await referenceRefusal(email);
    expect(response.status).toBe(reference.status);
    expect(response.body).toEqual(reference.body);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(await userExists(email)).toBe(false);
  }

  async function userExists(email: string) {
    const rows = await db.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.email, email));
    return rows.length > 0;
  }

  async function createInvite(body: Record<string, unknown>) {
    const res = await request(closedApp)
      .post(`/api/companies/${companyId}/invites`)
      .set("origin", ORIGIN)
      .set("cookie", ownerCookie)
      .send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: res.body.id as string, token: res.body.token as string };
  }

  async function loadInvite(id: string) {
    return db.select().from(invites).where(eq(invites.id, id)).then((rows) => rows[0]!);
  }

  beforeAll(async () => {
    betterAuthModule = await import("../auth/better-auth.js");
    accessModule = await import("../routes/access.js");
    actorModule = await import("../middleware/auth.js");
    errorModule = await import("../middleware/error-handler.js");
    hashModule = await import("../lib/invite-token-hash.js");

    database = await startEmbeddedPostgresTestDatabase("paperclip-invite-sign-up-");
    db = createDb(database.connectionString);
    process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
    // Off for the functional cases, which sign up back to back; the rate limit
    // case below builds its own instance with it on.
    process.env.GSAM_AUTH_RATE_LIMIT_ENABLED = "false";

    openApp = buildApp(false);
    closedApp = buildApp(true);
    referenceApp = buildReferenceApp();

    // The owner signs up while sign-up is still open, then runs the company.
    const ownerSignUp = await signUp(openApp, OWNER_EMAIL);
    expect(ownerSignUp.status).toBe(200);
    const ownerId = ownerSignUp.body.user.id as string;
    await db.insert(instanceUserRoles).values({ userId: ownerId, role: "instance_admin" });
    const company = await db
      .insert(companies)
      .values({ name: "Invite Co", issuePrefix: `IV${randomUUID().slice(0, 4).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    companyId = company.id;
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: ownerId,
      status: "active",
      membershipRole: "owner",
    });

    const signIn = await request(closedApp)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email: OWNER_EMAIL, password: PASSWORD });
    expect(signIn.status).toBe(200);
    ownerCookie = sessionCookie(signIn);
  }, 120_000);

  afterAll(async () => {
    await database?.cleanup();
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  describe("with sign-up closed", () => {
    it("refuses a sign-up with no invite token exactly as Better Auth's closed sign-up does", async () => {
      const response = await signUp(closedApp, "no-token@example.com");
      await expectRefusedLikeBetterAuth(response, "no-token@example.com");
    });

    it("gives the same refusal for an email that already has an account", async () => {
      const response = await signUp(closedApp, OWNER_EMAIL);
      const reference = await referenceRefusal(OWNER_EMAIL);
      expect(response.status).toBe(reference.status);
      expect(response.body).toEqual(reference.body);
    });

    it.each([
      ["an unknown token", `pcp_invite_${randomBytes(32).toString("base64url")}`],
      ["an empty token", ""],
      ["a blank token", "   "],
      ["an overlong token", `pcp_invite_${"a".repeat(4096)}`],
    ])("refuses a sign-up carrying %s", async (_label, token) => {
      const email = `unknown-${randomUUID()}@example.com`;
      const response = await signUp(closedApp, email, token);
      await expectRefusedLikeBetterAuth(response, email);
    });

    it("refuses a sign-up with an expired invite", async () => {
      const invite = await createInvite({ allowedJoinTypes: "human", humanRole: "viewer" });
      await db
        .update(invites)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(invites.id, invite.id));
      const response = await signUp(closedApp, "expired@example.com", invite.token);
      await expectRefusedLikeBetterAuth(response, "expired@example.com");
    });

    it("refuses a sign-up with a revoked invite", async () => {
      const invite = await createInvite({ allowedJoinTypes: "human", humanRole: "viewer" });
      await request(closedApp)
        .post(`/api/invites/${invite.id}/revoke`)
        .set("origin", ORIGIN)
        .set("cookie", ownerCookie)
        .expect(200);
      const response = await signUp(closedApp, "revoked@example.com", invite.token);
      await expectRefusedLikeBetterAuth(response, "revoked@example.com");
    });

    it("refuses a sign-up with an agent-only invite", async () => {
      const invite = await createInvite({ allowedJoinTypes: "agent" });
      const response = await signUp(closedApp, "agent-only@example.com", invite.token);
      await expectRefusedLikeBetterAuth(response, "agent-only@example.com");
      expect((await loadInvite(invite.id)).acceptedAt).toBeNull();
    });

    it("creates the account for a valid human invite without consuming it, then accepts it with the invite's role", async () => {
      const invite = await createInvite({ allowedJoinTypes: "human", humanRole: "viewer" });

      const created = await signUp(closedApp, "ben@example.com", invite.token);
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      expect(created.body.user.email).toBe("ben@example.com");
      const benId = created.body.user.id as string;
      const benCookie = sessionCookie(created);
      expect(benCookie).toContain("session_token");

      // Creating the account did not accept, revoke or otherwise touch the invite.
      const afterSignUp = await loadInvite(invite.id);
      expect(afterSignUp.acceptedAt).toBeNull();
      expect(afterSignUp.revokedAt).toBeNull();
      const membershipsBeforeAccept = await db
        .select()
        .from(companyMemberships)
        .where(eq(companyMemberships.principalId, benId));
      expect(membershipsBeforeAccept).toHaveLength(0);
      await request(closedApp).get(`/api/invites/${invite.token}`).expect(200);

      // The landing page's normal accept call then grants the invite's role.
      const accepted = await request(closedApp)
        .post(`/api/invites/${invite.token}/accept`)
        .set("origin", ORIGIN)
        .set("cookie", benCookie)
        .send({ requestType: "human" });
      expect([200, 201, 202], JSON.stringify(accepted.body)).toContain(accepted.status);
      expect(accepted.body.status).toBe("approved");

      const membership = await db
        .select()
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, benId),
          ),
        )
        .then((rows) => rows[0]);
      expect(membership).toMatchObject({ status: "active", membershipRole: "viewer" });
      expect((await loadInvite(invite.id)).acceptedAt).not.toBeNull();

      // Once accepted, the invite no longer admits a new account.
      const again = await signUp(closedApp, "ben-again@example.com", invite.token);
      await expectRefusedLikeBetterAuth(again, "ben-again@example.com");
    });

    it("lets a sign-up through for an invite that allows both humans and agents", async () => {
      const invite = await createInvite({ allowedJoinTypes: "both", humanRole: "operator" });
      const created = await signUp(closedApp, "both@example.com", ` ${invite.token} `);
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      expect((await loadInvite(invite.id)).acceptedAt).toBeNull();
    });

    it("lets a sign-up through for a pending bootstrap invite without consuming it", async () => {
      // Written the way `gsam auth bootstrap-ceo` writes it.
      const token = `pcp_bootstrap_${randomBytes(24).toString("hex")}`;
      const invite = await db
        .insert(invites)
        .values({
          inviteType: "bootstrap_ceo",
          tokenHash: hashModule.hashInviteToken(token),
          allowedJoinTypes: "human",
          expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
          invitedByUserId: "system",
        })
        .returning()
        .then((rows) => rows[0]!);

      const created = await signUp(closedApp, "bootstrap@example.com", token);
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      expect((await loadInvite(invite.id)).acceptedAt).toBeNull();
    });

    it("leaves sign-in unchanged", async () => {
      await request(closedApp)
        .post("/api/auth/sign-in/email")
        .set("origin", ORIGIN)
        .send({ email: OWNER_EMAIL, password: PASSWORD })
        .expect(200);
      await request(closedApp)
        .post("/api/auth/sign-in/email")
        .set("origin", ORIGIN)
        .send({ email: OWNER_EMAIL, password: "not-the-password" })
        .expect(401);
    });

    it("still applies Better Auth's sign-up rate limit, before the invite is even looked at", async () => {
      const previous = process.env.GSAM_AUTH_RATE_LIMIT_ENABLED;
      process.env.GSAM_AUTH_RATE_LIMIT_ENABLED = "true";
      let limitedApp: express.Express;
      try {
        limitedApp = buildApp(true);
      } finally {
        process.env.GSAM_AUTH_RATE_LIMIT_ENABLED = previous;
      }
      const invite = await createInvite({ allowedJoinTypes: "human", humanRole: "viewer" });
      const ip = "203.0.113.77";
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const refused = await signUp(limitedApp, `limited-${attempt}@example.com`, undefined, ip);
        expect(refused.status).toBe(400);
      }
      const limited = await signUp(limitedApp, "limited-valid@example.com", invite.token, ip);
      expect(limited.status).toBe(429);
      expect(await userExists("limited-valid@example.com")).toBe(false);
      expect((await loadInvite(invite.id)).acceptedAt).toBeNull();
    });
  });

  describe("with sign-up open", () => {
    it("creates accounts with or without a token, exactly as before", async () => {
      const plain = await signUp(openApp, "open-plain@example.com");
      expect(plain.status).toBe(200);
      const junkToken = await signUp(openApp, "open-junk@example.com", "not-an-invite");
      expect(junkToken.status).toBe(200);

      const invite = await createInvite({ allowedJoinTypes: "human", humanRole: "viewer" });
      const withInvite = await signUp(openApp, "open-invite@example.com", invite.token);
      expect(withInvite.status).toBe(200);
      expect((await loadInvite(invite.id)).acceptedAt).toBeNull();

      const agentInvite = await createInvite({ allowedJoinTypes: "agent" });
      const withAgentInvite = await signUp(openApp, "open-agent-invite@example.com", agentInvite.token);
      expect(withAgentInvite.status).toBe(200);
    });
  });
});
