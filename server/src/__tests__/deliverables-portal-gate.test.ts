import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues, issueWorkProducts, projects } from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { fillTestCaseOrganisation } from "./helpers/case-organisation.js";
import { errorHandler } from "../middleware/error-handler.js";
import { pipelineRoutes } from "../routes/pipelines.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { deliverableService } from "../services/deliverables.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres portal gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// The portal gate: only client or public items reach the client portal, a
// client item only once the case has an accepted NDA, and public items always.
// Also the stage completeness check on the journey.
describeEmbeddedPostgres("client portal confidentiality and NDA gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-portal-gate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    await instanceSettingsService(db).updateExperimental({ enablePipelines: true });
  });

  afterEach(async () => {
    await db.execute(sql`TRUNCATE "companies", "instance_settings", "activity_log" CASCADE`);
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

  function app(actor: Express.Request["actor"] = boardActor) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", fillTestCaseOrganisation(db));
    instance.use("/api", pipelineRoutes(db, { heartbeat: { wakeup: async () => null } }));
    instance.use(errorHandler);
    return instance;
  }

  async function seed() {
    const prefix = `N${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const [company] = await db.insert(companies).values({ name: "Greatstone", issuePrefix: prefix }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Everest", role: "engineer" }).returning();
    const [project] = await db.insert(projects).values({ companyId: company!.id, name: "Ministry project", status: "in_progress" }).returning();
    const http = request(app());
    const pipeline = await http
      .post(`/api/companies/${company!.id}/pipelines`)
      .send({
        key: "client",
        name: "Client journey",
        stages: [
          {
            key: "discovery",
            name: "Executive Discovery",
            kind: "working",
            position: 100,
            config: {
              expectedDeliverables: [
                { key: "north-star", title: "North Star summary", kind: "report" },
                { key: "pre-read", title: "Pre-read deck", kind: "deck" },
              ],
            },
          },
          { key: "gita", name: "GITA", kind: "working", position: 200 },
          { key: "playback", name: "Playback", kind: "done", position: 500 },
          { key: "paused", name: "Paused", kind: "cancelled", position: 900 },
        ],
      })
      .expect(201);
    const created = await http
      .post(`/api/pipelines/${pipeline.body.id}/cases`)
      .send({ caseKey: "ministry", title: "Ministry of Energy", stageKey: "discovery" })
      .expect(201);
    const caseId = (created.body.case ?? created.body).id as string;
    await http.post(`/api/cases/${caseId}/project-links`).send({ projectId: project!.id }).expect(201);
    const stages = (await http.get(`/api/pipelines/${pipeline.body.id}`).expect(200)).body.stages as Array<{ id: string; key: string }>;
    return { company: company!, agent: agent!, project: project!, caseId, stageId: (key: string) => stages.find((s) => s.key === key)!.id };
  }

  /** A link deliverable: a live site, no stored file. */
  async function seedLink(
    companyId: string,
    projectId: string,
    input: { key: string; title: string; confidentiality?: "internal" | "client" | "public" },
  ) {
    const [issue] = await db.insert(issues).values({
      companyId,
      projectId,
      identifier: `N-${randomUUID().slice(0, 6)}`,
      title: `Ship ${input.title}`,
      status: "done",
      priority: "medium",
    }).returning();
    const [row] = await db.insert(issueWorkProducts).values({
      companyId,
      issueId: issue!.id,
      type: "deliverable",
      provider: "paperclip",
      externalId: input.key,
      title: input.title,
      url: `https://${input.key}.example.com`,
      status: "active",
      metadata: {
        version: 1,
        external: true,
        contentType: "text/uri-list",
        kind: "deck",
        deliverableStatus: "final",
        ...(input.confidentiality ? { confidentiality: input.confidentiality } : {}),
      },
    }).returning();
    return row!;
  }

  async function moveTo(caseId: string, toStageKey: string) {
    const http = request(app());
    const current = await http.get(`/api/cases/${caseId}`).expect(200);
    const version = (current.body.case ?? current.body).version;
    await http.post(`/api/cases/${caseId}/transition`).send({ toStageKey, expectedVersion: version, force: true }).expect(200);
  }

  it("lets internal never, client only after the NDA, and public always reach the portal", async () => {
    const { company, project, caseId, stageId } = await seed();
    const http = request(app());
    const unlabelled = await seedLink(company.id, project.id, { key: "north-star", title: "North Star summary" });
    const client = await seedLink(company.id, project.id, { key: "deck", title: "Pre-read deck", confidentiality: "client" });
    const publicSite = await seedLink(company.id, project.id, { key: "site", title: "Launch site", confidentiality: "public" });
    for (const item of [unlabelled, client, publicSite]) {
      await http.post(`/api/cases/${caseId}/journey/deliverables`)
        .send({ stageId: stageId("discovery"), deliverableId: item.id, clientFacing: true })
        .expect(201);
    }
    await moveTo(caseId, "gita");

    const titles = async () => {
      const portal = await http.get(`/api/cases/${caseId}/portal`).expect(200);
      return portal.body.stages.flatMap((stage: { deliverables: Array<{ title: string }> }) =>
        stage.deliverables.map((item) => item.title));
    };

    // No NDA yet: only the public site. The unlabelled one is internal.
    expect(await titles()).toEqual(["Launch site"]);
    const portal = await http.get(`/api/cases/${caseId}/portal`).expect(200);
    expect(portal.body.stages[0].deliverables[0]).toMatchObject({
      url: "https://site.example.com",
      contentPath: null,
      confidentiality: "public",
    });

    // Only the board records the NDA.
    const agentHttp = request(app({
      type: "agent",
      agentId: randomUUID(),
      companyId: company.id,
      runId: randomUUID(),
      source: "agent_key",
    }));
    await agentHttp.put(`/api/cases/${caseId}/nda`).send({ accepted: true }).expect(403);

    const accepted = await http.put(`/api/cases/${caseId}/nda`).send({ accepted: true }).expect(200);
    expect(accepted.body.ndaAcceptedAt).toEqual(expect.any(String));
    expect((await titles()).sort()).toEqual(["Launch site", "Pre-read deck"]);
    expect((await http.get(`/api/cases/${caseId}/journey`).expect(200)).body.ndaAcceptedAt).toBe(accepted.body.ndaAcceptedAt);

    // Clearing the NDA takes client items off again; internal never shows.
    await http.put(`/api/cases/${caseId}/nda`).send({ accepted: false }).expect(200);
    expect(await titles()).toEqual(["Launch site"]);
    expect(JSON.stringify((await http.get(`/api/cases/${caseId}/portal`).expect(200)).body)).not.toContain("North Star");
  });

  it("has three NDA states: required holds client items, accepted and suspended (with a reason) let them through", async () => {
    const { company, project, caseId, stageId } = await seed();
    const http = request(app());
    const client = await seedLink(company.id, project.id, { key: "deck", title: "Pre-read deck", confidentiality: "client" });
    await http.post(`/api/cases/${caseId}/journey/deliverables`)
      .send({ stageId: stageId("discovery"), deliverableId: client.id, clientFacing: true })
      .expect(201);
    await moveTo(caseId, "gita");
    const titles = async () => (await http.get(`/api/cases/${caseId}/portal`).expect(200)).body.stages
      .flatMap((stage: { deliverables: Array<{ title: string }> }) => stage.deliverables.map((item) => item.title));
    const nda = async () => (await http.get(`/api/cases/${caseId}/journey`).expect(200)).body.nda;

    // A new case starts at required.
    expect(await nda()).toMatchObject({ status: "required", acceptedAt: null, suspendedReason: null });
    expect(await titles()).toEqual([]);

    // Suspended needs a reason, and only the board may set it.
    await http.put(`/api/cases/${caseId}/nda`).send({ status: "suspended" }).expect(400);
    const agentHttp = request(app({
      type: "agent",
      agentId: randomUUID(),
      companyId: company.id,
      runId: randomUUID(),
      source: "agent_key",
    }));
    await agentHttp.put(`/api/cases/${caseId}/nda`).send({ status: "suspended", reason: "Under way" }).expect(403);

    const suspended = await http.put(`/api/cases/${caseId}/nda`)
      .send({ status: "suspended", reason: "Engagement already under way" })
      .expect(200);
    expect(suspended.body.nda).toMatchObject({
      status: "suspended",
      suspendedReason: "Engagement already under way",
      acceptedAt: null,
      changedAt: expect.any(String),
    });
    expect(await titles()).toEqual(["Pre-read deck"]);

    const accepted = await http.put(`/api/cases/${caseId}/nda`).send({ status: "accepted" }).expect(200);
    expect(accepted.body.nda).toMatchObject({ status: "accepted", acceptedAt: expect.any(String), suspendedReason: null });
    expect(accepted.body.ndaAcceptedAt).toBe(accepted.body.nda.acceptedAt);
    expect(await titles()).toEqual(["Pre-read deck"]);

    await http.put(`/api/cases/${caseId}/nda`).send({ status: "required" }).expect(200);
    expect(await nda()).toMatchObject({ status: "required", acceptedAt: null });
    expect(await titles()).toEqual([]);
  });

  it("filters the deliverables list by audience: client-facing is client and public, internal is internal", async () => {
    const { company, project } = await seed();
    await seedLink(company.id, project.id, { key: "north-star", title: "North Star summary" });
    await seedLink(company.id, project.id, { key: "deck", title: "Pre-read deck", confidentiality: "client" });
    await seedLink(company.id, project.id, { key: "site", title: "Launch site", confidentiality: "public" });
    const titles = async (audience: "client_facing" | "internal") =>
      (await deliverableService(db).list(company.id, { audience })).deliverables.map((item) => item.title).sort();
    expect(await titles("client_facing")).toEqual(["Launch site", "Pre-read deck"]);
    expect(await titles("internal")).toEqual(["North Star summary"]);
  });

  it("migrates a recorded nda_accepted_at to accepted", async () => {
    const { caseId } = await seed();
    const acceptedAt = new Date("2026-10-01T09:00:00Z");
    // What 0335 does to a case that recorded an NDA under 0334.
    await db.execute(sql`UPDATE "pipeline_cases" SET "nda_accepted_at" = ${acceptedAt.toISOString()}::timestamptz, "nda_status" = 'required' WHERE "id" = ${caseId}`);
    const migration = readFileSync(
      fileURLToPath(new URL("../../../packages/db/src/migrations/0335_pipeline_case_nda_status.sql", import.meta.url)),
      "utf8",
    );
    const backfill = migration.split("--> statement-breakpoint").map((part) => part.trim()).find((part) => part.startsWith("UPDATE"));
    expect(backfill).toBeDefined();
    await db.execute(sql.raw(backfill!));
    const journey = await request(app()).get(`/api/cases/${caseId}/journey`).expect(200);
    expect(journey.body.nda).toMatchObject({ status: "accepted", acceptedAt: acceptedAt.toISOString() });
    expect(journey.body.ndaAcceptedAt).toBe(acceptedAt.toISOString());
  });

  it("shows expected against filed per stage, with the gap", async () => {
    const { company, project, caseId, stageId } = await seed();
    const http = request(app());
    const filed = await seedLink(company.id, project.id, { key: "north-star", title: "North Star summary" });
    await http.post(`/api/cases/${caseId}/journey/deliverables`)
      .send({ stageId: stageId("discovery"), deliverableId: filed.id, clientFacing: false })
      .expect(201);

    const journey = await http.get(`/api/cases/${caseId}/journey`).expect(200);
    const discovery = journey.body.stages.find((stage: { key: string }) => stage.key === "discovery");
    expect(discovery.expected).toEqual([
      { key: "north-star", title: "North Star summary", kind: "report", deliverableId: filed.id },
      { key: "pre-read", title: "Pre-read deck", kind: "deck", deliverableId: null },
    ]);
    expect(journey.body.stages.find((stage: { key: string }) => stage.key === "gita").expected).toEqual([]);
    // A link deliverable keeps its url on the internal journey too.
    expect(discovery.deliverables[0].deliverable).toMatchObject({ external: true, url: "https://north-star.example.com", attachmentId: null });
  });
});
