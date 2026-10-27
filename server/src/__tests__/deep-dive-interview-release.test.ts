import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
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
  documents,
  instanceSettings,
} from "@greatstone/db";
import {
  DEEP_DIVE_GIF,
  defaultDeepDiveStreamFields,
  type DeepDiveInterviewReleaseView,
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
    `Skipping embedded Postgres Parallel Interview release tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const ORG = "org_7Hq2kLm9";

describeEmbeddedPostgres("Parallel Interview release to the client (GRE-2667)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let bridge!: FakeInterviewBridge;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-deep-dive-interview-release-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(deepDiveInterviewRounds);
    await db.delete(deepDiveFindings);
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
      name: "Interview Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    return { type: "agent", agentId: agent!.id, companyId, source: "agent_key" } as Express.Request["actor"];
  }

  function interview(id: string, unitId: string, insights: object[], consent = { participation: true, attribution: true }): GsInterviewDetail {
    return {
      interview: { interviewId: id, employeeId: `emp_${id}`, userId: `usr_${id}`, voiceKey: `voice_${id}`, unitId, roleTitle: `Role ${id}`, complete: true, partial: false, fingerprint: id },
      consent,
      insights: insights as GsInterviewDetail["insights"],
    };
  }

  const pain = (id: string, label: string, quote: string) => ({
    id, type: "pain_point", label, evidenceQuote: quote, timePerWeekHours: 3, confidence: 0.8, secondHand: false, attributionRedacted: false, quoteEligible: true,
  });

  /**
   * An open per-team round whose synthesis an agent has proposed: one
   * re-keying theme from Finance and the Depot with two quotes, plus a role.
   */
  async function seedProposed(prefix: string) {
    const company = await seedCompany(prefix);
    const fields = defaultDeepDiveStreamFields("operations");
    const [stream] = await db.insert(cases).values({
      companyId: company.id,
      caseNumber: Math.floor(Math.random() * 1_000_000),
      identifier: `DD-${randomUUID()}`,
      caseType: "deep_dive_stream",
      key: "operations",
      title: "Deep dive: operations",
      fields: fields as unknown as Record<string, unknown>,
    }).returning();
    for (const gif of DEEP_DIVE_GIF) {
      const [doc] = await db.insert(documents).values({ companyId: company.id, title: gif.label, latestBody: `# ${gif.label}\n\n${gif.question}\n` }).returning();
      await db.insert(caseDocuments).values({ companyId: company.id, caseId: stream!.id, documentId: doc!.id, key: gif.documentKey });
    }
    const [co] = await db.insert(deepDiveOrgUnits).values({ companyId: company.id, name: "Northwind Freight", unitType: "company" }).returning();
    const [finance] = await db.insert(deepDiveOrgUnits).values({ companyId: company.id, name: "Finance", unitType: "team", parentId: co!.id, position: 1 }).returning();
    const [depot] = await db.insert(deepDiveOrgUnits).values({ companyId: company.id, name: "Depot", unitType: "team", parentId: co!.id, position: 2 }).returning();
    const created = await request(app(person)).post(`/api/companies/${company.id}/deep-dive/interview-round`).send({ websiteOrganisationId: ORG, mode: "per_team" }).expect(201);
    const roundId = (created.body as DeepDiveInterviewRoundView).round!.id;
    for (const unitId of [finance!.id, depot!.id]) {
      const drafted = await request(app(person)).post(`/api/deep-dive/interview-rounds/${roundId}/sets`).send({ unitId }).expect(201);
      const setId = (drafted.body as DeepDiveInterviewRoundView).round!.sets.at(-1)!.id;
      await request(app(person)).post(`/api/deep-dive/interview-sets/${setId}/approve`).expect(200);
    }
    await request(app(person)).post(`/api/deep-dive/interview-rounds/${roundId}/open`).send({ allowedEmailDomains: ["northwind.example"], seatTotal: 10 }).expect(200);

    bridge.fake.addInterview(roundId, interview("i1", finance!.id, [pain("a1", "Re-keying orders into SAP", "Every morning we re-key orders into SAP by hand.")]));
    bridge.fake.addInterview(roundId, interview("i2", depot!.id, [pain("b1", "Rekeying orders in SAP", "I spend an hour rekeying orders in SAP.")]));

    const agent = await seedAgentActor(company.id);
    const evidence = (await request(app(agent)).get(`/api/deep-dive/interview-rounds/${roundId}/synthesis/evidence`).expect(200)).body as DeepDiveSynthesisEvidence;
    const rekey = evidence.themes.find((t) => t.labels.includes("Re-keying orders into SAP"))!;
    await request(app(agent)).post(`/api/deep-dive/interview-rounds/${roundId}/synthesis/proposals`).send({
      items: [{
        themeKey: rekey.key,
        statement: "Finance and the depot type every order into SAP by hand.",
        quotes: [{ insightId: "a1", quote: "we re-key orders into SAP by hand" }, { insightId: "b1", quote: "I spend an hour rekeying orders in SAP." }],
      }],
    }).expect(201);
    const rows = await db.select().from(deepDiveInterviewProposals).where(eq(deepDiveInterviewProposals.roundId, roundId));
    streamCaseId = stream!.id;
    return { company, roundId, agent, rows };
  }

  /** The stream an accepted theme's finding goes in (GRE-2756). */
  let streamCaseId = "";
  const decide = (id: string, decision: "accepted" | "rejected") =>
    request(app(person)).post(`/api/deep-dive/interview-proposals/${id}/decision`).send({ decision, streamCaseId }).expect(200);

  it("sends nothing to the website before a person releases, and refuses a synthesis that is not reviewed", async () => {
    bridge = createFakeInterviewBridge();
    const { roundId, agent, rows } = await seedProposed("DRN");
    const theme = rows.find((row) => row.kind === "pain")!;

    const before = (await request(app(agent)).get(`/api/deep-dive/interview-rounds/${roundId}/synthesis/release`).expect(200)).body as DeepDiveInterviewReleaseView;
    expect(before).toMatchObject({ roundId, websiteOrganisationId: ORG, released: null, readiness: { ready: false } });
    expect(before.readiness.blockers.map((b) => b.code)).toEqual(["undecided", "nothing_accepted"]);

    // Accepting the theme alone is not enough: its quotes wait for a decision too.
    await decide(theme.id, "accepted");
    const refused = await request(app(person)).post(`/api/deep-dive/interview-rounds/${roundId}/synthesis/release`).send({ headline: "Orders are typed twice." }).expect(422);
    expect(refused.body.details.blockers.map((b: { code: string }) => b.code)).toEqual(["undecided", "theme_without_quote"]);

    expect(bridge.fake.round(roundId)!.synthesisLog).toEqual([]);
    expect(bridge.fake.round(roundId)!.released).toBeNull();
  });

  it("lets only a person release or withdraw; an agent gets 403 and nothing is pushed", async () => {
    bridge = createFakeInterviewBridge();
    const { roundId, agent, rows } = await seedProposed("DRA");
    for (const row of rows.filter((r) => r.kind !== "person")) await decide(row.id, "accepted");

    await request(app(agent)).post(`/api/deep-dive/interview-rounds/${roundId}/synthesis/release`).send({ headline: "Orders are typed twice." }).expect(403);
    await request(app(agent)).post(`/api/deep-dive/interview-rounds/${roundId}/synthesis/withdraw`).expect(403);
    expect(bridge.fake.round(roundId)!.synthesisLog).toEqual([]);

    const other = await seedCompany("DRB");
    const outsider = await seedAgentActor(other.id);
    await request(app(outsider)).get(`/api/deep-dive/interview-rounds/${roundId}/synthesis/release`).expect(403);
  });

  it("pushes the accepted themes and quotes under the organisation id, and withdraw takes them away at once", async () => {
    bridge = createFakeInterviewBridge();
    const { roundId, rows } = await seedProposed("DRR");
    const theme = rows.find((row) => row.kind === "pain")!;
    const kept = rows.find((row) => row.kind === "quote" && row.websiteInsightId === "a1")!;
    const dropped = rows.find((row) => row.kind === "quote" && row.websiteInsightId === "b1")!;
    await decide(theme.id, "accepted");
    await decide(kept.id, "accepted");
    await decide(dropped.id, "rejected");

    const released = await request(app(person)).post(`/api/deep-dive/interview-rounds/${roundId}/synthesis/release`).send({ headline: "Orders are typed twice." }).expect(200);
    const view = released.body as DeepDiveInterviewReleaseView;
    expect(view.released).toMatchObject({ synthesisId: expect.any(String) });

    const log = bridge.fake.round(roundId)!.synthesisLog;
    expect(log).toHaveLength(1);
    const push = log[0]!;
    expect(push).toMatchObject({ kind: "released", organisationId: ORG });
    if (push.kind !== "released") throw new Error("expected a release");
    expect(push.body).toMatchObject({
      schema: "gs-interview-synthesis-v1",
      synthesisId: view.released!.synthesisId,
      headlineRead: { text: "Orders are typed twice.", supporting_insight_ids: ["a1"] },
      themes: [{ theme_id: theme.themeKey, label: theme.label, summary: "Finance and the depot type every order into SAP by hand.",
        evidence_quotes: [{ insight_id: "a1", quote: "we re-key orders into SAP by hand" }] }],
      inputInsightIds: ["a1"],
    });
    // The rejected quote, the person's role and any website or GSAM person id stay in GSAM.
    const sent = JSON.stringify(push.body);
    expect(sent).not.toContain("rekeying orders");
    expect(sent).not.toContain("emp_i1");
    expect(sent).not.toContain("usr_i1");
    expect(sent).not.toContain("Role i1");

    const activity = await db.select().from(activityLog).where(eq(activityLog.action, "deep_dive_interview.synthesis_released"));
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ actorType: "user", actorId: "board-user", details: { websiteOrganisationId: ORG, themes: 1, quotes: 1 } });

    const withdrawn = await request(app(person)).post(`/api/deep-dive/interview-rounds/${roundId}/synthesis/withdraw`).expect(200);
    expect((withdrawn.body as DeepDiveInterviewReleaseView).released).toBeNull();
    expect(bridge.fake.round(roundId)!.released).toBeNull();
    expect(bridge.fake.round(roundId)!.synthesisLog.at(-1)).toEqual({ kind: "withdrawn", organisationId: ORG });

    // Released again later, it goes as a new synthesis.
    const again = await request(app(person)).post(`/api/deep-dive/interview-rounds/${roundId}/synthesis/release`).send({ headline: "Orders are typed twice." }).expect(200);
    expect((again.body as DeepDiveInterviewReleaseView).released!.synthesisId).not.toBe(view.released!.synthesisId);
  });

  it("waits for the round to open", async () => {
    bridge = createFakeInterviewBridge();
    const company = await seedCompany("DRS");
    const created = await request(app(person)).post(`/api/companies/${company.id}/deep-dive/interview-round`).send({ websiteOrganisationId: ORG, mode: "per_team" }).expect(201);
    const roundId = (created.body as DeepDiveInterviewRoundView).round!.id;
    const waiting = await request(app(person)).post(`/api/deep-dive/interview-rounds/${roundId}/synthesis/release`).send({ headline: "x" }).expect(409);
    expect(waiting.body.error).toContain("has not opened");
  });
});
