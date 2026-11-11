import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  cases,
  companies,
  createDb,
  deepDiveDrafts,
  deepDiveOrgUnits,
  heartbeatRuns,
  instanceSettings,
  pipelineCases,
  pipelineStages,
  pipelines,
} from "@greatstone/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedDeepDiveRecord } from "./helpers/deep-dive-record.js";
import { errorHandler } from "../middleware/error-handler.js";
import { deepDiveBoardsRoutes } from "../routes/deep-dive-boards.js";
import { deepDiveDraftsRoutes } from "../routes/deep-dive-drafts.js";
import { instanceSettingsService } from "../services/instance-settings.js";

// GRE-4430: one Deep Dive per client engagement, and the agent draft tool.
// Access: no company access is refused; agents never approve, publish or
// delete. Scoping: one client's Deep Dive never reads another's.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

async function refused(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: unknown })?.cause;
    return (cause ?? error) as { code?: string; message?: string };
  }
  throw new Error("The database accepted a write it should refuse");
}


const interview = (overrides: Record<string, unknown> = {}) => ({
  interview: {
    notionPage: "https://www.notion.so/demo-meeting",
    meetingTitle: "Demo interview",
    heldOn: "2026-11-12",
    interviewee: "Demo Person, Finance lead",
    questionSource: "Demo interview guide",
    items: [
      { question: "How is a month closed?", status: "answered", answer: "By hand over five days.", quote: "We close by hand, it takes five days.", at: "00:04:10", pillars: ["process"] },
      { question: "Who signs off the forecast?", status: "not_answered" },
      { question: "Which system holds the ledger?", status: "unclear", answer: "Mentioned two systems." },
    ],
    outsideNotes: [{ note: "A new ERP is being trialled." }],
    ...overrides,
  },
});

