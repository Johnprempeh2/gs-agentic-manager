import express, { Router } from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Client editions hide Releases (GRE-129): with `instance.releases` in
 * GSAM_HIDDEN_SETTINGS every release route, reads included, answers 403
 * `settings_operator_managed`, even for a board owner. Without the key (our
 * own install) requests reach the release routes unchanged. The stub router
 * stands in for the release routes.
 */

async function createApp() {
  const [{ releasesFloorRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/releases-floor.js"),
    import("../middleware/index.js"),
  ]);
  const releases = Router();
  releases.get("/companies/:companyId/releases", (_req, res) => res.json({ live: null }));
  releases.post("/companies/:companyId/releases/release", (_req, res) => res.json({ ok: true }));
  releases.post("/companies/:companyId/releases/rollback", (_req, res) => res.json({ ok: true }));
  releases.patch("/companies/:companyId/releases/next", (_req, res) => res.json({ ok: true }));
  releases.get("/companies/:companyId/issues", (_req, res) => res.json([]));

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "board-user-1",
      source: "session",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
      isInstanceAdmin: false,
    } as Express.Request["actor"];
    next();
  });
  const api = Router();
  api.use(releasesFloorRoutes());
  api.use(releases);
  app.use("/api", api);
  app.use(errorHandler);
  return app;
}

const attempts: Array<[string, (app: express.Express) => request.Test]> = [
  ["list", (app) => request(app).get("/api/companies/company-1/releases")],
  ["release", (app) => request(app).post("/api/companies/company-1/releases/release").send({ tag: "rc-1" })],
  ["rollback", (app) => request(app).post("/api/companies/company-1/releases/rollback").send({ tag: "rc-1" })],
  ["edit next title", (app) => request(app).patch("/api/companies/company-1/releases/next").send({ title: "x" })],
];

describe("releases hidden floor", () => {
  const original = process.env.GSAM_HIDDEN_SETTINGS;
  afterEach(() => {
    if (original === undefined) delete process.env.GSAM_HIDDEN_SETTINGS;
    else process.env.GSAM_HIDDEN_SETTINGS = original;
  });

  it.each(attempts)("client edition: %s is 403 for the board user", async (_name, send) => {
    process.env.GSAM_HIDDEN_SETTINGS = "instance.adapters,instance.releases";
    const res = await send(await createApp());
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain("settings_operator_managed");
  });

  it.each(attempts)("admin edition (key not hidden): %s reaches the release route", async (_name, send) => {
    delete process.env.GSAM_HIDDEN_SETTINGS;
    const res = await send(await createApp());
    expect(res.status).toBe(200);
  });

  it("client edition: other company routes stay open", async () => {
    process.env.GSAM_HIDDEN_SETTINGS = "instance.releases";
    const res = await request(await createApp()).get("/api/companies/company-1/issues");
    expect(res.status).toBe(200);
  });
});
