import { randomUUID } from "node:crypto";
import express from "express";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  caseDocuments,
  cases,
  companies,
  createDb,
  deepDiveFindings,
  deepDiveInterviewProposals,
  deepDiveInterviewRounds,
  deepDiveOrgUnits,
  deepDivePeople,
  deepDiveProcesses,
  documents,
  instanceSettings,
} from "@greatstone/db";
import {
  DEEP_DIVE_GIF,
  defaultDeepDiveStreamFields,
  type DeepDiveInterviewProposal,
  type DeepDiveInterviewRoundView,
  type DeepDiveSynthesisEvidence,
  type GsInterviewDetail,
} from "@greatstone/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { deepDiveInterviewsRoutes } from "../routes/deep-dive-interviews.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { createFakeInterviewBridge, type FakeInterviewBridge } from "../services/website/interview-bridge.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Parallel Interview synthesis tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const ORG = "org_7Hq2kLm9";
/** A raw answer: it must never reach GSAM's database or an API answer. */
const RAW = "RAW-ANSWER-never-stored";

describeEmbeddedPostgres("Parallel Interview synthesis through a fake bridge (GRE-2666)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let bridge!: FakeInterviewBridge;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-deep-dive-interview-synthesis-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(deepDiveInterviewRounds);
    await db.delete(deepDiveFindings);
    await db.delete(deepDiveProcesses);
    await db.delete(deepDivePeople);
    await db.delete(deepDiveOrgUnits);
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
    instance.use("/api", deepDiveInterviewsRoutes(db, { interviewBridge: bridge }));
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
      name: "Synthesis Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    return { type: "agent", agentId: agent!.id, companyId, source: "agent_key" } as Express.Request["actor"];
  }

  /** An open per-team round with Finance and Depot under the company, as slice 2 leaves it. */
  async function seedOpenRound(companyId: string) {
    const fields = defaultDeepDiveStreamFields("operations");
    const [stream] = await db.insert(cases).values({
      companyId,
      caseNumber: Math.floor(Math.random() * 1_000_000),
      identifier: `DD-${randomUUID()}`,
      caseType: "deep_dive_stream",
      key: "operations",
      title: "Deep dive: operations",
      fields: fields as unknown as Record<string, unknown>,
    }).returning();
    for (const gif of DEEP_DIVE_GIF) {
      const [doc] = await db.insert(documents).values({ companyId, title: gif.label, latestBody: `# ${gif.label}\n\n${gif.question}\n` }).returning();
      await db.insert(caseDocuments).values({ companyId, caseId: stream!.id, documentId: doc!.id, key: gif.documentKey });
    }
    const [co] = await db.insert(deepDiveOrgUnits).values({ companyId, name: "Northwind Freight", unitType: "company" }).returning();
    const [finance] = await db.insert(deepDiveOrgUnits).values({ companyId, name: "Finance", unitType: "team", parentId: co!.id, position: 1 }).returning();
    const [depot] = await db.insert(deepDiveOrgUnits).values({ companyId, name: "Depot", unitType: "team", parentId: co!.id, position: 2 }).returning();
    const created = await request(app(person)).post(`/api/companies/${companyId}/deep-dive/interview-round`).send({ websiteOrganisationId: ORG, mode: "per_team" }).expect(201);
    const roundId = (created.body as DeepDiveInterviewRoundView).round!.id;
    for (const unitId of [finance!.id, depot!.id]) {
      const drafted = await request(app(person)).post(`/api/deep-dive/interview-rounds/${roundId}/sets`).send({ unitId }).expect(201);
      const setId = (drafted.body as DeepDiveInterviewRoundView).round!.sets.at(-1)!.id;
      await request(app(person)).post(`/api/deep-dive/interview-sets/${setId}/approve`).expect(200);
    }
    await request(app(person)).post(`/api/deep-dive/interview-rounds/${roundId}/open`).send({ allowedEmailDomains: ["northwind.example"], seatTotal: 10 }).expect(200);
    return { roundId, streamCaseId: stream!.id, co: co!, finance: finance!, depot: depot! };
  }

  function interview(id: string, unitId: string, insights: object[], consent = { participation: true, attribution: true }): GsInterviewDetail & { turns: { seq: number; role: string; content: string }[] } {
    return {
      interview: { interviewId: id, employeeId: `emp_${id}`, userId: `usr_${id}`, voiceKey: `voice_${id}`, unitId, roleTitle: `Role ${id}`, complete: true, partial: false, fingerprint: id },
      consent,
      insights: insights as GsInterviewDetail["insights"],
      turns: [{ seq: 1, role: "user", content: `${RAW} from ${id}` }],
    };
  }

  const pain = (id: string, label: string, quote: string, extra: object = {}) => ({
    id, type: "pain_point", label, evidenceQuote: quote, timePerWeekHours: 3, confidence: 0.8, secondHand: false, attributionRedacted: false, quoteEligible: true, ...extra,
  });

  /** Finance and Depot both re-key orders; only Finance mentions payroll; one person withheld attribution. */
  function seedInterviews(roundId: string, units: { finance: { id: string }; depot: { id: string } }) {
    bridge.fake.addInterview(roundId, interview("i1", units.finance.id, [
      pain("a1", "Re-keying orders into SAP", "Every morning we re-key orders into SAP by hand."),
      pain("a2", "Payroll errors", "Payroll is wrong most months."),
    ]));
    bridge.fake.addInterview(roundId, interview("i2", units.depot.id, [
      pain("b1", "Rekeying orders in SAP", "I spend an hour rekeying orders in SAP."),
    ], { participation: true, attribution: false }));
    bridge.fake.addInterview(roundId, interview("i3", units.depot.id, [
      pain("c1", "Re-keying orders into SAP", "We re-key orders into SAP too."),
    ], { participation: false, attribution: false }));
  }

  async function counts() {
    const [findings, people, units, processes] = await Promise.all([
      db.select().from(deepDiveFindings), db.select().from(deepDivePeople), db.select().from(deepDiveOrgUnits), db.select().from(deepDiveProcesses),
    ]);
    return { findings: findings.length, people: people.length, units: units.length, processes: processes.length };
  }

  it("reads the evidence with the rules applied and never a raw answer", async () => {
    bridge = createFakeInterviewBridge();
    const company = await seedCompany("DSE");
    const round = await seedOpenRound(company.id);
    seedInterviews(round.roundId, round);
    const agent = await seedAgentActor(company.id);

    const res = await request(app(agent)).get(`/api/deep-dive/interview-rounds/${round.roundId}/synthesis/evidence`).expect(200);
    expect(JSON.stringify(res.body)).not.toContain(RAW);
    const evidence = res.body as DeepDiveSynthesisEvidence;
    expect(evidence).toMatchObject({ interviews: 3, withoutConsent: 1, rulesVersion: "gsam-synthesis-rules-1" });
    const rekey = evidence.themes.find((t) => t.labels.includes("Re-keying orders into SAP"))!;
    expect(rekey).toMatchObject({ kind: "pain", voices: 2, promoted: true, labels: ["Re-keying orders into SAP", "Rekeying orders in SAP"] });
    expect(evidence.themes.find((t) => t.labels.includes("Payroll errors"))).toMatchObject({ voices: 1, promoted: false });
    // One voice in each team; promoted where the teams meet.
    const at = (unitId: string) => evidence.rollUp.find((n) => n.unitId === unitId)!.themes.find((t) => t.key === rekey.key);
    expect(at(round.finance.id)).toMatchObject({ voices: 1, promoted: false });
    expect(at(round.depot.id)).toMatchObject({ voices: 1, promoted: false });
    expect(at(round.co.id)).toMatchObject({ voices: 2, promoted: true });
  });

  it("refuses a one-voice pain or a made-up quote and writes nothing", async () => {
    bridge = createFakeInterviewBridge();
    const company = await seedCompany("DSR");
    const round = await seedOpenRound(company.id);
    seedInterviews(round.roundId, round);
    const agent = await seedAgentActor(company.id);
    const evidence = (await request(app(agent)).get(`/api/deep-dive/interview-rounds/${round.roundId}/synthesis/evidence`).expect(200)).body as DeepDiveSynthesisEvidence;
    const rekey = evidence.themes.find((t) => t.labels.includes("Re-keying orders into SAP"))!;
    const payroll = evidence.themes.find((t) => t.labels.includes("Payroll errors"))!;

    const refused = await request(app(agent)).post(`/api/deep-dive/interview-rounds/${round.roundId}/synthesis/proposals`).send({
      items: [
        { themeKey: rekey.key, statement: "Orders are typed in twice.", quotes: [{ insightId: "a1", quote: "we re-key every order" }] },
        { themeKey: payroll.key, statement: "Payroll is often wrong." },
      ],
    }).expect(422);
    expect(refused.body.details.refusals).toEqual([
      { item: 0, themeKey: rekey.key, quote: 0, reason: "The quote is not word for word in the insight" },
      { item: 1, themeKey: payroll.key, quote: null, reason: "Not promoted: Only one person raised it" },
    ]);
    expect(await db.select().from(deepDiveInterviewProposals)).toEqual([]);
  });

  it("writes only proposed, internal items, keeps raw answers out, and lets only a person decide", async () => {
    bridge = createFakeInterviewBridge();
    const company = await seedCompany("DSW");
    const round = await seedOpenRound(company.id);
    seedInterviews(round.roundId, round);
    const agent = await seedAgentActor(company.id);
    const before = await counts();
    const evidence = (await request(app(agent)).get(`/api/deep-dive/interview-rounds/${round.roundId}/synthesis/evidence`).expect(200)).body as DeepDiveSynthesisEvidence;
    const rekey = evidence.themes.find((t) => t.labels.includes("Re-keying orders into SAP"))!;
    const submit = () => request(app(agent)).post(`/api/deep-dive/interview-rounds/${round.roundId}/synthesis/proposals`).send({
      items: [{
        themeKey: rekey.key,
        statement: "Finance and the depot type every order into SAP by hand.",
        quotes: [{ insightId: "a1", quote: "we re-key orders into SAP by hand" }, { insightId: "b1", quote: "I spend an hour rekeying orders in SAP." }],
      }],
    });

    const written = await submit().expect(201);
    expect(written.body.written).toEqual({ themes: 1, quotes: 2, people: 1 });

    const rows = await db.select().from(deepDiveInterviewProposals);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.status === "proposed" && row.visibility === "internal" && row.decidedAt === null)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(RAW);
    // Nothing went straight onto the boards or into the findings.
    expect(await counts()).toEqual(before);

    const theme = rows.find((row) => row.kind === "pain")!;
    expect(theme).toMatchObject({ statement: "Finance and the depot type every order into SAP by hand.", voices: 2, firstHandVoices: 2, unitId: null, proposedByAgentId: (agent as { agentId: string }).agentId });
    const quotes = rows.filter((row) => row.kind === "quote");
    expect(quotes.find((q) => q.websiteInsightId === "a1")).toMatchObject({ parentId: theme.id, anonymous: false, websiteEmployeeId: "emp_i1", statement: "we re-key orders into SAP by hand" });
    // No attribution consent: the quote is kept without the person.
    expect(quotes.find((q) => q.websiteInsightId === "b1")).toMatchObject({ anonymous: true, websiteEmployeeId: null });
    const listed = (await request(app(person)).get(`/api/deep-dive/interview-rounds/${round.roundId}/synthesis/proposals`).expect(200)).body.proposals as DeepDiveInterviewProposal[];
    expect(listed.find((p) => p.websiteInsightId === "b1")!.sources).toEqual([{ interviewId: "i2", userId: null, employeeId: null }]);
    // People for the board: only i1 consented to attribution (i2 did not, i3 did not take part).
    expect(rows.filter((row) => row.kind === "person")).toMatchObject([{ websiteEmployeeId: "emp_i1", statement: "Role i1", unitId: round.finance.id }]);

    // An agent never decides; a person does, once.
    await request(app(agent)).post(`/api/deep-dive/interview-proposals/${theme.id}/decision`).send({ decision: "accepted", streamCaseId: round.streamCaseId }).expect(403);
    const accepted = await request(app(person)).post(`/api/deep-dive/interview-proposals/${theme.id}/decision`).send({ decision: "accepted", streamCaseId: round.streamCaseId }).expect(200);
    expect(accepted.body).toMatchObject({ status: "accepted", decidedByUserId: "board-user", visibility: "internal" });
    await request(app(person)).post(`/api/deep-dive/interview-proposals/${theme.id}/decision`).send({ decision: "rejected" }).expect(409);

    // Running again keeps the decided theme (and its quotes) and does not propose it twice.
    const again = await submit().expect(201);
    expect(again.body.written).toEqual({ themes: 0, quotes: 0, people: 1 });
    const after = await db.select().from(deepDiveInterviewProposals);
    expect(after.filter((row) => row.kind === "pain")).toHaveLength(1);
    expect(after.filter((row) => row.kind === "quote")).toHaveLength(2);
  });

  it("turns each accepted item into its Internal Deep Dive record, and only a person can accept (GRE-2756)", async () => {
    bridge = createFakeInterviewBridge();
    const company = await seedCompany("DSA");
    const round = await seedOpenRound(company.id);
    const kinds = (id: string, quote: string) => [
      pain(`${id}p`, "Re-keying orders into SAP", quote),
      { ...pain(`${id}w`, "Month-end close handoff", "The close waits on the depot's sheet."), type: "workflow" },
      { ...pain(`${id}o`, "Teams trust the spreadsheet", "Everyone checks the spreadsheet first."), type: "observation" },
    ];
    bridge.fake.addInterview(round.roundId, interview("i1", round.finance.id, kinds("a", "Every morning we re-key orders into SAP by hand.")));
    bridge.fake.addInterview(round.roundId, interview("i2", round.depot.id, kinds("b", "I spend an hour rekeying orders in SAP."), { participation: true, attribution: false }));
    bridge.fake.addPerson(round.roundId, { employeeId: "emp_i1", userId: "usr_i1", name: "Ama Mensah", roleTitle: "Role i1", unitId: round.finance.id });
    const agent = await seedAgentActor(company.id);
    const evidence = (await request(app(agent)).get(`/api/deep-dive/interview-rounds/${round.roundId}/synthesis/evidence`).expect(200)).body as DeepDiveSynthesisEvidence;
    const key = (kind: string) => evidence.themes.find((t) => t.kind === kind)!.key;
    await request(app(agent)).post(`/api/deep-dive/interview-rounds/${round.roundId}/synthesis/proposals`).send({
      items: [
        { themeKey: key("pain"), statement: "Orders are typed into SAP twice.", quotes: [{ insightId: "ap", quote: "we re-key orders into SAP by hand" }, { insightId: "bp", quote: "I spend an hour rekeying orders in SAP." }] },
        { themeKey: key("process"), statement: "Month-end close waits on the depot." },
        { themeKey: key("finding"), statement: "The spreadsheet is the source people trust." },
      ],
    }).expect(201);
    const rows = await db.select().from(deepDiveInterviewProposals);
    const of = (kind: string) => rows.find((row) => row.kind === kind)!;
    const decide = (actor: Express.Request["actor"], id: string, body: object) =>
      request(app(actor)).post(`/api/deep-dive/interview-proposals/${id}/decision`).send(body);
    const before = await counts();

    // An agent can accept nothing, and nothing is made.
    for (const row of rows) await decide(agent, row.id, { decision: "accepted", streamCaseId: round.streamCaseId }).expect(403);
    expect(await counts()).toEqual(before);
    expect((await db.select().from(deepDiveInterviewProposals)).every((row) => row.status === "proposed")).toBe(true);

    // A pain needs its stream; then it is a proposed, Internal finding in that stream's GIF cell.
    await decide(person, of("pain").id, { decision: "accepted" }).expect(422);
    const pain_ = (await decide(person, of("pain").id, { decision: "accepted", streamCaseId: round.streamCaseId }).expect(200)).body as DeepDiveInterviewProposal;
    expect(pain_.record).toMatchObject({ type: "finding" });
    const [finding] = await db.select().from(deepDiveFindings).where(eq(deepDiveFindings.id, pain_.record!.id!));
    const [cell] = await db.select().from(caseDocuments).where(eq(caseDocuments.id, finding!.gifDocumentId));
    expect(finding).toMatchObject({ streamCaseId: round.streamCaseId, statement: "Orders are typed into SAP twice.", status: "proposed", visibility: "internal", proposedByAgentId: (agent as { agentId: string }).agentId, decidedAt: null });
    expect(cell!.key).toBe("gif-current-state");

    // A finding in the cell the person picks.
    const found = (await decide(person, of("finding").id, { decision: "accepted", streamCaseId: round.streamCaseId, gifKey: "evidence" }).expect(200)).body as DeepDiveInterviewProposal;
    const [second] = await db.select().from(deepDiveFindings).where(eq(deepDiveFindings.id, found.record!.id!));
    expect((await db.select().from(caseDocuments).where(eq(caseDocuments.id, second!.gifDocumentId)))[0]!.key).toBe("gif-evidence");

    // A process: a candidate on the process board, no lane yet.
    const proc = (await decide(person, of("process").id, { decision: "accepted" }).expect(200)).body as DeepDiveInterviewProposal;
    const [candidate] = await db.select().from(deepDiveProcesses).where(eq(deepDiveProcesses.id, proc.record!.id!));
    expect(candidate).toMatchObject({ name: "Month-end close handoff", offeringId: null, visibility: "internal" });

    // A person: on the board in their team, named live from the website.
    const who = (await decide(person, of("person").id, { decision: "accepted" }).expect(200)).body as DeepDiveInterviewProposal;
    const [boardPerson] = await db.select().from(deepDivePeople).where(eq(deepDivePeople.id, who.record!.id!));
    expect(boardPerson).toMatchObject({ name: "Ama Mensah", role: "Role i1", unitId: round.finance.id, side: "client", visibility: "internal" });
    expect(JSON.stringify(await db.select().from(deepDiveInterviewProposals))).not.toContain("Ama Mensah");

    // Quotes: evidence for their theme's finding, through the theme. An anonymous quote names nobody.
    const quotes = rows.filter((row) => row.kind === "quote");
    for (const q of quotes) await decide(person, q.id, { decision: "accepted" }).expect(200);
    const listed = (await request(app(person)).get(`/api/deep-dive/interview-rounds/${round.roundId}/synthesis/proposals`).expect(200)).body.proposals as DeepDiveInterviewProposal[];
    const evidenceFor = listed.filter((p) => p.kind === "quote" && p.parentId === of("pain").id);
    expect(evidenceFor.map((q) => q.status)).toEqual(["accepted", "accepted"]);
    expect(evidenceFor.find((q) => q.websiteInsightId === "bp")).toMatchObject({ anonymous: true, websiteEmployeeId: null, sources: [{ interviewId: "i2", userId: null, employeeId: null }] });

    // Nothing is shared: every record made is Internal.
    expect(await counts()).toEqual({ ...before, findings: 2, processes: 1, people: 1 });
    for (const table of [deepDiveFindings, deepDiveProcesses, deepDivePeople]) {
      expect((await db.select().from(table)).every((row) => row.visibility === "internal")).toBe(true);
    }
    // A rejected theme makes nothing, and its quotes cannot be accepted after it.
    await decide(person, of("pain").id, { decision: "rejected" }).expect(409);
  });

  it("refuses a stream from another company and a person the website no longer names (GRE-2756)", async () => {
    bridge = createFakeInterviewBridge();
    const company = await seedCompany("DSB");
    const round = await seedOpenRound(company.id);
    seedInterviews(round.roundId, round);
    const other = await seedOpenRound((await seedCompany("DSC")).id);
    const agent = await seedAgentActor(company.id);
    const evidence = (await request(app(agent)).get(`/api/deep-dive/interview-rounds/${round.roundId}/synthesis/evidence`).expect(200)).body as DeepDiveSynthesisEvidence;
    const rekey = evidence.themes.find((t) => t.labels.includes("Re-keying orders into SAP"))!;
    await request(app(agent)).post(`/api/deep-dive/interview-rounds/${round.roundId}/synthesis/proposals`).send({
      items: [{ themeKey: rekey.key, statement: "Orders are typed twice.", quotes: [{ insightId: "a1", quote: "we re-key orders into SAP" }] }],
    }).expect(201);
    const rows = await db.select().from(deepDiveInterviewProposals).where(eq(deepDiveInterviewProposals.roundId, round.roundId));
    const theme = rows.find((row) => row.kind === "pain")!;
    const refused = await request(app(person)).post(`/api/deep-dive/interview-proposals/${theme.id}/decision`).send({ decision: "accepted", streamCaseId: other.streamCaseId }).expect(422);
    expect(refused.body.error).toContain("not found in this company");
    // emp_i1 is not on the website's list of people for this round.
    await request(app(person)).post(`/api/deep-dive/interview-proposals/${rows.find((row) => row.kind === "person")!.id}/decision`).send({ decision: "accepted" }).expect(409);
    // Rejecting the theme leaves its quote with nothing to be evidence for.
    await request(app(person)).post(`/api/deep-dive/interview-proposals/${theme.id}/decision`).send({ decision: "rejected" }).expect(200);
    await request(app(person)).post(`/api/deep-dive/interview-proposals/${rows.find((row) => row.kind === "quote")!.id}/decision`).send({ decision: "accepted" }).expect(409);
    expect((await db.select().from(deepDiveInterviewProposals).where(eq(deepDiveInterviewProposals.roundId, round.roundId))).filter((row) => row.status !== "proposed").map((row) => row.kind)).toEqual(["pain"]);
    expect(await db.select().from(deepDiveFindings)).toEqual([]);
  });

  it("removes a withdrawn person's quotes and undecided items, and trims decided ones", async () => {
    bridge = createFakeInterviewBridge();
    const company = await seedCompany("DSX");
    const round = await seedOpenRound(company.id);
    seedInterviews(round.roundId, round);
    bridge.fake.addInterview(round.roundId, interview("i4", round.finance.id, [pain("d1", "Payroll errors", "Payroll goes wrong.")]));
    const agent = await seedAgentActor(company.id);
    const evidence = (await request(app(agent)).get(`/api/deep-dive/interview-rounds/${round.roundId}/synthesis/evidence`).expect(200)).body as DeepDiveSynthesisEvidence;
    const rekey = evidence.themes.find((t) => t.labels.includes("Re-keying orders into SAP"))!;
    const payroll = evidence.themes.find((t) => t.labels.includes("Payroll errors"))!;
    await request(app(agent)).post(`/api/deep-dive/interview-rounds/${round.roundId}/synthesis/proposals`).send({
      items: [
        { themeKey: rekey.key, statement: "Orders are typed twice.", quotes: [{ insightId: "a1", quote: "we re-key orders into SAP" }] },
        { themeKey: payroll.key, statement: "Payroll is often wrong.", quotes: [{ insightId: "d1", quote: "Payroll goes wrong." }] },
      ],
    }).expect(201);
    const rekeyRow = (await db.select().from(deepDiveInterviewProposals)).find((row) => row.themeKey === rekey.key && row.kind === "pain")!;
    await request(app(person)).post(`/api/deep-dive/interview-proposals/${rekeyRow.id}/decision`).send({ decision: "accepted", streamCaseId: round.streamCaseId }).expect(200);

    // i1 hard-deletes everything on the website.
    bridge.fake.withdraw(round.roundId, { userId: "usr_i1", interviewId: null });
    const applied = await request(app(agent)).post(`/api/deep-dive/interview-rounds/${round.roundId}/synthesis/withdrawals`).expect(200);
    // Their quote, their board entry and the undecided payroll theme they were part of (with its other quote).
    expect(applied.body).toEqual({ removed: 3, trimmed: 1 });

    const left = await db.select().from(deepDiveInterviewProposals);
    expect(JSON.stringify(left)).not.toContain("usr_i1");
    expect(left.map((row) => `${row.kind}:${row.status}`).sort()).toEqual(["pain:accepted", "person:proposed"]);
    // The accepted theme keeps its words and loses only the withdrawn source.
    expect(left.find((row) => row.kind === "pain")!.sources).toEqual([{ interviewId: "i2", userId: "usr_i2", employeeId: "emp_i2" }]);
  });

  it("keeps another company's round out of reach and waits for the round to open", async () => {
    bridge = createFakeInterviewBridge();
    const company = await seedCompany("DSO");
    const round = await seedOpenRound(company.id);
    const other = await seedCompany("DSP");
    const outsider = await seedAgentActor(other.id);
    await request(app(outsider)).get(`/api/deep-dive/interview-rounds/${round.roundId}/synthesis/evidence`).expect(403);
    await request(app(outsider)).post(`/api/deep-dive/interview-rounds/${round.roundId}/synthesis/proposals`).send({ items: [{ themeKey: "x", statement: "y" }] }).expect(403);

    const fresh = await seedCompany("DSQ");
    const created = await request(app(person)).post(`/api/companies/${fresh.id}/deep-dive/interview-round`).send({ websiteOrganisationId: "org_other", mode: "per_team" }).expect(201);
    const setupRound = (created.body as DeepDiveInterviewRoundView).round!.id;
    const waiting = await request(app(person)).get(`/api/deep-dive/interview-rounds/${setupRound}/synthesis/evidence`).expect(409);
    expect(waiting.body.error).toContain("has not opened");
  });
});
