import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agents, createDb, companies, heartbeatRuns, issues, notificationPreferences, pipelineCases, pipelineStages, pipelines, pushSubscriptions } from "@greatstone/db";
import { startEmbeddedPostgresTestDatabase } from "@greatstone/db/test-embedded-postgres";
import { DEFAULT_NOTIFICATION_PREFERENCES, type MorningSummary, type NeedsMe } from "@greatstone/shared";
import { morningSummaryDue, morningSummaryMessage, morningSummaryService, needsYouItems } from "../services/morning-summary.js";

const summary = (needs: number, finished: number, stuck: number, due = 0): MorningSummary => ({
  companyId: "c",
  generatedAt: "",
  since: "",
  needsYou: { count: needs, items: [] },
  dueToday: { count: due, items: [] },
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
    expect(morningSummaryMessage(summary(1, 0, 0, 2), "GRE").body).toBe(
      "2 tasks are due today. No tasks finished since yesterday. Nothing is stuck.",
    );
    expect(morningSummaryMessage({ ...summary(0, 0, 0), deals: { won: 2, lost: 1, items: [] } }, "GRE").body).toBe(
      "No tasks finished since yesterday. Nothing is stuck. 2 deals won.",
    );
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
      { companyId, title: "Send the proposal", status: "todo", dueDate: "2026-10-16" },
      { companyId, title: "Late invoice", status: "in_progress", dueDate: "2026-10-14" },
      { companyId, title: "Due tomorrow", status: "todo", dueDate: "2026-10-17" },
      { companyId, title: "Done today", status: "done", dueDate: "2026-10-16" },
    ]);
    const [agent] = await db.insert(agents).values({ companyId, name: "Writer" }).returning();
    const [running, finished] = await db
      .insert(heartbeatRuns)
      .values([
        { companyId, agentId: agent!.id, status: "running" },
        { companyId, agentId: agent!.id, status: "succeeded" },
      ])
      .returning();
    const [pipeline] = await db.insert(pipelines).values({ companyId, key: "pipedrive-1", name: "DevTools" }).returning();
    const [pdOpen, pdWon] = await db
      .insert(pipelineStages)
      .values([
        { pipelineId: pipeline!.id, key: "pd_1", name: "Qualified", kind: "working", position: 0 },
        { pipelineId: pipeline!.id, key: "won", name: "Won", kind: "done", position: 1 },
      ])
      .returning();
    const deal = (title: string, fields: Record<string, unknown>, stageId = pdOpen!.id) => ({
      companyId, pipelineId: pipeline!.id, stageId, caseKey: title.toLowerCase().replace(/\W+/g, "-"), title, fields,
    });
    await db.insert(pipelineCases).values([
      deal("Acme", { dealStatus: "Open", nextActivityDate: "2026-10-16", nextActivitySubject: "Demo call" }),
      deal("Globex", { dealStatus: "Open", nextActivityDate: "2026-10-12" }),
      deal("Initech", { dealStatus: "Open", nextActivityDate: "2026-10-20" }),
      deal("Umbrella", { dealStatus: "Lost", nextActivityDate: "2026-10-10" }),
      deal("Hooli", { dealStatus: "Open", nextActivityDate: "2026-10-10" }, pdWon!.id),
      deal("Client journey card", { nextActivityDate: "2026-10-10" }),
    ]);
    await db.insert(issues).values([
      { companyId, title: "Drafting the deck", status: "in_progress", executionRunId: running!.id },
      { companyId, title: "Run already ended", status: "in_progress", executionRunId: finished!.id },
    ]);
    // Deals: two closed on a client pipeline since yesterday, one older, one on another pipeline.
    const [clients, hiring] = await db.insert(pipelines).values([
      { companyId, key: "clients", name: "Clients", requiresOrganisation: true },
      { companyId, key: "hiring", name: "Hiring" },
    ]).returning();
    const [won, hired] = await db.insert(pipelineStages).values([
      { companyId, pipelineId: clients!.id, key: "won", name: "Won", kind: "done", position: 0 },
      { companyId, pipelineId: hiring!.id, key: "hired", name: "Hired", kind: "done", position: 0 },
    ]).returning();
    await db.insert(pipelineCases).values([
      { companyId, pipelineId: clients!.id, stageId: won!.id, caseKey: "a", title: "Indago rollout", terminalKind: "done", terminalAt: new Date("2026-10-16T06:00:00Z") },
      { companyId, pipelineId: clients!.id, stageId: won!.id, caseKey: "b", title: "Acme renewal", terminalKind: "cancelled", terminalAt: new Date("2026-10-15T21:00:00Z") },
      { companyId, pipelineId: clients!.id, stageId: won!.id, caseKey: "c", title: "Last week's win", terminalKind: "done", terminalAt: new Date("2026-10-10T09:00:00Z") },
      { companyId, pipelineId: hiring!.id, stageId: hired!.id, caseKey: "d", title: "Candidate hired", terminalKind: "done", terminalAt: new Date("2026-10-16T05:00:00Z") },
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

  it("counts client deals won and lost since yesterday, newest first", async () => {
    const built = await service().build(companyId, "john", now);
    expect(built.deals?.won).toBe(1);
    expect(built.deals?.lost).toBe(1);
    expect(built.deals?.items.map((deal) => [deal.title, deal.outcome])).toEqual([["Indago rollout", "won"], ["Acme renewal", "lost"]]);
  });

  it("lists the tasks an agent is working on right now", async () => {
    const built = await service().build(companyId, "john", now);
    expect(built.workingNow).toEqual({ count: 1, items: [expect.objectContaining({ title: "Drafting the deck" })] });
  });

  it("lists open tasks due today by the person's own date, late ones first", async () => {
    const built = await service().build(companyId, "john", now);
    expect(built.dueToday.count).toBe(2);
    expect(built.dueToday.items.map((item) => [item.title, item.dueDate])).toEqual([
      ["Late invoice", "2026-10-14"],
      ["Send the proposal", "2026-10-16"],
    ]);
    // 23:30 on the 16th in London is already the 17th in Tokyo.
    await db.insert(notificationPreferences).values({ companyId, userId: "kenji", timeZone: "Asia/Tokyo" });
    const tokyo = await service().build(companyId, "kenji", new Date("2026-10-16T22:30:00Z"));
    expect(tokyo.dueToday.count).toBe(3);
  });

  it("lists open Pipedrive deals whose next step is due today or late, linking to each deal", async () => {
    const built = await service().build(companyId, "john", now);
    expect(built.dealNextSteps?.count).toBe(2);
    expect(built.dealNextSteps?.items).toEqual([
      expect.objectContaining({ title: "Globex", dueDate: "2026-10-12", href: expect.stringMatching(/^\/pipelines\/.+\/cases\/.+$/) }),
      expect.objectContaining({ title: "Acme: Demo call", dueDate: "2026-10-16" }),
    ]);
    expect(morningSummaryMessage(built, "MRN").body).toContain("2 deals have their next step due.");
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
