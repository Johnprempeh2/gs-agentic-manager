// Releases page API guards (GRE-121): board only, agents get 403; the release
// manager agent may edit only the next title; an agent may flag only its own run.
// In login mode release and rollback also need the password re-check (GRE-136).
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "11111111-1111-4111-8111-111111111111";
const keystoneId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const otherRunId = "55555555-5555-4555-8555-555555555555";

const progress = { id: "job-1", state: "holding" };
const job = { id: "job-1", tag: "rc-2026-09-28.1" };
const svc = vi.hoisted(() => ({
  overview: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
  override: vi.fn(),
  setNextTitle: vi.fn(),
  setRunFlag: vi.fn(),
  isReleaseManagerAgent: vi.fn(),
  findRun: vi.fn(),
  promote: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

const GOOD = "sandbox-test-pass";
let reauth: import("../services/release-reauth.js").ReleaseReauth;

async function createApp(actor: Record<string, unknown>) {
  vi.doMock("../services/live-release.js", () => ({ liveReleaseService: () => svc }));
  vi.doMock("../services/index.js", () => ({ logActivity: mockLogActivity }));
  const [{ releaseRoutes }, { errorHandler }, { createReleaseReauth }] = await Promise.all([
    vi.importActual<typeof import("../routes/releases.js")>("../routes/releases.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../services/release-reauth.js")>("../services/release-reauth.js"),
  ]);
  reauth = createReleaseReauth({ verifyPassword: async (_userId, password) => password === GOOD });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", releaseRoutes({} as any, reauth));
  app.use(errorHandler);
  return app;
}

const board = { type: "board", userId: "john", sessionId: "sess-1", companyIds: [companyId], source: "session", isInstanceAdmin: false };
const localBoard = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };
const otherBoard = { ...board, userId: "stranger", companyIds: [] };
const agent = { type: "agent", agentId, companyId, source: "agent_jwt", runId };
const keystone = { type: "agent", agentId: keystoneId, companyId, source: "agent_jwt", runId: otherRunId };
const base = `/api/companies/${companyId}/releases`;
const REAUTH = "x-gsam-reauth";

async function token(action: "release" | "rollback" | "promote", userId = "john", sessionId: string | null = "sess-1") {
  const result = await reauth.issue({ userId, sessionId, action, password: GOOD });
  if (!result.ok) throw new Error("expected a token");
  return result.token;
}

describe("release routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    svc.overview.mockResolvedValue({ live: null, history: [], next: null, flaggedRuns: [], progress: null });
    svc.start.mockResolvedValue({ ok: true, job, progress });
    svc.cancel.mockResolvedValue({ ok: true, job, progress: { ...progress, state: "cancelled" } });
    svc.override.mockResolvedValue({ ok: true, job, progress: { ...progress, state: "switching" } });
    svc.setNextTitle.mockResolvedValue({ ok: true, next: { proposedTitle: "T" } });
    svc.setRunFlag.mockResolvedValue({ ok: true, flag: { runId } });
    svc.isReleaseManagerAgent.mockImplementation(async (_c: string, id: string) => id === keystoneId);
    svc.promote.mockResolvedValue({ ok: true, stable: { tag: "stable-2026-09-29.1", commit: "abc", liveTag: "live-2026-09-20.1" } });
    svc.findRun.mockImplementation(async (id: string) => (id === runId || id === otherRunId ? { companyId, agentId, status: "running" } : null));
  });

  it.each([
    ["get", base, undefined],
    ["post", `${base}/release`, { tag: "rc-2026-09-28.1" }],
    ["post", `${base}/release`, {}],
    ["post", `${base}/rollback`, { tag: "live-2026-09-20.1" }],
    ["post", `${base}/cancel`, {}],
    ["post", `${base}/override`, {}],
    ["post", `${base}/promote`, { liveTag: "live-2026-09-20.1", notes: "Faster board." }],
  ] as const)("an agent gets 403 on %s %s", async (method, url, body) => {
    for (const actor of [agent, keystone]) {
      const app = await createApp(actor);
      const res = await (request(app) as any)[method](url).send(body ?? {});
      expect(res.status).toBe(403);
    }
    expect(svc.start).not.toHaveBeenCalled();
    expect(svc.cancel).not.toHaveBeenCalled();
    expect(svc.override).not.toHaveBeenCalled();
    expect(svc.overview).not.toHaveBeenCalled();
    expect(svc.promote).not.toHaveBeenCalled();
  });

  it("the board reads, releases, rolls back, cancels and overrides", async () => {
    const app = await createApp(board);
    expect((await request(app).get(base)).status).toBe(200);

    const release = await request(app).post(`${base}/release`).set(REAUTH, await token("release")).send({ tag: "rc-2026-09-28.1" });
    expect(release.status).toBe(202);
    expect(release.body).toEqual({ progress });
    expect(svc.start).toHaveBeenLastCalledWith({ kind: "release", tag: "rc-2026-09-28.1", title: null, actor: { actorType: "user", actorId: "john" } });

    await request(app).post(`${base}/release`).set(REAUTH, await token("release")).send({ title: "From main" });
    expect(svc.start).toHaveBeenLastCalledWith({ kind: "release", tag: null, title: "From main", actor: { actorType: "user", actorId: "john" } });

    expect((await request(app).post(`${base}/rollback`).set(REAUTH, await token("rollback")).send({ tag: "live-2026-09-20.1" })).status).toBe(202);
    expect(svc.start).toHaveBeenLastCalledWith({ kind: "rollback", tag: "live-2026-09-20.1", actor: { actorType: "user", actorId: "john" } });
    expect((await request(app).post(`${base}/cancel`)).body.progress.state).toBe("cancelled");
    expect((await request(app).post(`${base}/override`)).body.progress.state).toBe("switching");
    expect(mockLogActivity).toHaveBeenCalledTimes(5);
  });

  it("returns a pre-flight failure as { error } with its status", async () => {
    svc.start.mockResolvedValue({ ok: false, status: 409, error: "the release repo /dev has local changes (x.ts); commit or discard them first" });
    const app = await createApp(board);
    const res = await request(app).post(`${base}/release`).set(REAUTH, await token("release")).send({ tag: "rc-2026-09-28.1" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "the release repo /dev has local changes (x.ts); commit or discard them first" });
  });

  describe("password re-check (login mode)", () => {
    it.each([
      ["release", { tag: "rc-2026-09-28.1" }],
      ["rollback", { tag: "live-2026-09-20.1" }],
    ] as const)("%s without the token gets 403 reauth_required and does not start", async (action, body) => {
      const app = await createApp(board);
      const res = await request(app).post(`${base}/${action}`).send(body);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("reauth_required");
      expect(svc.start).not.toHaveBeenCalled();
    });

    it.each([
      ["release", { tag: "rc-2026-09-28.1" }],
      ["rollback", { tag: "live-2026-09-20.1" }],
    ] as const)("%s passes with a fresh token, once", async (action, body) => {
      const app = await createApp(board);
      const t = await token(action);
      expect((await request(app).post(`${base}/${action}`).set(REAUTH, t).send(body)).status).toBe(202);
      const again = await request(app).post(`${base}/${action}`).set(REAUTH, t).send(body);
      expect(again.status).toBe(403);
      expect(again.body.code).toBe("reauth_required");
      expect(svc.start).toHaveBeenCalledTimes(1);
    });

    it("a release token does not pass a rollback", async () => {
      const app = await createApp(board);
      const res = await request(app).post(`${base}/rollback`).set(REAUTH, await token("release")).send({ tag: "live-2026-09-20.1" });
      expect(res.status).toBe(403);
      expect(svc.start).not.toHaveBeenCalled();
    });

    it("a board user of another company is refused before the re-check, even with a token", async () => {
      const app = await createApp(otherBoard);
      const res = await request(app).post(`${base}/release`).set(REAUTH, await token("release", "stranger")).send({});
      expect(res.status).toBe(403);
      expect(res.body.code).not.toBe("reauth_required");
      expect(svc.start).not.toHaveBeenCalled();
    });

    it("local_trusted releases and rolls back with no password", async () => {
      const app = await createApp(localBoard);
      expect((await request(app).post(`${base}/release`).send({ tag: "rc-2026-09-28.1" })).status).toBe(202);
      expect((await request(app).post(`${base}/rollback`).send({ tag: "live-2026-09-20.1" })).status).toBe(202);
    });

    it("cancel and override still need only the board", async () => {
      const app = await createApp(board);
      expect((await request(app).post(`${base}/cancel`)).status).toBe(200);
      expect((await request(app).post(`${base}/override`)).status).toBe(200);
    });
  });

  describe("promote to Stable (GRE-127)", () => {
    const body = { liveTag: "live-2026-09-20.1", notes: "Faster board." };

    it("the board promotes with a fresh promote token and it is logged", async () => {
      const app = await createApp(board);
      const res = await request(app).post(`${base}/promote`).set(REAUTH, await token("promote")).send(body);
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ stable: { tag: "stable-2026-09-29.1", commit: "abc", liveTag: "live-2026-09-20.1" } });
      expect(svc.promote).toHaveBeenCalledWith(body);
      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "release.promoted_to_stable", entityId: "stable-2026-09-29.1" }),
      );
    });

    it("login mode: no token, or a release token, gets 403 reauth_required", async () => {
      const app = await createApp(board);
      for (const req of [request(app).post(`${base}/promote`), request(app).post(`${base}/promote`).set(REAUTH, await token("release"))]) {
        const res = await req.send(body);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("reauth_required");
      }
      expect(svc.promote).not.toHaveBeenCalled();
    });

    it("local_trusted promotes with the board guard only", async () => {
      const app = await createApp(localBoard);
      expect((await request(app).post(`${base}/promote`).send(body)).status).toBe(201);
    });

    it("returns a refusal as { error } with its status and logs nothing", async () => {
      svc.promote.mockResolvedValue({ ok: false, status: 422, error: "the client notes contain an issue number (GRE-123); clients must not see internal numbers" });
      const app = await createApp(localBoard);
      const res = await request(app).post(`${base}/promote`).send({ ...body, notes: "Fix GRE-123" });
      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/issue number/);
      expect(mockLogActivity).not.toHaveBeenCalled();
    });
  });

  it("refuses another company's board and agents", async () => {
    const app = await createApp({ ...agent, companyId: "99999999-9999-4999-8999-999999999999" });
    expect((await request(app).patch(`${base}/next`).send({ title: "x" })).status).toBe(403);
  });

  describe("next title", () => {
    it("the release manager agent can edit the title", async () => {
      const app = await createApp(keystone);
      const res = await request(app).patch(`${base}/next`).send({ title: "Releases page" });
      expect(res.status).toBe(200);
      expect(svc.setNextTitle).toHaveBeenCalledWith({ title: "Releases page", editedBy: `agent:${keystoneId}` });
    });

    it("the release manager agent can edit only the title", async () => {
      const app = await createApp(keystone);
      const res = await request(app).patch(`${base}/next`).send({ title: "x", commit: "abc" });
      expect(res.status).toBe(422);
      expect(svc.setNextTitle).not.toHaveBeenCalled();
    });

    it("other agents cannot edit it; the board can", async () => {
      expect((await request(await createApp(agent)).patch(`${base}/next`).send({ title: "x" })).status).toBe(403);
      expect((await request(await createApp(board)).patch(`${base}/next`).send({ title: "x" })).status).toBe(200);
    });
  });

  describe("finish before update", () => {
    const flagUrl = (id: string) => `/api/heartbeat-runs/${id}/finish-before-update`;

    it("an agent flags its own current run", async () => {
      const app = await createApp(agent);
      const res = await request(app).post(flagUrl(runId)).send({ enabled: true, reason: "mid-migration" });
      expect(res.status).toBe(200);
      expect(svc.setRunFlag).toHaveBeenCalledWith({ runId, companyId, agentId, enabled: true, reason: "mid-migration", by: `agent:${agentId}` });
    });

    it("an agent cannot flag another run", async () => {
      const app = await createApp(agent);
      expect((await request(app).post(flagUrl(otherRunId)).send({ enabled: true })).status).toBe(403);
      expect((await request(await createApp(keystone)).post(flagUrl(runId)).send({ enabled: true })).status).toBe(403);
      expect(svc.setRunFlag).not.toHaveBeenCalled();
    });

    it("the board sets or clears it on any run", async () => {
      const app = await createApp(board);
      expect((await request(app).post(flagUrl(otherRunId)).send({ enabled: false })).status).toBe(200);
      expect(svc.setRunFlag).toHaveBeenCalledWith(expect.objectContaining({ runId: otherRunId, enabled: false, by: "user:john" }));
    });

    it("checks the run id and the body", async () => {
      const app = await createApp(board);
      expect((await request(app).post(flagUrl("not-a-uuid")).send({ enabled: true })).status).toBe(400);
      expect((await request(app).post(flagUrl("66666666-6666-4666-8666-666666666666")).send({ enabled: true })).status).toBe(404);
      expect((await request(app).post(flagUrl(runId)).send({ enabled: "yes" })).status).toBe(422);
    });
  });
});
