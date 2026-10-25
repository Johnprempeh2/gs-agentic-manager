import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  caseDocuments,
  cases,
  companies,
  createDb,
  deepDiveBuilds,
  deepDiveCommercials,
  deepDiveFindingEvidence,
  deepDiveFindings,
  deepDiveKpiProcesses,
  deepDiveKpis,
  deepDiveOpportunities,
  deepDiveOpportunityFindings,
  deepDivePeople,
  deepDiveProcesses,
  deepDiveRoadmapItems,
  deepDiveRoadmapKpis,
  documents,
  instanceSettings,
  pipelineCaseEvidence,
  pipelineCases,
  pipelineStages,
  pipelines,
} from "@greatstone/db";
import { DEEP_DIVE_GIF } from "@greatstone/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { deepDiveBoardsRoutes } from "../routes/deep-dive-boards.js";
import { deepDiveOpportunitiesRoutes } from "../routes/deep-dive-opportunities.js";
import { deepDiveTraceabilityRoutes } from "../routes/deep-dive-traceability.js";
import { companyService } from "../services/companies.js";
import { deepDiveFindingsService } from "../services/deep-dive-findings.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Deep Dive traceability tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function refused(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown })?.cause;
    return (cause ?? error) as { code?: string; message?: string };
  }
  throw new Error("The database accepted a write it should refuse");
}

type Broken = { step: string; missing: string; itemName: string };
const where = (chain: { broken: Broken[] }) => chain.broken.map((b) => `${b.step}->${b.missing}`);

