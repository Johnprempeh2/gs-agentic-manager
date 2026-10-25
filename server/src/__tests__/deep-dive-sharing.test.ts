import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  caseEvents,
  cases,
  companies,
  createDb,
  instanceSettings,
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
import { listSharedDeepDiveItemsForClient, withDeepDiveClientWrite } from "../services/deep-dive-sharing.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres Deep Dive sharing tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const storage = {} as StorageService;

/** The Postgres error behind a drizzle query error. */
function pgError(error: unknown): { code?: string; message?: string } {
  const cause = (error as { cause?: unknown })?.cause;
  return (cause ?? error) as { code?: string; message?: string };
}

describeEmbeddedPostgres("Deep Dive sharing and client-edit locks (GRE-2366)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-deep-dive-sharing-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(caseEvents);
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
    return client!;
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
    visibility?: "internal" | "shared";
    fields?: Record<string, unknown>;
    clientEditableFields?: string[];
    sourceValues?: Record<string, unknown> | null;
  }) {
    const caseNumber = Math.floor(Math.random() * 1_000_000);
    const [row] = await db.insert(cases).values({
      companyId: input.companyId,
      caseNumber,
      identifier: `DD-${randomUUID()}`,
      caseType: "deep_dive_stream",
      key: input.key,
      title: `Deep dive: ${input.key}`,
      fields: input.fields ?? {},
      clientCaseId: input.clientCaseId,
      ...(input.visibility ? { visibility: input.visibility } : {}),
      ...(input.clientEditableFields ? { clientEditableFields: input.clientEditableFields } : {}),
      ...(input.sourceValues !== undefined ? { sourceValues: input.sourceValues } : {}),
    }).returning();
    return row!;
  }

  describe("Internal by default", () => {
    it("stores a new item Internal in the database when nothing says Shared", async () => {
      const company = await seedCompany("DDI");
      const row = await seedItem({ companyId: company.id, clientCaseId: null, key: "data" });
      expect(row.visibility).toBe("internal");
      expect(row.clientEditableFields).toEqual([]);
    });

    it("creates an item Internal through the API, for a person and for an agent", async () => {
      const company = await seedCompany("DDA");
      const created = await request(app(person))
        .post(`/api/companies/${company.id}/cases`)
        .send({ caseType: "deep_dive_stream", key: "data", title: "Deep dive: Data" })
        .expect(201);
      expect(created.body.visibility).toBe("internal");

      const agent = await seedAgentActor(company.id);
      const byAgent = await request(app(agent))
        .post(`/api/companies/${company.id}/cases`)
        .send({ caseType: "deep_dive_stream", key: "people", title: "Deep dive: People" })
        .expect(201);
      expect(byAgent.body.visibility).toBe("internal");
    });

    it("lets a person set Shared, and refuses Shared or unlocks from an agent", async () => {
      const company = await seedCompany("DDP");
      const client = await seedClient(company.id, "Client A");
      const agent = await seedAgentActor(company.id);

      await request(app(agent))
        .post(`/api/companies/${company.id}/cases`)
        .send({ caseType: "deep_dive_stream", key: "data", title: "Deep dive: Data", visibility: "shared" })
        .expect(403);
      const created = await request(app(agent))
        .post(`/api/companies/${company.id}/cases`)
        .send({ caseType: "deep_dive_stream", key: "data", title: "Deep dive: Data", clientCaseId: client.id })
        .expect(201);
      expect(created.body.visibility).toBe("internal");
      expect(created.body.clientCaseId).toBe(client.id);

      await request(app(agent)).patch(`/api/cases/${created.body.id}`).send({ visibility: "shared" }).expect(403);
      await request(app(agent)).patch(`/api/cases/${created.body.id}`).send({ clientEditableFields: ["note"] }).expect(403);

      const shared = await request(app(person))
        .patch(`/api/cases/${created.body.id}`)
        .send({ visibility: "shared" })
        .expect(200);
      expect(shared.body.visibility).toBe("shared");

      // An agent may still make an item more private.
      const back = await request(app(agent)).patch(`/api/cases/${created.body.id}`).send({ visibility: "internal" }).expect(200);
      expect(back.body.visibility).toBe("internal");
    });

    it("keeps Shared on a repeat upsert that does not mention it", async () => {
      const company = await seedCompany("DDU");
      const http = request(app(person));
      const created = await http
        .post(`/api/companies/${company.id}/cases`)
        .send({ caseType: "deep_dive_stream", key: "data", title: "Deep dive: Data", visibility: "shared" })
        .expect(201);
      const again = await http
        .post(`/api/companies/${company.id}/cases`)
        .send({ caseType: "deep_dive_stream", key: "data", title: "Deep dive: Data" })
        .expect(200);
      expect(again.body.id).toBe(created.body.id);
      expect(again.body.visibility).toBe("shared");
    });

    it("gives a new child its parent's client, and moving an item to another client makes it Internal", async () => {
      const company = await seedCompany("DDC");
      const clientA = await seedClient(company.id, "Client A");
      const clientB = await seedClient(company.id, "Client B");
      const http = request(app(person));
      const record = await http
        .post(`/api/companies/${company.id}/cases`)
        .send({ caseType: "deep_dive", key: "record", title: "Deep dive record", clientCaseId: clientA.id })
        .expect(201);
      const stream = await http
        .post(`/api/companies/${company.id}/cases`)
        .send({ caseType: "deep_dive_stream", key: "data", title: "Deep dive: Data", parentCaseId: record.body.id, visibility: "shared" })
        .expect(201);
      expect(stream.body.clientCaseId).toBe(clientA.id);

      const moved = await http.patch(`/api/cases/${stream.body.id}`).send({ clientCaseId: clientB.id }).expect(200);
      expect(moved.body.clientCaseId).toBe(clientB.id);
      expect(moved.body.visibility).toBe("internal");
    });

    it("refuses sharing fields on other case types and a client from another company", async () => {
      const company = await seedCompany("DDX");
      const other = await seedCompany("DDY");
      const otherClient = await seedClient(other.id, "Other client");
      const http = request(app(person));
      await http
        .post(`/api/companies/${company.id}/cases`)
        .send({ caseType: "bug", title: "A bug", visibility: "shared" })
        .expect(422);
      await http
        .post(`/api/companies/${company.id}/cases`)
        .send({ caseType: "deep_dive_stream", key: "data", title: "Deep dive: Data", clientCaseId: otherClient.id })
        .expect(422);
      // The database refuses it too, whatever path writes it.
      await expect(seedItem({ companyId: company.id, clientCaseId: otherClient.id, key: "people" }))
        .rejects.toSatisfy((error: unknown) => pgError(error).code === "23514");
    });
  });

  describe("the client read helper", () => {
    it("returns only Shared items of that client, never Internal ones or another client's", async () => {
      const company = await seedCompany("DDR");
      const clientA = await seedClient(company.id, "Client A");
      const clientB = await seedClient(company.id, "Client B");
      const sharedA = await seedItem({ companyId: company.id, clientCaseId: clientA.id, key: "data", visibility: "shared" });
      await seedItem({ companyId: company.id, clientCaseId: clientA.id, key: "people" });
      await seedItem({ companyId: company.id, clientCaseId: clientB.id, key: "technology", visibility: "shared" });
      await seedItem({ companyId: company.id, clientCaseId: null, key: "governance", visibility: "shared" });

      const forA = await listSharedDeepDiveItemsForClient(db, { companyId: company.id, clientCaseId: clientA.id });
      expect(forA.map((item) => item.id)).toEqual([sharedA.id]);
      expect(forA[0]).not.toHaveProperty("sourceValues");
      expect(forA[0]).not.toHaveProperty("createdByUserId");

      const forB = await listSharedDeepDiveItemsForClient(db, { companyId: company.id, clientCaseId: clientB.id });
      expect(forB.map((item) => item.key)).toEqual(["technology"]);
    });

    it("never returns a client's items under another company", async () => {
      const company = await seedCompany("DDS");
      const other = await seedCompany("DDT");
      const client = await seedClient(company.id, "Client A");
      await seedItem({ companyId: company.id, clientCaseId: client.id, key: "data", visibility: "shared" });

      expect(await listSharedDeepDiveItemsForClient(db, { companyId: other.id, clientCaseId: client.id })).toEqual([]);
    });

    it("returns nothing for non-Deep-Dive cases even when marked Shared directly", async () => {
      const company = await seedCompany("DDN");
      const client = await seedClient(company.id, "Client A");
      await db.insert(cases).values({
        companyId: company.id,
        caseNumber: 1,
        identifier: `DDN-${randomUUID()}`,
        caseType: "bug",
        title: "Not Deep Dive",
        visibility: "shared",
        clientCaseId: client.id,
      });
      expect(await listSharedDeepDiveItemsForClient(db, { companyId: company.id, clientCaseId: client.id })).toEqual([]);
    });
  });

  describe("client-edit locks in the database", () => {
    async function sharedItemFor(prefix: string) {
      const company = await seedCompany(prefix);
      const client = await seedClient(company.id, "Client A");
      const item = await seedItem({
        companyId: company.id,
        clientCaseId: client.id,
        key: "data",
        visibility: "shared",
        fields: { answer: "draft", finding: "Staff wording" },
        clientEditableFields: ["answer"],
      });
      return { company, client, item };
    }

    it("lets the client change an unlocked field of its own Shared item", async () => {
      const { company, client, item } = await sharedItemFor("DLA");
      await withDeepDiveClientWrite(db, { companyId: company.id, clientCaseId: client.id }, (tx) =>
        tx.update(cases).set({ fields: { ...item.fields, answer: "Our answer" } }).where(eq(cases.id, item.id)));
      const [row] = await db.select().from(cases).where(eq(cases.id, item.id));
      expect(row!.fields).toEqual({ answer: "Our answer", finding: "Staff wording" });
    });

    it("refuses a client change to a locked field, even with a raw UPDATE", async () => {
      const { company, client, item } = await sharedItemFor("DLB");
      const scope = { companyId: company.id, clientCaseId: client.id };

      await expect(withDeepDiveClientWrite(db, scope, (tx) =>
        tx.update(cases).set({ fields: { ...item.fields, finding: "Client wording" } }).where(eq(cases.id, item.id))))
        .rejects.toSatisfy((error: unknown) => pgError(error).code === "42501");
      await expect(withDeepDiveClientWrite(db, scope, (tx) =>
        tx.execute(sql`update cases set fields = fields || '{"added": "x"}'::jsonb where id = ${item.id}`)))
        .rejects.toSatisfy((error: unknown) => pgError(error).code === "42501");
      for (const change of [
        { title: "Renamed" },
        { visibility: "internal" as const },
        { clientEditableFields: ["answer", "finding"] },
        { status: "done" },
      ]) {
        await expect(withDeepDiveClientWrite(db, scope, (tx) =>
          tx.update(cases).set(change).where(eq(cases.id, item.id))))
          .rejects.toSatisfy((error: unknown) => pgError(error).code === "42501");
      }

      const [row] = await db.select().from(cases).where(eq(cases.id, item.id));
      expect(row!.fields).toEqual({ answer: "draft", finding: "Staff wording" });
      expect(row!.title).toBe("Deep dive: data");
      expect(row!.visibility).toBe("shared");
    });

    it("refuses a client write to an Internal item, another client's item, or a new or deleted item", async () => {
      const { company, client, item } = await sharedItemFor("DLC");
      const scope = { companyId: company.id, clientCaseId: client.id };
      const internal = await seedItem({
        companyId: company.id,
        clientCaseId: client.id,
        key: "people",
        fields: { answer: "draft" },
        clientEditableFields: ["answer"],
      });
      const otherClient = await seedClient(company.id, "Client B");
      const theirs = await seedItem({
        companyId: company.id,
        clientCaseId: otherClient.id,
        key: "technology",
        visibility: "shared",
        fields: { answer: "draft" },
        clientEditableFields: ["answer"],
      });

      for (const target of [internal, theirs]) {
        await expect(withDeepDiveClientWrite(db, scope, (tx) =>
          tx.update(cases).set({ fields: { answer: "changed" } }).where(eq(cases.id, target.id))))
          .rejects.toSatisfy((error: unknown) => pgError(error).code === "42501");
      }
      await expect(withDeepDiveClientWrite(db, scope, (tx) => tx.delete(cases).where(eq(cases.id, item.id))))
        .rejects.toSatisfy((error: unknown) => pgError(error).code === "42501");
      await expect(withDeepDiveClientWrite(db, scope, (tx) =>
        tx.insert(cases).values({
          companyId: company.id,
          caseNumber: 999_999_9,
          identifier: `DLC-${randomUUID()}`,
          caseType: "deep_dive_stream",
          title: "Client made",
          clientCaseId: client.id,
          visibility: "shared",
        })))
        .rejects.toSatisfy((error: unknown) => pgError(error).code === "42501");
    });

    it("refuses to act as a client of another company", async () => {
      const { client } = await sharedItemFor("DLD");
      const other = await seedCompany("DLE");
      await expect(withDeepDiveClientWrite(db, { companyId: other.id, clientCaseId: client.id }, async () => null))
        .rejects.toMatchObject({ status: 404 });
    });

    it("does not leak the client role to later writes on the same pool", async () => {
      const { company, client, item } = await sharedItemFor("DLF");
      await withDeepDiveClientWrite(db, { companyId: company.id, clientCaseId: client.id }, async () => null);
      await db.update(cases).set({ title: "Staff rename" }).where(eq(cases.id, item.id));
      const [row] = await db.select().from(cases).where(eq(cases.id, item.id));
      expect(row!.title).toBe("Staff rename");
    });
  });

  describe("imported source rows", () => {
    it("keeps source values unchanged and stores edits beside them", async () => {
      const company = await seedCompany("DSV");
      const item = await seedItem({
        companyId: company.id,
        clientCaseId: null,
        key: "data",
        sourceValues: { finding: "As imported" },
      });
      await db.update(cases).set({ fields: { finding: "Edited by staff" } }).where(eq(cases.id, item.id));
      await expect(db.update(cases).set({ sourceValues: { finding: "Rewritten" } }).where(eq(cases.id, item.id)))
        .rejects.toSatisfy((error: unknown) => pgError(error).code === "23514");
      const [row] = await db.select().from(cases).where(eq(cases.id, item.id));
      expect(row!.sourceValues).toEqual({ finding: "As imported" });
      expect(row!.fields).toEqual({ finding: "Edited by staff" });
    });

    it("answers 409 when an upsert tries to replace an imported source row", async () => {
      const company = await seedCompany("DSW");
      const http = request(app(person));
      const body = { caseType: "deep_dive_stream", key: "data", title: "Deep dive: Data", sourceValues: { finding: "As imported" } };
      await http.post(`/api/companies/${company.id}/cases`).send(body).expect(201);
      await http.post(`/api/companies/${company.id}/cases`).send(body).expect(200);
      await http
        .post(`/api/companies/${company.id}/cases`)
        .send({ ...body, sourceValues: { finding: "Rewritten" } })
        .expect(409);
    });
  });
});
