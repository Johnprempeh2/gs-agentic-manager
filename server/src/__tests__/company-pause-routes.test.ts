import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb } from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// No adapter process may start.
vi.doMock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(() => ({
    type: "process",
    execute: vi.fn(() => new Promise(() => {})),
    testEnvironment: vi.fn(),
  })),
  runningProcesses: new Map(),
}));

const { companyRoutes } = await import("../routes/companies.js");
const { errorHandler } = await import("../middleware/index.js");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company pause route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// GRE-1396: the company API must return pausedAt and pauseReason, so the UI can
// show "Paused since <date>".
describeEmbeddedPostgres("company pause routes return pausedAt and pauseReason (GRE-1396)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "board-user",
        userName: "Board User",
        userEmail: "board-user@example.com",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        isInstanceAdmin: true,
        source: "session",
      };
      next();
    });
    app.use("/api/companies", companyRoutes(db));
    app.use(errorHandler);
    return app;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("company-pause-routes-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("pause, get and list return pausedAt and pauseReason; resume clears both", async () => {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Pause Route Co",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    const app = createApp();

    const before = await request(app).get(`/api/companies/${companyId}`);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ status: "active", pauseReason: null, pausedAt: null });

    const startedAt = Date.now();
    const paused = await request(app)
      .post(`/api/companies/${companyId}/pause`)
      .send({ reason: "Client asked to stop" });
    expect(paused.status).toBe(200);
    expect(paused.body).toMatchObject({ status: "paused", pauseReason: "manual" });
    expect(typeof paused.body.pausedAt).toBe("string");
    expect(Date.parse(paused.body.pausedAt)).toBeGreaterThanOrEqual(startedAt - 1000);

    const detail = await request(app).get(`/api/companies/${companyId}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      status: "paused",
      pauseReason: "manual",
      pausedAt: paused.body.pausedAt,
    });

    const list = await request(app).get("/api/companies");
    expect(list.status).toBe(200);
    expect(list.body.find((row: { id: string }) => row.id === companyId)).toMatchObject({
      status: "paused",
      pauseReason: "manual",
      pausedAt: paused.body.pausedAt,
    });

    // Pausing again keeps the original date.
    const again = await request(app).post(`/api/companies/${companyId}/pause`).send({});
    expect(again.status).toBe(200);
    expect(again.body.pausedAt).toBe(paused.body.pausedAt);

    const resumed = await request(app)
      .post(`/api/companies/${companyId}/resume`)
      .send({ operator: "John Prempeh", reason: "Invoice paid" });
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ status: "active", pauseReason: null, pausedAt: null });

    const afterDetail = await request(app).get(`/api/companies/${companyId}`);
    expect(afterDetail.body).toMatchObject({ status: "active", pauseReason: null, pausedAt: null });
    const afterList = await request(app).get("/api/companies");
    expect(afterList.body.find((row: { id: string }) => row.id === companyId)).toMatchObject({
      pauseReason: null,
      pausedAt: null,
    });
  });
});
