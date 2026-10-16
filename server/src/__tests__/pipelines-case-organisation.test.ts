import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  instanceSettings,
  organisationContacts,
  organisations,
  pipelineCaseContacts,
  pipelineCaseDocuments,
  pipelineCaseEvents,
  pipelineCases,
  pipelineStages,
  pipelineTransitions,
  pipelines,
  documentRevisions,
  documents,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { pipelineRoutes } from "../routes/pipelines.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { backfillCaseOrganisations } from "../services/pipeline-case-organisation-backfill.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres case organisation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("pipeline cases link to an organisation (GRE-1478)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pipeline-case-organisation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    await instanceSettingsService(db).updateExperimental({ enablePipelines: true });
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(pipelineCaseEvents);
    await db.delete(pipelineCaseContacts);
    await db.delete(pipelineCaseDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(pipelineCases);
    await db.delete(pipelineTransitions);
    await db.delete(pipelineStages);
    await db.delete(pipelines);
    await db.delete(organisationContacts);
    await db.delete(organisations);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const boardActor: Express.Request["actor"] = {
    type: "board",
    userId: "board-user",
    source: "local_implicit",
    isInstanceAdmin: true,
  };

  function app() {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = boardActor;
      next();
    });
    instance.use("/api", pipelineRoutes(db, { heartbeat: { wakeup: async () => null } }));
    instance.use(errorHandler);
    return instance;
  }

  async function seedCompany(name = "Greatstone") {
    const [company] = await db.insert(companies).values({
      name,
      issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    return company!;
  }

  async function seedPipeline(companyId: string, input: { key: string; requiresOrganisation?: boolean }) {
    const res = await request(app())
      .post(`/api/companies/${companyId}/pipelines`)
      .send({ key: input.key, name: input.key, requiresOrganisation: input.requiresOrganisation });
    expect(res.status).toBe(201);
    return res.body as { id: string; requiresOrganisation: boolean };
  }

  // A card made before the rule: written straight to the table, with no organisation.
  async function seedLegacyCase(companyId: string, pipelineId: string, title: string, fields: Record<string, unknown> = {}) {
    const [stage] = await db.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, pipelineId)).limit(1);
    const [row] = await db.insert(pipelineCases).values({
      companyId,
      pipelineId,
      stageId: stage!.id,
      caseKey: randomUUID(),
      title,
      fields,
    }).returning();
    return row!;
  }

  async function seedOrganisation(companyId: string, name = "Acme Ltd", archived = false) {
    const [row] = await db.insert(organisations).values({
      companyId,
      name,
      archivedAt: archived ? new Date() : null,
    }).returning();
    return row!;
  }

  describe("in every pipeline (GRE-1538)", () => {
    it("rejects a case with no organisation, whatever the pipeline", async () => {
      const company = await seedCompany();
      const journey = await seedPipeline(company.id, { key: "client" });
      const work = await seedPipeline(company.id, { key: "work", requiresOrganisation: false });

      for (const pipeline of [journey, work]) {
        const res = await request(app()).post(`/api/pipelines/${pipeline.id}/cases`).send({ title: "Acme" });
        expect(res.status).toBe(422);
        expect(res.body.details?.code).toBe("organisation_required");
      }
      expect(await db.select().from(pipelineCases)).toHaveLength(0);
    });

    it("rejects a case with no organisation in a batch", async () => {
      const company = await seedCompany();
      const org = await seedOrganisation(company.id);
      const pipeline = await seedPipeline(company.id, { key: "work" });

      const res = await request(app())
        .post(`/api/pipelines/${pipeline.id}/cases/batch`)
        .send({ items: [{ title: "No org" }, { title: "Acme", organisationId: org.id }] });

      expect(res.status).toBeLessThan(300);
      expect(res.body[0]).toMatchObject({ ok: false });
      expect(res.body[0].error.details?.code).toBe("organisation_required");
      expect(res.body[1]).toMatchObject({ ok: true });
    });

    it("rejects an organisation of another company", async () => {
      const company = await seedCompany();
      const other = await seedCompany("Other");
      const foreignOrg = await seedOrganisation(other.id);
      const pipeline = await seedPipeline(company.id, { key: "client" });

      const res = await request(app())
        .post(`/api/pipelines/${pipeline.id}/cases`)
        .send({ title: "Acme", organisationId: foreignOrg.id });

      expect(res.status).toBe(422);
      expect(res.body.details?.code).toBe("organisation_not_found");
    });

    it("rejects an archived organisation", async () => {
      const company = await seedCompany();
      const archived = await seedOrganisation(company.id, "Old Co", true);
      const pipeline = await seedPipeline(company.id, { key: "client" });

      const res = await request(app())
        .post(`/api/pipelines/${pipeline.id}/cases`)
        .send({ title: "Old Co", organisationId: archived.id });

      expect(res.status).toBe(422);
      expect(res.body.details?.code).toBe("organisation_archived");
    });

    it("creates the case linked to a live organisation of the same company", async () => {
      const company = await seedCompany();
      const org = await seedOrganisation(company.id);
      const pipeline = await seedPipeline(company.id, { key: "work" });

      const res = await request(app())
        .post(`/api/pipelines/${pipeline.id}/cases`)
        .send({ title: "Acme", organisationId: org.id });

      expect(res.status).toBe(201);
      expect(res.body.case.organisationId).toBe(org.id);
    });

    it("gives a child case its parent's organisation unless another is named", async () => {
      const company = await seedCompany();
      const org = await seedOrganisation(company.id);
      const other = await seedOrganisation(company.id, "Beta GmbH");
      const pipeline = await seedPipeline(company.id, { key: "work" });
      const parent = await request(app())
        .post(`/api/pipelines/${pipeline.id}/cases`)
        .send({ title: "Acme", organisationId: org.id });

      const inherited = await request(app())
        .post(`/api/pipelines/${pipeline.id}/cases`)
        .send({ title: "Acme step 1", parentCaseId: parent.body.case.id });
      expect(inherited.status).toBe(201);
      expect(inherited.body.case.organisationId).toBe(org.id);

      const named = await request(app())
        .post(`/api/pipelines/${pipeline.id}/cases`)
        .send({ title: "Beta step", parentCaseId: parent.body.case.id, organisationId: other.id });
      expect(named.status).toBe(201);
      expect(named.body.case.organisationId).toBe(other.id);
    });

    it("checks the rule when the organisation changes", async () => {
      const company = await seedCompany();
      const org = await seedOrganisation(company.id);
      const archived = await seedOrganisation(company.id, "Old Co", true);
      const next = await seedOrganisation(company.id, "Acme Group");
      const pipeline = await seedPipeline(company.id, { key: "work" });
      const created = await request(app())
        .post(`/api/pipelines/${pipeline.id}/cases`)
        .send({ title: "Acme", organisationId: org.id });
      const caseId = created.body.case.id as string;

      const cleared = await request(app()).patch(`/api/cases/${caseId}`).send({ organisationId: null });
      expect(cleared.status).toBe(422);
      expect(cleared.body.details?.code).toBe("organisation_required");

      const toArchived = await request(app()).patch(`/api/cases/${caseId}`).send({ organisationId: archived.id });
      expect(toArchived.status).toBe(422);
      expect(toArchived.body.details?.code).toBe("organisation_archived");

      const moved = await request(app()).patch(`/api/cases/${caseId}`).send({ organisationId: next.id });
      expect(moved.status).toBe(200);
      expect(moved.body.organisationId).toBe(next.id);

      // Editing other content does not re-check an unchanged organisation.
      await db.update(organisations).set({ archivedAt: new Date() }).where(eq(organisations.id, next.id));
      const renamed = await request(app()).patch(`/api/cases/${caseId}`).send({ title: "Acme Group" });
      expect(renamed.status).toBe(200);
    });

    it("refuses to save a card made before the rule until it gains an organisation", async () => {
      const company = await seedCompany();
      const org = await seedOrganisation(company.id);
      const pipeline = await seedPipeline(company.id, { key: "work" });
      const legacy = await seedLegacyCase(company.id, pipeline.id, "Acme");

      const renamed = await request(app()).patch(`/api/cases/${legacy.id}`).send({ title: "Acme Ltd" });
      expect(renamed.status).toBe(422);
      expect(renamed.body.details?.code).toBe("organisation_required");

      const linked = await request(app()).patch(`/api/cases/${legacy.id}`).send({ title: "Acme Ltd", organisationId: org.id });
      expect(linked.status).toBe(200);
      expect(linked.body.organisationId).toBe(org.id);
    });
  });

  it("ignores the old per-pipeline switch", async () => {
    const company = await seedCompany();
    const pipeline = await seedPipeline(company.id, { key: "work" });
    expect(pipeline.requiresOrganisation).toBe(true);

    const res = await request(app()).patch(`/api/pipelines/${pipeline.id}`).send({ requiresOrganisation: false });

    expect(res.status).toBe(200);
    const created = await request(app()).post(`/api/pipelines/${pipeline.id}/cases`).send({ title: "Fix login" });
    expect(created.status).toBe(422);
  });

  describe("backfill", () => {
    it("links cases in every pipeline, reports unmatched names, copies contacts, and is safe to run twice", async () => {
      const company = await seedCompany();
      const existing = await seedOrganisation(company.id, "Acme Ltd");
      const journey = await seedPipeline(company.id, { key: "client" });
      const sales = await seedPipeline(company.id, { key: "sales" });
      const acme = await seedLegacyCase(company.id, journey.id, "acme  LTD ");
      const acmeSales = await seedLegacyCase(company.id, sales.id, "Acme Ltd");
      const beta = await seedLegacyCase(company.id, journey.id, "Beta GmbH", { country: "Germany" });
      const betaSales = await seedLegacyCase(company.id, sales.id, "beta gmbh");
      const blank = await seedLegacyCase(company.id, sales.id, "   ");
      await db.insert(pipelineCaseContacts).values([
        { companyId: company.id, caseId: beta.id, name: "Ana", email: "ana@beta.example", position: 0 },
        { companyId: company.id, caseId: beta.id, name: "Ben", role: "CFO", position: 1 },
        { companyId: company.id, caseId: betaSales.id, name: "ana", email: "ANA@beta.example", position: 0 },
      ]);

      const dry = await backfillCaseOrganisations(db, { companyId: company.id, dryRun: true });
      expect(dry).toMatchObject({ pipelines: 2, casesLinked: 4, organisationsCreated: 1, contactsCopied: 2, dryRun: true });
      expect(await db.select().from(organisations)).toHaveLength(1);
      expect((await db.select().from(pipelineCases)).every((row) => row.organisationId === null)).toBe(true);

      const first = await backfillCaseOrganisations(db, { companyId: company.id });
      expect(first).toMatchObject({ pipelines: 2, casesLinked: 4, organisationsCreated: 1, contactsCopied: 2 });
      expect(first.unmatched.map((row) => [row.pipelineKey, row.title]).sort()).toEqual([
        ["client", "Beta GmbH"],
        ["sales", "   "],
        ["sales", "beta gmbh"],
      ]);
      expect(first.unmatched.find((row) => row.caseId === blank.id)?.createdOrganisationId).toBeNull();

      const caseRows = await db.select().from(pipelineCases);
      const byId = new Map(caseRows.map((row) => [row.id, row]));
      expect(byId.get(acme.id)?.organisationId).toBe(existing.id);
      expect(byId.get(acmeSales.id)?.organisationId).toBe(existing.id);
      const betaOrgId = byId.get(beta.id)?.organisationId;
      expect(betaOrgId).toBeTruthy();
      expect(byId.get(betaSales.id)?.organisationId).toBe(betaOrgId);
      expect(byId.get(blank.id)?.organisationId).toBeNull();

      const [betaOrg] = await db.select().from(organisations).where(eq(organisations.id, betaOrgId!));
      expect(betaOrg).toMatchObject({ name: "Beta GmbH", country: "Germany", status: "prospect" });
      const contacts = await db.select().from(organisationContacts).where(eq(organisationContacts.organisationId, betaOrgId!));
      expect(contacts.map((row) => row.name).sort()).toEqual(["Ana", "Ben"]);

      const second = await backfillCaseOrganisations(db, { companyId: company.id });
      expect(second).toMatchObject({ casesLinked: 0, organisationsCreated: 0, contactsCopied: 0 });
      expect(second.unmatched.map((row) => row.caseId)).toEqual([blank.id]);
      expect(await db.select().from(organisations)).toHaveLength(2);
      expect(await db.select().from(organisationContacts)).toHaveLength(2);
    });

    it("limits the run to the named pipelines", async () => {
      const company = await seedCompany();
      const journey = await seedPipeline(company.id, { key: "client" });
      const sales = await seedPipeline(company.id, { key: "sales" });
      const inJourney = await seedLegacyCase(company.id, journey.id, "Acme");
      const inSales = await seedLegacyCase(company.id, sales.id, "Beta");

      const result = await backfillCaseOrganisations(db, { companyId: company.id, pipelineKeys: ["client"] });

      expect(result).toMatchObject({ pipelines: 1, casesLinked: 1 });
      const rows = new Map((await db.select().from(pipelineCases)).map((row) => [row.id, row.organisationId]));
      expect(rows.get(inJourney.id)).toBeTruthy();
      expect(rows.get(inSales.id)).toBeNull();
    });
  });
});
