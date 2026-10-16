import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, calendarFeeds, companies, createDb, goals, issues } from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { calendarRoutes } from "../routes/calendar.js";
import { deadlinesToIcs, foldIcsLine } from "../services/calendar-feed.js";

describe("deadlinesToIcs", () => {
  it("writes open deadlines as all-day events and leaves closed ones out", () => {
    const base = { identifier: null, status: "todo", agentName: null, goalTitle: null, times: [], runCount: 0, timeZone: null };
    const ics = deadlinesToIcs(
      [
        { ...base, kind: "task", id: "t1", date: "2026-11-02", title: "Send proposal, v2", identifier: "GRE-7", closed: false, agentName: "Ops" },
        { ...base, kind: "task", id: "t2", date: "2026-11-03", title: "Done already", closed: true },
        { ...base, kind: "goal", id: "g1", date: "2026-12-31", title: "Ten clients", closed: false },
      ],
      { calendarName: "Greatstone deadlines", itemUrl: (item) => `https://gsam.test/${item.id}`, now: new Date("2026-10-16T00:00:00Z") },
    );
    expect(ics).toContain("SUMMARY:Due: GRE-7 Send proposal\\, v2");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261102");
    expect(ics).toContain("DTEND;VALUE=DATE:20261103");
    expect(ics).toContain("SUMMARY:Goal date: Ten clients");
    expect(ics).not.toContain("Done already");
    expect(ics.split("\r\n").every((line) => Buffer.byteLength(line) <= 75)).toBe(true);
    expect(foldIcsLine("x".repeat(80))).toBe(`${"x".repeat(75)}\r\n ${"x".repeat(5)}`);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

describeEmbeddedPostgres("calendar feed routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-calendar-feed-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(calendarFeeds);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: Express.Request["actor"]) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", calendarRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  it("is off until turned on, serves deadlines at a secret URL, and stops when turned off", async () => {
    const prefix = `C${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
    const [company] = await db.insert(companies).values({ name: "Greatstone", issuePrefix: prefix }).returning();
    const companyId = company!.id;
    const dueDate = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await db.insert(issues).values({ companyId, title: "Send the Kente proposal", status: "todo", priority: "medium", dueDate, identifier: `${prefix}-1` });
    const board = { type: "board", userId: "local-board", source: "local_implicit", companyIds: [companyId], memberships: [], isInstanceAdmin: false } as unknown as Express.Request["actor"];
    const none = { type: "none", source: "none" } as Express.Request["actor"];

    expect((await request(app(board)).get(`/api/companies/${companyId}/calendar-feed`)).body).toEqual({ enabled: false, lastFetchedAt: null });

    const on = await request(app(board)).post(`/api/companies/${companyId}/calendar-feed`);
    expect(on.status).toBe(201);
    expect(on.body.path).toMatch(/^\/api\/calendar-feeds\/gsam_cal_[a-f0-9]{48}\.ics$/);

    const feed = await request(app(none)).get(on.body.path);
    expect(feed.status).toBe(200);
    expect(feed.headers["content-type"]).toContain("text/calendar");
    expect(feed.text).toContain(`SUMMARY:Due: ${prefix}-1 Send the Kente proposal`);
    expect(feed.text).toContain(`/${prefix}/issues/${prefix}-1`);
    expect((await request(app(board)).get(`/api/companies/${companyId}/calendar-feed`)).body.lastFetchedAt).not.toBeNull();

    expect((await request(app(none)).get("/api/calendar-feeds/gsam_cal_" + "0".repeat(48) + ".ics")).status).toBe(404);

    // Turning it on again replaces the URL; the old one stops working.
    const again = await request(app(board)).post(`/api/companies/${companyId}/calendar-feed`);
    expect((await request(app(none)).get(on.body.path)).status).toBe(404);
    await request(app(board)).delete(`/api/companies/${companyId}/calendar-feed`).expect(200);
    expect((await request(app(none)).get(again.body.path)).status).toBe(404);
  });
});
