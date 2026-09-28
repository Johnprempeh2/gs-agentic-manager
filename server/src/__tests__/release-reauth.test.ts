// Password re-check for release, rollback and promote (GRE-133).
import express, { Router } from "express";
import request from "supertest";
import { hashPassword } from "better-auth/crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { releaseReauthRoutes } from "../routes/release-reauth.js";
import {
  RELEASE_REAUTH_ACTIONS,
  RELEASE_REAUTH_HEADER,
  RELEASE_REAUTH_TTL_MS,
  assertReleaseReauth,
  createReleaseReauth,
  credentialPasswordVerifier,
  type ReleaseReauth,
} from "../services/release-reauth.js";

const GOOD = "sandbox-test-pass";

const john = { type: "board", userId: "john", sessionId: "sess-1", source: "session", companyIds: [], isInstanceAdmin: true };
const johnOtherDevice = { ...john, sessionId: "sess-2" };
const boardKey = { type: "board", userId: "john", source: "board_key", keyId: "key-1", companyIds: [] };
const localBoard = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };
const agentKey = { type: "agent", agentId: "agent-1", companyId: "c1", source: "agent_key" };
const agentJwt = { type: "agent", agentId: "agent-1", companyId: "c1", source: "agent_jwt", runId: "run-1" };

let clock = 1_000_000;

function makeReauth() {
  return createReleaseReauth({
    verifyPassword: async (userId, password) => userId === "john" && password === GOOD,
    now: () => clock,
  });
}

// Stand-ins for the GRE-121 and GRE-127 routes: board guard, then the shared check.
function actionRoutes(reauth: ReleaseReauth) {
  const router = Router();
  for (const action of RELEASE_REAUTH_ACTIONS) {
    router.post(`/test/${action}`, (req, res) => {
      assertReleaseReauth(req, action, reauth);
      res.json({ ok: true, action });
    });
  }
  return router;
}

function createApp(reauth: ReleaseReauth) {
  let actor: Record<string, unknown> = john;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", releaseReauthRoutes({} as any, reauth));
  app.use("/api", actionRoutes(reauth));
  app.use(errorHandler);
  return { app, as: (next: Record<string, unknown>) => { actor = next; } };
}