describeEmbeddedPostgres("Deep Dive traceability (GRE-2371)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-deep-dive-traceability-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(deepDiveRoadmapKpis);
    await db.delete(deepDiveRoadmapItems);
    await db.delete(deepDiveCommercials);
    await db.delete(deepDiveKpiProcesses);
    await db.delete(deepDiveKpis);
    await db.delete(deepDiveBuilds);
    await db.delete(deepDiveOpportunityFindings);
    await db.delete(deepDiveOpportunities);
    await db.delete(deepDiveProcesses);
    await db.delete(deepDivePeople);
    await db.delete(deepDiveFindingEvidence);
    await db.delete(deepDiveFindings);
    await db.delete(pipelineCaseEvidence);
    await db.delete(caseDocuments);
    await db.delete(documents);
    await db.delete(cases);
    await db.delete(pipelineCases);
    await db.delete(pipelineStages);
    await db.delete(pipelines);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const person: Express.Request["actor"] = {
    type: "board",
    userId: "board-user",
    source: "local_implicit",
    isInstanceAdmin: true,
  };

  function app(actor: Express.Request["actor"]) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", deepDiveTraceabilityRoutes(db));
    instance.use("/api", deepDiveOpportunitiesRoutes(db));
    instance.use("/api", deepDiveBoardsRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  const api = (actor: Express.Request["actor"] = person) => request(app(actor));

  async function seedCompany(prefix: string) {
    await instanceSettingsService(db).updateExperimental({ enableDeepDive: true });
    const [company] = await db.insert(companies).values({
      name: `${prefix} Co`,
      issuePrefix: `${prefix}${randomUUID().replace(/-/g, "").slice(0, 4)}`,
    }).returning();
    return company!;
  }

  async function seedAgentActor(companyId: string): Promise<Express.Request["actor"]> {
    const [agent] = await db.insert(agents).values({
      companyId,
      name: "Deep Dive Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    return { type: "agent", agentId: agent!.id, companyId, source: "agent_key" } as Express.Request["actor"];
  }

  /** The Deep Dive record with its North Star document. */
  async function seedNorthStar(companyId: string, body: string) {
    const [record] = await db.insert(cases).values({
      companyId,
      caseNumber: Math.floor(Math.random() * 1_000_000),
      identifier: `DD-${randomUUID()}`,
      caseType: "deep_dive",
      key: "record",
      title: "Deep dive record",
    }).returning();
    const [doc] = await db.insert(documents).values({ companyId, title: "North Star", latestBody: body }).returning();
    await db.insert(caseDocuments).values({ companyId, caseId: record!.id, documentId: doc!.id, key: "north-star" });
  }

  /** One client file (a source) and one validated finding that rests on it, unless told otherwise. */
  async function seedSourcedFinding(companyId: string, statement: string, withSource = true) {
    const [pipeline] = await db.insert(pipelines).values({ companyId, key: `j-${randomUUID().slice(0, 8)}`, name: "Client journey" }).returning();
    const [stage] = await db.insert(pipelineStages).values({ pipelineId: pipeline!.id, key: "deep-dive", name: "Deep dive", kind: "working", position: 0 }).returning();
    const [client] = await db.insert(pipelineCases).values({ companyId, pipelineId: pipeline!.id, stageId: stage!.id, caseKey: randomUUID(), title: "Client" }).returning();
    const [source] = await db.insert(pipelineCaseEvidence).values({ companyId, caseId: client!.id, kind: "link", title: "Quote log 2026", url: "https://example.test/log" }).returning();
    const [stream] = await db.insert(cases).values({
      companyId,
      caseNumber: Math.floor(Math.random() * 1_000_000),
      identifier: `DD-${randomUUID()}`,
      caseType: "deep_dive_stream",
      key: `stream-${randomUUID().slice(0, 6)}`,
      title: "Deep dive: Operations",
    }).returning();
    for (const gif of DEEP_DIVE_GIF) {
      const [doc] = await db.insert(documents).values({ companyId, title: gif.label, latestBody: `# ${gif.label}\n` }).returning();
      await db.insert(caseDocuments).values({ companyId, caseId: stream!.id, documentId: doc!.id, key: gif.documentKey });
    }
    const findings = deepDiveFindingsService(db);
    const finding = await findings.propose(companyId, {
      streamCaseId: stream!.id,
      gifKey: DEEP_DIVE_GIF[0]!.key,
      statement,
      evidenceIds: withSource ? [source!.id] : [],
    }, { type: "user", userId: "board-user" });
    await findings.decide(finding.id, "validated", { type: "user", userId: "board-user" });
    return { findingId: finding.id, sourceId: source!.id };
  }

  /** Every link from North Star to KPI, made through the API. */
  async function seedFullChain(companyId: string) {
    await seedNorthStar(companyId, "# North Star\n\nSame-day quotes for every customer. CEO, 3 Oct 2026.\n");
    const { findingId, sourceId } = await seedSourcedFinding(companyId, "Quotes take 8 days");
    const opportunity = (await api().post(`/api/companies/${companyId}/deep-dive/opportunities`)
      .send({ name: "Faster quotes", desiredOutcome: "Same-day quotes", findingIds: [findingId] }).expect(201)).body.opportunities[0];
    const design = (await api().post(`/api/companies/${companyId}/deep-dive/builds`)
      .send({ name: "Quote builder", opportunityId: opportunity.id, state: "agreed" }).expect(201)).body.builds[0];
    const owner = (await api().post(`/api/companies/${companyId}/deep-dive/people`).send({ name: "Ama" }).expect(201)).body.people[0].id;
    const kpi = (await api().post(`/api/companies/${companyId}/deep-dive/kpis`).send({
      name: "Days to quote", ownerPersonId: owner, baseline: 8, definition: "Mean days", baselinePeriod: "Q3 2026", target: 1,
    }).expect(201)).body.kpis[0];
    const commercial = (await api().post(`/api/companies/${companyId}/deep-dive/commercials`)
      .send({ name: "Fixed fee build", buildId: design.id, terms: "Fixed fee, two payments" }).expect(201)).body.commercials[0];
    const chain = (await api().post(`/api/companies/${companyId}/deep-dive/roadmap`)
      .send({ name: "Phase 1", phase: "Q1 2027", commercialId: commercial.id, kpiIds: [kpi.id] }).expect(201)).body;
    return { chain, findingId, sourceId, opportunity, design, commercial, roadmap: chain.roadmap[0], kpi };
  }

  describe("the broken-link check", () => {
    it("finds no broken link in a full chain, and shows every link as saved", async () => {
      const company = await seedCompany("DTF");
      const seeded = await seedFullChain(company.id);

      const chain = (await api().get(`/api/companies/${company.id}/deep-dive/traceability`).expect(200)).body;
      expect(chain.broken).toEqual([]);
      expect(chain.northStar.words).toBe("Same-day quotes for every customer. CEO, 3 Oct 2026.");
      expect(chain.sources).toEqual([{ id: seeded.sourceId, title: "Quote log 2026" }]);
      expect(chain.findings[0]).toMatchObject({ id: seeded.findingId, sourceIds: [seeded.sourceId] });
      expect(chain.opportunities[0]).toMatchObject({ id: seeded.opportunity.id, findingIds: [seeded.findingId] });
      expect(chain.designs[0]).toMatchObject({ id: seeded.design.id, opportunityId: seeded.opportunity.id });
      expect(chain.commercials[0]).toMatchObject({ buildId: seeded.design.id, terms: "Fixed fee, two payments", visibility: "internal" });
      expect(chain.roadmap[0]).toMatchObject({ commercialId: seeded.commercial.id, kpiIds: [seeded.kpi.id], phase: "Q1 2027", visibility: "internal" });
    });

    it("lists where a chain breaks: removing the commercial case breaks it on both sides", async () => {
      const company = await seedCompany("DTB");
      const seeded = await seedFullChain(company.id);

      const chain = (await api().delete(`/api/deep-dive/commercials/${seeded.commercial.id}`).expect(200)).body;
      expect(where(chain)).toEqual(["design->commercial", "roadmap->commercial"]);
      expect(chain.broken[0]).toMatchObject({ itemName: "Quote builder", message: "This design has no commercial case." });
      // The roadmap item stays; only its link is empty.
      expect(chain.roadmap[0]).toMatchObject({ id: seeded.roadmap.id, commercialId: null });
    });

    it("lists a missing North Star, a finding with no source and a KPI no roadmap item moves", async () => {
      const company = await seedCompany("DTM");
      const { findingId } = await seedSourcedFinding(company.id, "Prices retyped twice", false);
      await api().post(`/api/companies/${company.id}/deep-dive/opportunities`)
        .send({ name: "One price list", desiredOutcome: "Typed once", findingIds: [findingId] }).expect(201);
      const owner = (await api().post(`/api/companies/${company.id}/deep-dive/people`).send({ name: "Kofi" }).expect(201)).body.people[0].id;
      await api().post(`/api/companies/${company.id}/deep-dive/kpis`).send({
        name: "Errors per quote", ownerPersonId: owner, baseline: 3, definition: "Count", baselinePeriod: "Q3", target: 0, direction: "down",
      }).expect(201);

      const chain = (await api().get(`/api/companies/${company.id}/deep-dive/traceability`).expect(200)).body;
      expect(where(chain)).toEqual([
        "north_star->source",
        "finding->source",
        "opportunity->design",
        "kpi->roadmap",
      ]);
    });

    it("updates the roadmap item's KPIs as a set", async () => {
      const company = await seedCompany("DTK");
      const seeded = await seedFullChain(company.id);
      let chain = (await api().patch(`/api/deep-dive/roadmap/${seeded.roadmap.id}`).send({ kpiIds: [] }).expect(200)).body;
      expect(where(chain)).toEqual(["roadmap->kpi", "kpi->roadmap"]);
      chain = (await api().patch(`/api/deep-dive/roadmap/${seeded.roadmap.id}`).send({ kpiIds: [seeded.kpi.id] }).expect(200)).body;
      expect(chain.broken).toEqual([]);
    });
  });

  describe("access", () => {
    it("keeps every link inside one company, and hides another company's chain", async () => {
      const a = await seedCompany("DTA");
      const b = await seedCompany("DTC");
      const foreign = await seedFullChain(b.id);

      await api().post(`/api/companies/${a.id}/deep-dive/commercials`).send({ name: "C", buildId: foreign.design.id }).expect(422);
      await api().post(`/api/companies/${a.id}/deep-dive/roadmap`).send({ name: "R", commercialId: foreign.commercial.id }).expect(422);
      await api().post(`/api/companies/${a.id}/deep-dive/roadmap`).send({ name: "R", kpiIds: [foreign.kpi.id] }).expect(422);
      expect(await db.select().from(deepDiveRoadmapItems)).toHaveLength(1);
      const err = await refused(db.insert(deepDiveCommercials).values({ companyId: a.id, name: "x", buildId: foreign.design.id }));
      expect(err.code).toBe("23514");

      const agent = await seedAgentActor(a.id);
      await api(agent).get(`/api/companies/${b.id}/deep-dive/traceability`).expect(403);
      await api(agent).patch(`/api/deep-dive/commercials/${foreign.commercial.id}`).send({ name: "taken" }).expect(403);
      await api(agent).delete(`/api/deep-dive/roadmap/${foreign.roadmap.id}`).expect(403);
    });

    it("makes every new item Internal; only a person shares one", async () => {
      const company = await seedCompany("DTS");
      const agent = await seedAgentActor(company.id);
      const chain = (await api(agent).post(`/api/companies/${company.id}/deep-dive/commercials`).send({ name: "Retainer" }).expect(201)).body;
      const commercial = chain.commercials[0];
      expect(commercial.visibility).toBe("internal");
      await api(agent).post(`/api/companies/${company.id}/deep-dive/commercials`).send({ name: "x", visibility: "shared" }).expect(400);
      await api(agent).patch(`/api/deep-dive/commercials/${commercial.id}`).send({ visibility: "shared" }).expect(403);
      const shared = (await api().patch(`/api/deep-dive/commercials/${commercial.id}`).send({ visibility: "shared" }).expect(200)).body;
      expect(shared.commercials[0].visibility).toBe("shared");

      const err = await refused(db.insert(deepDiveRoadmapItems).values({ companyId: company.id, name: "x", visibility: "shared" }));
      expect(err.message).toMatch(/Internal/);
    });

    it("removes a company with its commercial cases, roadmap and links", async () => {
      const company = await seedCompany("DTX");
      await seedFullChain(company.id);
      await companyService(db).remove(company.id);
      expect(await db.select().from(deepDiveCommercials)).toHaveLength(0);
      expect(await db.select().from(deepDiveRoadmapItems)).toHaveLength(0);
      expect(await db.select().from(deepDiveRoadmapKpis)).toHaveLength(0);
    });
  });
});
