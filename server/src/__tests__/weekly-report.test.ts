import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  agents,
  companies,
  costEvents,
  createDb,
  issues,
  notificationPreferences,
  pipelineCaseEvents,
  pipelineCases,
  pipelineStages,
  pipelines,
  pushSubscriptions,
} from "@greatstone/db";
import { startEmbeddedPostgresTestDatabase } from "@greatstone/db/test-embedded-postgres";
import { DEFAULT_NOTIFICATION_PREFERENCES, type NeedsMe, type WeeklyReport } from "@greatstone/shared";
import { weeklyReportDue, weeklyReportMessage, weeklyReportService } from "../services/weekly-report.js";

describe("when the weekly report is due", () => {
  const prefs = { ...DEFAULT_NOTIFICATION_PREFERENCES, weeklyReport: true, timeZone: "Europe/London", morningSummaryHour: 8 };
  const monday = (time: string) => new Date(`2026-10-19T${time}Z`); // London is UTC+1 that day

  it("goes on Monday at the morning summary hour, once", () => {
    expect(weeklyReportDue(prefs, null, monday("06:59:00")).due).toBe(false);
    expect(weeklyReportDue(prefs, null, monday("07:00:00"))).toEqual({ due: true, localDate: "2026-10-19" });
    expect(weeklyReportDue(prefs, "2026-10-19", monday("07:30:00")).due).toBe(false);
    expect(weeklyReportDue(prefs, null, new Date("2026-10-20T07:00:00Z")).due).toBe(false);
  });

  it("is off until chosen, and waits for quiet hours to end", () => {
    expect(weeklyReportDue({ ...prefs, weeklyReport: false }, null, monday("07:00:00")).due).toBe(false);
    expect(weeklyReportDue({ ...prefs, quietHoursStart: 22, quietHoursEnd: 9 }, null, monday("07:30:00")).due).toBe(false);
    expect(weeklyReportDue({ ...prefs, quietHoursStart: 22, quietHoursEnd: 9 }, null, monday("08:30:00")).due).toBe(true);
    expect(weeklyReportDue(prefs, null, monday("11:30:00")).due).toBe(false);
  });

  it("sums the week up in one line and opens the report", () => {
    const report = {
      companyName: "Greatstone",
      finished: { count: 12, agents: [] },
      stuck: { count: 3, items: [] },
      pipeline: { added: 1, moved: 2, won: 0, lost: 0, moves: [] },
      needsYou: { count: 1, items: [] },
    } as unknown as WeeklyReport;
    expect(weeklyReportMessage(report, "GRE")).toEqual({
      title: "Your week at Greatstone",
      body: "12 tasks finished. 3 stuck. Pipeline: 1 new, 2 moves. 1 thing needs you.",
      url: "/GRE/weekly-report",
      tag: "weekly-report",
      badge: 1,
    });
  });
});

const needsMe = (): NeedsMe => ({
  companyId: "c",
  generatedAt: "",
  count: 2,
  decisionCount: 1,
  assignedTaskCount: 1,
  decisions: [],
  // An assigned task is not "needs you": only the overdue wait counts.
  assignedTasks: [{ id: "a", identifier: "WK-8", title: "Sign the lease", status: "todo", priority: "medium", updatedAt: "" }],
  overdueWaits: [{ id: "t", identifier: "WK-9", title: "Pick a launch date" }] as unknown as NeedsMe["overdueWaits"],
});

