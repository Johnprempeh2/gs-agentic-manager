import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDb, companies, issues, notificationPreferences, pushSubscriptions } from "@greatstone/db";
import { startEmbeddedPostgresTestDatabase } from "@greatstone/db/test-embedded-postgres";
import { DEFAULT_NOTIFICATION_PREFERENCES, type MorningSummary, type NeedsMe } from "@greatstone/shared";
import { morningSummaryDue, morningSummaryMessage, morningSummaryService, needsYouItems } from "../services/morning-summary.js";

const summary = (needs: number, finished: number, stuck: number): MorningSummary => ({
  companyId: "c",
  generatedAt: "",
  since: "",
  needsYou: { count: needs, items: [] },
  finished: { count: finished, items: [] },
  stuck: { count: stuck, items: [] },
});

const emptyNeedsMe = (over: Partial<NeedsMe> = {}): NeedsMe => ({
  companyId: "c", generatedAt: "", count: 0, decisionCount: 0, assignedTaskCount: 0, decisions: [], assignedTasks: [], overdueWaits: [], ...over,
});

describe("morning summary wording", () => {
  it("leads with what needs you, then what got done and what is stuck", () => {
    expect(morningSummaryMessage(summary(3, 5, 1), "GRE")).toEqual({
      title: "Good morning. 3 things need you",
      body: "5 tasks finished since yesterday. 1 task is stuck.",
      url: "/GRE/morning",
      tag: "morning-summary",
      badge: 3,
    });
    expect(morningSummaryMessage(summary(0, 1, 0), "GRE")).toMatchObject({
      title: "Good morning. Nothing needs you",
      body: "1 task finished since yesterday. Nothing is stuck.",
    });
  });

  it("lists decisions before assigned tasks, once per task, and leaves out outage notices", () => {
    const needs = emptyNeedsMe({
      decisions: [
        { id: "outage:1", kind: "outage", title: "Offline", task: null },
        { id: "task:a", kind: "review", title: "Review", task: { id: "a", identifier: "GRE-1", title: "Approve brief" } },
      ] as unknown as NeedsMe["decisions"],
      assignedTasks: [{ id: "b", identifier: "GRE-2", title: "Pick a date", status: "todo", priority: "medium", updatedAt: "" }],
      overdueWaits: [{ id: "a", identifier: "GRE-1", title: "Approve brief" }] as unknown as NeedsMe["overdueWaits"],
    });
    expect(needsYouItems(needs)).toEqual([
      { id: "a", identifier: "GRE-1", title: "Approve brief" },
      { id: "b", identifier: "GRE-2", title: "Pick a date" },
    ]);
  });
});

describe("when the morning summary is due", () => {
  const prefs = { ...DEFAULT_NOTIFICATION_PREFERENCES, timeZone: "Europe/London", morningSummaryHour: 8 };
  it("goes at the chosen local hour, once a day", () => {
    expect(morningSummaryDue(prefs, null, new Date("2026-10-16T06:59:00Z"))).toEqual({ due: false, localDate: "2026-10-16" });
    expect(morningSummaryDue(prefs, null, new Date("2026-10-16T07:00:00Z"))).toEqual({ due: true, localDate: "2026-10-16" });
    expect(morningSummaryDue(prefs, "2026-10-16", new Date("2026-10-16T07:30:00Z")).due).toBe(false);
  });

  it("catches up for a few hours, then skips the day", () => {
    expect(morningSummaryDue(prefs, null, new Date("2026-10-16T10:30:00Z")).due).toBe(true);
    expect(morningSummaryDue(prefs, null, new Date("2026-10-16T11:30:00Z")).due).toBe(false);
  });

  it("waits for quiet hours to end and respects the switch", () => {
    expect(morningSummaryDue({ ...prefs, quietHoursStart: 22, quietHoursEnd: 9 }, null, new Date("2026-10-16T07:30:00Z")).due).toBe(false);
    expect(morningSummaryDue({ ...prefs, quietHoursStart: 22, quietHoursEnd: 9 }, null, new Date("2026-10-16T08:30:00Z")).due).toBe(true);
    expect(morningSummaryDue({ ...prefs, morningSummary: false }, null, new Date("2026-10-16T07:30:00Z")).due).toBe(false);
  });
});

describe("morning summary service", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const companyId = randomUUID();
  const now = new Date("2026-10-16T07:15:00Z"); // 08:15 in London

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "gsam-morning-tests-"));
    vi.stubEnv("GSAM_HOME", home);
    database = await startEmbeddedPostgresTestDatabase("gsam-morning-db-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Morning tests", issuePrefix: "MRN" });
    await db.insert(issues).values([
      { companyId, title: "Write the one-pager", status: "done", completedAt: new Date("2026-10-15T20:00:00Z") },
      { companyId, title: "Old work", status: "done", completedAt: new Date("2026-10-14T20:00:00Z") },
      { companyId, title: "Import contacts", status: "blocked" },
      { companyId, title: "Hidden stuck", status: "blocked", hiddenAt: new Date() },
      { companyId, title: "Under way", status: "in_progress" },
    ]);
  }, 90000);
  afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });
  beforeEach(async () => {
    await db.delete(notificationPreferences);
    await db.delete(pushSubscriptions);
  });

  const service = () => morningSummaryService(db, { buildNeedsMe: async () => emptyNeedsMe({ count: 2 }) });

  it("counts what finished in the last 24 hours and what is stuck", async () => {
    const built = await service().build(companyId, "john", now);
    expect(built.finished.count).toBe(1);
    expect(built.finished.items.map((item) => item.title)).toEqual(["Write the one-pager"]);
    expect(built.stuck.count).toBe(1);
    expect(built.stuck.items.map((item) => item.title)).toEqual(["Import contacts"]);
    expect(built.needsYou.count).toBe(2);
  });

  it("sends once a day to people with a phone registered", async () => {
    await db.insert(pushSubscriptions).values({ companyId, userId: "john", endpoint: "https://push.example/1", p256dh: "k", auth: "a" });
    const sent: Array<{ userId: string; title: string }> = [];
    const deliver = async (_companyId: string, userId: string, message: { title: string }) => {
      sent.push({ userId, title: message.title });
      return { targets: 1, delivered: 1 };
    };
    expect(await service().sendDue(deliver, now)).toBe(1);
    expect(await service().sendDue(deliver, new Date(now.getTime() + 60_000))).toBe(0);
    expect(sent).toEqual([{ userId: "john", title: "Good morning. 2 things need you" }]);
  });
});
