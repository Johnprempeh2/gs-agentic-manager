import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issues,
  organisations,
  pipelineCaseEvents,
  pipelineCaseIssueLinks,
  pipelineCaseProjectLinks,
  pipelineCases,
  pipelineStages,
  pipelines,
  projects,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { organisationRoutes } from "../routes/organisations.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres organisation history tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("organisation history route (GRE-1480)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-organisation-history-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    await instanceSettingsService(db).updateExperimental({ enablePipelines: true });
  });

  afterEach(async () => {
    await db.delete(pipelineCaseEvents);
    await db.delete(pipelineCaseIssueLinks);
    await db.delete(pipelineCaseProjectLinks);
    await db.delete(pipelineCases);
    await db.delete(pipelineStages);
    await db.delete(pipelines);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(organisations);
    await db.delete(companyMemberships);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const admin: Express.Request["actor"] = {
    type: "board",
    userId: "board-user",
    source: "local_implicit",
    isInstanceAdmin: true,
  };

  function app(actor: Express.Request["actor"] = admin) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", organisationRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function seedCompany(name = "Greatstone") {
    const [company] = await db
      .insert(companies)
      .values({ name, issuePrefix: `H${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}` })
      .returning();
    return company!.id;
  }

  async function seedMember(companyId: string) {
    const userId = `user-${randomUUID().slice(0, 8)}`;
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
    });
    return {
      type: "board",
      userId,
      source: "session",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      isInstanceAdmin: false,
    } as Express.Request["actor"];
  }

  async function seedPipeline(companyId: string) {
    const [pipeline] = await db
      .insert(pipelines)
      .values({ companyId, key: `sales-${randomUUID().slice(0, 4)}`, name: "Sales", requiresOrganisation: true })
      .returning();
    const [lead, proposal, won] = await db
      .insert(pipelineStages)
      .values([
        { pipelineId: pipeline!.id, key: "lead", name: "Lead", kind: "working", position: 0 },
        { pipelineId: pipeline!.id, key: "proposal", name: "Proposal", kind: "working", position: 1 },
        { pipelineId: pipeline!.id, key: "won", name: "Won", kind: "done", position: 2 },
      ])
      .returning();
    return { pipeline: pipeline!, lead: lead!, proposal: proposal!, won: won! };
  }

  async function seedOrganisation(companyId: string, name: string) {
    const [row] = await db.insert(organisations).values({ companyId, name }).returning();
    return row!;
  }

  it("returns the cases, stage changes, projects, tasks and last contact date", async () => {
    const companyId = await seedCompany();
    const acme = await seedOrganisation(companyId, "Acme Mining");
    const other = await seedOrganisation(companyId, "Blue Bank");
    const { pipeline, lead, proposal, won } = await seedPipeline(companyId);
    const [agent] = await db
      .insert(agents)
      .values({ companyId, name: "Sales Agent", role: "engineer", adapterType: "codex_local" })
      .returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id }).returning();

    const [deal, retired, otherDeal] = await db
      .insert(pipelineCases)
      .values([
        { companyId, pipelineId: pipeline.id, stageId: won.id, caseKey: "deal-1", title: "Acme drill rig", organisationId: acme.id, terminalKind: "done" },
        { companyId, pipelineId: pipeline.id, stageId: lead.id, caseKey: "deal-2", title: "Retired deal", organisationId: acme.id, retiredAt: new Date() },
        { companyId, pipelineId: pipeline.id, stageId: lead.id, caseKey: "deal-3", title: "Blue Bank deal", organisationId: other.id },
      ])
      .returning();

    await db.insert(pipelineCaseEvents).values([
      {
        companyId, caseId: deal!.id, type: "transitioned", actorType: "user", actorUserId: "board-user",
        fromStageId: lead.id, toStageId: proposal.id, createdAt: new Date("2026-10-01T09:00:00Z"),
      },
      {
        companyId, caseId: deal!.id, type: "transition_forced", actorType: "agent", actorAgentId: agent!.id,
        runId: run!.id, fromStageId: proposal.id, toStageId: won.id, createdAt: new Date("2026-10-05T09:00:00Z"),
      },
      // Not a stage change, but still counts as contact.
      { companyId, caseId: deal!.id, type: "updated", actorType: "system", createdAt: new Date("2026-10-07T09:00:00Z") },
      { companyId, caseId: retired!.id, type: "transitioned", actorType: "system", createdAt: new Date("2026-10-11T09:00:00Z") },
      { companyId, caseId: otherDeal!.id, type: "transitioned", actorType: "system", createdAt: new Date("2026-10-11T09:00:00Z") },
    ]);

    const [project] = await db.insert(projects).values({ companyId, name: "Acme onboarding", status: "in_progress" }).returning();
    await db.insert(pipelineCaseProjectLinks).values({ companyId, caseId: deal!.id, projectId: project!.id });

    const [task, hidden] = await db
      .insert(issues)
      .values([
        { companyId, title: "Send the proposal", status: "done", identifier: "H-1", updatedAt: new Date("2026-10-03T09:00:00Z") },
        { companyId, title: "Hidden task", status: "todo", hiddenAt: new Date() },
      ])
      .returning();
    await db.insert(pipelineCaseIssueLinks).values([
      { companyId, caseId: deal!.id, issueId: task!.id, role: "work" },
      { companyId, caseId: deal!.id, issueId: hidden!.id, role: "work" },
    ]);

    const res = await request(app()).get(`/api/companies/${companyId}/organisations/${acme.id}/history`);
    expect(res.status).toBe(200);
    expect(res.body.organisationId).toBe(acme.id);
    // The retired case and the other organisation's case do not appear.
    expect(res.body.cases.map((row: { title: string }) => row.title)).toEqual(["Acme drill rig"]);
    const [history] = res.body.cases;
    expect(history).toMatchObject({
      caseKey: "deal-1",
      pipelineId: pipeline.id,
      pipelineName: "Sales",
      stageName: "Won",
      stageKind: "done",
      terminalKind: "done",
      ndaStatus: "required",
      engagementStatus: "not_sent",
    });
    expect(history.stageChanges).toEqual([
      expect.objectContaining({ fromStageName: "Lead", toStageName: "Proposal", forced: false, actorType: "user", actorAgentName: null }),
      expect.objectContaining({ fromStageName: "Proposal", toStageName: "Won", forced: true, actorType: "agent", actorAgentName: "Sales Agent" }),
    ]);
    expect(history.projects).toEqual([{ id: project!.id, name: "Acme onboarding", status: "in_progress" }]);
    expect(history.tasks).toEqual([
      expect.objectContaining({ id: task!.id, identifier: "H-1", title: "Send the proposal", status: "done" }),
    ]);
    // The newest of case creation, any case event and any linked task.
    expect(new Date(res.body.lastContactAt).getTime()).toBeGreaterThanOrEqual(new Date("2026-10-07T09:00:00Z").getTime());
  });

  it("answers an empty history for an organisation with no cases", async () => {
    const companyId = await seedCompany();
    const acme = await seedOrganisation(companyId, "Acme Mining");
    const res = await request(app()).get(`/api/companies/${companyId}/organisations/${acme.id}/history`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ organisationId: acme.id, lastContactAt: null, cases: [] });
  });

  it("keeps each company's history to itself", async () => {
    const companyA = await seedCompany("Company A");
    const companyB = await seedCompany("Company B");
    const acme = await seedOrganisation(companyA, "Acme Mining");
    const memberOfB = await seedMember(companyB);

    const otherCompany = await request(app(memberOfB)).get(`/api/companies/${companyA}/organisations/${acme.id}/history`);
    expect(otherCompany.status).toBe(403);
    const crossId = await request(app(memberOfB)).get(`/api/companies/${companyB}/organisations/${acme.id}/history`);
    expect(crossId.status).toBe(404);
    const badId = await request(app()).get(`/api/companies/${companyA}/organisations/not-a-uuid/history`);
    expect(badId.status).toBe(404);
  });

  it("is off while pipelines are turned off", async () => {
    const companyId = await seedCompany();
    const acme = await seedOrganisation(companyId, "Acme Mining");
    await instanceSettingsService(db).updateExperimental({ enablePipelines: false });
    const res = await request(app()).get(`/api/companies/${companyId}/organisations/${acme.id}/history`);
    expect(res.status).not.toBe(200);
  });
});
