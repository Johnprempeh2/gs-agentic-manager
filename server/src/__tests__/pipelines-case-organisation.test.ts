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

  async function seedOrganisation(companyId: string, name = "Acme Ltd", archived = false) {
    const [row] = await db.insert(organisations).values({
      companyId,
      name,
      archivedAt: archived ? new Date() : null,
    }).returning();
    return row!;
  }

  describe("on a pipeline that requires an organisation", () => {
    it("rejects a case with no organisation", async () => {
      const company = await seedCompany();
      const pipeline = await seedPipeline(company.id, { key: "client-journey", requiresOrganisation: true });
      expect(pipeline.requiresOrganisation).toBe(true);

      const res = await request(app()).post(`/api/pipelines/${pipeline.id}/cases`).send({ title: "Acme" });

      expect(res.status).toBe(422);
      expect(res.body.details?.code).toBe("organisation_required");
      expect(await db.select().from(pipelineCases)).toHaveLength(0);
    });

    it("rejects an organisation of another company", async () => {
      const company = await seedCompany();
      const other = await seedCompany("Other");
      const foreignOrg = await seedOrganisation(other.id);
      const pipeline = await seedPipeline(company.id, { key: "client-journey", requiresOrganisation: true });

      const res = await request(app())
        .post(`/api/pipelines/${pipeline.id}/cases`)
        .send({ title: "Acme", organisationId: foreignOrg.id });

      expect(res.status).toBe(422);
      expect(res.body.details?.code).toBe("organisation_not_found");
    });

    it("rejects an archived organisation", async () => {
      const company = await seedCompany();
      const archived = await seedOrganisation(company.id, "Old Co", true);
      const pipeline = await seedPipeline(company.id, { key: "client-journey", requiresOrganisation: true });

      const res = await request(app())
        .post(`/api/pipelines/${pipeline.id}/cases`)
        .send({ title: "Old Co", organisationId: archived.id });

      expect(res.status).toBe(422);
      expect(res.body.details?.code).toBe("organisation_archived");
    });

    it("creates the case linked to a live organisation of the same company", async () => {
      const company = await seedCompany();
      const org = await seedOrganisation(company.id);
      const pipeline = await seedPipeline(company.id, { key: "client-journey", requiresOrganisation: true });

      const res = await request(app())
        .post(`/api/pipelines/${pipeline.id}/cases`)
        .send({ title: "Acme", organisationId: org.id });

      expect(res.status).toBe(201);
      expect(res.body.case.organisationId).toBe(org.id);
    });

    it("checks the rule when the organisation changes", async () => {
      const company = await seedCompany();
      const org = await seedOrganisation(company.id);
      const archived = await seedOrganisation(company.id, "Old Co", true);
      const next = await seedOrganisation(company.id, "Acme Group");
      const pipeline = await seedPipeline(company.id, { key: "client-journey", requiresOrganisation: true });
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
  });

  describe("on a pipeline without the rule", () => {
    it("creates a case with no organisation", async () => {
      const company = await seedCompany();
      const pipeline = await seedPipeline(company.id, { key: "work" });
      expect(pipeline.requiresOrganisation).toBe(false);

      const res = await request(app()).post(`/api/pipelines/${pipeline.id}/cases`).send({ title: "Fix login" });

      expect(res.status).toBe(201);
      expect(res.body.case.organisationId).toBeNull();
    });

    it("still refuses another company's organisation", async () => {
      const company = await seedCompany();
      const other = await seedCompany("Other");
      const foreignOrg = await seedOrganisation(other.id);
      const pipeline = await seedPipeline(company.id, { key: "work" });

      const res = await request(app())
        .post(`/api/pipelines/${pipeline.id}/cases`)
        .send({ title: "Fix login", organisationId: foreignOrg.id });

      expect(res.status).toBe(422);
      expect(res.body.details?.code).toBe("organisation_not_found");
    });
  });

  it("lets a pipeline writer turn the rule on", async () => {
    const company = await seedCompany();
    const pipeline = await seedPipeline(company.id, { key: "client-journey" });

    const res = await request(app()).patch(`/api/pipelines/${pipeline.id}`).send({ requiresOrganisation: true });

    expect(res.status).toBe(200);
    expect(res.body.requiresOrganisation).toBe(true);
  });

  describe("backfill", () => {
    it("links client cases, copies contacts, turns the rule on, and is safe to run twice", async () => {
      const company = await seedCompany();
      const existing = await seedOrganisation(company.id, "Acme Ltd");
      const journey = await seedPipeline(company.id, { key: "client-journey" });
      const work = await seedPipeline(company.id, { key: "work" });
      const acme = await request(app()).post(`/api/pipelines/${journey.id}/cases`).send({ title: "acme ltd " });
      const beta = await request(app())
        .post(`/api/pipelines/${journey.id}/cases`)
        .send({ title: "Beta GmbH", fields: { country: "Germany" } });
      const task = await request(app()).post(`/api/pipelines/${work.id}/cases`).send({ title: "Fix login" });
      await db.insert(pipelineCaseContacts).values([
        { companyId: company.id, caseId: beta.body.case.id, name: "Ana", email: "ana@beta.example", position: 0 },
        { companyId: company.id, caseId: beta.body.case.id, name: "Ben", role: "CFO", position: 1 },
      ]);

      const dry = await backfillCaseOrganisations(db, { companyId: company.id, dryRun: true });
      expect(dry).toMatchObject({ casesLinked: 2, organisationsCreated: 1, contactsCopied: 2, dryRun: true });
      expect(await db.select().from(organisations)).toHaveLength(1);

      const first = await backfillCaseOrganisations(db, { companyId: company.id });
      expect(first).toMatchObject({ pipelines: 1, casesLinked: 2, organisationsCreated: 1, contactsCopied: 2 });

      const caseRows = await db.select().from(pipelineCases);
      const byId = new Map(caseRows.map((row) => [row.id, row]));
      expect(byId.get(acme.body.case.id)?.organisationId).toBe(existing.id);
      const betaOrgId = byId.get(beta.body.case.id)?.organisationId;
      expect(betaOrgId).toBeTruthy();
      expect(byId.get(task.body.case.id)?.organisationId).toBeNull();

      const [betaOrg] = await db.select().from(organisations).where(eq(organisations.id, betaOrgId!));
      expect(betaOrg).toMatchObject({ name: "Beta GmbH", country: "Germany", status: "client" });
      const contacts = await db.select().from(organisationContacts).where(eq(organisationContacts.organisationId, betaOrgId!));
      expect(contacts.map((row) => row.name).sort()).toEqual(["Ana", "Ben"]);

      const [journeyRow] = await db.select().from(pipelines).where(eq(pipelines.id, journey.id));
      const [workRow] = await db.select().from(pipelines).where(eq(pipelines.id, work.id));
      expect(journeyRow?.requiresOrganisation).toBe(true);
      expect(workRow?.requiresOrganisation).toBe(false);

      const second = await backfillCaseOrganisations(db, { companyId: company.id });
      expect(second).toMatchObject({ casesLinked: 0, organisationsCreated: 0, contactsCopied: 0 });
      expect(await db.select().from(organisations)).toHaveLength(2);
      expect(await db.select().from(organisationContacts)).toHaveLength(2);
    });
  });
});
