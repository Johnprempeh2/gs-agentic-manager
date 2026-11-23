import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  instanceSettings,
  intelligenceBoardSnapshots,
  intelligenceRecommendations,
  intelligenceReports,
  intelligenceSettings,
  issues,
  principalPermissionGrants,
} from "@greatstone/db";
import { INTELLIGENCE_AI_PRESET } from "@greatstone/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { intelligenceRoutes } from "../routes/intelligence.js";
import { instanceSettingsService } from "../services/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe.sequential : describe.skip;
if (!support.supported) {
  console.warn(`Skipping embedded Postgres intelligence route tests: ${support.reason ?? "unsupported environment"}`);
}

const pulse = {
  kind: "daily_pulse",
  status: "published",
  headline: "Meta ships Muse Wonder",
  sections: {
    quickWin: { title: "Try Cline", action: "Install Cline and run one task.", timeNeeded: "20 minutes", outcome: "A first-hand view." },
    trends: [
      {
        headline: "Meta releases Muse Wonder",
        whyItMatters: "A fourth serious US API vendor at the top.",
        freshness: "today",
        sourceName: "TechCrunch",
        url: "https://techcrunch.com/2026/10/12/meta-releases-its-first-frontier-model-muse-wonder/",
      },
    ],
  },
};

describePostgres("intelligence routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("gsam-intelligence-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(intelligenceSettings);
    await db.delete(intelligenceRecommendations);
    await db.delete(intelligenceBoardSnapshots);
    await db.delete(intelligenceReports);
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => tempDb?.cleanup());

  const board: Express.Request["actor"] = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };

  function app(actor: Express.Request["actor"] = board) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", intelligenceRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function seed() {
    await instanceSettingsService(db).updateExperimental({ enableIntelligence: true });
    const [company] = await db
      .insert(companies)
      .values({ name: "Greatstone", issuePrefix: `I${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}` })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({ companyId: company!.id, name: "Scout", role: "researcher", status: "active", adapterType: "process", adapterConfig: {}, runtimeConfig: {} })
      .returning();
    await db.insert(companyMemberships).values({
      companyId: company!.id,
      principalType: "agent",
      principalId: agent!.id,
      status: "active",
      membershipRole: "member",
    });
    const agentActor = {
      type: "agent",
      agentId: agent!.id,
      companyId: company!.id,
      runId: null,
      source: "agent_jwt",
    } as Express.Request["actor"];
    return { company: company!, agent: agent!, agentActor };
  }

  it("answers 403 not_entitled while the switch is off", async () => {
    const { company } = await seed();
    await instanceSettingsService(db).updateExperimental({ enableIntelligence: false });
    const response = await request(app()).get(`/api/companies/${company.id}/intelligence/reports`);
    expect(response.status).toBe(403);
    expect(response.body.feature).toBe("enableIntelligence");
  });

  it("refuses an agent without intelligence:write and accepts one with it", async () => {
    const { company, agent, agentActor } = await seed();
    const refused = await request(app(agentActor)).put(`/api/companies/${company.id}/intelligence/reports/2026-10-13`).send(pulse);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain("Missing permission: intelligence:write");

    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "agent",
      principalId: agent.id,
      permissionKey: "intelligence:write",
      scope: null,
    });
    const written = await request(app(agentActor)).put(`/api/companies/${company.id}/intelligence/reports/2026-10-13`).send(pulse);
    expect(written.status, JSON.stringify(written.body)).toBe(200);
    expect(written.body).toMatchObject({ kind: "daily_pulse", status: "published", createdByAgentId: agent.id });
    expect(written.body.publishedAt).toBeTruthy();

    // An agent can read without the grant's help, and `latest` finds the published report.
    const latest = await request(app(agentActor)).get(`/api/companies/${company.id}/intelligence/reports/latest?kind=daily_pulse`);
    expect(latest.status).toBe(200);
    expect(latest.body.sections.trends[0].sourceName).toBe("TechCrunch");
  });

  it("lets a board user write, rejects a bad shape with the field path, and lists the archive", async () => {
    const { company } = await seed();
    const http = request(app());
    const bad = await http
      .put(`/api/companies/${company.id}/intelligence/reports/2026-10-13`)
      .send({ ...pulse, sections: { ...pulse.sections, trends: [{ ...pulse.sections.trends[0], url: undefined }] } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain("url");

    await http.put(`/api/companies/${company.id}/intelligence/reports/2026-10-12`).send({ ...pulse, status: "draft" }).expect(200);
    await http.put(`/api/companies/${company.id}/intelligence/reports/2026-10-13`).send(pulse).expect(200);
    const archive = await http.get(`/api/companies/${company.id}/intelligence/reports?kind=daily_pulse`).expect(200);
    expect(archive.body.reports.map((r: { reportDate: string }) => r.reportDate)).toEqual(["2026-10-13", "2026-10-12"]);
  });

  it("computes week-over-week board movement from stored snapshots", async () => {
    const { company } = await seed();
    const http = request(app());
    await http.put(`/api/companies/${company.id}/intelligence/settings`).send(INTELLIGENCE_AI_PRESET).expect(200);
    const put = (date: string, entries: unknown[]) =>
      http.put(`/api/companies/${company.id}/intelligence/boards/ai_systems/snapshots/${date}`).send({ entries }).expect(200);
    await put("2026-10-05", [{ name: "Gemini", rank: 1, score: 95 }, { name: "Claude", rank: 2, score: 94 }]);
    await put("2026-10-12", [{ name: "Claude", rank: 1, score: 96 }, { name: "Gemini", rank: 2, score: 96 }]);
    await put("2026-10-13", [{ name: "Claude", rank: 1, score: 97.3 }, { name: "Gemini", rank: 2, score: 96.6 }, { name: "Kimi", rank: 3, score: 72 }]);

    const response = await http.get(`/api/companies/${company.id}/intelligence/boards`).expect(200);
    const [systems] = response.body.boards;
    expect(systems).toMatchObject({ board: "ai_systems", label: "AI Systems", scoreLabel: "Score", snapshotDate: "2026-10-13", comparedTo: "2026-10-05" });
    expect(systems.entries.map((e: { movement: unknown }) => e.movement)).toEqual([
      { rankDelta: 1, scoreDelta: 3.3, isNew: false },
      { rankDelta: -1, scoreDelta: 1.6, isNew: false },
      { rankDelta: null, scoreDelta: null, isNew: true },
    ]);

    const history = await http.get(`/api/companies/${company.id}/intelligence/boards/history?limit=2`).expect(200);
    expect(history.body.history).toEqual([
      {
        board: "ai_systems",
        points: [
          { snapshotDate: "2026-10-12", scores: { claude: 96, gemini: 96 } },
          { snapshotDate: "2026-10-13", scores: { claude: 97.3, gemini: 96.6, kimi: 72 } },
        ],
      },
    ]);
  });

  it("starts a new company with no topics, and lets the owner add, rename, reorder and remove them", async () => {
    const { company } = await seed();
    const http = request(app());
    const fresh = await http.get(`/api/companies/${company.id}/intelligence/settings`).expect(200);
    expect(fresh.body).toEqual({ companyId: company.id, configured: false, topics: [], sectionTitles: {}, updatedAt: null });

    const markets = { key: "markets", label: "Markets", covers: "Equities and rates", sources: ["Reuters"], keywords: ["FTSE"], leaderboard: true };
    const jobs = { key: "jobs", label: "Jobs", sources: [], keywords: ["analyst roles"] };
    const saved = await http
      .put(`/api/companies/${company.id}/intelligence/settings`)
      .send({ topics: [markets, jobs], sectionTitles: { trends: "Market moves" } })
      .expect(200);
    expect(saved.body.configured).toBe(true);
    expect(saved.body.topics.map((t: { key: string }) => t.key)).toEqual(["markets", "jobs"]);
    expect(saved.body.topics[1]).toMatchObject({ covers: "", leaderboard: false });

    // Rename and reorder keep the key, so history lines up; removing a topic drops its board from the page.
    await http
      .put(`/api/companies/${company.id}/intelligence/settings`)
      .send({ topics: [{ ...jobs, label: "Job search" }, { ...markets, label: "Global markets" }] })
      .expect(200);
    const read = await http.get(`/api/companies/${company.id}/intelligence/settings`).expect(200);
    expect(read.body.topics.map((t: { label: string }) => t.label)).toEqual(["Job search", "Global markets"]);
    expect(read.body.sectionTitles).toEqual({});

    await http.put(`/api/companies/${company.id}/intelligence/boards/markets/snapshots/2026-11-20`).send({ entries: [{ name: "FTSE 100", rank: 1, score: 8100 }] }).expect(200);
    const refused = await http.put(`/api/companies/${company.id}/intelligence/boards/jobs/snapshots/2026-11-20`).send({ entries: [{ name: "x", rank: 1, score: 1 }] });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toContain("markets");
    const boards = await http.get(`/api/companies/${company.id}/intelligence/boards`).expect(200);
    expect(boards.body.boards).toMatchObject([{ board: "markets", label: "Global markets", scoreLabel: "Score" }]);

    await http.put(`/api/companies/${company.id}/intelligence/settings`).send({ topics: [jobs] }).expect(200);
    const after = await http.get(`/api/companies/${company.id}/intelligence/boards`).expect(200);
    expect(after.body.boards).toEqual([]);
  });

  it("checks Pulse topic tags against the company's topics", async () => {
    const { company } = await seed();
    const http = request(app());
    await http.put(`/api/companies/${company.id}/intelligence/settings`).send({ topics: [{ key: "jobs", label: "Jobs" }] }).expect(200);
    const trend = pulse.sections.trends[0]!;
    const unknown = await http
      .put(`/api/companies/${company.id}/intelligence/reports/2026-11-20`)
      .send({ ...pulse, sections: { ...pulse.sections, trends: [{ ...trend, topic: "ai_systems" }] } });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error).toContain("ai_systems");
    const ok = await http
      .put(`/api/companies/${company.id}/intelligence/reports/2026-11-20`)
      .send({ ...pulse, sections: { ...pulse.sections, trends: [{ ...trend, topic: "jobs" }] } })
      .expect(200);
    expect(ok.body.sections.trends[0].topic).toBe("jobs");
  });

  it("refuses bad settings and keeps them for the owner or an admin", async () => {
    const { company, agentActor } = await seed();
    const dup = await request(app())
      .put(`/api/companies/${company.id}/intelligence/settings`)
      .send({ topics: [{ key: "jobs", label: "Jobs" }, { key: "jobs", label: "Work" }] });
    expect(dup.status).toBe(400);
    expect(JSON.stringify(dup.body)).toContain("Duplicate topic key");
    const badKey = await request(app()).put(`/api/companies/${company.id}/intelligence/settings`).send({ topics: [{ key: "Jobs!", label: "Jobs" }] });
    expect(badKey.status).toBe(400);

    // Agents read the settings to steer their run, but cannot change them.
    await request(app(agentActor)).get(`/api/companies/${company.id}/intelligence/settings`).expect(200);
    const agentWrite = await request(app(agentActor)).put(`/api/companies/${company.id}/intelligence/settings`).send({ topics: [] });
    expect(agentWrite.status).toBe(403);
    const member = {
      type: "board",
      userId: "member-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [company.id],
      memberships: [{ companyId: company.id, membershipRole: "member", status: "active" }],
    } as unknown as Express.Request["actor"];
    const memberWrite = await request(app(member)).put(`/api/companies/${company.id}/intelligence/settings`).send({ topics: [] });
    expect(memberWrite.status).toBe(403);
    const other = await seed();
    const crossCompany = await request(app(agentActor)).get(`/api/companies/${other.company.id}/intelligence/settings`);
    expect(crossCompany.status).toBe(403);
  });

  it("migration 0427 gives companies with intelligence data the AI preset and leaves new companies unset", async () => {
    const withData = await seed();
    const withReport = await seed();
    const fresh = await seed();
    await db.insert(intelligenceBoardSnapshots).values({ companyId: withData.company.id, board: "ai_systems", snapshotDate: "2026-11-01", entries: [] });
    await db.insert(intelligenceReports).values({ companyId: withReport.company.id, reportDate: "2026-11-01", kind: "daily_pulse", sections: {} });

    const migration = readFileSync(new URL("../../../packages/db/src/migrations/0427_intelligence_settings.sql", import.meta.url), "utf8");
    const seedStatement = migration.split("--> statement-breakpoint").find((part) => part.includes("INSERT INTO"))!;
    await db.execute(sql.raw(seedStatement));
    await db.execute(sql.raw(seedStatement)); // re-running changes nothing

    const http = request(app());
    for (const { company } of [withData, withReport]) {
      const settings = await http.get(`/api/companies/${company.id}/intelligence/settings`).expect(200);
      expect(settings.body).toMatchObject({ configured: true, ...INTELLIGENCE_AI_PRESET });
    }
    const unset = await http.get(`/api/companies/${fresh.company.id}/intelligence/settings`).expect(200);
    expect(unset.body.configured).toBe(false);
    // Greatstone's page reads the same three boards in the same order after the migration.
    await http.put(`/api/companies/${withData.company.id}/intelligence/boards/frontier_models/snapshots/2026-11-02`).send({ entries: [{ name: "Claude", rank: 1, score: 70 }] }).expect(200);
    const boards = await http.get(`/api/companies/${withData.company.id}/intelligence/boards`).expect(200);
    expect(boards.body.boards.map((b: { board: string; label: string; scoreLabel: string }) => [b.board, b.label, b.scoreLabel])).toEqual([
      ["ai_systems", "AI Systems", "Score"],
      ["frontier_models", "Frontier Models", "Index"],
    ]);
  });

  it("keeps recommendation decisions and task creation for board users", async () => {
    const { company, agent, agentActor } = await seed();
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "agent",
      principalId: agent.id,
      permissionKey: "intelligence:write",
      scope: null,
    });
    const body = { kind: "gsam_feature", title: "Pulse digest email", why: "John reads the pulse on his phone.", effort: "medium" };
    const created = await request(app(agentActor)).post(`/api/companies/${company.id}/intelligence/recommendations`).send(body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await request(app(agentActor)).post(`/api/companies/${company.id}/intelligence/recommendations`).send(body).expect(409);

    const id = created.body.id as string;
    await request(app(agentActor)).patch(`/api/intelligence/recommendations/${id}`).send({ status: "accepted" }).expect(403);
    await request(app(agentActor)).post(`/api/intelligence/recommendations/${id}/task`).send({}).expect(403);

    const dismissed = await request(app()).patch(`/api/intelligence/recommendations/${id}`).send({ status: "dismissed" }).expect(200);
    expect(dismissed.body.status).toBe("dismissed");
    const task = await request(app()).post(`/api/intelligence/recommendations/${id}/task`).send({});
    expect(task.status, JSON.stringify(task.body)).toBe(201);
    expect(task.body).toMatchObject({ status: "accepted" });
    expect(task.body.issueId).toBeTruthy();
    const [issue] = await db.select().from(issues);
    expect(issue!.title).toBe("GSAM feature: Pulse digest email");
  });
});
