/**
 * GRE-125: moving an install that ran `local_trusted` to `authenticated` +
 * `private`, as `doc/AUTH-SWITCH-RUNBOOK.md` does it. Runs the real Better Auth
 * mount and the real actor middleware against a migrated Postgres that was
 * seeded the way a `local_trusted` install leaves it (local-board owns every
 * company and every agent key), and proves:
 *
 * - the owner signs up once, claims the board, and signs in;
 * - agent keys and run tokens made before the switch still authenticate;
 * - board-only routes refuse a request with no session;
 * - `resetCredentialPassword` is a working way back in, and signs devices out;
 * - once sign-up is closed, nobody else can create an account.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeys,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  createBetterAuthHandler,
  createBetterAuthInstance,
  resolveBetterAuthSession,
} from "../auth/better-auth.js";
import { resetCredentialPassword } from "../auth/reset-password.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { claimBoardOwnership, getBoardClaimWarningUrl, initializeBoardClaimChallenge } from "../board-claim.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { assertAuthenticated, assertBoard, assertCompanyAccess, assertInstanceAdmin } from "../routes/authz.js";
import type { Config } from "../config.js";

const ORIGIN = "http://127.0.0.1:41998";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = "first-password-for-the-owner";
const NEW_PASSWORD = "second-password-after-reset";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function authConfig(disableSignUp: boolean): Config {
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    authBaseUrlMode: "explicit",
    authPublicBaseUrl: ORIGIN,
    authDisableSignUp: disableSignUp,
    allowedHostnames: ["127.0.0.1", "localhost"],
    port: 41998,
  } as unknown as Config;
}

function sessionCookie(response: request.Response): string {
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

function buildApp(db: ReturnType<typeof createDb>, disableSignUp: boolean) {
  const auth = createBetterAuthInstance(db, authConfig(disableSignUp), [ORIGIN]);
  const app = express();
  app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
  app.use(express.json());
  app.use(
    actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: (req) => resolveBetterAuthSession(auth, req),
    }),
  );
  app.get("/api/whoami", (req, res) => {
    assertAuthenticated(req);
    res.json({ type: req.actor.type, source: req.actor.source });
  });
  app.get("/api/board-only", (req, res) => {
    assertBoard(req);
    res.json({ ok: true, userId: req.actor.userId });
  });
  app.get("/api/instance-admin-only", (req, res) => {
    assertBoard(req);
    assertInstanceAdmin(req);
    res.json({ ok: true });
  });
  app.get("/api/companies/:companyId/work", (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.json({ ok: true, type: req.actor.type, source: req.actor.source });
  });
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("switching a local_trusted install to authenticated + private", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: express.Express;
  let companyId!: string;
  let agentId!: string;
  let ownerCookie = "";
  let runTokenFromBeforeTheSwitch!: string;
  const agentKey = `pcak_${randomBytes(16).toString("hex")}`;
  const envKeys = [
    "BETTER_AUTH_SECRET",
    "GSAM_AGENT_JWT_SECRET",
    "GSAM_AUTH_RATE_LIMIT_ENABLED",
    "GSAM_HOME",
    "GSAM_INSTANCE_ID",
  ] as const;
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsam-auth-switch-"));

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-auth-switch-");
    db = createDb(database.connectionString);

    // Before the switch: a local_trusted install with no auth secrets, whose
    // run tokens are signed with the generated per-instance key file.
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.GSAM_AGENT_JWT_SECRET;
    process.env.GSAM_HOME = homeDir;
    process.env.GSAM_INSTANCE_ID = "auth-switch";
    process.env.GSAM_AUTH_RATE_LIMIT_ENABLED = "false";

    const now = new Date();
    await db.insert(authUsers).values({
      id: "local-board",
      name: "Board",
      email: "local@paperclip.local",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(instanceUserRoles).values({ userId: "local-board", role: "instance_admin" });
    const company = await db
      .insert(companies)
      .values({ name: "Switch Co", issuePrefix: `SW${randomUUID().slice(0, 4).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    companyId = company.id;
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "local-board",
      status: "active",
      membershipRole: "owner",
    });
    const agent = await db
      .insert(agents)
      .values({ companyId, name: "Worker", role: "engineer", adapterType: "process", adapterConfig: {} })
      .returning()
      .then((rows) => rows[0]!);
    agentId = agent.id;
    await db.insert(agentApiKeys).values({
      companyId,
      agentId,
      name: "made under local_trusted",
      keyHash: createHash("sha256").update(agentKey).digest("hex"),
      responsibleUserId: "local-board",
    });
    runTokenFromBeforeTheSwitch = createLocalAgentJwt(agentId, companyId, "process", randomUUID(), "local-board")!;
    expect(runTokenFromBeforeTheSwitch).toBeTruthy();

    // The switch, as `gsam auth mode authenticated` writes it: a new Better
    // Auth secret, and the agent JWT secret pinned to the generated key.
    const keyFile = path.join(homeDir, "instances", "auth-switch", "secrets", "agent-jwt.key");
    process.env.GSAM_AGENT_JWT_SECRET = fs.readFileSync(keyFile, "utf8").trim();
    process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");

    app = buildApp(db, false);
  }, 60_000);

  afterAll(async () => {
    await initializeBoardClaimChallenge(db, { deploymentMode: "local_trusted" });
    await database?.cleanup();
    fs.rmSync(homeDir, { recursive: true, force: true });
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it("refuses board-only routes when there is no session", async () => {
    await request(app).get("/api/whoami").expect(401);
    await request(app).get("/api/board-only").expect(403);
    await request(app).get("/api/instance-admin-only").expect(403);
    await request(app).get(`/api/companies/${companyId}/work`).expect(401);
  });

  it("lets the owner sign up once, claim the board and sign in", async () => {
    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD, name: "Owner" });
    expect(signUp.status).toBe(200);
    const ownerId = signUp.body.user.id as string;

    // Signed in but not yet the owner: local-board still holds the board.
    const beforeClaim = sessionCookie(signUp);
    await request(app).get("/api/instance-admin-only").set("cookie", beforeClaim).expect(403);

    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    const claimUrl = new URL(getBoardClaimWarningUrl("127.0.0.1", 41998)!);
    await expect(
      claimBoardOwnership(db, {
        token: claimUrl.pathname.split("/").pop()!,
        code: claimUrl.searchParams.get("code")!,
        userId: ownerId,
      }),
    ).resolves.toMatchObject({ status: "claimed" });

    const signIn = await request(app)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD });
    expect(signIn.status).toBe(200);
    ownerCookie = sessionCookie(signIn);

    const board = await request(app).get("/api/board-only").set("cookie", ownerCookie).expect(200);
    expect(board.body.userId).toBe(ownerId);
    await request(app).get("/api/instance-admin-only").set("cookie", ownerCookie).expect(200);
    await request(app).get(`/api/companies/${companyId}/work`).set("cookie", ownerCookie).expect(200);
  });

  it("still accepts agent keys and run tokens made before the switch", async () => {
    const byKey = await request(app)
      .get(`/api/companies/${companyId}/work`)
      .set("authorization", `Bearer ${agentKey}`)
      .expect(200);
    expect(byKey.body).toMatchObject({ type: "agent", source: "agent_key" });

    const byRunToken = await request(app)
      .get(`/api/companies/${companyId}/work`)
      .set("authorization", `Bearer ${runTokenFromBeforeTheSwitch}`)
      .expect(200);
    expect(byRunToken.body).toMatchObject({ type: "agent", source: "agent_jwt" });

    // An agent credential is not a board session.
    await request(app).get("/api/board-only").set("authorization", `Bearer ${agentKey}`).expect(403);
  });

  it("would break run tokens if the agent JWT secret were not pinned", async () => {
    const pinned = process.env.GSAM_AGENT_JWT_SECRET;
    delete process.env.GSAM_AGENT_JWT_SECRET;
    try {
      await request(app)
        .get(`/api/companies/${companyId}/work`)
        .set("authorization", `Bearer ${runTokenFromBeforeTheSwitch}`)
        .expect(401);
    } finally {
      process.env.GSAM_AGENT_JWT_SECRET = pinned;
    }
  });

  it("resets the password, signs every device out, and accepts only the new password", async () => {
    const result = await resetCredentialPassword(db, { email: OWNER_EMAIL.toUpperCase(), newPassword: NEW_PASSWORD });
    expect(result.email).toBe(OWNER_EMAIL);
    expect(result.sessionsRevoked).toBeGreaterThan(0);

    await request(app).get("/api/board-only").set("cookie", ownerCookie).expect(403);
    await request(app)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD })
      .expect(401);
    const signIn = await request(app)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email: OWNER_EMAIL, password: NEW_PASSWORD });
    expect(signIn.status).toBe(200);
    await request(app).get("/api/board-only").set("cookie", sessionCookie(signIn)).expect(200);

    // Same password again: same outcome, no error.
    await expect(
      resetCredentialPassword(db, { email: OWNER_EMAIL, newPassword: NEW_PASSWORD }),
    ).resolves.toMatchObject({ email: OWNER_EMAIL });
  });

  it("refuses a reset for an unknown user or a too-short password", async () => {
    await expect(
      resetCredentialPassword(db, { email: "nobody@example.com", newPassword: NEW_PASSWORD }),
    ).rejects.toMatchObject({ code: "user_not_found" });
    await expect(
      resetCredentialPassword(db, { email: OWNER_EMAIL, newPassword: "short" }),
    ).rejects.toMatchObject({ code: "invalid_password" });
    await expect(
      resetCredentialPassword(db, { email: "local@paperclip.local", newPassword: NEW_PASSWORD }),
    ).rejects.toMatchObject({ code: "no_password_sign_in" });
  });

  it("refuses a second account once sign-up is closed", async () => {
    const closed = buildApp(db, true);
    const signUp = await request(closed)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email: "intruder@example.com", password: "another-long-password", name: "Intruder" });
    expect(signUp.status).toBeGreaterThanOrEqual(400);
    await request(closed)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email: OWNER_EMAIL, password: NEW_PASSWORD })
      .expect(200);
  });
});
