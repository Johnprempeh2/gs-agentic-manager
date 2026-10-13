import { randomUUID } from "node:crypto";
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
  issues,
  principalPermissionGrants,
} from "@greatstone/db";
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
  }, 30_000);

  afterEach(async () => {
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
    const put = (date: string, entries: unknown[]) =>
      http.put(`/api/companies/${company.id}/intelligence/boards/ai_systems/snapshots/${date}`).send({ entries }).expect(200);
    await put("2026-10-05", [{ name: "Gemini", rank: 1, score: 95 }, { name: "Claude", rank: 2, score: 94 }]);
    await put("2026-10-12", [{ name: "Claude", rank: 1, score: 96 }, { name: "Gemini", rank: 2, score: 96 }]);
    await put("2026-10-13", [{ name: "Claude", rank: 1, score: 97.3 }, { name: "Gemini", rank: 2, score: 96.6 }, { name: "Kimi", rank: 3, score: 72 }]);

    const response = await http.get(`/api/companies/${company.id}/intelligence/boards`).expect(200);
    const [systems] = response.body.boards;
    expect(systems).toMatchObject({ board: "ai_systems", snapshotDate: "2026-10-13", comparedTo: "2026-10-05" });
    expect(systems.entries.map((e: { movement: unknown }) => e.movement)).toEqual([
      { rankDelta: 1, scoreDelta: 3.3, isNew: false },
      { rankDelta: -1, scoreDelta: 1.6, isNew: false },
      { rankDelta: null, scoreDelta: null, isNew: true },
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
