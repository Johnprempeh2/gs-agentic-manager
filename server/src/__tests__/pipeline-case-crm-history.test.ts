import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { companies, createDb, crmFiles, crmTimelineEntries } from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { fillTestCaseOrganisation } from "./helpers/case-organisation.js";
import { errorHandler } from "../middleware/error-handler.js";
import { pipelineRoutes } from "../routes/pipelines.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres case CRM history tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// A client's Pipedrive history on its case page (evening run, 16 Oct).
describeEmbeddedPostgres("case CRM history", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-case-crm-history-");
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

  function app(actor: Express.Request["actor"]) {
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

  const board: Express.Request["actor"] = { type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: true };

  async function seedCase(name: string) {
    const prefix = `P${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const [company] = await db.insert(companies).values({ name, issuePrefix: prefix }).returning();
    const http = request(app(board));
    const pipeline = await http
      .post(`/api/companies/${company!.id}/pipelines`)
      .send({
        key: "devtools",
        name: "DevTools",
        stages: [
          { key: "qualified", name: "Qualified", kind: "open", position: 100 },
          { key: "won", name: "Won", kind: "done", position: 900 },
          { key: "lost", name: "Lost", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(201);
    const make = async (caseKey: string, title: string) => {
      const created = await http.post(`/api/pipelines/${pipeline.body.id}/cases`).send({ caseKey, title, stageKey: "qualified" }).expect(201);
      return (created.body.case ?? created.body).id as string;
    };
    return { company: company!, caseId: await make("pipedrive-11", `${name} deal`), otherCaseId: await make("pipedrive-12", `${name} other deal`) };
  }

  it("returns the entries and files filed on the case, newest first, and nothing from other cases", async () => {
    const { company, caseId, otherCaseId } = await seedCase("Omni");
    await db.insert(crmTimelineEntries).values([
      { companyId: company.id, source: "pipedrive", kind: "note", externalId: "n1", body: "Old note", occurredAt: new Date("2026-01-01T10:00:00Z"), caseId },
      { companyId: company.id, source: "pipedrive", kind: "email", externalId: "e1", subject: "Proposal", occurredAt: new Date("2026-03-01T10:00:00Z"), caseId, details: { from: ["a@example.com"] } },
      { companyId: company.id, source: "pipedrive", kind: "note", externalId: "n2", body: "Undated", caseId },
      { companyId: company.id, source: "pipedrive", kind: "note", externalId: "n3", body: "Other deal", occurredAt: new Date("2026-04-01T10:00:00Z"), caseId: otherCaseId },
    ]);
    await db.insert(crmFiles).values([
      { companyId: company.id, source: "pipedrive", externalId: "f1", name: "SOW.pdf", caseId, remoteUrl: "https://drive.example.com/sow", details: { notCopied: "Linked from Google Drive" } },
      { companyId: company.id, source: "pipedrive", externalId: "f2", name: "Other.pdf", caseId: otherCaseId },
    ]);

    const res = await request(app(board)).get(`/api/cases/${caseId}/crm-history`).expect(200);
    expect(res.body.caseId).toBe(caseId);
    expect(res.body.truncated).toBe(false);
    expect(res.body.timeline.map((entry: { externalId?: string; subject: string | null; body: string | null }) => entry.subject ?? entry.body))
      .toEqual(["Proposal", "Old note", "Undated"]);
    expect(res.body.timeline[0]).toMatchObject({ kind: "email", source: "pipedrive", caseTitle: "Omni deal", details: { from: ["a@example.com"] } });
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0]).toMatchObject({ name: "SOW.pdf", contentPath: null, remoteUrl: "https://drive.example.com/sow", notCopied: "Linked from Google Drive" });
  });

  it("returns empty lists for a case with no CRM history", async () => {
    const { caseId } = await seedCase("Quiet");
    const res = await request(app(board)).get(`/api/cases/${caseId}/crm-history`).expect(200);
    expect(res.body).toEqual({ caseId, timeline: [], files: [], truncated: false });
  });

  it("refuses an agent from another company", async () => {
    const { caseId } = await seedCase("Omni");
    const [other] = await db.insert(companies).values({ name: "Other", issuePrefix: "OTHR" }).returning();
    const agent: Express.Request["actor"] = { type: "agent", agentId: randomUUID(), companyId: other!.id, source: "agent_key" } as never;
    const res = await request(app(agent)).get(`/api/cases/${caseId}/crm-history`);
    expect([403, 404]).toContain(res.status);
    expect(res.body.timeline).toBeUndefined();
  });
});
