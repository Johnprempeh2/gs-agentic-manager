import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  caseEvents,
  cases,
  companies,
  createDb,
  deepDiveItemFiles,
  instanceSettings,
  pipelineCaseDocumentRequests,
  pipelineCaseEvidence,
  pipelineCases,
  pipelineStages,
  pipelines,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { caseRoutes } from "../routes/cases.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { listSharedDeepDiveFilesForClient, withDeepDiveClientWrite } from "../services/deep-dive-sharing.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Deep Dive files tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const storage = {} as StorageService;

/** The Postgres error behind a drizzle query error. */
function pgError(error: unknown): { code?: string; message?: string } {
  const cause = (error as { cause?: unknown })?.cause;
  return (cause ?? error) as { code?: string; message?: string };
}

describeEmbeddedPostgres("Deep Dive evidence and files: one file, many items (GRE-2395)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-deep-dive-files-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(deepDiveItemFiles);
    await db.delete(caseEvents);
    await db.delete(cases);
    await db.delete(pipelineCaseDocumentRequests);
    await db.delete(pipelineCaseEvidence);
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
    instance.use("/api", caseRoutes(db, storage));
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
    return { ...client!, stageId: stage!.id };
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

  async function seedItem(input: {
    companyId: string;
    clientCaseId: string | null;
    key: string;
    caseType?: string;
    visibility?: "internal" | "shared";
  }) {
    const [row] = await db.insert(cases).values({
      companyId: input.companyId,
      caseNumber: Math.floor(Math.random() * 1_000_000),
      identifier: `DD-${randomUUID()}`,
      caseType: input.caseType ?? "deep_dive_stream",
      key: input.key,
      title: `Deep dive: ${input.key}`,
      clientCaseId: input.clientCaseId,
      ...(input.visibility ? { visibility: input.visibility } : {}),
    }).returning();
    return row!;
  }

  async function seedFile(companyId: string, clientCaseId: string, title: string) {
    const [row] = await db.insert(pipelineCaseEvidence).values({
      companyId,
      caseId: clientCaseId,
      kind: "link",
      title,
      url: `https://example.com/${randomUUID()}`,
      createdByUserId: "board-user",
    }).returning();
    return row!;
  }

  async function seedRequest(companyId: string, client: { id: string; stageId: string }, title: string, evidenceId?: string) {
    const [row] = await db.insert(pipelineCaseDocumentRequests).values({
      companyId,
      caseId: client.id,
      stageId: client.stageId,
      title,
      evidenceId: evidenceId ?? null,
    }).returning();
    return row!;
  }

  describe("one file, many items", () => {
    it("links one file to two items and unlinks it from one without touching the other", async () => {
      const company = await seedCompany("DDF");
      const client = await seedClient(company.id, "Client A");
      const data = await seedItem({ companyId: company.id, clientCaseId: client.id, key: "data" });
      const people = await seedItem({ companyId: company.id, clientCaseId: client.id, key: "people" });
      const file = await seedFile(company.id, client.id, "Org chart");

      const first = await request(app(person))
        .post(`/api/cases/${data.id}/deep-dive-files`)
        .send({ evidenceId: file.id })
        .expect(201);
      const second = await request(app(person))
        .post(`/api/cases/${people.id}/deep-dive-files`)
        .send({ evidenceId: file.id })
        .expect(201);
      expect(first.body).toMatchObject({ caseId: data.id, evidenceId: file.id, visibility: "internal" });
      expect(first.body.linkedBy).toMatchObject({ type: "user", id: "board-user" });
      expect(typeof first.body.linkedAt).toBe("string");
      expect(second.body.caseId).toBe(people.id);

      await request(app(person))
        .post(`/api/cases/${data.id}/deep-dive-files`)
        .send({ evidenceId: file.id })
        .expect(409);

      await request(app(person))
        .delete(`/api/cases/${data.id}/deep-dive-files/${first.body.id}`)
        .expect(200);

      const remaining = await db.select().from(deepDiveItemFiles);
      expect(remaining.map((row) => [row.caseId, row.evidenceId])).toEqual([[people.id, file.id]]);
      const files = await db.select().from(pipelineCaseEvidence).where(eq(pipelineCaseEvidence.id, file.id));
      expect(files).toHaveLength(1);

      // A link is unlinked only through its own item.
      await request(app(person))
        .delete(`/api/cases/${data.id}/deep-dive-files/${second.body.id}`)
        .expect(404);
      expect(await db.select().from(deepDiveItemFiles)).toHaveLength(1);
    });

    it("links a document request, and the screen shows the file's provenance and the request", async () => {
      const company = await seedCompany("DDS");
      const client = await seedClient(company.id, "Client A");
      const record = await seedItem({
        companyId: company.id,
        clientCaseId: client.id,
        key: "record",
        caseType: "deep_dive",
      });
      const data = await seedItem({ companyId: company.id, clientCaseId: client.id, key: "data" });
      const file = await seedFile(company.id, client.id, "Board pack");
      const missing = await seedRequest(company.id, client, "Last year's accounts");

      await request(app(person)).post(`/api/cases/${data.id}/deep-dive-files`).send({ evidenceId: file.id }).expect(201);
      await request(app(person))
        .post(`/api/cases/${data.id}/deep-dive-files`)
        .send({ documentRequestId: missing.id })
        .expect(201);

      const screen = await request(app(person)).get(`/api/companies/${company.id}/deep-dive/files`).expect(200);
      expect(screen.body.client).toMatchObject({ id: client.id, title: "Client A" });
      expect(screen.body.evidence).toEqual([
        expect.objectContaining({ id: file.id, kind: "link", addedBy: expect.objectContaining({ type: "user" }) }),
      ]);
      expect(screen.body.requests).toEqual([expect.objectContaining({ id: missing.id, received: null })]);
      expect(screen.body.links.map((link: { caseId: string }) => link.caseId)).toEqual([data.id, data.id]);
      expect(record.clientCaseId).toBe(client.id);
    });
  });

  describe("access rule", () => {
    it("refuses a file of another client, through the API and in the database", async () => {
      const company = await seedCompany("DDX");
      const clientA = await seedClient(company.id, "Client A");
      const clientB = await seedClient(company.id, "Client B");
      const item = await seedItem({ companyId: company.id, clientCaseId: clientA.id, key: "data" });
      const otherFile = await seedFile(company.id, clientB.id, "B's file");

      await request(app(person))
        .post(`/api/cases/${item.id}/deep-dive-files`)
        .send({ evidenceId: otherFile.id })
        .expect(404);

      const direct = await db.insert(deepDiveItemFiles).values({
        companyId: company.id,
        caseId: item.id,
        evidenceId: otherFile.id,
      }).then(() => null, (error: unknown) => pgError(error));
      expect(direct).toMatchObject({ code: "23514", message: "The file belongs to another client" });
    });

    it("refuses a link on an item with no client, and on an item of another company", async () => {
      const company = await seedCompany("DDN");
      const client = await seedClient(company.id, "Client A");
      const noClient = await seedItem({ companyId: company.id, clientCaseId: null, key: "data" });
      const file = await seedFile(company.id, client.id, "Org chart");
      const res = await request(app(person))
        .post(`/api/cases/${noClient.id}/deep-dive-files`)
        .send({ evidenceId: file.id })
        .expect(422);
      expect(res.body.error).toContain("Choose the client");

      const other = await seedCompany("DDO");
      const otherItem = await seedItem({ companyId: other.id, clientCaseId: null, key: "data" });
      const direct = await db.insert(deepDiveItemFiles).values({
        companyId: company.id,
        caseId: otherItem.id,
        evidenceId: file.id,
      }).then(() => null, (error: unknown) => pgError(error));
      expect(direct).toMatchObject({ code: "23514" });
    });

    it("lets an agent link a file Internal but never share it", async () => {
      const company = await seedCompany("DDG");
      const client = await seedClient(company.id, "Client A");
      const item = await seedItem({ companyId: company.id, clientCaseId: client.id, key: "data" });
      const file = await seedFile(company.id, client.id, "Org chart");
      const agent = await seedAgentActor(company.id);

      await request(app(agent))
        .post(`/api/cases/${item.id}/deep-dive-files`)
        .send({ evidenceId: file.id, visibility: "shared" })
        .expect(403);
      const linked = await request(app(agent))
        .post(`/api/cases/${item.id}/deep-dive-files`)
        .send({ evidenceId: file.id })
        .expect(201);
      expect(linked.body.linkedBy).toMatchObject({ type: "agent", name: "Deep Dive Agent" });
      await request(app(agent))
        .patch(`/api/cases/${item.id}/deep-dive-files/${linked.body.id}`)
        .send({ visibility: "shared" })
        .expect(403);
      const shared = await request(app(person))
        .patch(`/api/cases/${item.id}/deep-dive-files/${linked.body.id}`)
        .send({ visibility: "shared" })
        .expect(200);
      expect(shared.body.visibility).toBe("shared");
    });

    it("refuses every link write made for a client, and a change of a link's file", async () => {
      const company = await seedCompany("DDC");
      const client = await seedClient(company.id, "Client A");
      const item = await seedItem({ companyId: company.id, clientCaseId: client.id, key: "data", visibility: "shared" });
      const file = await seedFile(company.id, client.id, "Org chart");
      const another = await seedFile(company.id, client.id, "Board pack");
      const [link] = await db.insert(deepDiveItemFiles).values({
        companyId: company.id,
        caseId: item.id,
        evidenceId: file.id,
        visibility: "shared",
      }).returning();

      const scope = { companyId: company.id, clientCaseId: client.id };
      const asClient = [
        () => withDeepDiveClientWrite(db, scope, (tx) =>
          tx.insert(deepDiveItemFiles).values({ companyId: company.id, caseId: item.id, evidenceId: another.id })),
        () => withDeepDiveClientWrite(db, scope, (tx) =>
          tx.delete(deepDiveItemFiles).where(eq(deepDiveItemFiles.id, link!.id))),
        () => withDeepDiveClientWrite(db, scope, (tx) =>
          tx.update(deepDiveItemFiles).set({ visibility: "internal" }).where(eq(deepDiveItemFiles.id, link!.id))),
      ];
      for (const write of asClient) {
        const error = await write().then(() => null, (caught: unknown) => pgError(caught));
        expect(error).toMatchObject({ code: "42501" });
      }

      const retarget = await db.update(deepDiveItemFiles)
        .set({ evidenceId: another.id })
        .where(eq(deepDiveItemFiles.id, link!.id))
        .then(() => null, (error: unknown) => pgError(error));
      expect(retarget).toMatchObject({ code: "23514" });
      expect(await db.select().from(deepDiveItemFiles)).toEqual([expect.objectContaining({ evidenceId: file.id })]);
    });

    it("moving an item to another client removes its links and keeps the files", async () => {
      const company = await seedCompany("DDM");
      const clientA = await seedClient(company.id, "Client A");
      const clientB = await seedClient(company.id, "Client B");
      const item = await seedItem({ companyId: company.id, clientCaseId: clientA.id, key: "data" });
      const file = await seedFile(company.id, clientA.id, "Org chart");
      await request(app(person)).post(`/api/cases/${item.id}/deep-dive-files`).send({ evidenceId: file.id }).expect(201);

      await request(app(person)).patch(`/api/cases/${item.id}`).send({ clientCaseId: clientB.id }).expect(200);

      expect(await db.select().from(deepDiveItemFiles)).toEqual([]);
      expect(await db.select().from(pipelineCaseEvidence).where(eq(pipelineCaseEvidence.id, file.id))).toHaveLength(1);
    });
  });

  describe("client read helper", () => {
    it("returns only Shared links of Shared items of that client", async () => {
      const company = await seedCompany("DDR");
      const clientA = await seedClient(company.id, "Client A");
      const clientB = await seedClient(company.id, "Client B");
      const sharedItem = await seedItem({ companyId: company.id, clientCaseId: clientA.id, key: "data", visibility: "shared" });
      const internalItem = await seedItem({ companyId: company.id, clientCaseId: clientA.id, key: "people" });
      const otherClientItem = await seedItem({
        companyId: company.id,
        clientCaseId: clientB.id,
        key: "money",
        visibility: "shared",
      });
      const fileA = await seedFile(company.id, clientA.id, "Org chart");
      const secretA = await seedFile(company.id, clientA.id, "Internal notes");
      const fileB = await seedFile(company.id, clientB.id, "B's file");
      const heldRequest = await seedRequest(company.id, clientA, "Signed NDA", fileA.id);
      const missingRequest = await seedRequest(company.id, clientA, "Last year's accounts");

      const link = (caseId: string, target: { evidenceId?: string; documentRequestId?: string }, visibility: "internal" | "shared") =>
        db.insert(deepDiveItemFiles).values({ companyId: company.id, caseId, ...target, visibility }).returning();
      const [sharedLink] = await link(sharedItem.id, { evidenceId: fileA.id }, "shared");
      await link(sharedItem.id, { evidenceId: secretA.id }, "internal");
      const [heldLink] = await link(sharedItem.id, { documentRequestId: heldRequest.id }, "shared");
      const [missingLink] = await link(sharedItem.id, { documentRequestId: missingRequest.id }, "shared");
      await link(internalItem.id, { evidenceId: fileA.id }, "shared");
      await link(otherClientItem.id, { evidenceId: fileB.id }, "shared");

      const files = await listSharedDeepDiveFilesForClient(db, { companyId: company.id, clientCaseId: clientA.id });
      expect(files).toEqual([
        { linkId: sharedLink!.id, itemId: sharedItem.id, title: "Org chart", kind: "link", status: "held", heldAt: expect.any(String) },
        { linkId: heldLink!.id, itemId: sharedItem.id, title: "Signed NDA", kind: "link", status: "held", heldAt: expect.any(String) },
        { linkId: missingLink!.id, itemId: sharedItem.id, title: "Last year's accounts", kind: null, status: "missing", heldAt: null },
      ]);
      expect(JSON.stringify(files)).not.toContain("board-user");

      // The same client in another company sees nothing.
      const other = await seedCompany("DDQ");
      expect(await listSharedDeepDiveFilesForClient(db, { companyId: other.id, clientCaseId: clientA.id })).toEqual([]);
      // Client B sees only its own.
      const forB = await listSharedDeepDiveFilesForClient(db, { companyId: company.id, clientCaseId: clientB.id });
      expect(forB.map((file) => file.title)).toEqual(["B's file"]);
    });
  });
});
