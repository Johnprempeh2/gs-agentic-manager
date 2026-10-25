import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
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
  documents,
  instanceSettings,
  pipelineCaseEvidence,
  pipelineCases,
  pipelineStages,
  pipelines,
} from "@greatstone/db";
import { DEEP_DIVE_FINDING_NEVER_EDITED, DEEP_DIVE_GIF } from "@greatstone/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { caseRoutes } from "../routes/cases.js";
import { deepDiveFindingsRoutes } from "../routes/deep-dive-findings.js";
import { companyService } from "../services/companies.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Deep Dive findings tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/** The Postgres error behind a drizzle query error. */
function pgError(error: unknown): { code?: string; message?: string } {
  const cause = (error as { cause?: unknown })?.cause;
  return (cause ?? error) as { code?: string; message?: string };
}

async function refused(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return pgError(error);
  }
  throw new Error("The database accepted a write it should refuse");
}

describeEmbeddedPostgres("Deep Dive findings (GRE-2367)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-deep-dive-findings-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(deepDiveFindingEvidence);
    await db.delete(deepDiveFindings);
    await db.delete(activityLog);
    await db.delete(pipelineCaseEvidence);
    await db.delete(caseDocuments);
    await db.delete(documents);
    await db.delete(cases);
    await db.delete(pipelineCases);
    await db.delete(pipelineStages);
    await db.delete(pipelines);
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

  async function seedClient(companyId: string, title: string) {
    const [pipeline] = await db.insert(pipelines).values({
      companyId,
      key: `journey-${randomUUID().slice(0, 8)}`,
      name: "Client journey",
    }).returning();
    const [stage] = await db.insert(pipelineStages).values({
      pipelineId: pipeline!.id,
      key: "deep-dive",
      name: "Deep dive",
      kind: "working",
      position: 0,
    }).returning();
    const [client] = await db.insert(pipelineCases).values({
      companyId,
      pipelineId: pipeline!.id,
      stageId: stage!.id,
      caseKey: randomUUID(),
      title,
    }).returning();
    return client!;
  }

  async function seedEvidence(companyId: string, clientCaseId: string, title: string) {
    const [row] = await db.insert(pipelineCaseEvidence).values({
      companyId,
      caseId: clientCaseId,
      kind: "link",
      title,
      url: `https://example.test/${randomUUID()}`,
    }).returning();
    return row!;
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

  /** A deep_dive_stream case with all five GIF documents, as the Deep Dive page lays it out. */
  async function seedStream(companyId: string, key: string, clientCaseId: string | null = null) {
    const [stream] = await db.insert(cases).values({
      companyId,
      caseNumber: Math.floor(Math.random() * 1_000_000),
      identifier: `DD-${randomUUID()}`,
      caseType: "deep_dive_stream",
      key,
      title: `Deep dive: ${key}`,
      clientCaseId,
    }).returning();
    const cells: Record<string, string> = {};
    for (const gif of DEEP_DIVE_GIF) {
      const [doc] = await db.insert(documents).values({ companyId, title: gif.label, latestBody: `# ${gif.label}\n` }).returning();
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

  function propose(actor: Express.Request["actor"], companyId: string, body: Record<string, unknown>) {
    return request(app(actor)).post(`/api/companies/${companyId}/deep-dive/findings`).send(body);
  }

  function validate(findingId: string) {
    return request(app(person)).post(`/api/deep-dive/findings/${findingId}/decision`).send({ decision: "validated" });
  }

  describe("propose, validate, supersede", () => {
    it("lets an agent propose, a person validate, and a validated replacement supersede it", async () => {
      const company = await seedCompany("DFP");
      const client = await seedClient(company.id, "Client A");
      const evidence = await seedEvidence(company.id, client.id, "Ops interview notes");
      const { stream, cells } = await seedStream(company.id, "operations", client.id);
      const agent = await seedAgentActor(company.id);

      const proposed = await propose(agent, company.id, {
        streamCaseId: stream.id,
        gifKey: "current-state",
        statement: "Orders are re-keyed by hand into the ledger.",
        evidenceIds: [evidence.id],
      }).expect(201);
      expect(proposed.body).toMatchObject({
        status: "proposed",
        visibility: "internal",
        streamCaseId: stream.id,
        gifKey: "current-state",
        gifDocumentId: cells["current-state"],
        proposedByAgentId: (agent as { agentId: string }).agentId,
        proposedByUserId: null,
      });
      expect(proposed.body.evidence).toEqual([
        { id: evidence.id, title: "Ops interview notes", kind: "link", clientCaseId: client.id },
      ]);

      // An agent may propose but never validate.
      await request(app(agent))
        .post(`/api/deep-dive/findings/${proposed.body.id}/decision`)
        .send({ decision: "validated" })
        .expect(403);

      const validated = await validate(proposed.body.id).expect(200);
      expect(validated.body).toMatchObject({ status: "validated", decidedByUserId: "board-user" });
      expect(validated.body.decidedAt).toEqual(expect.any(String));

      // A decision is made once.
      await validate(proposed.body.id).expect(409);

      const replacement = await propose(person, company.id, {
        streamCaseId: stream.id,
        gifKey: "current-state",
        statement: "Orders are re-keyed by hand, twice a day.",
        supersedesFindingId: proposed.body.id,
      }).expect(201);
      expect(replacement.body).toMatchObject({ status: "proposed", supersedesFindingId: proposed.body.id, proposedByUserId: "board-user" });

      // Proposing does not supersede yet, and only one replacement may be pending.
      const stillValid = await request(app(person)).get(`/api/deep-dive/findings/${proposed.body.id}`).expect(200);
      expect(stillValid.body.status).toBe("validated");
      await propose(person, company.id, {
        streamCaseId: stream.id,
        gifKey: "current-state",
        statement: "A second replacement.",
        supersedesFindingId: proposed.body.id,
      }).expect(409);

      await validate(replacement.body.id).expect(200);
      const old = await request(app(person)).get(`/api/deep-dive/findings/${proposed.body.id}`).expect(200);
      expect(old.body).toMatchObject({
        status: "superseded",
        supersededByFindingId: replacement.body.id,
        statement: "Orders are re-keyed by hand into the ledger.",
        evidence: [expect.objectContaining({ id: evidence.id })],
      });
      expect(old.body.supersededAt).toEqual(expect.any(String));

      // A superseded finding cannot be superseded again.
      await propose(person, company.id, {
        streamCaseId: stream.id,
        gifKey: "current-state",
        statement: "Too late.",
        supersedesFindingId: proposed.body.id,
      }).expect(409);

      const list = await request(app(person))
        .get(`/api/companies/${company.id}/deep-dive/findings?streamCaseId=${stream.id}`)
        .expect(200);
      expect(list.body.findings.map((f: { status: string }) => f.status)).toEqual(["superseded", "validated"]);

      const actions = await db.select({ action: activityLog.action }).from(activityLog).where(eq(activityLog.companyId, company.id));
      expect(actions.map((row) => row.action).sort()).toEqual([
        "deep_dive_finding.proposed",
        "deep_dive_finding.proposed",
        "deep_dive_finding.validated",
        "deep_dive_finding.validated",
      ]);
    });

    it("lets a person reject a proposal, and a rejected replacement leaves the old finding validated", async () => {
      const company = await seedCompany("DFR");
      const { stream } = await seedStream(company.id, "data");
      const first = await propose(person, company.id, { streamCaseId: stream.id, gifKey: "evidence", statement: "One." }).expect(201);
      await validate(first.body.id).expect(200);
      const second = await propose(person, company.id, {
        streamCaseId: stream.id,
        gifKey: "evidence",
        statement: "Two.",
        supersedesFindingId: first.body.id,
      }).expect(201);
      const rejected = await request(app(person))
        .post(`/api/deep-dive/findings/${second.body.id}/decision`)
        .send({ decision: "rejected" })
        .expect(200);
      expect(rejected.body.status).toBe("rejected");
      const old = await request(app(person)).get(`/api/deep-dive/findings/${first.body.id}`).expect(200);
      expect(old.body).toMatchObject({ status: "validated", supersededByFindingId: null });
      // The slot is free again after a rejection.
      await propose(person, company.id, {
        streamCaseId: stream.id,
        gifKey: "evidence",
        statement: "Three.",
        supersedesFindingId: first.body.id,
      }).expect(201);
      // A proposal cannot be superseded: it is decided first.
      await propose(person, company.id, {
        streamCaseId: stream.id,
        gifKey: "evidence",
        statement: "Four.",
        supersedesFindingId: second.body.id,
      }).expect(409);
    });
  });

  describe("never edited", () => {
    it("refuses an edit of a validated finding through the API", async () => {
      const company = await seedCompany("DFE");
      const { stream } = await seedStream(company.id, "people");
      const created = await propose(person, company.id, { streamCaseId: stream.id, gifKey: "future-state", statement: "Original." }).expect(201);
      await validate(created.body.id).expect(200);

      const edit = await request(app(person))
        .patch(`/api/deep-dive/findings/${created.body.id}`)
        .send({ statement: "Rewritten." })
        .expect(409);
      expect(edit.body.error).toBe(DEEP_DIVE_FINDING_NEVER_EDITED);
      await request(app(person))
        .patch(`/api/deep-dive/findings/${created.body.id}`)
        .send({ visibility: "shared", gifKey: "evidence" })
        .expect(409);

      const after = await request(app(person)).get(`/api/deep-dive/findings/${created.body.id}`).expect(200);
      expect(after.body).toMatchObject({ statement: "Original.", gifKey: "future-state", visibility: "internal" });
    });

    it("refuses an edit of a validated finding in the database, whoever writes it", async () => {
      const company = await seedCompany("DFD");
      const { stream, cells } = await seedStream(company.id, "governance");
      const created = await propose(person, company.id, { streamCaseId: stream.id, gifKey: "business-impact", statement: "Original." }).expect(201);
      await validate(created.body.id).expect(200);
      const id = created.body.id as string;

      const statement = await refused(db.update(deepDiveFindings).set({ statement: "Rewritten." }).where(eq(deepDiveFindings.id, id)));
      expect(statement).toMatchObject({ code: "23514", message: expect.stringContaining("never edited") });
      const cell = await refused(db.update(deepDiveFindings).set({ gifDocumentId: cells["current-state"] }).where(eq(deepDiveFindings.id, id)));
      expect(cell.code).toBe("23514");
      const back = await refused(db.update(deepDiveFindings).set({ status: "proposed", decidedAt: null, decidedByUserId: null }).where(eq(deepDiveFindings.id, id)));
      expect(back.code).toBe("23514");
      const redecide = await refused(db.update(deepDiveFindings).set({ decidedByUserId: "someone-else" }).where(eq(deepDiveFindings.id, id)));
      expect(redecide.code).toBe("23514");
      // Superseded only by a validated replacement.
      const orphan = await refused(db.update(deepDiveFindings).set({ status: "superseded", supersededAt: new Date() }).where(eq(deepDiveFindings.id, id)));
      expect(orphan.message).toContain("superseded only by a validated finding");

      // Evidence is fixed once the finding is decided.
      const client = await seedClient(company.id, "Client");
      const evidence = await seedEvidence(company.id, client.id, "Late file");
      const late = await refused(db.insert(deepDiveFindingEvidence).values({ companyId: company.id, findingId: id, evidenceId: evidence.id }));
      expect(late.code).toBe("23514");

      // A raw insert cannot skip the proposal.
      const skipped = await refused(db.insert(deepDiveFindings).values({
        companyId: company.id,
        streamCaseId: stream.id,
        gifDocumentId: cells["evidence"]!,
        statement: "Born validated.",
        status: "validated",
        decidedByUserId: "board-user",
        decidedAt: new Date(),
      }));
      expect(skipped.code).toBe("23514");

      // Sharing is the one change it takes, and only from a person.
      const agent = await seedAgentActor(company.id);
      await request(app(agent)).patch(`/api/deep-dive/findings/${id}`).send({ visibility: "shared" }).expect(403);
      const shared = await request(app(person)).patch(`/api/deep-dive/findings/${id}`).send({ visibility: "shared" }).expect(200);
      expect(shared.body.visibility).toBe("shared");
    });
  });

  describe("real links", () => {
    it("stores the stream, GIF cell and evidence as foreign keys", async () => {
      const result = await db.execute(sql`
        select tc.table_name, kcu.column_name, ccu.table_name as foreign_table
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
        join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
        where tc.constraint_type = 'FOREIGN KEY'
          and tc.table_name in ('deep_dive_findings', 'deep_dive_finding_evidence')
          and kcu.column_name in ('stream_case_id', 'gif_document_id', 'evidence_id', 'supersedes_finding_id', 'finding_id')
        order by kcu.column_name`);
      const rows = (result as unknown as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
      expect(rows).toEqual([
        { table_name: "deep_dive_finding_evidence", column_name: "evidence_id", foreign_table: "pipeline_case_evidence" },
        { table_name: "deep_dive_finding_evidence", column_name: "finding_id", foreign_table: "deep_dive_findings" },
        { table_name: "deep_dive_findings", column_name: "gif_document_id", foreign_table: "case_documents" },
        { table_name: "deep_dive_findings", column_name: "stream_case_id", foreign_table: "cases" },
        { table_name: "deep_dive_findings", column_name: "supersedes_finding_id", foreign_table: "deep_dive_findings" },
      ]);
    });

    it("refuses links that do not belong together", async () => {
      const company = await seedCompany("DFL");
      const other = await seedCompany("DFO");
      const clientA = await seedClient(company.id, "Client A");
      const clientB = await seedClient(company.id, "Client B");
      const evidenceB = await seedEvidence(company.id, clientB.id, "B's file");
      const { stream } = await seedStream(company.id, "technology", clientA.id);
      const { stream: otherStream, cells: otherCells } = await seedStream(other.id, "technology");

      // Another client's evidence, another company's stream, a missing stream.
      await propose(person, company.id, {
        streamCaseId: stream.id,
        gifKey: "evidence",
        statement: "Cites B.",
        evidenceIds: [evidenceB.id],
      }).expect(422);
      await propose(person, company.id, { streamCaseId: otherStream.id, gifKey: "evidence", statement: "Elsewhere." }).expect(422);
      await propose(person, company.id, { streamCaseId: randomUUID(), gifKey: "evidence", statement: "Nowhere." }).expect(422);
      await propose(person, company.id, { streamCaseId: stream.id, gifKey: "not-a-cell", statement: "Bad cell." }).expect(400);

      // The database refuses a GIF cell of another stream and evidence of another client.
      const wrongCell = await refused(db.insert(deepDiveFindings).values({
        companyId: company.id,
        streamCaseId: stream.id,
        gifDocumentId: otherCells["evidence"]!,
        statement: "Wrong cell.",
      }));
      expect(wrongCell.message).toContain("GIF cell of its own stream");
      const ok = await propose(person, company.id, { streamCaseId: stream.id, gifKey: "evidence", statement: "Fine." }).expect(201);
      const wrongClient = await refused(db.insert(deepDiveFindingEvidence).values({
        companyId: company.id,
        findingId: ok.body.id,
        evidenceId: evidenceB.id,
      }));
      expect(wrongClient.message).toContain("another company or client");

      // The other company's people cannot read this company's findings.
      const outsider = { type: "agent", agentId: randomUUID(), companyId: other.id, source: "agent_key" } as Express.Request["actor"];
      await request(app(outsider)).get(`/api/companies/${company.id}/deep-dive/findings`).expect(403);
      await request(app(outsider)).get(`/api/deep-dive/findings/${ok.body.id}`).expect(403);
    });

    it("needs the GIF document to exist before a finding can sit in it", async () => {
      const company = await seedCompany("DFM");
      const { stream } = await seedStream(company.id, "leadership");
      await db.delete(caseDocuments).where(eq(caseDocuments.key, "gif-future-state"));
      const missing = await propose(person, company.id, { streamCaseId: stream.id, gifKey: "future-state", statement: "No cell." }).expect(422);
      expect(missing.body.error).toContain("complete the record first");
    });

    it("keeps a GIF document while a finding sits in it", async () => {
      const company = await seedCompany("DFK");
      const { stream } = await seedStream(company.id, "customer-experience");
      await propose(person, company.id, { streamCaseId: stream.id, gifKey: "current-state", statement: "Kept." }).expect(201);
      await request(app(person)).delete(`/api/cases/${stream.id}/documents/gif-current-state`).expect(409);
      // A cell without findings can still go.
      await request(app(person)).delete(`/api/cases/${stream.id}/documents/gif-evidence`).expect(200);
    });

    it("still removes a company that has findings", async () => {
      const company = await seedCompany("DFX");
      const client = await seedClient(company.id, "Client");
      const evidence = await seedEvidence(company.id, client.id, "File");
      const { stream } = await seedStream(company.id, "data", client.id);
      const created = await propose(person, company.id, {
        streamCaseId: stream.id,
        gifKey: "evidence",
        statement: "Kept until the company goes.",
        evidenceIds: [evidence.id],
      }).expect(201);
      await validate(created.body.id).expect(200);
      await companyService(db).remove(company.id);
      expect(await db.select().from(deepDiveFindings)).toEqual([]);
    });
  });
});
