import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  companies,
  companyMemberships,
  createDb,
  instanceSettings,
  organisations,
  pipelineCases,
  pipelineStages,
  pipelines,
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
    `Skipping embedded Postgres organisation pipeline stage tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("organisations list: pipelines and stages (GRE-1540)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-organisations-pipeline-stages-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    await instanceSettingsService(db).updateExperimental({ enablePipelines: true });
  });

  afterEach(async () => {
    await db.delete(pipelineCases);
    await db.delete(pipelineStages);
    await db.delete(pipelines);
    await db.delete(organisations);
    await db.delete(companyMemberships);
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
      .values({ name, issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}` })
      .returning();
    return company!.id;
  }

  async function seedPipeline(companyId: string, name: string, archived = false) {
    const [pipeline] = await db
      .insert(pipelines)
      .values({
        companyId,
        key: `${name.toLowerCase()}-${randomUUID().slice(0, 4)}`,
        name,
        archivedAt: archived ? new Date() : null,
      })
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

  it("lists each organisation's live pipelines and current stage, and filters by pipeline and stage", async () => {
    const companyId = await seedCompany();
    const sales = await seedPipeline(companyId, "Sales");
    const delivery = await seedPipeline(companyId, "Delivery");
    const old = await seedPipeline(companyId, "Old", true);
    const acme = await seedOrganisation(companyId, "Acme Mining");
    const blue = await seedOrganisation(companyId, "Blue Bank");
    const cedar = await seedOrganisation(companyId, "Cedar Farms");

    await db.insert(pipelineCases).values([
      { companyId, pipelineId: sales.pipeline.id, stageId: sales.proposal.id, caseKey: "s-1", title: "Acme rig", organisationId: acme.id },
      { companyId, pipelineId: delivery.pipeline.id, stageId: delivery.won.id, caseKey: "d-1", title: "Acme delivery", organisationId: acme.id, terminalKind: "done" },
      { companyId, pipelineId: sales.pipeline.id, stageId: sales.lead.id, caseKey: "s-2", title: "Blue loan", organisationId: blue.id },
      // Retired cases and archived pipelines do not count.
      { companyId, pipelineId: sales.pipeline.id, stageId: sales.proposal.id, caseKey: "s-3", title: "Cedar old", organisationId: cedar.id, retiredAt: new Date() },
      { companyId, pipelineId: old.pipeline.id, stageId: old.lead.id, caseKey: "o-1", title: "Cedar archived", organisationId: cedar.id },
    ]);

    const list = await request(app()).get(`/api/companies/${companyId}/organisations`);
    expect(list.status).toBe(200);
    const byName = new Map(list.body.map((row: { name: string }) => [row.name, row]));
    expect((byName.get("Acme Mining") as { pipelines: unknown[] }).pipelines).toEqual([
      expect.objectContaining({ pipelineName: "Delivery", stageName: "Won", stageKind: "done", terminalKind: "done", caseKey: "d-1" }),
      expect.objectContaining({ pipelineName: "Sales", stageName: "Proposal", stageId: sales.proposal.id, terminalKind: null }),
    ]);
    expect((byName.get("Blue Bank") as { pipelines: unknown[] }).pipelines).toEqual([
      expect.objectContaining({ pipelineId: sales.pipeline.id, stageName: "Lead" }),
    ]);
    expect((byName.get("Cedar Farms") as { pipelines: unknown[] }).pipelines).toEqual([]);

    const names = async (query: string) =>
      (await request(app()).get(`/api/companies/${companyId}/organisations${query}`)).body.map(
        (row: { name: string }) => row.name,
      );
    expect(await names(`?pipelineId=${sales.pipeline.id}`)).toEqual(["Acme Mining", "Blue Bank"]);
    expect(await names(`?pipelineId=${delivery.pipeline.id}`)).toEqual(["Acme Mining"]);
    expect(await names(`?pipelineId=${sales.pipeline.id}&stageId=${sales.lead.id}`)).toEqual(["Blue Bank"]);
    expect(await names(`?stageId=${sales.proposal.id}`)).toEqual(["Acme Mining"]);
    expect(await names(`?pipelineId=${sales.pipeline.id}&stageId=${delivery.won.id}`)).toEqual([]);
    expect(await names(`?pipelineId=${old.pipeline.id}`)).toEqual([]);
    expect(await names(`?pipelineId=${sales.pipeline.id}&q=blue`)).toEqual(["Blue Bank"]);

    const bad = await request(app()).get(`/api/companies/${companyId}/organisations?pipelineId=not-a-uuid`);
    expect(bad.status).toBe(400);
  });

  it("never shows another company's pipelines or matches its pipeline filter", async () => {
    const companyA = await seedCompany("Company A");
    const companyB = await seedCompany("Company B");
    const salesA = await seedPipeline(companyA, "Sales A");
    const acme = await seedOrganisation(companyA, "Acme Mining");
    const blue = await seedOrganisation(companyB, "Blue Bank");
    await db.insert(pipelineCases).values([
      { companyId: companyA, pipelineId: salesA.pipeline.id, stageId: salesA.lead.id, caseKey: "a-1", title: "Acme", organisationId: acme.id },
    ]);

    // Company B filtering by company A's pipeline finds nothing.
    const filtered = await request(app()).get(`/api/companies/${companyB}/organisations?pipelineId=${salesA.pipeline.id}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body).toEqual([]);

    const listB = await request(app()).get(`/api/companies/${companyB}/organisations`);
    expect(listB.body.map((row: { id: string }) => row.id)).toEqual([blue.id]);
    expect(listB.body[0].pipelines).toEqual([]);
  });
});
