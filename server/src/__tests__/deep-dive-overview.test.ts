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
  deepDiveFindingEvidence,
  deepDiveFindings,
  deepDivePeople,
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
import { deepDiveOverviewRoutes } from "../routes/deep-dive-overview.js";
import { deepDiveFindingsService } from "../services/deep-dive-findings.js";
import { deepDiveSessionsService } from "../services/deep-dive-sessions.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Deep Dive overview tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("Deep Dive overview (GRE-2372)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-deep-dive-overview-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(deepDiveSessionQuestions);
    await db.delete(deepDiveSessions);
    await db.delete(deepDivePeople);
    await db.delete(deepDiveFindingEvidence);
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

  function api(actor: Express.Request["actor"] = person) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", deepDiveOverviewRoutes(db));
    instance.use(errorHandler);
    return request(instance);
  }

  async function seedCompany(prefix: string) {
    await instanceSettingsService(db).updateExperimental({ enableDeepDive: true });
    const [company] = await db.insert(companies).values({
      name: `${prefix} Co`,
      issuePrefix: `${prefix}${randomUUID().replace(/-/g, "").slice(0, 4)}`,
    }).returning();
    return company!;
  }

  async function seedCase(companyId: string, values: { caseType: string; key: string; fields?: Record<string, unknown> }) {
    const [row] = await db.insert(cases).values({
      companyId,
      caseNumber: Math.floor(Math.random() * 1_000_000),
      identifier: `DD-${randomUUID()}`,
      title: values.key,
      ...values,
    }).returning();
    return row!;
  }

  /** The record (no North Star, no client) and a blocked People stream with one Indicated cell. */
  async function seedRecordAndStream(companyId: string) {
    await seedCase(companyId, { caseType: "deep_dive", key: "record" });
    const fields = defaultDeepDiveStreamFields("people");
    const stream = await seedCase(companyId, {
      caseType: "deep_dive_stream",
      key: "people",
      fields: { ...fields, status: "blocked", knowledge: { ...fields.knowledge, evidence: "indicated" } },
    });
    for (const gif of DEEP_DIVE_GIF) {
      const [doc] = await db.insert(documents).values({ companyId, title: gif.label, latestBody: `# ${gif.label}\n` }).returning();
      await db.insert(caseDocuments).values({ companyId, caseId: stream.id, documentId: doc!.id, key: gif.documentKey });
    }
    return stream;
  }

  it("asks only to start the record for a company with no Deep Dive", async () => {
    const company = await seedCompany("DOE");
    const overview = (await api().get(`/api/companies/${company.id}/deep-dive/overview`).expect(200)).body;

    expect(overview.next.map((s: { key: string }) => s.key)).toEqual(["start_record"]);
    expect(overview.streams).toHaveLength(9);
    expect(overview.streams.every((s: { status: string; caseId: string | null }) => s.status === "not_started" && s.caseId === null)).toBe(true);
    expect(overview.cells).toEqual({ known: 0, indicated: 0, unknown: 45 });
    expect(overview.nextSession).toBeNull();
  });

  it("reads streams, findings, sessions and people into what is next", async () => {
    const company = await seedCompany("DOR");
    const stream = await seedRecordAndStream(company.id);
    const proposed = await deepDiveFindingsService(db).propose(company.id, {
      streamCaseId: stream.id,
      gifKey: "current-state",
      statement: "Two people approve every quote",
    }, { type: "agent", agentId: null });
    const sessions = deepDiveSessionsService(db);
    const due = await sessions.plan(company.id, { title: "HR walk-through", plannedFor: "2026-01-05T09:00:00Z" }, { type: "user", userId: "board-user" });
    await sessions.plan(company.id, { title: "Later", plannedFor: "2099-01-05T09:00:00Z" }, { type: "user", userId: "board-user" });
    await db.insert(deepDivePeople).values({ companyId: company.id, name: "Ama" });

    const overview = (await api().get(`/api/companies/${company.id}/deep-dive/overview`).expect(200)).body;

    expect(overview.next.map((s: { key: string }) => s.key)).toEqual([
      "decide_findings",
      "unblock_streams",
      "record_north_star",
      "choose_client",
      "validate_indicated",
      "start_session",
      "place_people",
    ]);
    expect(overview.needsPerson.map((s: { key: string }) => s.key)).toEqual([
      "decide_findings",
      "unblock_streams",
      "record_north_star",
      "choose_client",
      "validate_indicated",
    ]);
    expect(overview.next[5]).toMatchObject({ href: `/deep-dive/sessions/${due.id}` });
    expect(overview.nextSession).toMatchObject({ id: due.id, title: "HR walk-through" });
    expect(overview.openFindings).toEqual([
      expect.objectContaining({ id: proposed.id, streamKey: "people", gifKey: "current-state" }),
    ]);
    const people = overview.streams.find((s: { key: string }) => s.key === "people");
    expect(people).toMatchObject({ caseId: stream.id, status: "blocked", cells: { known: 0, indicated: 1, unknown: 4 }, findings: { proposed: 1, validated: 0 } });
    expect(overview.cells).toEqual({ known: 0, indicated: 1, unknown: 44 });
  });

  it("shows one company nothing of another, and refuses an agent of another company", async () => {
    const mine = await seedCompany("DOM");
    const theirs = await seedCompany("DOT");
    await seedRecordAndStream(theirs.id);

    const overview = (await api().get(`/api/companies/${mine.id}/deep-dive/overview`).expect(200)).body;
    expect(overview.next.map((s: { key: string }) => s.key)).toEqual(["start_record"]);
    expect(overview.streams.every((s: { caseId: string | null }) => s.caseId === null)).toBe(true);

    const [agent] = await db.insert(agents).values({
      companyId: mine.id,
      name: "Deep Dive Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    const outsider = { type: "agent", agentId: agent!.id, companyId: mine.id, source: "agent_key" } as Express.Request["actor"];
    await api(outsider).get(`/api/companies/${theirs.id}/deep-dive/overview`).expect(403);
  });

  it("is off while the Deep Dive is off", async () => {
    const company = await seedCompany("DOF");
    await instanceSettingsService(db).updateExperimental({ enableDeepDive: false });
    await api().get(`/api/companies/${company.id}/deep-dive/overview`).expect(403);
  });
});
