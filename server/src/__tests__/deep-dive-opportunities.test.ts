import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  caseDocuments,
  cases,
  companies,
  createDb,
  deepDiveBuilds,
  deepDiveFindings,
  deepDiveKpiProcesses,
  deepDiveKpis,
  deepDiveOpportunities,
  deepDiveOpportunityFindings,
  deepDivePeople,
  deepDiveProcesses,
  documents,
  instanceSettings,
} from "@greatstone/db";
import { DEEP_DIVE_GIF } from "@greatstone/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { deepDiveBoardsRoutes } from "../routes/deep-dive-boards.js";
import { deepDiveOpportunitiesRoutes } from "../routes/deep-dive-opportunities.js";
import { companyService } from "../services/companies.js";
import { deepDiveFindingsService } from "../services/deep-dive-findings.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Deep Dive opportunities tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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

describeEmbeddedPostgres("Deep Dive opportunities and KPIs (GRE-2370)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-deep-dive-opportunities-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(deepDiveKpiProcesses);
    await db.delete(deepDiveKpis);
    await db.delete(deepDiveBuilds);
    await db.delete(deepDiveOpportunityFindings);
    await db.delete(deepDiveOpportunities);
    await db.delete(deepDiveProcesses);
    await db.delete(deepDivePeople);
    await db.delete(deepDiveFindings);
    await db.delete(caseDocuments);
    await db.delete(documents);
    await db.delete(cases);
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

  /** One Investigation Stream with its GIF cells, and findings in it: validated unless asked otherwise. */
  async function seedFindings(companyId: string, statements: string[], status: "validated" | "proposed" = "validated") {
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
    const ids: string[] = [];
    for (const statement of statements) {
      const finding = await findings.propose(companyId, { streamCaseId: stream!.id, gifKey: DEEP_DIVE_GIF[0]!.key, statement }, { type: "user", userId: "board-user" });
      if (status === "validated") await findings.decide(finding.id, "validated", { type: "user", userId: "board-user" });
      ids.push(finding.id);
    }
    return { streamId: stream!.id, ids };
  }

  async function seedPerson(companyId: string, name: string) {
    const board = (await api().post(`/api/companies/${companyId}/deep-dive/people`).send({ name }).expect(201)).body;
    return board.people.find((p: { name: string }) => p.name === name).id as string;
  }

  async function seedProcess(companyId: string, name: string) {
    const board = (await api().post(`/api/companies/${companyId}/deep-dive/processes`).send({ name }).expect(201)).body;
    return board.processes.find((p: { name: string }) => p.name === name).id as string;
  }

  describe("opportunities", () => {
    it("links many validated findings and many builds, and reloads them as saved", async () => {
      const company = await seedCompany("DOP");
      const { ids: [f1, f2, f3] } = await seedFindings(company.id, ["Quotes take 8 days", "Prices retyped twice", "No quote tracking"]);

      let board = (await api().post(`/api/companies/${company.id}/deep-dive/opportunities`).send({
        name: "Faster quotes",
        desiredOutcome: "A quote goes out the same day",
        findingIds: [f1, f2],
      }).expect(201)).body;
      const opp = board.opportunities[0];
      expect(opp).toMatchObject({ name: "Faster quotes", state: "draft", visibility: "internal", findingIds: [f1, f2] });
      expect(board.findings.map((f: { id: string }) => f.id).sort()).toEqual([f1, f2, f3].sort());
      expect(board.findings[0]).toMatchObject({ status: "validated", streamTitle: "Deep dive: Operations" });

      await api().post(`/api/companies/${company.id}/deep-dive/builds`).send({ name: "Quote builder", opportunityId: opp.id }).expect(201);
      board = (await api().post(`/api/companies/${company.id}/deep-dive/builds`).send({ name: "Price list sync", opportunityId: opp.id }).expect(201)).body;
      expect(board.builds.filter((b: { opportunityId: string }) => b.opportunityId === opp.id).map((b: { name: string }) => b.name))
        .toEqual(["Quote builder", "Price list sync"]);

      // The set is replaced: f2 stays as it was, f1 goes, f3 joins.
      board = (await api().patch(`/api/deep-dive/opportunities/${opp.id}`).send({ findingIds: [f2, f3] }).expect(200)).body;
      expect(board.opportunities[0].findingIds).toEqual([f2, f3]);

      const reloaded = (await api().get(`/api/companies/${company.id}/deep-dive/opportunities`).expect(200)).body;
      expect(reloaded.opportunities[0].findingIds).toEqual([f2, f3]);
      expect(reloaded.builds).toHaveLength(2);
      const links = await db.select().from(deepDiveOpportunityFindings).where(eq(deepDiveOpportunityFindings.opportunityId, opp.id));
      expect(links).toHaveLength(2);
    });

    it("needs a desired outcome", async () => {
      const company = await seedCompany("DOD");
      await api().post(`/api/companies/${company.id}/deep-dive/opportunities`).send({ name: "Faster quotes" }).expect(400);
      const err = await refused(db.insert(deepDiveOpportunities).values({ companyId: company.id, name: "x", desiredOutcome: " " }));
      expect(err.code).toBe("23514");
    });

    it("links only validated findings, and keeps a link when its finding is later superseded", async () => {
      const company = await seedCompany("DOV");
      const { ids: [proposed] } = await seedFindings(company.id, ["Not yet judged"], "proposed");
      const { streamId, ids: [validated] } = await seedFindings(company.id, ["Quotes take 8 days"]);

      const res = await api().post(`/api/companies/${company.id}/deep-dive/opportunities`).send({
        name: "Faster quotes", desiredOutcome: "Same day", findingIds: [proposed],
      }).expect(422);
      expect(res.body.error).toMatch(/validated finding/);
      expect(await db.select().from(deepDiveOpportunities)).toHaveLength(0);

      const board = (await api().post(`/api/companies/${company.id}/deep-dive/opportunities`).send({
        name: "Faster quotes", desiredOutcome: "Same day", findingIds: [validated],
      }).expect(201)).body;
      const oppId = board.opportunities[0].id;

      // Direct writes are refused too.
      const err = await refused(db.insert(deepDiveOpportunityFindings).values({ companyId: company.id, opportunityId: oppId, findingId: proposed! }));
      expect(err.message).toMatch(/validated finding/);

      // Supersede the linked finding: the link stays, and the board still shows it.
      const findings = deepDiveFindingsService(db);
      const next = await findings.propose(company.id, {
        streamCaseId: streamId, gifKey: DEEP_DIVE_GIF[0]!.key, statement: "Quotes take 6 days", supersedesFindingId: validated,
      }, { type: "user", userId: "board-user" });
      await findings.decide(next.id, "validated", { type: "user", userId: "board-user" });
      const after = (await api().patch(`/api/deep-dive/opportunities/${oppId}`).send({ findingIds: [validated, next.id] }).expect(200)).body;
      expect(after.opportunities[0].findingIds).toEqual([validated, next.id]);
      expect(after.findings.find((f: { id: string }) => f.id === validated).status).toBe("superseded");
    });

    it("keeps every link inside one company", async () => {
      const a = await seedCompany("DOA");
      const b = await seedCompany("DOB");
      const { ids: [foreignFinding] } = await seedFindings(b.id, ["Other company finding"]);
      const foreign = (await api().post(`/api/companies/${b.id}/deep-dive/opportunities`).send({ name: "B", desiredOutcome: "B" }).expect(201)).body.opportunities[0];

      await api().post(`/api/companies/${a.id}/deep-dive/opportunities`).send({ name: "A", desiredOutcome: "A", findingIds: [foreignFinding] }).expect(422);
      await api().post(`/api/companies/${a.id}/deep-dive/builds`).send({ name: "A build", opportunityId: foreign.id }).expect(422);
      const err = await refused(db.insert(deepDiveBuilds).values({ companyId: a.id, name: "x", opportunityId: foreign.id }));
      expect(err.code).toBe("23514");

      // Another company's board is not visible to an agent of this one.
      const agent = await seedAgentActor(a.id);
      await api(agent).get(`/api/companies/${b.id}/deep-dive/opportunities`).expect(403);
      await api(agent).patch(`/api/deep-dive/opportunities/${foreign.id}`).send({ name: "taken" }).expect(403);
    });

    it("keeps builds when their opportunity is removed, and needs a reason to table one", async () => {
      const company = await seedCompany("DOR");
      const opp = (await api().post(`/api/companies/${company.id}/deep-dive/opportunities`).send({ name: "O", desiredOutcome: "O" }).expect(201)).body.opportunities[0];
      const build = (await api().post(`/api/companies/${company.id}/deep-dive/builds`).send({ name: "Portal", opportunityId: opp.id }).expect(201)).body.builds[0];

      await api().post(`/api/companies/${company.id}/deep-dive/builds`).send({ name: "Tabled", state: "tabled" }).expect(400);
      const res = await api().patch(`/api/deep-dive/builds/${build.id}`).send({ state: "deferred" }).expect(422);
      expect(res.body.error).toMatch(/needs a reason/);
      await api().patch(`/api/deep-dive/builds/${build.id}`).send({ state: "deferred", stateWhy: "Budget next year" }).expect(200);

      const board = (await api().delete(`/api/deep-dive/opportunities/${opp.id}`).expect(200)).body;
      expect(board.opportunities).toHaveLength(0);
      expect(board.builds[0]).toMatchObject({ id: build.id, opportunityId: null, state: "deferred", stateWhy: "Budget next year" });
    });
  });

  describe("KPIs", () => {
    it("needs an owner, a target and a baseline, and links to processes on the process board", async () => {
      const company = await seedCompany("DKP");
      const owner = await seedPerson(company.id, "Ama");
      const quoting = await seedProcess(company.id, "Quoting");
      const pricing = await seedProcess(company.id, "Pricing");
      const base = { name: "Days to quote", ownerPersonId: owner, unit: "days", direction: "down", baseline: 8.4, definition: "Mean working days from request to quote", baselinePeriod: "Q3 2026", target: 1 };

      for (const key of ["ownerPersonId", "target", "baseline", "definition", "baselinePeriod"] as const) {
        const { [key]: _gone, ...rest } = base;
        await api().post(`/api/companies/${company.id}/deep-dive/kpis`).send(rest).expect(400);
      }

      let board = (await api().post(`/api/companies/${company.id}/deep-dive/kpis`).send({ ...base, processIds: [quoting, pricing] }).expect(201)).body;
      const kpi = board.kpis[0];
      expect(kpi).toMatchObject({ ownerPersonId: owner, baseline: 8.4, target: 1, direction: "down", scope: "company", visibility: "internal" });
      expect(kpi.processIds.sort()).toEqual([quoting, pricing].sort());
      expect(board.processes.map((p: { name: string }) => p.name)).toEqual(["Pricing", "Quoting"]);
      expect(board.people.map((p: { name: string }) => p.name)).toEqual(["Ama"]);

      board = (await api().patch(`/api/deep-dive/kpis/${kpi.id}`).send({ processIds: [pricing], target: 2 }).expect(200)).body;
      expect(board.kpis[0]).toMatchObject({ processIds: [pricing], target: 2 });

      // Removing a process from the process board removes its link.
      await api().delete(`/api/deep-dive/processes/${pricing}`).expect(200);
      board = (await api().get(`/api/companies/${company.id}/deep-dive/opportunities`).expect(200)).body;
      expect(board.kpis[0].processIds).toEqual([]);

      // The owner cannot be removed while they own the number.
      const res = await api().delete(`/api/deep-dive/people/${owner}`).expect(409);
      expect(res.body.error).toMatch(/owns a KPI/);
    });

    it("keeps owner and processes inside one company", async () => {
      const a = await seedCompany("DKA");
      const b = await seedCompany("DKB");
      const owner = await seedPerson(a.id, "Ama");
      const foreignPerson = await seedPerson(b.id, "Kofi");
      const foreignProcess = await seedProcess(b.id, "Their process");
      const base = { name: "N", baseline: 1, definition: "d", baselinePeriod: "p", target: 2 };

      await api().post(`/api/companies/${a.id}/deep-dive/kpis`).send({ ...base, ownerPersonId: foreignPerson }).expect(422);
      await api().post(`/api/companies/${a.id}/deep-dive/kpis`).send({ ...base, ownerPersonId: owner, processIds: [foreignProcess] }).expect(422);
      expect(await db.select().from(deepDiveKpis)).toHaveLength(0);
    });
  });

  describe("sharing and removal", () => {
    it("makes every new item Internal; only a person shares or validates", async () => {
      const company = await seedCompany("DOS");
      const agent = await seedAgentActor(company.id);
      const owner = await seedPerson(company.id, "Ama");

      const opp = (await api(agent).post(`/api/companies/${company.id}/deep-dive/opportunities`).send({ name: "O", desiredOutcome: "O" }).expect(201)).body.opportunities[0];
      expect(opp.visibility).toBe("internal");
      await api(agent).post(`/api/companies/${company.id}/deep-dive/opportunities`).send({ name: "V", desiredOutcome: "V", state: "validated" }).expect(403);
      await api(agent).patch(`/api/deep-dive/opportunities/${opp.id}`).send({ state: "validated" }).expect(403);
      await api(agent).patch(`/api/deep-dive/opportunities/${opp.id}`).send({ visibility: "shared" }).expect(403);
      await api(agent).patch(`/api/deep-dive/opportunities/${opp.id}`).send({ state: "refined" }).expect(200);

      const kpi = (await api(agent).post(`/api/companies/${company.id}/deep-dive/kpis`).send({
        name: "N", ownerPersonId: owner, baseline: 1, definition: "d", baselinePeriod: "p", target: 2,
      }).expect(201)).body.kpis[0];
      await api(agent).patch(`/api/deep-dive/kpis/${kpi.id}`).send({ visibility: "shared" }).expect(403);

      const shared = (await api().patch(`/api/deep-dive/opportunities/${opp.id}`).send({ state: "validated", visibility: "shared" }).expect(200)).body;
      expect(shared.opportunities[0]).toMatchObject({ state: "validated", visibility: "shared" });

      const err = await refused(db.insert(deepDiveBuilds).values({ companyId: company.id, name: "x", visibility: "shared" }));
      expect(err.message).toMatch(/Internal/);
    });

    it("removes a company with its opportunities, builds, KPIs and links", async () => {
      const company = await seedCompany("DOX");
      const { ids } = await seedFindings(company.id, ["F"]);
      const owner = await seedPerson(company.id, "Ama");
      const proc = await seedProcess(company.id, "P");
      const opp = (await api().post(`/api/companies/${company.id}/deep-dive/opportunities`).send({ name: "O", desiredOutcome: "O", findingIds: ids }).expect(201)).body.opportunities[0];
      await api().post(`/api/companies/${company.id}/deep-dive/builds`).send({ name: "B", opportunityId: opp.id }).expect(201);
      await api().post(`/api/companies/${company.id}/deep-dive/kpis`).send({
        name: "N", ownerPersonId: owner, baseline: 1, definition: "d", baselinePeriod: "p", target: 2, processIds: [proc],
      }).expect(201);

      await companyService(db).remove(company.id);
      expect(await db.select().from(deepDiveOpportunities)).toHaveLength(0);
      expect(await db.select().from(deepDiveOpportunityFindings)).toHaveLength(0);
      expect(await db.select().from(deepDiveBuilds)).toHaveLength(0);
      expect(await db.select().from(deepDiveKpis)).toHaveLength(0);
      expect(await db.select().from(deepDiveKpiProcesses)).toHaveLength(0);
    });
  });
});
