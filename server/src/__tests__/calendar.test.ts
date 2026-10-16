import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, goals, issues, routines, routineTriggers } from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { calendarService, datesInWindow, scheduleOccurrences } from "../services/calendar.ts";
import { calendarRoutes } from "../routes/calendar.ts";
import { errorHandler } from "../middleware/index.js";

describe("calendar schedule helpers", () => {
  it("lists every date in the window, across a month end", () => {
    expect(datesInWindow("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  });

  it("projects a weekday schedule onto the right days", () => {
    // 15 Oct 2026 is a Thursday.
    const runs = scheduleOccurrences("30 9 * * 1-5", "2026-10-15", "2026-10-20");
    expect(runs).toEqual([
      { date: "2026-10-15", times: ["09:30"] },
      { date: "2026-10-16", times: ["09:30"] },
      { date: "2026-10-19", times: ["09:30"] },
      { date: "2026-10-20", times: ["09:30"] },
    ]);
  });

  it("lists several times a day and skips months the schedule leaves out", () => {
    expect(scheduleOccurrences("0 8,17 1 11 *", "2026-10-01", "2026-11-30")).toEqual([
      { date: "2026-11-01", times: ["08:00", "17:00"] },
    ]);
  });

  it("returns nothing for an expression the scheduler rejects", () => {
    expect(scheduleOccurrences("not a cron", "2026-10-01", "2026-10-31")).toEqual([]);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres calendar tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("company calendar", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-calendar-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const goalId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Calendar", issuePrefix: `C${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Ridge", role: "engineer", status: "idle", adapterType: "codex_local" });
    await db.insert(goals).values([
      { id: goalId, companyId, title: "Win five clients", kind: "objective", status: "active", targetDate: "2026-10-31" },
      { companyId, title: "Out of window", status: "active", targetDate: "2026-12-31" },
    ]);
    await db.insert(issues).values([
      { companyId, title: "Send the proposal", identifier: "CAL-1", status: "todo", dueDate: "2026-10-20", assigneeAgentId: agentId, goalId },
      { companyId, title: "Finished early", identifier: "CAL-2", status: "done", dueDate: "2026-10-21" },
      { companyId, title: "Hidden", identifier: "CAL-3", status: "todo", dueDate: "2026-10-21", hiddenAt: new Date() },
      { companyId, title: "No date", identifier: "CAL-4", status: "todo" },
    ]);
    const weekly = randomUUID();
    const paused = randomUUID();
    await db.insert(routines).values([
      { id: weekly, companyId, title: "Monday pipeline review", assigneeAgentId: agentId },
      { id: paused, companyId, title: "Paused routine", status: "paused" },
    ]);
    await db.insert(routineTriggers).values([
      { companyId, routineId: weekly, kind: "schedule", cronExpression: "0 9 * * 1", timezone: "Europe/London" },
      { companyId, routineId: weekly, kind: "schedule", cronExpression: "0 9 * * 1", timezone: "Europe/London", enabled: false },
      { companyId, routineId: weekly, kind: "webhook" },
      { companyId, routineId: paused, kind: "schedule", cronExpression: "0 9 * * *", timezone: "UTC" },
    ]);
    return { companyId };
  }

  it("brings tasks, goals and routine runs together, in date order", async () => {
    const { companyId } = await seedCompany();
    const calendar = await calendarService(db).build(companyId, "2026-10-15", "2026-10-31");

    expect(calendar.items.map((item) => [item.kind, item.date, item.title])).toEqual([
      ["routine", "2026-10-19", "Monday pipeline review"],
      ["task", "2026-10-20", "Send the proposal"],
      ["task", "2026-10-21", "Finished early"],
      ["routine", "2026-10-26", "Monday pipeline review"],
      ["goal", "2026-10-31", "Win five clients"],
    ]);
    const task = calendar.items.find((item) => item.identifier === "CAL-1")!;
    expect(task).toMatchObject({ agentName: "Ridge", goalTitle: "Win five clients", closed: false });
    expect(calendar.items.find((item) => item.identifier === "CAL-2")!.closed).toBe(true);
    const run = calendar.items.find((item) => item.kind === "routine")!;
    expect(run).toMatchObject({ times: ["09:00"], runCount: 1, timeZone: "Europe/London", agentName: "Ridge" });
  });

  it("serves the calendar over HTTP and checks the window", async () => {
    const { companyId } = await seedCompany();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "user-1", source: "session", isInstanceAdmin: false, companyIds: [companyId] } as never;
      next();
    });
    app.use("/api", calendarRoutes(db));
    app.use(errorHandler);

    const ok = await request(app).get(`/api/companies/${companyId}/calendar`).query({ from: "2026-10-01", to: "2026-10-31" });
    expect(ok.status).toBe(200);
    expect(ok.body.items).toHaveLength(7); // four Monday runs, two tasks, one goal

    const backwards = await request(app).get(`/api/companies/${companyId}/calendar`).query({ from: "2026-10-31", to: "2026-10-01" });
    expect(backwards.status).toBe(400);
    const tooLong = await request(app).get(`/api/companies/${companyId}/calendar`).query({ from: "2026-01-01", to: "2026-12-31" });
    expect(tooLong.status).toBe(400);
    const badDate = await request(app).get(`/api/companies/${companyId}/calendar`).query({ from: "soon", to: "2026-10-31" });
    expect(badDate.status).toBe(400);

    const otherCompany = await request(app).get(`/api/companies/${randomUUID()}/calendar`).query({ from: "2026-10-01", to: "2026-10-31" });
    expect(otherCompany.status).toBe(403);
  });
});