describe("weekly report service", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const companyId = randomUUID();
  const ada = randomUUID();
  const ben = randomUUID();
  const now = new Date("2026-10-19T07:00:00Z");
  const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "gsam-weekly-tests-"));
    vi.stubEnv("GSAM_HOME", home);
    database = await startEmbeddedPostgresTestDatabase("gsam-weekly-db-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Greatstone", issuePrefix: "WK" });
    await db.insert(agents).values([
      { id: ada, companyId, name: "Ada" },
      { id: ben, companyId, name: "Ben" },
    ]);
    await db.insert(issues).values([
      { companyId, title: "Write the brief", status: "done", assigneeAgentId: ada, completedAt: daysAgo(1) },
      { companyId, title: "Draft the deck", status: "done", assigneeAgentId: ada, completedAt: daysAgo(3) },
      { companyId, title: "Book venue", status: "done", assigneeAgentId: ben, completedAt: daysAgo(2) },
      { companyId, title: "Last month", status: "done", assigneeAgentId: ben, completedAt: daysAgo(20) },
      { companyId, title: "Import contacts", status: "blocked", assigneeAgentId: ben, blockedTransitionAt: daysAgo(4) },
      { companyId, title: "Wait for logo", status: "blocked", blockedTransitionAt: daysAgo(9) },
    ]);
    const [pipeline] = await db.insert(pipelines).values({ companyId, key: "clients", name: "Client journey" }).returning();
    const [lead, proposal, won] = await db
      .insert(pipelineStages)
      .values([
        { pipelineId: pipeline!.id, key: "lead", name: "Lead", kind: "working", position: 0 },
        { pipelineId: pipeline!.id, key: "proposal", name: "Proposal", kind: "working", position: 1 },
        { pipelineId: pipeline!.id, key: "won", name: "Won", kind: "done", position: 2 },
      ])
      .returning();
    const [acme, beta] = await db
      .insert(pipelineCases)
      .values([
        { companyId, pipelineId: pipeline!.id, stageId: won!.id, caseKey: "acme", title: "Acme", createdAt: daysAgo(30) },
        { companyId, pipelineId: pipeline!.id, stageId: proposal!.id, caseKey: "beta", title: "Beta Ltd", createdAt: daysAgo(2) },
      ])
      .returning();
    await db.insert(pipelineCaseEvents).values([
      { companyId, caseId: acme!.id, type: "transitioned", actorType: "user", fromStageId: proposal!.id, toStageId: won!.id, createdAt: daysAgo(1) },
      { companyId, caseId: beta!.id, type: "transitioned", actorType: "user", fromStageId: lead!.id, toStageId: proposal!.id, createdAt: daysAgo(2) },
      { companyId, caseId: acme!.id, type: "transitioned", actorType: "user", fromStageId: lead!.id, toStageId: proposal!.id, createdAt: daysAgo(12) },
    ]);
    const cost = { companyId, provider: "anthropic", model: "m" };
    await db.insert(costEvents).values([
      { ...cost, agentId: ada, costCents: 250, occurredAt: daysAgo(1) },
      { ...cost, agentId: ada, costCents: 150, occurredAt: daysAgo(5) },
      { ...cost, agentId: ben, costCents: 900, occurredAt: daysAgo(2) },
      { ...cost, agentId: ben, costCents: 5000, occurredAt: daysAgo(10) },
    ]);
  }, 90000);
  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("sums up the last seven days", async () => {
    const report = await weeklyReportService(db, { buildNeedsMe: async () => needsMe() }).build(companyId, "john", now);
    expect(report.companyName).toBe("Greatstone");
    expect(report.finished.count).toBe(3);
    expect(report.finished.agents.map((agent) => [agent.name, agent.finished])).toEqual([["Ada", 2], ["Ben", 1]]);
    expect(report.finished.agents[0]!.items.map((item) => item.title)).toEqual(["Write the brief", "Draft the deck"]);

    expect(report.stuck.count).toBe(2);
    expect(report.stuck.items.map((item) => [item.title, item.agentName])).toEqual([["Wait for logo", null], ["Import contacts", "Ben"]]);
    expect(report.stuck.items[0]!.stuckSince).toBe(daysAgo(9).toISOString());

    expect(report.pipeline).toMatchObject({ added: 1, moved: 2, won: 1, lost: 0 });
    expect(report.pipeline.moves.map((move) => [move.title, move.fromStage, move.toStage])).toEqual([
      ["Acme", "Proposal", "Won"],
      ["Beta Ltd", "Lead", "Proposal"],
    ]);

    expect(report.needsYou).toEqual({ count: 1, items: [{ id: "t", identifier: "WK-9", title: "Pick a launch date" }] });
    expect(report.costs).toEqual({
      totalCents: 1300,
      agents: [
        { agentId: ben, name: "Ben", cents: 900 },
        { agentId: ada, name: "Ada", cents: 400 },
      ],
    });
  });

  it("sends on Monday morning only to people who chose it", async () => {
    await db.insert(pushSubscriptions).values([
      { companyId, userId: "john", endpoint: "https://push.example/john", p256dh: "k", auth: "a" },
      { companyId, userId: "ben", endpoint: "https://push.example/ben", p256dh: "k", auth: "a" },
    ]);
    await db.insert(notificationPreferences).values({ companyId, userId: "john", weeklyReport: true });
    const sent: Array<{ userId: string; title: string }> = [];
    const deliver = async (_companyId: string, userId: string, message: { title: string }) => {
      sent.push({ userId, title: message.title });
      return { targets: 1, delivered: 1 };
    };
    const service = weeklyReportService(db, { buildNeedsMe: async () => needsMe() });
    expect(await service.sendDue(deliver, now)).toBe(1);
    expect(await service.sendDue(deliver, new Date(now.getTime() + 60_000))).toBe(0);
    expect(sent).toEqual([{ userId: "john", title: "Your week at Greatstone" }]);
  });
});
