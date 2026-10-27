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
  deepDiveFindings,
  deepDiveInterviewRounds,
  deepDiveInterviewSets,
  deepDiveOrgUnits,
  deepDivePeople,
  documents,
  instanceSettings,
} from "@greatstone/db";
import { DEEP_DIVE_GIF, defaultDeepDiveStreamFields, type DeepDiveInterviewRoundView } from "@greatstone/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { deepDiveInterviewsRoutes } from "../routes/deep-dive-interviews.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Parallel Interview tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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

describeEmbeddedPostgres("Parallel Interview rounds (GRE-2611)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-deep-dive-interviews-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(deepDiveInterviewRounds);
    await db.delete(deepDivePeople);
    await db.delete(deepDiveOrgUnits);
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
    instance.use("/api", deepDiveInterviewsRoutes(db));
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
      name: "Interview Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    return { type: "agent", agentId: agent!.id, companyId, source: "agent_key" } as Express.Request["actor"];
  }

  /** A stream with its five GIF documents; `bodies` fills cells beyond the stub. */
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
      const [link] = await db.insert(caseDocuments).values({ companyId, caseId: stream!.id, documentId: doc!.id, key: gif.documentKey }).returning();
      cells[gif.key] = link!.id;
    }
    return { stream: stream!, cells };
  }

  async function seedBoard(companyId: string) {
    const [company] = await db.insert(deepDiveOrgUnits).values({ companyId, name: "Northwind Freight", unitType: "company" }).returning();
    const [finance] = await db.insert(deepDiveOrgUnits).values({ companyId, name: "Finance", unitType: "team", parentId: company!.id }).returning();
    const [ama] = await db.insert(deepDivePeople).values({ companyId, name: "Ama Mensah", role: "Finance lead", unitId: finance!.id }).returning();
    const [consultant] = await db.insert(deepDivePeople).values({ companyId, name: "Greatstone consultant", side: "greatstone" }).returning();
    return { company: company!, finance: finance!, ama: ama!, consultant: consultant! };
  }

  function setUp(actor: Express.Request["actor"], companyId: string, body: Record<string, unknown>) {
    return request(app(actor))
      .post(`/api/companies/${companyId}/deep-dive/interview-round`)
      .send({ websiteOrganisationId: "org_7Hq2kLm9", ...body });
  }

  it("refuses a round without the website organisation id, and keeps the id it was given", async () => {
    const company = await seedCompany("DIO");
    for (const websiteOrganisationId of [undefined, "", "  ", "acme ltd", "a@b.com"]) {
      await setUp(person, company.id, { mode: "per_team", websiteOrganisationId }).expect(400);
    }
    // Not past the API either.
    expect(await refused(db.insert(deepDiveInterviewRounds).values({ companyId: company.id, mode: "per_team" } as never))).toMatchObject({ code: "23502" });
    expect(await refused(db.insert(deepDiveInterviewRounds).values({ companyId: company.id, mode: "per_team", websiteOrganisationId: "" }))).toMatchObject({ code: "23514" });

    const created = await setUp(person, company.id, { mode: "per_team", websiteOrganisationId: " org_7Hq2kLm9 " }).expect(201);
    const round = (created.body as DeepDiveInterviewRoundView).round!;
    expect(round.websiteOrganisationId).toBe("org_7Hq2kLm9");
    await request(app(person)).patch(`/api/deep-dive/interview-rounds/${round.id}`).send({ websiteOrganisationId: "org_other" }).expect(400);
    expect(await refused(db.update(deepDiveInterviewRounds).set({ websiteOrganisationId: "org_other" }).where(eq(deepDiveInterviewRounds.id, round.id)))).toMatchObject({ code: "23514" });
  });

  it("sets up a round, drafts a set from what is known, and lets only a person approve it", async () => {
    const company = await seedCompany("DIR");
    const { stream, cells } = await seedStream(company.id, "operations", {
      knowledge: { "current-state": "known", "business-impact": "indicated" },
      bodies: { "current-state": "# Current state\n\nWhat exists today?\n\nOrders are keyed by hand into Sage." },
    });
    await db.insert(deepDiveFindings).values({
      companyId: company.id,
      streamCaseId: stream.id,
      gifDocumentId: cells["business-impact"]!,
      statement: "Month-end close takes nine days.",
    });
    const board = await seedBoard(company.id);

    const created = await setUp(person, company.id, {
      mode: "per_team",
      contextPack: { company_background: "A regional haulier.", do_not_discuss: "Pay and redundancies." },
    }).expect(201);
    const view = created.body as DeepDiveInterviewRoundView;
    expect(view.round).toMatchObject({ mode: "per_team", targetMinutes: 20, status: "setup", sets: [] });
    expect(view.round!.contextPack).toEqual({ company_background: "A regional haulier.", do_not_discuss: "Pay and redundancies." });
    // Teams only: not the whole company, not people.
    expect(view.available).toEqual([{ kind: "unit", id: board.finance.id, name: "Finance", detail: "Team" }]);

    await setUp(person, company.id, { mode: "per_person" }).expect(409);

    const drafted = await request(app(person))
      .post(`/api/deep-dive/interview-rounds/${view.round!.id}/sets`)
      .send({ unitId: board.finance.id })
      .expect(201);
    const set = (drafted.body as DeepDiveInterviewRoundView).round!.sets[0]!;
    expect(set).toMatchObject({ status: "draft", target: { name: "Finance" }, leftOut: 0 });
    // Known is placed, never asked; Indicated is validated first; Unknown is investigated.
    expect(set.known).toEqual([{ streamKey: "operations", gifKey: "current-state", text: "Orders are keyed by hand into Sage." }]);
    expect(set.questions.map((q) => [q.purpose, q.gifKey])).toEqual([
      ["validate", "business-impact"],
      ["investigate", "transformation-opportunity"],
      ["investigate", "future-state"],
      ["investigate", "evidence"],
    ]);
    expect(set.questions[0]!.prompt).toContain("month-end close takes nine days");
    expect((drafted.body as DeepDiveInterviewRoundView).available).toEqual([]);

    const agent = await seedAgentActor(company.id);
    await request(app(agent)).post(`/api/deep-dive/interview-sets/${set.id}/approve`).expect(403);
    const approved = await request(app(person)).post(`/api/deep-dive/interview-sets/${set.id}/approve`).expect(200);
    expect((approved.body as DeepDiveInterviewRoundView).round!.sets[0]).toMatchObject({ status: "approved", approvedByUserId: "board-user" });

    // An edit, even an agent's, puts it back to Draft for a person to approve again.
    const edited = await request(app(agent))
      .patch(`/api/deep-dive/interview-sets/${set.id}`)
      .send({ questions: [...set.questions, { prompt: "What else should we know?", purpose: "investigate", streamKey: null, gifKey: null }] })
      .expect(200);
    expect((edited.body as DeepDiveInterviewRoundView).round!.sets[0]).toMatchObject({ status: "draft", approvedAt: null });
    expect((edited.body as DeepDiveInterviewRoundView).round!.sets[0]!.questions).toHaveLength(5);

    const changes = await db.select().from(activityLog).where(eq(activityLog.companyId, company.id));
    expect(changes.map((row) => row.action)).toEqual(expect.arrayContaining([
      "deep_dive_interview.round_created",
      "deep_dive_interview.set_drafted",
      "deep_dive_interview.set_approved",
      "deep_dive_interview.set_changed",
    ]));
  });

  it("runs per person with the client's people only, and keeps the mode while sets exist", async () => {
    const company = await seedCompany("DIP");
    await seedStream(company.id, "people");
    const board = await seedBoard(company.id);
    const created = await setUp(person, company.id, { mode: "per_person", targetMinutes: 10 }).expect(201);
    const roundId = (created.body as DeepDiveInterviewRoundView).round!.id;
    expect((created.body as DeepDiveInterviewRoundView).available).toEqual([
      { kind: "person", id: board.ama.id, name: "Ama Mensah", detail: "Finance lead" },
    ]);

    await request(app(person)).post(`/api/deep-dive/interview-rounds/${roundId}/sets`).send({ unitId: board.finance.id }).expect(422);
    await request(app(person)).post(`/api/deep-dive/interview-rounds/${roundId}/sets`).send({ personId: board.consultant.id }).expect(422);
    const drafted = await request(app(person)).post(`/api/deep-dive/interview-rounds/${roundId}/sets`).send({ personId: board.ama.id }).expect(201);
    const set = (drafted.body as DeepDiveInterviewRoundView).round!.sets[0]!;
    expect(set.questions).toHaveLength(5);
    expect(set.questions[0]!.prompt).toContain("your role");
    await request(app(person)).post(`/api/deep-dive/interview-rounds/${roundId}/sets`).send({ personId: board.ama.id }).expect(409);

    await request(app(person)).patch(`/api/deep-dive/interview-rounds/${roundId}`).send({ mode: "per_team" }).expect(409);
    await request(app(person)).delete(`/api/deep-dive/interview-sets/${set.id}`).expect(200);
    await request(app(person)).patch(`/api/deep-dive/interview-rounds/${roundId}`).send({ mode: "per_team" }).expect(200);
  });

  it("keeps one company's round out of another's reach", async () => {
    const mine = await seedCompany("DIA");
    const theirs = await seedCompany("DIB");
    await seedStream(theirs.id, "operations");
    const board = await seedBoard(theirs.id);
    const created = await setUp(person, theirs.id, { mode: "per_team" }).expect(201);
    const roundId = (created.body as DeepDiveInterviewRoundView).round!.id;
    const drafted = await request(app(person)).post(`/api/deep-dive/interview-rounds/${roundId}/sets`).send({ unitId: board.finance.id }).expect(201);
    const setId = (drafted.body as DeepDiveInterviewRoundView).round!.sets[0]!.id;

    const outsider = await seedAgentActor(mine.id);
    await request(app(outsider)).get(`/api/companies/${theirs.id}/deep-dive/interview-round`).expect(403);
    await request(app(outsider)).patch(`/api/deep-dive/interview-rounds/${roundId}`).send({ targetMinutes: 30 }).expect(403);
    await request(app(outsider)).post(`/api/deep-dive/interview-sets/${setId}/redraft`).expect(403);
    await request(app(outsider)).delete(`/api/deep-dive/interview-sets/${setId}`).expect(403);

    // A team of another company cannot be put on this round, even past the API.
    const myBoard = await seedBoard(mine.id);
    await setUp(person, mine.id, { mode: "per_team" }).expect(201);
    const error = await refused(db.insert(deepDiveInterviewSets).values({ companyId: theirs.id, roundId, unitId: myBoard.finance.id }));
    expect(error).toMatchObject({ code: "23514" });
  });

  it("freezes the setup and the sets once the round opens", async () => {
    const company = await seedCompany("DIF");
    await seedStream(company.id, "operations");
    const board = await seedBoard(company.id);
    const created = await setUp(person, company.id, { mode: "per_team" }).expect(201);
    const roundId = (created.body as DeepDiveInterviewRoundView).round!.id;
    const drafted = await request(app(person)).post(`/api/deep-dive/interview-rounds/${roundId}/sets`).send({ unitId: board.finance.id }).expect(201);
    const setId = (drafted.body as DeepDiveInterviewRoundView).round!.sets[0]!.id;

    // Changed questions cannot stay approved, even past the API.
    await db.update(deepDiveInterviewSets).set({ status: "approved", approvedAt: new Date(), approvedByUserId: "board-user" }).where(eq(deepDiveInterviewSets.id, setId));
    expect(await refused(db.update(deepDiveInterviewSets).set({ questions: [] }).where(eq(deepDiveInterviewSets.id, setId)))).toMatchObject({ code: "23514" });

    await db.update(deepDiveInterviewRounds).set({ status: "open" }).where(eq(deepDiveInterviewRounds.id, roundId));
    await request(app(person)).patch(`/api/deep-dive/interview-rounds/${roundId}`).send({ targetMinutes: 30 }).expect(409);
    await request(app(person)).post(`/api/deep-dive/interview-sets/${setId}/redraft`).expect(409);
    await request(app(person)).delete(`/api/deep-dive/interview-sets/${setId}`).expect(409);
    expect(await refused(db.update(deepDiveInterviewRounds).set({ status: "setup" }).where(eq(deepDiveInterviewRounds.id, roundId)))).toMatchObject({ code: "23514" });
    expect(await refused(db.update(deepDiveInterviewRounds).set({ contextPack: { scope: "x" } }).where(eq(deepDiveInterviewRounds.id, roundId)))).toMatchObject({ code: "23514" });
  });
});
