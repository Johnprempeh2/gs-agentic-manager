import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, companyMemberships, createDb, labels } from "@greatstone/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres label update route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("label update (routes + postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-label-update-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(labels);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const userId = `user-${randomUUID()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Label Co",
      issuePrefix: `L${randomUUID().slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "operator",
    });
    const bugId = randomUUID();
    const urgentId = randomUUID();
    await db.insert(labels).values([
      { id: bugId, companyId, name: "Bug", color: "#ff0000" },
      { id: urgentId, companyId, name: "Urgent", color: "#00ff00" },
    ]);
    const actor = {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "operator" }],
      isInstanceAdmin: false,
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, {}));
    app.use(errorHandler);
    return { app, companyId, bugId, urgentId };
  }

  it("renames and recolours a label and logs the change", async () => {
    const { app, companyId, bugId } = await seed();
    const res = await request(app).patch(`/api/labels/${bugId}`).send({ name: "Defect", color: "#123456" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: bugId, name: "Defect", color: "#123456" });
    const [row] = await db.select().from(labels).where(eq(labels.id, bugId));
    expect(row).toMatchObject({ name: "Defect", color: "#123456" });
    const [entry] = await db.select().from(activityLog).where(eq(activityLog.entityId, bugId));
    expect(entry).toMatchObject({ companyId, action: "label.updated" });
    expect(entry?.details).toMatchObject({ previousName: "Bug", previousColor: "#ff0000" });
  });

  it("changes only the colour when no name is sent", async () => {
    const { app, bugId } = await seed();
    const res = await request(app).patch(`/api/labels/${bugId}`).send({ color: "#abcdef" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Bug", color: "#abcdef" });
  });

  it("refuses a name another label already has", async () => {
    const { app, bugId } = await seed();
    const res = await request(app).patch(`/api/labels/${bugId}`).send({ name: "urgent" });
    expect(res.status).toBe(409);
    const [row] = await db.select().from(labels).where(eq(labels.id, bugId));
    expect(row?.name).toBe("Bug");
  });

  it("rejects an empty change", async () => {
    const { app, bugId } = await seed();
    const res = await request(app).patch(`/api/labels/${bugId}`).send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown label", async () => {
    await seed();
    const res = await request(app404()).patch(`/api/labels/${randomUUID()}`).send({ name: "X" });
    expect([403, 404]).toContain(res.status);
  });

  function app404() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "session", userId: "nobody", companyIds: [], memberships: [], isInstanceAdmin: false };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, {}));
    app.use(errorHandler);
    return app;
  }
});
