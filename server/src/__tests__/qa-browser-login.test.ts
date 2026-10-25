import { eq } from "drizzle-orm";
import request from "supertest";
import {
  activityLog,
  agentQaLogins,
  agents,
  authAccounts,
  authSessions,
  authUsers,
  boardApiKeys,
  type Db,
} from "@greatstone/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  exchangeQaBrowserLoginTicket,
  issueQaBrowserLoginTicket,
  QA_BROWSER_LOGIN_TICKET_TTL_SECONDS,
  QA_BROWSER_SESSION_MAX_AGE_MS,
  resolveQaBrowserLoginKey,
  verifyQaBrowserLoginTicket,
  type QaBrowserLoginExchangeDeps,
} from "../auth/qa-browser-login.js";
import { narrowForQaLogin } from "../middleware/auth.js";
import { agentQaLoginRoutes } from "../routes/agent-qa-logins.js";
import { agentQaLoginService } from "../services/agent-qa-logins.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

const KEY = "test-qa-key";
const NOW = new Date("2026-10-25T10:00:00Z");
const ids = { userId: "u1", loginId: "l1", companyId: "c1", agentId: "a1" };

function deps(overrides: Partial<QaBrowserLoginExchangeDeps> = {}) {
  const used = new Set<string>();
  return {
    isGrantLive: vi.fn(async () => true),
    reserveNonce: vi.fn(async ({ nonce }: { nonce: string }) => (used.has(nonce) ? false : (used.add(nonce), true))),
    createSession: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("QA browser login ticket (GRE-2387)", () => {
  it("verifies its own ticket and binds user, grant, company and agent", () => {
    const { ticket } = issueQaBrowserLoginTicket({ key: KEY, ...ids, now: NOW });
    const result = verifyQaBrowserLoginTicket({ ticket, key: KEY, now: NOW });
    expect(result).toMatchObject({ ok: true, payload: { sub: "u1", lid: "l1", cid: "c1", aid: "a1" } });
    if (result.ok) expect(result.payload.exp - result.payload.iat).toBe(QA_BROWSER_LOGIN_TICKET_TTL_SECONDS);
  });

  it("refuses a wrong key, a changed payload, a late ticket and no key", () => {
    const { ticket } = issueQaBrowserLoginTicket({ key: KEY, ...ids, now: NOW });
    expect(verifyQaBrowserLoginTicket({ ticket, key: "other", now: NOW })).toEqual({ ok: false, reason: "bad_signature" });
    const [v, , sig] = ticket.split(".");
    const forged = Buffer.from(JSON.stringify({ v: "qa1", jti: "j", sub: "admin", lid: "l1", cid: "c1", aid: "a1", iat: 0, exp: 90 })).toString("base64url");
    expect(verifyQaBrowserLoginTicket({ ticket: `${v}.${forged}.${sig}`, key: KEY, now: NOW })).toEqual({ ok: false, reason: "bad_signature" });
    const late = new Date(NOW.getTime() + (QA_BROWSER_LOGIN_TICKET_TTL_SECONDS + 10) * 1000);
    expect(verifyQaBrowserLoginTicket({ ticket, key: KEY, now: late })).toEqual({ ok: false, reason: "expired" });
    expect(verifyQaBrowserLoginTicket({ ticket, key: null, now: NOW })).toEqual({ ok: false, reason: "not_configured" });
    expect(verifyQaBrowserLoginTicket({ ticket: "x.y", key: KEY, now: NOW })).toEqual({ ok: false, reason: "malformed" });
  });

  it("derives a key only from the server auth secret, separate from the secret itself", () => {
    expect(resolveQaBrowserLoginKey({})).toBeNull();
    const key = resolveQaBrowserLoginKey({ BETTER_AUTH_SECRET: "s" });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toBe("s");
  });

  it("exchange: works once, and only while the grant is live", async () => {
    const { ticket } = issueQaBrowserLoginTicket({ key: KEY, ...ids, now: NOW });
    const d = deps();
    expect(await exchangeQaBrowserLoginTicket({ ticket, key: KEY, deps: d, now: NOW })).toMatchObject({ ok: true });
    expect(d.createSession).toHaveBeenCalledWith("u1");
    expect(await exchangeQaBrowserLoginTicket({ ticket, key: KEY, deps: d, now: NOW })).toMatchObject({ ok: false, reason: "replayed" });
    expect(d.createSession).toHaveBeenCalledTimes(1);

    const dead = deps({ isGrantLive: vi.fn(async () => false) });
    expect(await exchangeQaBrowserLoginTicket({ ticket, key: KEY, deps: dead, now: NOW })).toMatchObject({ ok: false, reason: "grant_not_live" });
    expect(dead.reserveNonce).not.toHaveBeenCalled();
    expect(dead.createSession).not.toHaveBeenCalled();
  });
});

describe("QA browser session cap (GRE-2387)", () => {
  const standing = { kind: "active" as const, loginId: "l1", companyId: "c1", agentId: "a1", expiresAt: new Date(Date.now() + 86_400_000) };
  const memberships = [{ companyId: "c1" }, { companyId: "c2" }];

  it("keeps a fresh QA session to its own company", () => {
    expect(narrowForQaLogin(standing, memberships, new Date())?.memberships).toEqual([{ companyId: "c1" }]);
  });

  it("refuses a QA session older than 8 hours, or one with no start time", () => {
    expect(narrowForQaLogin(standing, memberships, new Date(Date.now() - QA_BROWSER_SESSION_MAX_AGE_MS - 1000))).toBeNull();
    expect(narrowForQaLogin(standing, memberships, null)).toBeNull();
  });

  it("does not touch a normal user's session", () => {
    expect(narrowForQaLogin({ kind: "not_qa" }, memberships, new Date(0))?.memberships).toEqual(memberships);
  });
});

describeEmbeddedPostgres("POST /agents/me/qa-browser-login (GRE-2387)", () => {
  const ctx = useEmbeddedPostgres("gsam-qa-browser-login-", {
    resetEach: async (db) => {
      await db.delete(agentQaLogins);
      await db.delete(activityLog);
      await db.delete(boardApiKeys);
      await db.delete(authSessions);
      await db.delete(authAccounts);
      await db.delete(authUsers);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
    },
  });

  const savedSecret = process.env.BETTER_AUTH_SECRET;
  beforeAll(() => {
    process.env.BETTER_AUTH_SECRET = "qa-browser-login-test-secret";
  });
  afterAll(() => {
    if (savedSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = savedSecret;
  });

  async function seed(db: Db) {
    const seeded = await seedCompanyWithBoardAccess(db, "QB");
    const agent = await db
      .insert(agents)
      .values({ companyId: seeded.companyId, name: "Flint", role: "qa", adapterType: "process", adapterConfig: {} })
      .returning()
      .then((rows) => rows[0]!);
    const agentActor = { type: "agent", agentId: agent.id, companyId: seeded.companyId, source: "agent_key" };
    return { ...seeded, agentId: agent.id, agentActor };
  }

  it("gives the agent a one-time link for its live grant, and audits it without the link", async () => {
    const { companyId, userId, agentId, agentActor } = await seed(ctx.db);
    const svc = agentQaLoginService(ctx.db);
    const qa = await svc.grant({ companyId, agentId, role: "viewer", grantedByUserId: userId });

    const res = await request(routeApp(ctx.db, agentActor as never, agentQaLoginRoutes)).post("/api/agents/me/qa-browser-login").expect(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({ email: qa.email, role: "viewer", accessExpiresAt: qa.expiresAt });
    const url = new URL(res.body.url);
    expect(url.pathname).toBe("/api/auth/qa-login/exchange");
    const verified = verifyQaBrowserLoginTicket({ ticket: url.searchParams.get("ticket"), key: resolveQaBrowserLoginKey() });
    expect(verified).toMatchObject({ ok: true, payload: { sub: qa.userId, lid: qa.id, cid: companyId, aid: agentId } });

    const [entry] = await ctx.db.select().from(activityLog).where(eq(activityLog.action, "agent_qa_login.browser_login_issued"));
    expect(entry).toMatchObject({ actorType: "agent", actorId: agentId });
    expect(JSON.stringify(entry!.details)).not.toContain(url.searchParams.get("ticket")!);
  });

  it("refuses with no grant, after revoke, and for a board user", async () => {
    const { companyId, userId, agentId, agentActor, actor } = await seed(ctx.db);
    const agentApp = routeApp(ctx.db, agentActor as never, agentQaLoginRoutes);
    await request(agentApp).post("/api/agents/me/qa-browser-login").expect(404);

    const svc = agentQaLoginService(ctx.db);
    const qa = await svc.grant({ companyId, agentId, role: "operator", grantedByUserId: userId });
    await request(routeApp(ctx.db, actor, agentQaLoginRoutes)).post("/api/agents/me/qa-browser-login").expect(401);

    await svc.revoke({ companyId, agentId, byUserId: userId });
    await request(agentApp).post("/api/agents/me/qa-browser-login").expect(404);
    expect(await svc.isGrantLive({ loginId: qa.id, userId: qa.userId, companyId, agentId })).toBe(false);
  });

  it("isGrantLive is false past expiry and for another agent", async () => {
    const { companyId, userId, agentId } = await seed(ctx.db);
    const svc = agentQaLoginService(ctx.db);
    const qa = await svc.grant({ companyId, agentId, role: "viewer", expiresInDays: 1, grantedByUserId: userId, now: NOW });
    const live = { loginId: qa.id, userId: qa.userId, companyId, agentId };
    expect(await svc.isGrantLive({ ...live, now: NOW })).toBe(true);
    expect(await svc.isGrantLive({ ...live, now: new Date(NOW.getTime() + 2 * 86_400_000) })).toBe(false);
    expect(await svc.isGrantLive({ ...live, agentId: "00000000-0000-0000-0000-000000000000", now: NOW })).toBe(false);
  });
});
