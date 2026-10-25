/**
 * End to end through the real Better Auth mount (GRE-2387): an agent's
 * one-time QA login link makes a real session cookie, works once, and stops
 * working when the grant is revoked.
 */

import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, createDb } from "@greatstone/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedCompanyWithBoardAccess } from "./helpers/route-test-harness.js";
import { createBetterAuthHandler, createBetterAuthInstance, resolveBetterAuthSession } from "../auth/better-auth.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { qaLoginGuard } from "../middleware/qa-login-guard.js";
import { agentQaLoginRoutes } from "../routes/agent-qa-logins.js";
import { agentQaLoginService } from "../services/agent-qa-logins.js";
import type { Config } from "../config.js";

const ORIGIN = "http://127.0.0.1:41998";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

function sessionCookie(response: request.Response): string {
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return cookies.filter((c) => c.includes("session_token")).map((c) => c.split(";")[0]).join("; ");
}

describeEmbeddedPostgres("QA browser login through Better Auth (GRE-2387)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let app!: express.Express;
  let agentActor: Record<string, unknown> | null = null;
  const savedSecret = process.env.BETTER_AUTH_SECRET;
  const savedRateLimit = process.env.GSAM_AUTH_RATE_LIMIT_ENABLED;

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "qa-browser-login-integration-secret";
    process.env.GSAM_AUTH_RATE_LIMIT_ENABLED = "false";
    database = await startEmbeddedPostgresTestDatabase("gsam-qa-browser-login-int-");
    db = createDb(database.connectionString);
    const config = {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: ORIGIN,
      authDisableSignUp: true,
      allowedHostnames: ["127.0.0.1"],
      port: 41998,
    } as unknown as Config;
    const auth = createBetterAuthInstance(db, config, [ORIGIN]);
    app = express();
    // Test hook: a request with x-test-agent acts as the agent (stands in for its API key).
    app.use((req, _res, next) => {
      if (req.header("x-test-agent") && agentActor) (req as { actor?: unknown }).actor = agentActor;
      next();
    });
    const actor = actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: (req) => resolveBetterAuthSession(auth, req) });
    app.use((req, res, next) => (req.header("x-test-agent") ? next() : actor(req, res, next)));
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
    app.use("/api", express.json(), qaLoginGuard(), agentQaLoginRoutes(db, { authPublicBaseUrl: ORIGIN }));
    app.get("/api/whoami", (req, res) => res.json({ type: req.actor.type, userId: req.actor.userId ?? null, qaLogin: req.actor.qaLogin ?? null, companyIds: req.actor.companyIds ?? [] }));
    app.post("/api/approvals/:id/approve", (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);
  });

  afterAll(async () => {
    await database?.cleanup();
    if (savedSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = savedSecret;
    if (savedRateLimit === undefined) delete process.env.GSAM_AUTH_RATE_LIMIT_ENABLED;
    else process.env.GSAM_AUTH_RATE_LIMIT_ENABLED = savedRateLimit;
  });

  it("link -> session once; QA session is fenced; revoke ends it", async () => {
    const seeded = await seedCompanyWithBoardAccess(db, "QI");
    const agent = await db
      .insert(agents)
      .values({ companyId: seeded.companyId, name: "Flint", role: "qa", adapterType: "process", adapterConfig: {} })
      .returning()
      .then((rows) => rows[0]!);
    agentActor = { type: "agent", agentId: agent.id, companyId: seeded.companyId, source: "agent_key" };
    const svc = agentQaLoginService(db);
    const qa = await svc.grant({ companyId: seeded.companyId, agentId: agent.id, role: "viewer", grantedByUserId: seeded.userId });

    const issued = await request(app).post("/api/agents/me/qa-browser-login").set("x-test-agent", "1").expect(200);
    const link = new URL(issued.body.url);
    expect(link.origin).toBe(ORIGIN);
    const path = `${link.pathname}${link.search}`;

    const exchanged = await request(app).get(path).set("origin", ORIGIN);
    expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(302);
    expect(exchanged.headers.location).toBe("/");
    const cookie = sessionCookie(exchanged);
    expect(cookie).toContain("session_token");

    const me = await request(app).get("/api/whoami").set("cookie", cookie).expect(200);
    expect(me.body).toMatchObject({ type: "board", userId: qa.userId, companyIds: [seeded.companyId] });
    expect(me.body.qaLogin).toMatchObject({ loginId: qa.id, agentId: agent.id });

    // Fenced: cannot approve cards.
    await request(app).post("/api/approvals/x/approve").set("cookie", cookie).set("origin", ORIGIN).expect(403);

    // Works once.
    const again = await request(app).get(path).set("origin", ORIGIN);
    expect(again.status).toBe(401);
    expect(sessionCookie(again)).toBe("");

    // Revoke: the session is gone and a fresh link is refused.
    await svc.revoke({ companyId: seeded.companyId, agentId: agent.id, byUserId: seeded.userId });
    const after = await request(app).get("/api/whoami").set("cookie", cookie).expect(200);
    expect(after.body.type).not.toBe("board");
    await request(app).post("/api/agents/me/qa-browser-login").set("x-test-agent", "1").expect(404);
  });
});