async function getToken(app: express.Express, action: string) {
  const res = await request(app).post("/api/reauth").send({ action, password: GOOD });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

describe("release re-check service", () => {
  beforeEach(() => {
    clock = 1_000_000;
  });

  it("gives a token for the right password, good once, for one action, user and session", async () => {
    const reauth = makeReauth();
    const result = await reauth.issue({ userId: "john", sessionId: "s1", action: "release", password: GOOD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(reauth.consume(result.token, { userId: "john", sessionId: "s1", action: "rollback" })).toBe(false);
    expect(reauth.consume(result.token, { userId: "other", sessionId: "s1", action: "release" })).toBe(false);
    expect(reauth.consume(result.token, { userId: "john", sessionId: "s2", action: "release" })).toBe(false);
    expect(reauth.consume(result.token, { userId: "john", sessionId: "s1", action: "release" })).toBe(true);
    expect(reauth.consume(result.token, { userId: "john", sessionId: "s1", action: "release" })).toBe(false);
  });

  it("refuses a wrong or empty password and an expired token", async () => {
    const reauth = makeReauth();
    expect(await reauth.issue({ userId: "john", sessionId: null, action: "promote", password: "wrong" })).toEqual({ ok: false, reason: "invalid_password" });
    expect(await reauth.issue({ userId: "john", sessionId: null, action: "promote", password: "" })).toEqual({ ok: false, reason: "invalid_password" });
    const result = await reauth.issue({ userId: "john", sessionId: null, action: "promote", password: GOOD });
    if (!result.ok) throw new Error("expected a token");
    clock += RELEASE_REAUTH_TTL_MS + 1;
    expect(reauth.consume(result.token, { userId: "john", sessionId: null, action: "promote" })).toBe(false);
  });

  it("locks the user out after 5 wrong passwords, even for the right one, for 15 minutes", async () => {
    const reauth = makeReauth();
    for (let i = 0; i < 4; i += 1) {
      expect((await reauth.issue({ userId: "john", sessionId: null, action: "release", password: "wrong" })).ok).toBe(false);
    }
    expect(await reauth.issue({ userId: "john", sessionId: null, action: "release", password: "wrong" })).toEqual({ ok: false, reason: "locked" });
    expect(await reauth.issue({ userId: "john", sessionId: null, action: "release", password: GOOD })).toEqual({ ok: false, reason: "locked" });
    clock += 15 * 60 * 1000 + 1;
    expect((await reauth.issue({ userId: "john", sessionId: null, action: "release", password: GOOD })).ok).toBe(true);
  });

  it("checks the password against the stored better-auth hash", async () => {
    const hash = await hashPassword(GOOD);
    const rows = (value: unknown[]) => ({ select: () => ({ from: () => ({ where: () => Promise.resolve(value) }) }) });
    expect(await credentialPasswordVerifier(rows([{ password: hash }]) as any)("john", GOOD)).toBe(true);
    expect(await credentialPasswordVerifier(rows([{ password: hash }]) as any)("john", "wrong")).toBe(false);
    expect(await credentialPasswordVerifier(rows([]) as any)("john", GOOD)).toBe(false);
    expect(await credentialPasswordVerifier(rows([{ password: null }]) as any)("john", GOOD)).toBe(false);
  });
});

describe("release, rollback and promote in login mode", () => {
  beforeEach(() => {
    clock = 1_000_000;
  });

  it.each(RELEASE_REAUTH_ACTIONS)("%s is refused without the re-check", async (action) => {
    const { app } = createApp(makeReauth());
    const res = await request(app).post(`/api/test/${action}`).send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("reauth_required");
  });

  it.each(RELEASE_REAUTH_ACTIONS)("%s passes with a fresh token, once", async (action) => {
    const { app } = createApp(makeReauth());
    const token = await getToken(app, action);
    const ok = await request(app).post(`/api/test/${action}`).set(RELEASE_REAUTH_HEADER, token).send({});
    expect(ok.status).toBe(200);
    const again = await request(app).post(`/api/test/${action}`).set(RELEASE_REAUTH_HEADER, token).send({});
    expect(again.status).toBe(403);
    expect(again.body.code).toBe("reauth_required");
  });

  it("a token for one action does not pass another", async () => {
    const { app } = createApp(makeReauth());
    const token = await getToken(app, "promote");
    const res = await request(app).post("/api/test/release").set(RELEASE_REAUTH_HEADER, token).send({});
    expect(res.status).toBe(403);
  });

  it("a token from one device does not pass on another session", async () => {
    const { app, as } = createApp(makeReauth());
    const token = await getToken(app, "release");
    as(johnOtherDevice);
    const res = await request(app).post("/api/test/release").set(RELEASE_REAUTH_HEADER, token).send({});
    expect(res.status).toBe(403);
  });

  it("a wrong password gets no token", async () => {
    const { app } = createApp(makeReauth());
    const res = await request(app).post("/api/reauth").send({ action: "release", password: "wrong" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "reauth_invalid_password" });
    expect(res.body.token).toBeUndefined();
  });

  it("a sixth try after 5 wrong passwords gets 429", async () => {
    const { app } = createApp(makeReauth());
    for (let i = 0; i < 5; i += 1) await request(app).post("/api/reauth").send({ action: "release", password: "wrong" });
    const res = await request(app).post("/api/reauth").send({ action: "release", password: GOOD });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("reauth_locked");
  });

  it("an unknown action gets 422", async () => {
    const { app } = createApp(makeReauth());
    const res = await request(app).post("/api/reauth").send({ action: "delete", password: GOOD });
    expect(res.status).toBe(422);
  });

  it("a board API key cannot get or use a token", async () => {
    const { app, as } = createApp(makeReauth());
    const token = await getToken(app, "release");
    as(boardKey);
    expect((await request(app).post("/api/reauth").send({ action: "release", password: GOOD })).status).toBe(403);
    expect((await request(app).post("/api/test/release").set(RELEASE_REAUTH_HEADER, token).send({})).status).toBe(403);
  });
});

describe("agents never pass the re-check", () => {
  it.each([agentKey, agentJwt])("agent ($source) gets 403 on /reauth and on every action, even with a board token", async (agent) => {
    const { app, as } = createApp(makeReauth());
    const tokens = Object.fromEntries(
      await Promise.all(RELEASE_REAUTH_ACTIONS.map(async (action) => [action, await getToken(app, action)] as const)),
    );
    as(agent);
    const reauthRes = await request(app).post("/api/reauth").send({ action: "release", password: GOOD });
    expect(reauthRes.status).toBe(403);
    expect(reauthRes.body.token).toBeUndefined();
    for (const action of RELEASE_REAUTH_ACTIONS) {
      const res = await request(app).post(`/api/test/${action}`).set(RELEASE_REAUTH_HEADER, tokens[action]!).send({});
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Board access required");
    }
  });
});

describe("local_trusted keeps the board-only guard", () => {
  it.each(RELEASE_REAUTH_ACTIONS)("the local board may %s without a password", async (action) => {
    const { app, as } = createApp(makeReauth());
    as(localBoard);
    expect((await request(app).post(`/api/test/${action}`).send({})).status).toBe(200);
  });

  it("/reauth says no password is needed", async () => {
    const { app, as } = createApp(makeReauth());
    as(localBoard);
    const res = await request(app).post("/api/reauth").send({ action: "release", password: "x" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("reauth_not_needed");
  });
});
