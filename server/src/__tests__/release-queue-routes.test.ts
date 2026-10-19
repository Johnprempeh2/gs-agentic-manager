// Release queue API guards (scripts/greatstone-release-queue.mjs): the board
// and the release manager agent (Keystone) read the queue and add to it; any
// other agent gets 403; only an owner or admin cancels; another company's
// caller gets 404; in login mode a board request needs the password re-check.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "99999999-9999-4999-8999-999999999999";
const agentId = "11111111-1111-4111-8111-111111111111";
const keystoneId = "33333333-3333-4333-8333-333333333333";

const svc = vi.hoisted(() => ({
  isReleaseManagerAgent: vi.fn(),
  releaseOffReason: vi.fn(),
  releaseRepo: vi.fn(),
}));
const queue = vi.hoisted(() => ({ view: vi.fn(), enqueue: vi.fn(), cancel: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());
const item = { id: "rq-abc123", ref: "main", title: "Faster board", status: "queued" };
const view = { running: null, queued: [item], recent: [], main: null, workerSeenAt: null };

const GOOD = "sandbox-test-pass";
let reauth: import("../services/release-reauth.js").ReleaseReauth;

async function createApp(actor: Record<string, unknown>) {
  vi.doMock("../services/live-release.js", () => ({ liveReleaseService: () => svc }));
  vi.doMock("../services/index.js", () => ({ logActivity: mockLogActivity }));
  vi.doMock("../services/release-queue.js", async () => ({
    ...(await vi.importActual<typeof import("../services/release-queue.js")>("../services/release-queue.js")),
    releaseQueueService: () => queue,
  }));
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

const member = (userId: string, membershipRole: string) => ({
  type: "board",
  userId,
  sessionId: `sess-${userId}`,
  companyIds: [companyId],
  memberships: [{ companyId, membershipRole, status: "active" }],
  source: "session",
  isInstanceAdmin: false,
});
const owner = member("john", "owner");
const operator = member("ben", "operator");
const localBoard = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };
const agent = { type: "agent", agentId, companyId, source: "agent_jwt", runId: "r1" };
const keystone = { type: "agent", agentId: keystoneId, companyId, source: "agent_jwt", runId: "r2" };
const base = `/api/companies/${companyId}/releases/queue`;

describe("release queue routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    svc.isReleaseManagerAgent.mockImplementation(async (_c: string, id: string) => id === keystoneId);
    svc.releaseOffReason.mockReturnValue(null);
    svc.releaseRepo.mockReturnValue("/repo");
    queue.view.mockReturnValue(view);
    queue.enqueue.mockResolvedValue({ ok: true, item });
    queue.cancel.mockResolvedValue({ ok: true, item: { ...item, status: "cancelled" } });
  });

  it("the board reads the queue, asks for a release of main and cancels it", async () => {
    const app = await createApp(localBoard);
    const read = await request(app).get(base);
    expect(read.status).toBe(200);
    expect(read.body).toEqual(view);

    const queued = await request(app).post(base).send({ title: "Faster board" });
    expect(queued.status).toBe(202);
    expect(queued.body.item).toEqual(item);
    expect(queue.enqueue).toHaveBeenCalledWith("/repo", { ref: "main", title: "Faster board", by: "user:local-board" });

    const cancelled = await request(app).post(`${base}/rq-abc123/cancel`);
    expect(cancelled.status).toBe(200);
    expect(queue.cancel).toHaveBeenCalledWith("/repo", { id: "rq-abc123", by: "user:local-board" });
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
  });

  it("the release manager agent reads and enqueues, with no password re-check; it cannot cancel", async () => {
    const app = await createApp(keystone);
    expect((await request(app).get(base)).status).toBe(200);
    const queued = await request(app).post(base).send({ ref: "rc-2026-10-18.1" });
    expect(queued.status).toBe(202);
    expect(queue.enqueue).toHaveBeenCalledWith("/repo", { ref: "rc-2026-10-18.1", title: null, by: `agent:${keystoneId}` });
    expect((await request(app).post(`${base}/rq-abc123/cancel`)).status).toBe(403);
    expect(queue.cancel).not.toHaveBeenCalled();
  });

  it("any other agent gets 403 on every queue route", async () => {
    const app = await createApp(agent);
    expect((await request(app).get(base)).status).toBe(403);
    expect((await request(app).post(base).send({})).status).toBe(403);
    expect((await request(app).post(`${base}/rq-abc123/cancel`)).status).toBe(403);
    expect(queue.view).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("an operator reads the queue but cannot ask for a release or cancel", async () => {
    const app = await createApp(operator);
    expect((await request(app).get(base)).status).toBe(200);
    expect((await request(app).post(base).send({})).status).toBe(403);
    expect((await request(app).post(`${base}/rq-abc123/cancel`)).status).toBe(403);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("another company's board and agents get 404", async () => {
    const other = `/api/companies/${otherCompanyId}/releases/queue`;
    for (const actor of [owner, keystone]) {
      const app = await createApp(actor);
      expect((await request(app).get(other)).status).toBe(404);
      expect((await request(app).post(other).send({})).status).toBe(404);
      expect((await request(app).post(`${other}/rq-abc123/cancel`)).status).toBe(404);
    }
    expect(queue.view).not.toHaveBeenCalled();
  });

  it("in login mode the owner needs the password re-check to ask for a release", async () => {
    const app = await createApp(owner);
    const refused = await request(app).post(base).send({});
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("reauth_required");
    const issued = await reauth.issue({ userId: "john", sessionId: "sess-john", action: "release", password: GOOD });
    if (!issued.ok) throw new Error("expected a token");
    expect((await request(app).post(base).set("x-gsam-reauth", issued.token).send({})).status).toBe(202);
  });

  it("refuses a ref or body it cannot pass to the worker, and is off where release is off", async () => {
    const app = await createApp(localBoard);
    for (const body of [{ ref: "--by" }, { ref: "feature/x" }, { title: 3 }, { ref: "main", tag: "x" }]) {
      expect((await request(app).post(base).send(body)).status).toBe(422);
    }
    expect((await request(app).post(`${base}/not-an-id/cancel`)).status).toBe(404);
    expect(queue.enqueue).not.toHaveBeenCalled();

    svc.releaseOffReason.mockReturnValue("release is off on this server: it does not run from /live");
    const off = await request(app).post(base).send({});
    expect(off.status).toBe(409);
    expect(off.body.error).toMatch(/release is off/);
    queue.enqueue.mockResolvedValue({ ok: false, status: 422, error: "the title must be one line" });
    svc.releaseOffReason.mockReturnValue(null);
    expect((await request(app).post(base).send({ title: "x" })).body).toEqual({ error: "the title must be one line" });
  });
});
