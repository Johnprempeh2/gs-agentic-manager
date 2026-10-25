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
  deepDiveFindingEvidence,
  deepDiveFindings,
  deepDiveSessionQuestions,
  deepDiveSessions,
  documents,
  instanceSettings,
} from "@greatstone/db";
import { DEEP_DIVE_GIF, defaultDeepDiveStreamFields } from "@greatstone/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { caseRoutes } from "../routes/cases.js";
import { deepDiveFindingsRoutes } from "../routes/deep-dive-findings.js";
import { deepDiveSessionsRoutes } from "../routes/deep-dive-sessions.js";
import { companyService } from "../services/companies.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Deep Dive sessions tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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

describeEmbeddedPostgres("Deep Dive sessions (GRE-2368)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-deep-dive-sessions-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(deepDiveSessions);
    await db.delete(deepDiveFindingEvidence);
    await db.delete(deepDiveFindings);
    await db.delete(activityLog);
    await db.delete(caseDocuments);
    await db.delete(documents);
    await db.delete(cases);
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
    instance.use("/api", deepDiveSessionsRoutes(db));
    instance.use("/api", deepDiveFindingsRoutes(db));
    instance.use("/api", caseRoutes(db, {} as StorageService));
    instance.use(errorHandler);
    return instance;
  }

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

  /** A deep_dive_stream case with all five GIF documents; `bodies` fills cells beyond the stub. */
  async function seedStream(
    companyId: string,
    key: "operations" | "people",
    options: { knowledge?: Partial<Record<string, string>>; bodies?: Partial<Record<string, string>> } = {},
  ) {
    const fields = defaultDeepDiveStreamFields(key);
    Object.assign(fields.knowledge, options.knowledge ?? {});
    const [stream] = await db.insert(cases).values({
      companyId,
      caseNumber: Math.floor(Math.random() * 1_000_000),
      identifier: `DD-${randomUUID()}`,
      caseType: "deep_dive_stream",
      key,
      title: `Deep dive: ${key}`,
      fields: fields as unknown as Record<string, unknown>,
    }).returning();
    const cells: Record<string, string> = {};
    for (const gif of DEEP_DIVE_GIF) {
      const body = options.bodies?.[gif.key] ?? `# ${gif.label}\n\n${gif.question}\n`;
      const [doc] = await db.insert(documents).values({ companyId, title: gif.label, latestBody: body }).returning();
      const [link] = await db.insert(caseDocuments).values({
        companyId,
        caseId: stream!.id,
        documentId: doc!.id,
        key: gif.documentKey,
      }).returning();
      cells[gif.key] = link!.id;
    }
    return { stream: stream!, cells };
  }

  function plan(actor: Express.Request["actor"], companyId: string, body: Record<string, unknown>) {
    return request(app(actor)).post(`/api/companies/${companyId}/deep-dive/sessions`).send(body);
  }

  function answer(questionId: string, text: string | null, actor = person) {
    return request(app(actor)).patch(`/api/deep-dive/session-questions/${questionId}`).send({ answer: text });
  }

  describe("plan, run, close", () => {
    it("plans a session, runs it one question at a time and closes it", async () => {
      const company = await seedCompany("DSP");
      const { stream, cells } = await seedStream(company.id, "operations");

      const planned = await plan(person, company.id, {
        title: "Operations lead interview",
        plannedFor: "2026-11-02T10:00:00.000Z",
        questions: [
          { streamCaseId: stream.id, gifKey: "current-state" },
          { streamCaseId: stream.id, gifKey: "business-impact", prompt: "What does a late order cost?" },
        ],
      }).expect(201);
      expect(planned.body).toMatchObject({
        status: "planned",
        visibility: "internal",
        plannedFor: "2026-11-02T10:00:00.000Z",
        questionCount: 2,
        answeredCount: 0,
      });
      const [first, second] = planned.body.questions;
      expect(first).toMatchObject({ position: 0, gifKey: "current-state", gifDocumentId: cells["current-state"], prompt: "What exists today?" });
      expect(second).toMatchObject({ position: 1, gifKey: "business-impact", prompt: "What does a late order cost?" });

      // No answers before the session is live.
      await answer(first.id, "Too early").expect(409);

      // Planning: a question can be added, reworded and removed.
      const added = await request(app(person))
        .post(`/api/deep-dive/sessions/${planned.body.id}/questions`)
        .send({ streamCaseId: stream.id, gifKey: "future-state" })
        .expect(201);
      const third = added.body.questions[2];
      expect(third).toMatchObject({ position: 2, gifKey: "future-state" });
      await request(app(person)).patch(`/api/deep-dive/session-questions/${third.id}`).send({ prompt: "What should exist?" }).expect(200);
      const removed = await request(app(person)).delete(`/api/deep-dive/session-questions/${third.id}`).expect(200);
      expect(removed.body.questions).toHaveLength(2);

      const live = await request(app(person)).post(`/api/deep-dive/sessions/${planned.body.id}/start`).expect(200);
      expect(live.body).toMatchObject({ status: "live", startedAt: expect.any(String) });
      await request(app(person)).post(`/api/deep-dive/sessions/${planned.body.id}/start`).expect(409);

      // Once live, the plan is fixed: no rewording or removal.
      await request(app(person)).patch(`/api/deep-dive/session-questions/${first.id}`).send({ prompt: "Changed" }).expect(409);
      await request(app(person)).delete(`/api/deep-dive/session-questions/${first.id}`).expect(409);

      const answered = await answer(first.id, "  Orders are keyed by hand.  ").expect(200);
      expect(answered.body.questions[0]).toMatchObject({
        answer: "Orders are keyed by hand.",
        answeredByUserId: "board-user",
        answeredAt: expect.any(String),
      });
      expect(answered.body.answeredCount).toBe(1);

      const closed = await request(app(person)).post(`/api/deep-dive/sessions/${planned.body.id}/close`).expect(200);
      expect(closed.body).toMatchObject({ status: "closed", closedAt: expect.any(String), questionCount: 2, answeredCount: 1 });

      // A closed session is kept as it was run.
      await answer(second.id, "Late").expect(409);
      await request(app(person)).post(`/api/deep-dive/sessions/${planned.body.id}/questions`)
        .send({ streamCaseId: stream.id, gifKey: "evidence" }).expect(409);
      await request(app(person)).patch(`/api/deep-dive/sessions/${planned.body.id}`).send({ title: "Renamed" }).expect(409);
      await request(app(person)).patch(`/api/deep-dive/sessions/${planned.body.id}`).send({ visibility: "shared" }).expect(200);

      const list = await request(app(person)).get(`/api/companies/${company.id}/deep-dive/sessions`).expect(200);
      expect(list.body.sessions).toEqual([
        expect.objectContaining({ id: planned.body.id, status: "closed", visibility: "shared", questionCount: 2, answeredCount: 1 }),
      ]);
    });

    it("will not start a session with no questions", async () => {
      const company = await seedCompany("DSE");
      const planned = await plan(person, company.id, { title: "Empty" }).expect(201);
      await request(app(person)).post(`/api/deep-dive/sessions/${planned.body.id}/start`).expect(422);
      await request(app(person)).post(`/api/deep-dive/sessions/${planned.body.id}/close`).expect(409);
    });
  });

  describe("what is known shows beside each question", () => {
    it("returns the cell's knowledge, text, findings and answers from other sessions", async () => {
      const company = await seedCompany("DSK");
      const { stream } = await seedStream(company.id, "people", {
        knowledge: { "current-state": "indicated" },
        bodies: { "current-state": "# Current state\n\nTwo teams share one rota.\n" },
      });

      // Nothing known yet about Evidence: Unknown, stub only.
      const earlier = await plan(person, company.id, {
        title: "HR interview",
        questions: [{ streamCaseId: stream.id, gifKey: "current-state" }, { streamCaseId: stream.id, gifKey: "evidence" }],
      }).expect(201);
      expect(earlier.body.questions[1].known).toEqual({ knowledge: "unknown", cellText: null, findings: [], earlierAnswers: [] });
      expect(earlier.body.questions[0].known).toMatchObject({
        knowledge: "indicated",
        cellText: "# Current state\n\nTwo teams share one rota.",
      });

      await request(app(person)).post(`/api/deep-dive/sessions/${earlier.body.id}/start`).expect(200);
      await answer(earlier.body.questions[0].id, "The rota is a shared spreadsheet.").expect(200);
      const turned = await request(app(person))
        .post(`/api/deep-dive/session-questions/${earlier.body.questions[0].id}/finding`)
        .send({})
        .expect(201);
      await request(app(person)).post(`/api/deep-dive/sessions/${earlier.body.id}/close`).expect(200);

      const later = await plan(person, company.id, {
        title: "Team leads",
        questions: [{ streamCaseId: stream.id, gifKey: "current-state" }],
      }).expect(201);
      expect(later.body.questions[0].known).toEqual({
        knowledge: "indicated",
        cellText: "# Current state\n\nTwo teams share one rota.",
        findings: [{ id: turned.body.finding.id, statement: "The rota is a shared spreadsheet.", status: "proposed" }],
        earlierAnswers: [
          expect.objectContaining({
            sessionId: earlier.body.id,
            sessionTitle: "HR interview",
            answer: "The rota is a shared spreadsheet.",
          }),
        ],
      });

      // The session's own answer is not repeated back as "already known".
      const own = await request(app(person)).get(`/api/deep-dive/sessions/${earlier.body.id}`).expect(200);
      expect(own.body.questions[0].known.earlierAnswers).toEqual([]);
    });
  });

  describe("an answer becomes a proposed finding", () => {
    it("proposes a finding in the question's stream and GIF cell, once", async () => {
      const company = await seedCompany("DSF");
      const { stream, cells } = await seedStream(company.id, "operations");
      const agent = await seedAgentActor(company.id);
      const planned = await plan(agent, company.id, {
        title: "Warehouse walk",
        questions: [{ streamCaseId: stream.id, gifKey: "transformation-opportunity" }, { streamCaseId: stream.id, gifKey: "evidence" }],
      }).expect(201);
      const [question, unanswered] = planned.body.questions;
      await request(app(agent)).post(`/api/deep-dive/sessions/${planned.body.id}/start`).expect(200);
      await answer(question.id, "Scan at the dock, not at the desk.", agent).expect(200);

      await request(app(person)).post(`/api/deep-dive/session-questions/${unanswered.id}/finding`).send({}).expect(422);

      const result = await request(app(person))
        .post(`/api/deep-dive/session-questions/${question.id}/finding`)
        .send({ statement: "Scanning at the dock would remove re-keying." })
        .expect(201);
      expect(result.body.finding).toMatchObject({
        status: "proposed",
        visibility: "internal",
        streamCaseId: stream.id,
        gifKey: "transformation-opportunity",
        gifDocumentId: cells["transformation-opportunity"],
        statement: "Scanning at the dock would remove re-keying.",
        proposedByUserId: "board-user",
      });
      expect(result.body.session.questions[0].findingId).toBe(result.body.finding.id);

      await request(app(person)).post(`/api/deep-dive/session-questions/${question.id}/finding`).send({}).expect(409);
      // The answer behind a finding is kept as it was.
      await answer(question.id, "Changed my mind").expect(409);

      // Closing the session leaves the link in place, and a closed answer can still become a finding.
      await request(app(person)).post(`/api/deep-dive/sessions/${planned.body.id}/close`).expect(200);
      const findings = await request(app(person)).get(`/api/companies/${company.id}/deep-dive/findings`).expect(200);
      expect(findings.body.findings).toHaveLength(1);
    });
  });

  describe("permissions and company boundaries", () => {
    it("keeps another company's agent out and lets only a person share", async () => {
      const company = await seedCompany("DSA");
      const other = await seedCompany("DSB");
      const { stream } = await seedStream(company.id, "operations");
      const { stream: otherStream } = await seedStream(other.id, "operations");
      const outsider = await seedAgentActor(other.id);
      const insider = await seedAgentActor(company.id);

      const planned = await plan(person, company.id, { title: "Ops", questions: [{ streamCaseId: stream.id, gifKey: "current-state" }] }).expect(201);
      await request(app(outsider)).get(`/api/deep-dive/sessions/${planned.body.id}`).expect(403);
      await request(app(outsider)).get(`/api/companies/${company.id}/deep-dive/sessions`).expect(403);
      await request(app(outsider)).patch(`/api/deep-dive/session-questions/${planned.body.questions[0].id}`).send({ prompt: "x" }).expect(403);

      // A question can only sit in this company's streams.
      await request(app(person))
        .post(`/api/deep-dive/sessions/${planned.body.id}/questions`)
        .send({ streamCaseId: otherStream.id, gifKey: "current-state" })
        .expect(422);

      await request(app(insider)).patch(`/api/deep-dive/sessions/${planned.body.id}`).send({ visibility: "shared" }).expect(403);
      await request(app(insider)).patch(`/api/deep-dive/sessions/${planned.body.id}`).send({ title: "Ops lead" }).expect(200);
    });

    it("answers 404 for an unknown session and refuses an unknown body key", async () => {
      const company = await seedCompany("DSN");
      await request(app(person)).get(`/api/deep-dive/sessions/${randomUUID()}`).expect(404);
      await plan(person, company.id, { title: "x", status: "live" }).expect(400);
    });
  });

  describe("the database keeps the same rules for any writer", () => {
    it("refuses a session created Live, a step backwards, and answers outside a live session", async () => {
      const company = await seedCompany("DSG");
      const { stream, cells } = await seedStream(company.id, "operations");
      expect((await refused(db.insert(deepDiveSessions).values({ companyId: company.id, title: "x", status: "live", startedAt: new Date() }))).code).toBe("23514");

      const [session] = await db.insert(deepDiveSessions).values({ companyId: company.id, title: "Direct" }).returning();
      const [question] = await db.insert(deepDiveSessionQuestions).values({
        companyId: company.id,
        sessionId: session!.id,
        position: 0,
        streamCaseId: stream.id,
        gifDocumentId: cells["evidence"]!,
        prompt: "What supports this?",
      }).returning();
      expect((await refused(
        db.update(deepDiveSessionQuestions).set({ answer: "x", answeredAt: new Date() }).where(eq(deepDiveSessionQuestions.id, question!.id)),
      )).code).toBe("23514");

      await db.update(deepDiveSessions).set({ status: "live", startedAt: new Date() }).where(eq(deepDiveSessions.id, session!.id));
      expect((await refused(
        db.update(deepDiveSessions).set({ status: "planned", startedAt: null }).where(eq(deepDiveSessions.id, session!.id)),
      )).code).toBe("23514");
      expect((await refused(db.delete(deepDiveSessionQuestions).where(eq(deepDiveSessionQuestions.id, question!.id)))).code).toBe("23514");
    });
  });

  it("removes a company with a live session, and keeps a GIF document a question was asked in", async () => {
    const company = await seedCompany("DSR");
    const { stream } = await seedStream(company.id, "operations");
    const planned = await plan(person, company.id, { title: "Ops", questions: [{ streamCaseId: stream.id, gifKey: "current-state" }] }).expect(201);
    await request(app(person)).post(`/api/deep-dive/sessions/${planned.body.id}/start`).expect(200);
    await request(app(person)).delete(`/api/cases/${stream.id}/documents/gif-current-state`).expect(409);

    await companyService(db).remove(company.id);
    expect(await db.select().from(deepDiveSessions).where(eq(deepDiveSessions.companyId, company.id))).toEqual([]);
  });
});