describeEmbeddedPostgres("Deep Dive per client and agent drafts (GRE-4430)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-deep-dive-drafts-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.execute("ALTER TABLE deep_dive_drafts DISABLE TRIGGER deep_dive_drafts_guard");
    await db.delete(deepDiveDrafts);
    await db.execute("ALTER TABLE deep_dive_drafts ENABLE TRIGGER deep_dive_drafts_guard");
    await db.delete(deepDiveOrgUnits);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(cases);
    await db.delete(pipelineCases);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const person: Express.Request["actor"] = { type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: true };

  function api(actor: Express.Request["actor"] = person) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", deepDiveDraftsRoutes(db));
    instance.use("/api", deepDiveBoardsRoutes(db));
    instance.use(errorHandler);
    return request(instance);
  }

  async function seedClientDeepDive(companyId: string, title: string, fields: Record<string, unknown> = {}) {
    const [pipeline] = await db.insert(pipelines).values({ companyId, key: `journey-${randomUUID().slice(0, 8)}`, name: "Client journey" }).returning();
    const [stage] = await db.insert(pipelineStages).values({ pipelineId: pipeline!.id, key: "deep-dive", name: "Deep dive", kind: "working", position: 0 }).returning();
    const [client] = await db.insert(pipelineCases).values({ companyId, pipelineId: pipeline!.id, stageId: stage!.id, caseKey: randomUUID(), title }).returning();
    const recordId = await seedDeepDiveRecord(db, companyId, client!.id);
    if (Object.keys(fields).length) {
      await db.update(cases).set({ fields: { workstreams: [], status: "active", ...fields } }).where(eq(cases.id, recordId));
    }
    return recordId;
  }

  async function seedCompany(prefix: string) {
    await instanceSettingsService(db).updateExperimental({ enableDeepDive: true });
    const [company] = await db.insert(companies).values({ name: `${prefix} Co`, issuePrefix: `${prefix}${randomUUID().replace(/-/g, "").slice(0, 4)}` }).returning();
    return company!;
  }

  /** An agent acting inside a run, unless withRun is false. */
  async function seedAgent(companyId: string, withRun = true): Promise<Express.Request["actor"] & { runId: string | null }> {
    const [agent] = await db.insert(agents).values({
      companyId, name: "Everest", role: "ceo", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    }).returning();
    const runId = withRun ? randomUUID() : null;
    if (runId) await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: agent!.id, status: "running" });
    return { type: "agent", agentId: agent!.id, companyId, source: "agent_key", runId } as Express.Request["actor"] & { runId: string | null };
  }

  describe("access", () => {
    it("refuses an agent with no access to the company, and a Deep Dive of another company", async () => {
      const mine = await seedCompany("DRA");
      const theirs = await seedCompany("DRB");
      const theirRecord = await seedClientDeepDive(theirs.id, "Demo client B");
      const agent = await seedAgent(mine.id);

      await api(agent).get(`/api/companies/${theirs.id}/deep-dives`).expect(403);
      await api(agent).post(`/api/companies/${theirs.id}/deep-dive/drafts/interview-log?recordId=${theirRecord}`).send(interview()).expect(403);
      // Naming another company's Deep Dive under my company is not found.
      await api(agent).post(`/api/companies/${mine.id}/deep-dive/drafts/interview-log?recordId=${theirRecord}`).send(interview()).expect(404);
      expect(await db.select().from(deepDiveDrafts)).toHaveLength(0);
    });

    it("lets an agent draft but never approve, publish or delete; only a person decides", async () => {
      const company = await seedCompany("DRC");
      const record = await seedClientDeepDive(company.id, "Demo client");
      const agent = await seedAgent(company.id);

      const draft = (await api(agent).post(`/api/companies/${company.id}/deep-dive/drafts/interview-log?recordId=${record}`).send(interview()).expect(201)).body;
      expect(draft).toMatchObject({ status: "draft", version: 1, kind: "interview_log", createdByRunId: agent.runId });

      // The API refuses an agent's decision.
      await api(agent).post(`/api/companies/${company.id}/deep-dive/drafts/${draft.id}/decision?recordId=${record}`)
        .send({ decision: "approved", expectedVersion: 1 }).expect(403);
      // The database refuses a decision with no person and every delete, whoever writes it.
      expect((await refused(db.update(deepDiveDrafts).set({ status: "approved", decidedAt: new Date() }).where(eq(deepDiveDrafts.id, draft.id)))).code).toBe("23514");
      expect((await refused(db.delete(deepDiveDrafts).where(eq(deepDiveDrafts.id, draft.id)))).code).toBe("23514");

      // A person approves against the version they read; the decision is final.
      await api().post(`/api/companies/${company.id}/deep-dive/drafts/${draft.id}/decision?recordId=${record}`)
        .send({ decision: "approved", expectedVersion: 2 }).expect(409);
      const approved = (await api().post(`/api/companies/${company.id}/deep-dive/drafts/${draft.id}/decision?recordId=${record}`)
        .send({ decision: "approved", expectedVersion: 1, note: "Matches the recording" }).expect(200)).body;
      expect(approved).toMatchObject({ status: "approved", decidedByUserId: "board-user", decisionNote: "Matches the recording" });
      await api().post(`/api/companies/${company.id}/deep-dive/drafts/${draft.id}/decision?recordId=${record}`)
        .send({ decision: "rejected", expectedVersion: 1 }).expect(409);
      expect((await refused(db.update(deepDiveDrafts).set({ title: "changed" }).where(eq(deepDiveDrafts.id, draft.id)))).code).toBe("23514");
      // An agent cannot revise a decided draft either.
      await api(agent).post(`/api/companies/${company.id}/deep-dive/drafts/interview-log?recordId=${record}`)
        .send({ ...interview(), draftId: draft.id, expectedVersion: 1 }).expect(409);
    });

    it("audits every write with the agent and run id, and refuses an agent write with no run", async () => {
      const company = await seedCompany("DRL");
      const record = await seedClientDeepDive(company.id, "Demo client");
      const agent = await seedAgent(company.id);
      const draft = (await api(agent).post(`/api/companies/${company.id}/deep-dive/drafts/record-proposal?recordId=${record}`)
        .send({ title: "Risk: files arrive late", proposal: { register: "Risks", values: { Risk: "Files arrive late", Likelihood: "High" } } }).expect(201)).body;
      const [row] = await db.select().from(activityLog).where(eq(activityLog.entityId, draft.id));
      expect(row).toMatchObject({ action: "deep_dive_draft.record_proposed", agentId: (agent as { agentId: string }).agentId, runId: agent.runId });

      const noRun = await seedAgent(company.id, false);
      await api(noRun).post(`/api/companies/${company.id}/deep-dive/drafts/interview-log?recordId=${record}`).send(interview()).expect(422);
    });

    it("checks the interview: an answer needs a verbatim quote, and workstreams are the Deep Dive's own", async () => {
      const company = await seedCompany("DRV");
      const record = await seedClientDeepDive(company.id, "Demo client", { workstreams: ["Evidence", "Economics"] });
      const agent = await seedAgent(company.id);
      const base = `/api/companies/${company.id}/deep-dive/drafts/interview-log?recordId=${record}`;
      await api(agent).post(base).send(interview({ items: [{ question: "Q?", status: "answered", answer: "Yes" }] })).expect(400);
      await api(agent).post(base).send(interview({ items: [{ question: "Q?", status: "not_answered", answer: "Something" }] })).expect(400);
      const wrong = await api(agent).post(base).send(interview({ items: [{ question: "Q?", status: "not_answered", workstream: "Invented" }] })).expect(422);
      expect(wrong.body.error).toContain("Invented");
      await api(agent).post(base).send(interview({ items: [{ question: "Q?", status: "not_answered", workstream: "Economics" }] })).expect(201);
    });
  });

  describe("per Deep Dive scoping", () => {
    it("never shows one client's Deep Dive another's drafts or boards, in the same company", async () => {
      const company = await seedCompany("DRS");
      const recordA = await seedClientDeepDive(company.id, "Demo client A");
      const recordB = await seedClientDeepDive(company.id, "Demo client B");
      const agent = await seedAgent(company.id);

      const draft = (await api(agent).post(`/api/companies/${company.id}/deep-dive/drafts/interview-log?recordId=${recordA}`).send(interview()).expect(201)).body;
      expect((await api().get(`/api/companies/${company.id}/deep-dive/drafts?recordId=${recordA}`).expect(200)).body.drafts).toHaveLength(1);
      expect((await api().get(`/api/companies/${company.id}/deep-dive/drafts?recordId=${recordB}`).expect(200)).body.drafts).toEqual([]);
      await api().get(`/api/companies/${company.id}/deep-dive/drafts/${draft.id}?recordId=${recordB}`).expect(404);
      await api().post(`/api/companies/${company.id}/deep-dive/drafts/${draft.id}/decision?recordId=${recordB}`)
        .send({ decision: "approved", expectedVersion: 1 }).expect(404);
      await api(agent).post(`/api/companies/${company.id}/deep-dive/drafts/interview-log?recordId=${recordB}`)
        .send({ ...interview(), draftId: draft.id, expectedVersion: 1 }).expect(404);

      // The boards are scoped the same way.
      await api().post(`/api/companies/${company.id}/deep-dive/org-units?recordId=${recordA}`).send({ name: "Finance" }).expect(201);
      expect((await api().get(`/api/companies/${company.id}/deep-dive/organisation?recordId=${recordB}`).expect(200)).body.units).toEqual([]);
      expect((await api().get(`/api/companies/${company.id}/deep-dive/organisation?recordId=${recordA}`).expect(200)).body.units).toHaveLength(1);
      await api().get(`/api/companies/${company.id}/deep-dive/organisation`).expect(400);

      // The tiles show both clients, each with its own waiting work.
      const tiles = (await api().get(`/api/companies/${company.id}/deep-dives`).expect(200)).body.deepDives;
      expect(tiles.map((t: { clientName: string; draftsWaiting: number }) => [t.clientName, t.draftsWaiting]).sort()).toEqual([
        ["Demo client A", 1],
        ["Demo client B", 0],
      ]);
    });
  });
});
