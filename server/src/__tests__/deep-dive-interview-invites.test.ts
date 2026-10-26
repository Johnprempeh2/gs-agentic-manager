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
  deepDiveInterviewInvites,
  deepDiveInterviewRounds,
  deepDiveOrgUnits,
  deepDivePeople,
  documents,
  instanceSettings,
} from "@greatstone/db";
import {
  DEEP_DIVE_GIF,
  defaultDeepDiveStreamFields,
  type DeepDiveInterviewProgress,
  type DeepDiveInterviewRoundView,
} from "@greatstone/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { deepDiveInterviewsRoutes } from "../routes/deep-dive-interviews.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { WebsiteBridgeError } from "../services/website/data-bridge-client.js";
import { createFakeInterviewBridge, type FakeInterviewBridge, type InterviewBridge } from "../services/website/interview-bridge.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Parallel Interview invite tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const ORG = "org_7Hq2kLm9";

describeEmbeddedPostgres("Parallel Interview invites and progress (GRE-2665)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let bridge!: FakeInterviewBridge;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-deep-dive-interview-invites-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(deepDiveInterviewRounds);
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

  function app(actor: Express.Request["actor"], interviewBridge: InterviewBridge = bridge) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", deepDiveInterviewsRoutes(db, { interviewBridge }));
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

  async function seedStream(companyId: string) {
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
  }

  async function seedBoard(companyId: string) {
    const [company] = await db.insert(deepDiveOrgUnits).values({ companyId, name: "Northwind Freight", unitType: "company" }).returning();
    const [finance] = await db.insert(deepDiveOrgUnits).values({ companyId, name: "Finance", unitType: "team", parentId: company!.id, position: 1 }).returning();
    const [depot] = await db.insert(deepDiveOrgUnits).values({ companyId, name: "Depot", unitType: "team", parentId: company!.id, position: 2 }).returning();
    const [ama] = await db.insert(deepDivePeople).values({ companyId, name: "Ama Mensah", role: "Finance lead", unitId: finance!.id }).returning();
    const [kofi] = await db.insert(deepDivePeople).values({ companyId, name: "Kofi Boateng", role: "Depot manager", unitId: depot!.id }).returning();
    return { finance: finance!, depot: depot!, ama: ama!, kofi: kofi! };
  }

  /** A per-team round with a set for Finance and Depot; `approve` approves the first n. */
  async function seedRound(companyId: string, mode: "per_team" | "per_person", approve: number) {
    await seedStream(companyId);
    const board = await seedBoard(companyId);
    const created = await request(app(person))
      .post(`/api/companies/${companyId}/deep-dive/interview-round`)
      .send({ websiteOrganisationId: ORG, mode })
      .expect(201);
    const roundId = (created.body as DeepDiveInterviewRoundView).round!.id;
    const targets = mode === "per_team" ? [{ unitId: board.finance.id }, { unitId: board.depot.id }] : [{ personId: board.ama.id }, { personId: board.kofi.id }];
    const setIds: string[] = [];
    for (const target of targets) {
      const drafted = await request(app(person)).post(`/api/deep-dive/interview-rounds/${roundId}/sets`).send(target).expect(201);
      setIds.push((drafted.body as DeepDiveInterviewRoundView).round!.sets.at(-1)!.id);
    }
    for (const setId of setIds.slice(0, approve)) {
      await request(app(person)).post(`/api/deep-dive/interview-sets/${setId}/approve`).expect(200);
    }
    return { roundId, board, setIds };
  }

  const openBody = { allowedEmailDomains: ["Northwind.example"], seatTotal: 40 };

  function open(roundId: string, actor = person) {
    return request(app(actor)).post(`/api/deep-dive/interview-rounds/${roundId}/open`).send(openBody);
  }

  it("refuses to open the round or invite anyone until a person has approved every question set", async () => {
    bridge = createFakeInterviewBridge();
    const company = await seedCompany("DII");
    const { roundId, board, setIds } = await seedRound(company.id, "per_team", 1);

    const refused = await open(roundId).expect(409);
    expect(refused.body.error).toContain("1 of 2 approved");
    await request(app(person))
      .post(`/api/deep-dive/interview-rounds/${roundId}/invites`)
      .send({ people: [{ boardPersonId: board.ama.id, email: "ama@northwind.example" }] })
      .expect(409);
    // Nothing reached the website and nothing was stored.
    expect(bridge.fake.round(roundId)).toBeNull();
    expect(await db.select().from(deepDiveInterviewInvites)).toEqual([]);

    await request(app(person)).post(`/api/deep-dive/interview-sets/${setIds[1]}/approve`).expect(200);
    // Still not open: inviting before opening is refused too.
    await request(app(person))
      .post(`/api/deep-dive/interview-rounds/${roundId}/invites`)
      .send({ people: [{ boardPersonId: board.ama.id, email: "ama@northwind.example" }] })
      .expect(409);

    const opened = await open(roundId).expect(200);
    expect(opened.body).toMatchObject({ status: "open", allowedEmailDomains: ["northwind.example"], seatTotal: 40, total: 0 });
    const onSite = bridge.fake.round(roundId)!;
    expect(onSite.organisationId).toBe(ORG);
    expect(onSite.payload).toMatchObject({ schema: "gs-interview-round-v1", mode: "team", status: "open", seatTotal: 40, clientName: "DII Co" });
    // Teams, not the whole company; each team's approved questions go with it.
    expect(onSite.payload.units.map((unit) => unit.name)).toEqual(["Finance", "Depot"]);
    expect(Object.keys(onSite.payload.contextPack.units as object).sort()).toEqual([board.finance.id, board.depot.id].sort());
    expect((onSite.payload.contextPack.units as Record<string, string>)[board.finance.id]).toContain("Questions:\n1. ");
    await open(roundId).expect(409);
  });

  it("stores only website ids for an invite and reads names and emails live from the website", async () => {
    bridge = createFakeInterviewBridge();
    const company = await seedCompany("DIS");
    const { roundId, board, setIds } = await seedRound(company.id, "per_team", 2);
    await open(roundId).expect(200);
    bridge.fake.addUser({ userId: "usr_existing01", email: "efua@northwind.example", name: "Efua Owusu" });

    const sent = await request(app(person))
      .post(`/api/deep-dive/interview-rounds/${roundId}/invites`)
      .send({
        people: [
          { boardPersonId: board.ama.id, email: "Ama@Northwind.example" },
          { name: "Yaw Darko", roleTitle: "Driver", email: "yaw@northwind.example", unitId: board.depot.id },
          { name: "Efua Owusu", websiteUserId: "usr_existing01", unitId: board.finance.id },
        ],
      })
      .expect(200);
    expect(sent.body).toMatchObject({ invited: 3, created: 3, emailed: 3 });

    const rows = await db.select().from(deepDiveInterviewInvites).where(eq(deepDiveInterviewInvites.roundId, roundId));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        "companyId", "createdAt", "createdByAgentId", "createdByUserId", "id", "lastRemindedAt", "lastSentAt",
        "remindedCount", "roundId", "sentCount", "setId", "updatedAt", "websiteOrganisationId", "websiteUserId",
      ]);
      expect(row.websiteOrganisationId).toBe(ORG);
      expect(row.websiteUserId).toMatch(/^usr_[A-Za-z0-9]+$/);
    }
    const stored = JSON.stringify(rows).toLowerCase();
    for (const personal of ["ama", "yaw", "efua", "darko", "mensah", "northwind.example", "@", "driver"]) {
      expect(stored).not.toContain(personal);
    }
    expect(rows.find((row) => row.websiteUserId === "usr_existing01")!.setId).toBe(setIds[0]);
    // Past the API too: an email or a name is not a website user id.
    for (const websiteUserId of ["ama@northwind.example", "Ama Mensah"]) {
      await expect(db.insert(deepDiveInterviewInvites).values({ companyId: company.id, roundId, websiteOrganisationId: ORG, websiteUserId }))
        .rejects.toMatchObject({ cause: { code: "23514" } });
    }
    // And an invite cannot point at another organisation than its round's.
    await expect(db.insert(deepDiveInterviewInvites).values({ companyId: company.id, roundId, websiteOrganisationId: "org_other", websiteUserId: "usr_x" }))
      .rejects.toMatchObject({ cause: { code: "23503" } });

    const progress = (await request(app(person)).get(`/api/companies/${company.id}/deep-dive/interview-round/progress`).expect(200)).body as DeepDiveInterviewProgress;
    expect(progress.people.map((p) => [p.name, p.email, p.teamName, p.status])).toEqual([
      ["Ama Mensah", "ama@northwind.example", "Finance", "invited"],
      ["Efua Owusu", "efua@northwind.example", "Finance", "invited"],
      ["Yaw Darko", "yaw@northwind.example", "Depot", "invited"],
    ]);

    // Inviting the same person again updates their place and sends nothing.
    const again = await request(app(person))
      .post(`/api/deep-dive/interview-rounds/${roundId}/invites`)
      .send({ people: [{ boardPersonId: board.ama.id, email: "ama@northwind.example" }] })
      .expect(200);
    expect(again.body).toMatchObject({ invited: 1, created: 0, emailed: 0 });
    expect(await db.select().from(deepDiveInterviewInvites).where(eq(deepDiveInterviewInvites.roundId, roundId))).toHaveLength(3);

    // A team without a question set is refused before the website is called.
    const [hr] = await db.insert(deepDiveOrgUnits).values({ companyId: company.id, name: "HR", unitType: "team" }).returning();
    await request(app(person))
      .post(`/api/deep-dive/interview-rounds/${roundId}/invites`)
      .send({ people: [{ name: "Abena", email: "abena@northwind.example", unitId: hr!.id }] })
      .expect(422);

    const actions = (await db.select().from(activityLog).where(eq(activityLog.companyId, company.id))).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["deep_dive_interview.round_opened", "deep_dive_interview.people_invited"]));
    const logged = JSON.stringify(await db.select().from(activityLog).where(eq(activityLog.companyId, company.id))).toLowerCase();
    expect(logged).not.toContain("@");
    expect(logged).not.toContain("mensah");
  });

  it("shows live progress per team and per person, and sends again or reminds", async () => {
    bridge = createFakeInterviewBridge();
    const company = await seedCompany("DIG");
    const { roundId, board } = await seedRound(company.id, "per_team", 2);
    await open(roundId).expect(200);
    const sent = await request(app(person))
      .post(`/api/deep-dive/interview-rounds/${roundId}/invites`)
      .send({
        people: [
          { boardPersonId: board.ama.id, email: "ama@northwind.example" },
          { name: "Esi Asante", email: "esi@northwind.example", unitId: board.finance.id },
          { boardPersonId: board.kofi.id, email: "kofi@northwind.example" },
          { name: "Yaw Darko", email: "yaw@northwind.example", unitId: board.depot.id },
        ],
      })
      .expect(200);
    const ids = new Map((sent.body.progress as DeepDiveInterviewProgress).people.map((p) => [p.name, p.websiteUserId]));
    bridge.fake.setStatus(roundId, ids.get("Ama Mensah")!, "completed");
    bridge.fake.setStatus(roundId, ids.get("Esi Asante")!, "started");
    bridge.fake.setStatus(roundId, ids.get("Kofi Boateng")!, "declined");

    const progress = (await request(app(person)).get(`/api/companies/${company.id}/deep-dive/interview-round/progress`).expect(200)).body as DeepDiveInterviewProgress;
    expect(progress.total).toBe(4);
    expect(progress.counts).toEqual({ invited: 1, started: 1, completed: 1, abandoned: 0, declined: 1 });
    expect(progress.teams).toEqual([
      { unitId: board.finance.id, name: "Finance", total: 2, counts: { invited: 0, started: 1, completed: 1, abandoned: 0, declined: 0 } },
      { unitId: board.depot.id, name: "Depot", total: 2, counts: { invited: 1, started: 0, completed: 0, abandoned: 0, declined: 1 } },
    ]);
    expect(progress.people.map((p) => [p.name, p.status])).toEqual([
      ["Ama Mensah", "completed"],
      ["Esi Asante", "started"],
      ["Kofi Boateng", "declined"],
      ["Yaw Darko", "invited"],
    ]);

    // An agent reads progress but does not email anyone.
    const agent = await seedAgentActor(company.id);
    await request(app(agent)).get(`/api/companies/${company.id}/deep-dive/interview-round/progress`).expect(200);
    await request(app(agent)).post(`/api/deep-dive/interview-rounds/${roundId}/invites/send`).send({ kind: "remind", websiteUserIds: [ids.get("Esi Asante")] }).expect(403);
    await request(app(agent)).post(`/api/deep-dive/interview-rounds/${roundId}/invites`).send({ people: [{ name: "X", email: "x@northwind.example", unitId: board.depot.id }] }).expect(403);

    const resent = await request(app(person))
      .post(`/api/deep-dive/interview-rounds/${roundId}/invites/send`)
      .send({ kind: "resend", websiteUserIds: [ids.get("Yaw Darko")] })
      .expect(200);
    expect(resent.body.emailed).toBe(1);
    await request(app(person))
      .post(`/api/deep-dive/interview-rounds/${roundId}/invites/send`)
      .send({ kind: "remind", websiteUserIds: [ids.get("Esi Asante")] })
      .expect(200);
    const after = (await request(app(person)).get(`/api/companies/${company.id}/deep-dive/interview-round/progress`).expect(200)).body as DeepDiveInterviewProgress;
    expect(after.people.find((p) => p.name === "Yaw Darko")).toMatchObject({ sentCount: 2, remindedCount: 0 });
    expect(after.people.find((p) => p.name === "Esi Asante")).toMatchObject({ sentCount: 1, remindedCount: 1 });
    expect(after.people.find((p) => p.name === "Esi Asante")!.lastRemindedAt).not.toBeNull();
    expect(bridge.fake.round(roundId)!.emails.map((e) => e.kind)).toEqual(["invite", "invite", "invite", "invite", "resend", "remind"]);

    // Only people this round invited.
    await request(app(person))
      .post(`/api/deep-dive/interview-rounds/${roundId}/invites/send`)
      .send({ kind: "resend", websiteUserIds: ["usr_someone_else"] })
      .expect(422);
  });

  it("per person: sends each invited person's own questions under their website employee id", async () => {
    bridge = createFakeInterviewBridge();
    const company = await seedCompany("DIQ");
    const { roundId, board } = await seedRound(company.id, "per_person", 2);
    await open(roundId).expect(200);
    expect(bridge.fake.round(roundId)!.payload).toMatchObject({ mode: "person", contextPack: { people: {} } });

    // A manual add has no question set of their own in a per-person round.
    await request(app(person))
      .post(`/api/deep-dive/interview-rounds/${roundId}/invites`)
      .send({ people: [{ name: "Yaw Darko", email: "yaw@northwind.example" }] })
      .expect(422);
    await request(app(person))
      .post(`/api/deep-dive/interview-rounds/${roundId}/invites`)
      .send({ people: [{ boardPersonId: board.ama.id, email: "ama@northwind.example" }] })
      .expect(200);
    const onSite = bridge.fake.round(roundId)!;
    const [ama] = [...onSite.people.values()];
    const pack = onSite.payload.contextPack.people as Record<string, string>;
    expect(Object.keys(pack)).toEqual([ama!.employeeId]);
    expect(pack[ama!.employeeId]).toContain("your role");
  });

  it("changes nothing in GSAM when the website refuses, and keeps one company's round out of another's reach", async () => {
    const company = await seedCompany("DIW");
    const { roundId } = await seedRound(company.id, "per_team", 2);
    const down: InterviewBridge = {
      ...createFakeInterviewBridge(),
      pushRound: async () => {
        throw new WebsiteBridgeError("not_configured", null, "this company has no website site");
      },
    };
    const refused = await request(app(person, down)).post(`/api/deep-dive/interview-rounds/${roundId}/open`).send(openBody).expect(409);
    expect(refused.body.error).toContain("not set up");
    const [round] = await db.select().from(deepDiveInterviewRounds).where(eq(deepDiveInterviewRounds.id, roundId));
    expect(round).toMatchObject({ status: "setup", seatTotal: null, allowedEmailDomains: [] });

    bridge = createFakeInterviewBridge();
    const other = await seedCompany("DIX");
    const outsider = await seedAgentActor(other.id);
    await request(app(outsider)).get(`/api/companies/${company.id}/deep-dive/interview-round/progress`).expect(403);
    await request(app(outsider)).post(`/api/deep-dive/interview-rounds/${roundId}/open`).send(openBody).expect(403);
    await request(app(outsider)).post(`/api/deep-dive/interview-rounds/${roundId}/invites`).send({ people: [{ name: "X", email: "x@northwind.example" }] }).expect(403);
    await request(app(outsider)).post(`/api/deep-dive/interview-rounds/${roundId}/invites/send`).send({ kind: "resend", websiteUserIds: ["usr_x"] }).expect(403);
  });
});
