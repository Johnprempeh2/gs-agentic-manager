import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agentDailyDigests,
  agents,
  companies,
  costEvents,
  createDb,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  AGENT_DAILY_DIGEST_DOCUMENT_KEY,
  AGENT_DAILY_DIGEST_ORIGIN_KIND,
  agentDailyDigestService,
  buildAgentDailyDigest,
  previousUtcDay,
  renderAgentDailyDigestMarkdown,
  utcDayWindow,
  weeklyReportDay,
  type AgentDailyDigestRows,
} from "../services/agent-daily-digest.js";
import { weeklyReportService } from "../services/weekly-report.js";
import { agentDailyDigestRoutes } from "../routes/agent-daily-digests.js";
import { errorHandler } from "../middleware/index.js";

const at = (time: string) => new Date(`2026-10-15T${time}Z`);

describe("the nightly digest window", () => {
  it("reports on the UTC day before now", () => {
    expect(previousUtcDay(new Date("2026-10-16T00:05:00Z"))).toBe("2026-10-15");
    expect(previousUtcDay(new Date("2026-10-16T23:59:00Z"))).toBe("2026-10-15");
    expect(previousUtcDay(new Date("2026-11-01T00:00:00Z"))).toBe("2026-10-31");
    expect(utcDayWindow("2026-10-15")).toEqual({ start: at("00:00:00"), end: new Date("2026-10-16T00:00:00Z") });
    expect(() => utcDayWindow("2026-02-30")).toThrow();
  });
});

