import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, userTourDismissals } from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { tourDismissalRoutes } from "../routes/tour-dismissals.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("tour dismissal routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("gsam-tour-dismissals-");
    db = createDb(tempDb.connectionString);
  }, 20_000);
  afterEach(async () => { await db.delete(userTourDismissals); });
  afterAll(async () => { await tempDb?.cleanup(); });

  function app(actor: Record<string, unknown>) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => { (req as any).actor = actor; next(); });
    server.use("/api", tourDismissalRoutes(db));
    server.use(errorHandler);
    return server;
  }
  const board = (userId: string) => app({ type: "board", source: "session", userId, companyIds: [], isInstanceAdmin: false });

  it("marks a tour seen idempotently and lists only the caller's own tours", async () => {
    const ama = board("ama");
    await request(ama).put("/api/tour-dismissals/me").send({ tourKey: "pipelines-list", tourVersion: 1 }).expect(204);
    const first = await request(ama).get("/api/tour-dismissals/me").expect(200);
    await request(ama).put("/api/tour-dismissals/me").send({ tourKey: "pipelines-list", tourVersion: 1 }).expect(204);
    await request(ama).put("/api/tour-dismissals/me").send({ tourKey: "pipelines-list", tourVersion: 2 }).expect(204);
    await request(board("kofi")).put("/api/tour-dismissals/me").send({ tourKey: "website", tourVersion: 1 }).expect(204);

    const res = await request(ama).get("/api/tour-dismissals/me").expect(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body.map((row: { tourKey: string; tourVersion: number }) => `${row.tourKey}@${row.tourVersion}`).sort())
      .toEqual(["pipelines-list@1", "pipelines-list@2"]);
    // The repeat did not move the first seenAt.
    expect(res.body.find((row: { tourVersion: number }) => row.tourVersion === 1).seenAt).toBe(first.body[0].seenAt);

    const kofi = await request(board("kofi")).get("/api/tour-dismissals/me").expect(200);
    expect(kofi.body.map((row: { tourKey: string }) => row.tourKey)).toEqual(["website"]);
  });

  it("resets only the caller's own tours", async () => {
    await request(board("ama")).put("/api/tour-dismissals/me").send({ tourKey: "website", tourVersion: 1 }).expect(204);
    await request(board("kofi")).put("/api/tour-dismissals/me").send({ tourKey: "website", tourVersion: 1 }).expect(204);
    await request(board("ama")).delete("/api/tour-dismissals/me").expect(204);
    await request(board("ama")).delete("/api/tour-dismissals/me").expect(204);
    expect((await request(board("ama")).get("/api/tour-dismissals/me").expect(200)).body).toEqual([]);
    expect((await request(board("kofi")).get("/api/tour-dismissals/me").expect(200)).body).toHaveLength(1);
  });

  it("rejects bad keys, versions and extra fields", async () => {
    const ama = board("ama");
    for (const body of [
      {},
      { tourKey: "Pipelines List", tourVersion: 1 },
      { tourKey: "x".repeat(65), tourVersion: 1 },
      { tourKey: "pipelines-list", tourVersion: 0 },
      { tourKey: "pipelines-list", tourVersion: 1.5 },
      { tourKey: "pipelines-list", tourVersion: "1" },
      { tourKey: "pipelines-list", tourVersion: 1, userId: "kofi" },
    ]) {
      await request(ama).put("/api/tour-dismissals/me").send(body).expect(400);
    }
    expect(await db.select().from(userTourDismissals)).toEqual([]);
  });

  it("refuses agents, anonymous callers and board callers without a user", async () => {
    const agent = app({ type: "agent", agentId: "agent-1", companyId: "c1" });
    await request(agent).get("/api/tour-dismissals/me").expect(403);
    await request(agent).put("/api/tour-dismissals/me").send({ tourKey: "website", tourVersion: 1 }).expect(403);
    await request(agent).delete("/api/tour-dismissals/me").expect(403);
    await request(app({ type: "none" })).get("/api/tour-dismissals/me").expect(401);
    await request(app({ type: "board", source: "session", companyIds: [] })).get("/api/tour-dismissals/me").expect(403);
    expect(await db.select().from(userTourDismissals)).toEqual([]);
  });
});