describe("building the digest", () => {
  const rows: AgentDailyDigestRows = {
    agents: [
      { id: "a1", name: "Ada" },
      { id: "a2", name: "Ben" },
      { id: "a3", name: "Cleo" },
    ],
    completed: [
      { agentId: "a1", identifier: "GRE-12", title: "Write the brief", at: at("09:00:00") },
      { agentId: "a1", identifier: "GRE-14", title: "Draft the deck", at: at("15:00:00") },
      { agentId: "a1", identifier: null, title: "Tidy notes", at: at("10:00:00") },
      { agentId: "a1", identifier: "GRE-9", title: "Old one", at: at("08:00:00") },
    ],
    moves: [{ agentId: "a2", identifier: "GRE-20", title: "Book venue", toStatus: "in_review", at: at("11:00:00") }],
    comments: [{ agentId: "a1", count: 3 }, { agentId: "a2", count: 1 }],
    runs: [
      { agentId: "a1", status: "succeeded", identifier: "GRE-12", title: "Write the brief", at: at("09:00:00") },
      { agentId: "a2", status: "failed", identifier: "GRE-21", title: "Import contacts", at: at("12:00:00") },
      { agentId: "a2", status: "timed_out", identifier: null, title: null, at: at("13:00:00") },
    ],
    costs: [{ agentId: "a1", cents: 250 }, { agentId: "a2", cents: 120 }, { agentId: "a3", cents: 0 }],
  };

  it("counts each agent's day and lists a few items, newest first", () => {
    const digest = buildAgentDailyDigest("2026-10-15", rows);
    expect(digest.windowStart).toBe("2026-10-15T00:00:00.000Z");
    expect(digest.totals).toEqual({ tasksCompleted: 4, tasksMoved: 1, comments: 4, runs: 3, failures: 2, spendCents: 370 });
    expect(digest.agents.map((agent) => agent.name)).toEqual(["Ada", "Ben"]);
    const [ada, ben] = digest.agents;
    expect(ada!.completed.map((item) => item.identifier ?? item.title)).toEqual(["GRE-14", "Tidy notes", "GRE-12"]);
    expect(ben!.counts).toEqual({ tasksCompleted: 0, tasksMoved: 1, comments: 1, runs: 2, failures: 2, spendCents: 120 });
    expect(ben!.failed).toEqual([{ identifier: "GRE-21", title: "Import contacts" }]);
  });

  it("writes plain markdown with task identifiers and no internal ids", () => {
    const markdown = renderAgentDailyDigestMarkdown(buildAgentDailyDigest("2026-10-15", rows), "Greatstone");
    expect(markdown).toContain("# Daily digest for 15 Oct 2026");
    expect(markdown).toContain("**All agents:** 4 tasks finished, 1 moved, 4 comments, 3 runs (2 failed). Spend $3.70.");
    expect(markdown).toContain("## Ada\n- Finished 4 tasks: GRE-14 Draft the deck; Tidy notes; GRE-12 Write the brief, and 1 more");
    expect(markdown).toContain("- Moved 1 task: GRE-20 Book venue to in review");
    expect(markdown).toContain("- 2 runs failed on GRE-21 Import contacts");
    expect(markdown).toContain("- Spend $1.20");
    expect(markdown).not.toMatch(/\ba[123]\b/);
    expect(markdown).not.toMatch(/[\u2013\u2014]/);
  });

  it("says so on a quiet day", () => {
    const quiet = buildAgentDailyDigest("2026-10-15", { agents: [], completed: [], moves: [], comments: [], runs: [], costs: [] });
    expect(quiet.agents).toEqual([]);
    expect(renderAgentDailyDigestMarkdown(quiet, "Greatstone")).toContain("No agent did any work this day.");
    expect(weeklyReportDay(quiet)).toMatchObject({ date: "2026-10-15", runs: 0, busiestAgent: null });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("nightly digest service", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let home = "";
  const greatstone = randomUUID();
  const other = randomUUID();
  const paused = randomUUID();
  const everest = randomUUID();
  const ada = randomUUID();
  const stranger = randomUUID();
  const night = new Date("2026-10-16T00:20:00Z");

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "gsam-daily-digest-"));
    vi.stubEnv("GSAM_HOME", home);
    tempDb = await startEmbeddedPostgresTestDatabase("gsam-daily-digest-db-");
    db = createDb(tempDb.connectionString);
    const created = new Date("2026-10-01T00:00:00Z");
    await db.insert(companies).values([
      { id: greatstone, name: "Greatstone", issuePrefix: "GRE", issueCounter: 100, createdAt: created },
      { id: other, name: "Other Co", issuePrefix: "OTH", issueCounter: 100, createdAt: created },
      { id: paused, name: "Paused Co", issuePrefix: "PAU", status: "paused", createdAt: created },
    ]);
    await db.insert(agents).values([
      { id: everest, companyId: greatstone, name: "Everest", role: "ceo", createdAt: created },
      { id: ada, companyId: greatstone, name: "Ada", reportsTo: everest, createdAt: new Date("2026-10-02T00:00:00Z") },
      { id: stranger, companyId: other, name: "Stranger", createdAt: created },
      { companyId: paused, name: "Sleeper", createdAt: created },
    ]);
    const [brief, venue] = await db
      .insert(issues)
      .values([
        { companyId: greatstone, identifier: "GRE-12", title: "Write the brief", status: "done", assigneeAgentId: ada, completedAt: at("09:00:00") },
        { companyId: greatstone, identifier: "GRE-20", title: "Book venue", status: "in_review", assigneeAgentId: ada },
        { companyId: greatstone, identifier: "GRE-3", title: "Last week", status: "done", assigneeAgentId: ada, completedAt: new Date("2026-10-08T09:00:00Z") },
        { companyId: other, identifier: "OTH-1", title: "Secret work", status: "done", assigneeAgentId: stranger, completedAt: at("10:00:00") },
      ])
      .returning();
    await db.insert(activityLog).values({
      companyId: greatstone,
      actorType: "agent",
      actorId: ada,
      agentId: ada,
      action: "issue.updated",
      entityType: "issue",
      entityId: venue!.id,
      details: { identifier: "GRE-20", status: "in_review", _previous: { status: "in_progress" } },
      createdAt: at("11:00:00"),
    });
    await db.insert(issueComments).values([
      { companyId: greatstone, issueId: brief!.id, authorAgentId: ada, body: "Done.", createdAt: at("09:01:00") },
      { companyId: greatstone, issueId: brief!.id, authorAgentId: ada, body: "Yesterday", createdAt: new Date("2026-10-14T09:00:00Z") },
    ]);
    await db.insert(heartbeatRuns).values([
      { companyId: greatstone, agentId: ada, status: "succeeded", finishedAt: at("09:00:00"), contextSnapshot: { issueId: brief!.id } },
      { companyId: greatstone, agentId: ada, status: "failed", finishedAt: at("12:00:00"), contextSnapshot: { issueId: venue!.id } },
    ]);
    const cost = { provider: "anthropic", model: "m" };
    await db.insert(costEvents).values([
      { ...cost, companyId: greatstone, agentId: ada, costCents: 250, occurredAt: at("09:00:00") },
      { ...cost, companyId: greatstone, agentId: everest, costCents: 40, occurredAt: at("23:59:00") },
      { ...cost, companyId: greatstone, agentId: ada, costCents: 9000, occurredAt: new Date("2026-10-16T00:01:00Z") },
      { ...cost, companyId: other, agentId: stranger, costCents: 777, occurredAt: at("10:00:00") },
    ]);
  }, 90_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("stores yesterday once per company and writes it to the lead agent's standing task", async () => {
    const service = agentDailyDigestService(db);
    const first = await service.runDue(night);
    expect(first).toEqual({ date: "2026-10-15", delivered: 2, skipped: 1 });

    // A restart, or a second round, sends nothing again.
    expect(await service.runDue(new Date(night.getTime() + 10 * 60_000))).toEqual({ date: "2026-10-15", delivered: 0, skipped: 0 });
    expect((await service.runForCompany(greatstone, "2026-10-15")).status).toBe("exists");

    const rows = await db.select().from(agentDailyDigests).where(eq(agentDailyDigests.companyId, greatstone));
    expect(rows).toHaveLength(1);
    const digest = rows[0]!;
    expect(digest.leadAgentId).toBe(everest);
    expect(digest.payload.totals).toEqual({ tasksCompleted: 1, tasksMoved: 1, comments: 1, runs: 2, failures: 1, spendCents: 290 });
    expect(digest.payload.agents.map((agent) => agent.name)).toEqual(["Ada", "Everest"]);
    expect(digest.body).toContain("GRE-12 Write the brief");
    expect(digest.body).not.toContain("Secret work");

    const [task] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, greatstone), eq(issues.originKind, AGENT_DAILY_DIGEST_ORIGIN_KIND)));
    expect(task).toMatchObject({ title: "Daily digest", status: "backlog", assigneeAgentId: everest, originId: greatstone });
    expect(digest.deliveredIssueId).toBe(task!.id);
    expect(digest.deliveredAt).not.toBeNull();

    const docs = await db
      .select({ body: documents.latestBody, revision: documents.latestRevisionNumber })
      .from(issueDocuments)
      .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
      .where(and(eq(issueDocuments.issueId, task!.id), eq(issueDocuments.key, AGENT_DAILY_DIGEST_DOCUMENT_KEY)));
    expect(docs).toEqual([{ body: digest.body, revision: 1 }]);

    const logged = await db
      .select({ action: activityLog.action, agentId: activityLog.agentId })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, greatstone), eq(activityLog.actorId, "agent_daily_digest")));
    expect(logged).toEqual([{ action: "agent_daily_digest.delivered", agentId: everest }]);
  });

  it("keeps each company's digest to its own work and skips delivery while a company is paused", async () => {
    const [otherDigest] = await db.select().from(agentDailyDigests).where(eq(agentDailyDigests.companyId, other));
    expect(otherDigest!.payload.totals.spendCents).toBe(777);
    expect(otherDigest!.body).toContain("OTH-1 Secret work");
    expect(otherDigest!.body).not.toContain("GRE-12");

    const [pausedDigest] = await db.select().from(agentDailyDigests).where(eq(agentDailyDigests.companyId, paused));
    expect(pausedDigest).toMatchObject({ skippedReason: "company_paused", deliveredIssueId: null });
    const pausedTasks = await db.select().from(issues).where(eq(issues.companyId, paused));
    expect(pausedTasks).toEqual([]);
  });

  it("adds the next night as a new revision on the same task", async () => {
    const service = agentDailyDigestService(db);
    expect((await service.runForCompany(greatstone, "2026-10-16")).status).toBe("delivered");
    const tasks = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, greatstone), eq(issues.originKind, AGENT_DAILY_DIGEST_ORIGIN_KIND)));
    expect(tasks).toHaveLength(1);
    const [doc] = await db
      .select({ revision: documents.latestRevisionNumber, body: documents.latestBody })
      .from(issueDocuments)
      .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
      .where(eq(issueDocuments.issueId, tasks[0]!.id));
    expect(doc!.revision).toBe(2);
    expect(doc!.body).toContain("# Daily digest for 16 Oct 2026");
  });

  it("feeds the weekly report day by day", async () => {
    const report = await weeklyReportService(db, {
      buildNeedsMe: async () => ({ companyId: greatstone, generatedAt: "", count: 0, decisionCount: 0, assignedTaskCount: 0, decisions: [], assignedTasks: [], overdueWaits: [] }),
    }).build(greatstone, "john", new Date("2026-10-19T07:00:00Z"));
    expect(report.daily.map((day) => [day.date, day.tasksCompleted, day.spendCents, day.busiestAgent])).toEqual([
      ["2026-10-15", 1, 290, "Ada"],
      ["2026-10-16", 0, 9000, null],
    ]);
    // The digest task is the platform's own: it never counts as finished work.
    expect(report.finished.agents.every((agent) => agent.name !== "Everest")).toBe(true);
  });

  it("serves the digests to the board and the company's own agents only", async () => {
    const appFor = (actor: Record<string, unknown>) => {
      const app = express();
      app.use((req, _res, next) => {
        req.actor = actor as never;
        next();
      });
      app.use("/api", agentDailyDigestRoutes(db));
      app.use(errorHandler);
      return app;
    };
    const board = appFor({ type: "board", userId: "john", source: "session", isInstanceAdmin: false, companyIds: [greatstone] });
    const ok = await request(board).get(`/api/companies/${greatstone}/agent-daily-digests`).query({ from: "2026-10-10", to: "2026-10-16" });
    expect(ok.status).toBe(200);
    expect(ok.body.digests.map((digest: { date: string }) => digest.date)).toEqual(["2026-10-16", "2026-10-15"]);
    expect(ok.body.digests[0].deliveredIssueIdentifier).toBe("GRE-101");

    const agent = appFor({ type: "agent", agentId: everest, companyId: greatstone, source: "agent_key" });
    const asAgent = await request(agent).get(`/api/companies/${greatstone}/agent-daily-digests`).query({ from: "2026-10-15", to: "2026-10-15" });
    expect(asAgent.status).toBe(200);
    expect(asAgent.body.digests).toHaveLength(1);

    expect((await request(agent).get(`/api/companies/${other}/agent-daily-digests`)).status).toBe(403);
    expect((await request(board).get(`/api/companies/${other}/agent-daily-digests`)).status).toBe(403);
    expect((await request(board).get(`/api/companies/${greatstone}/agent-daily-digests`).query({ from: "2026-10-16", to: "2026-10-15" })).status).toBe(400);
    expect((await request(board).get(`/api/companies/${greatstone}/agent-daily-digests`).query({ from: "2026-01-01", to: "2026-10-15" })).status).toBe(400);
    expect((await request(board).get(`/api/companies/${greatstone}/agent-daily-digests`).query({ from: "15/10/2026" })).status).toBe(400);
  });
});
