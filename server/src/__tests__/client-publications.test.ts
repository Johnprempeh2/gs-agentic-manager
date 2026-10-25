import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  assets,
  clientDeliverablePublicationEvents,
  clientDeliverablePublications,
  companies,
  companyMemberships,
  createDb,
  issueAttachments,
  issues,
  issueWorkProducts,
  pipelineCases,
  projects,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { fillTestCaseOrganisation } from "./helpers/case-organisation.js";
import { errorHandler } from "../middleware/error-handler.js";
import { pipelineRoutes } from "../routes/pipelines.js";
import { clientDeliverablePublicRoutes, clientPublicationRoutes } from "../routes/client-publications.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import type { ClientReceipt, ClientReceiptOutcome, ClientReceiptSender } from "../services/client-receipts.js";
import type { StorageService } from "../storage/types.js";

const storedObjects = new Map<string, { body: Buffer; contentType: string }>();
const memoryStorage: StorageService = {
  provider: "local_disk",
  putFile: async (input) => {
    const objectKey = `${input.companyId}/${input.namespace}/${randomUUID()}`;
    storedObjects.set(objectKey, { body: input.body, contentType: input.contentType });
    return {
      provider: "local_disk",
      objectKey,
      contentType: input.contentType,
      byteSize: input.body.length,
      sha256: createHash("sha256").update(input.body).digest("hex"),
      originalFilename: input.originalFilename,
    };
  },
  getObject: async (_companyId, objectKey) => {
    const object = storedObjects.get(objectKey);
    if (!object) throw new Error("missing object");
    return { stream: Readable.from(object.body), contentType: object.contentType, contentLength: object.body.length };
  },
  headObject: async (_companyId, objectKey) => ({ exists: storedObjects.has(objectKey) }),
  deleteObject: async (_companyId, objectKey) => {
    storedObjects.delete(objectKey);
  },
};

// A receipt sender that records what it was asked to send instead of calling Resend.
function fakeReceipts(outcome: () => ClientReceiptOutcome, configured = true) {
  const sent: Array<{ companyId: string; receipt: ClientReceipt }> = [];
  const sender: ClientReceiptSender = {
    configured: async () => configured,
    send: async (companyId, receipt) => {
      sent.push({ companyId, receipt });
      return outcome();
    },
  };
  return { sender, sent };
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres client publication tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Clients > Deliverables publishing (GRE-2373).
describeEmbeddedPostgres("client deliverable publishing", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let receipts = fakeReceipts(() => ({ status: "sent", messageId: "msg-1" }));

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-client-publications-");
    db = createDb(tempDb.connectionString);
  });

  beforeEach(async () => {
    receipts = fakeReceipts(() => ({ status: "sent", messageId: "msg-1" }));
    await instanceSettingsService(db).updateExperimental({ enablePipelines: true });
  });

  afterEach(async () => {
    storedObjects.clear();
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
  const anonymous: Express.Request["actor"] = { type: "none", source: "none" };

  function app(actor: Express.Request["actor"] = boardActor) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", fillTestCaseOrganisation(db));
    instance.use("/api", pipelineRoutes(db, { heartbeat: { wakeup: async () => null }, storage: memoryStorage }));
    instance.use("/api", clientPublicationRoutes(db, { publicBaseUrl: "https://gsam.example.com", receipts: receipts.sender }));
    instance.use("/api", clientDeliverablePublicRoutes(db, memoryStorage, { receipts: receipts.sender }));
    instance.use(errorHandler);
    return instance;
  }

  function person(userId: string, companyId: string): Express.Request["actor"] {
    return { type: "board", userId, source: "session", isInstanceAdmin: false, companyIds: [companyId] };
  }

  async function seedCompany(name: string) {
    const prefix = `D${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const [company] = await db.insert(companies).values({ name, issuePrefix: prefix }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: `${name} agent`, role: "engineer" }).returning();
    const [project] = await db.insert(projects).values({ companyId: company!.id, name: `${name} project`, status: "in_progress" }).returning();
    await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: "approver-user", status: "active" });
    return { company: company!, agent: agent!, project: project! };
  }

  async function seedClient(companyId: string, projectId: string) {
    const http = request(app());
    const pipeline = await http
      .post(`/api/companies/${companyId}/pipelines`)
      .send({
        key: "client",
        name: "Client journey",
        stages: [
          { key: "discovery", name: "Executive Discovery", kind: "working", position: 100 },
          { key: "deep-dive", name: "Deep Dive", kind: "working", position: 200 },
          { key: "playback", name: "Playback", kind: "done", position: 500 },
          { key: "paused", name: "Paused", kind: "cancelled", position: 900 },
        ],
      })
      .expect(201);
    const created = await http
      .post(`/api/pipelines/${pipeline.body.id}/cases`)
      .send({ caseKey: "client-1", title: "Northwind Logistics", stageKey: "discovery" })
      .expect(201);
    const caseId = (created.body.case ?? created.body).id as string;
    await http.post(`/api/cases/${caseId}/project-links`).send({ projectId }).expect(201);
    const stages = (await http.get(`/api/pipelines/${pipeline.body.id}`).expect(200)).body.stages as Array<{ id: string; key: string }>;
    return { caseId, stageId: (key: string) => stages.find((stage) => stage.key === key)!.id };
  }

  /** A stored HTML deliverable on a task of the client's project, filed under a stage. */
  async function seedDeliverable(companyId: string, projectId: string, caseId: string, stageId: string, body = "<h1>North Star</h1>") {
    const [issue] = await db.insert(issues).values({
      companyId,
      projectId,
      identifier: `D-${randomUUID().slice(0, 6)}`,
      title: "Make the North Star summary",
      status: "done",
      priority: "medium",
    }).returning();
    const addVersion = async (version: number, content: string) => {
      const stored = await memoryStorage.putFile({
        companyId,
        namespace: "issues",
        body: Buffer.from(content),
        contentType: "text/html",
        originalFilename: "north-star.html",
      });
      const [asset] = await db.insert(assets).values({
        companyId,
        provider: "local_disk",
        objectKey: stored.objectKey,
        contentType: "text/html",
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: "north-star.html",
      }).returning();
      const [attachment] = await db.insert(issueAttachments).values({ companyId, issueId: issue!.id, assetId: asset!.id }).returning();
      const [row] = await db.insert(issueWorkProducts).values({
        companyId,
        issueId: issue!.id,
        type: "deliverable",
        provider: "paperclip",
        externalId: "north-star",
        title: "North Star summary",
        status: "active",
        metadata: { version, attachmentId: attachment!.id, kind: "report", deliverableStatus: "final", confidentiality: "client" },
      }).returning();
      return { row: row!, asset: asset! };
    };
    const first = await addVersion(1, body);
    const link = await request(app())
      .post(`/api/cases/${caseId}/journey/deliverables`)
      .send({ stageId, deliverableId: first.row.id, clientFacing: true })
      .expect(201);
    return { first, addVersion, stageLinkId: link.body.id as string };
  }

  async function clearGates(caseId: string) {
    const http = request(app());
    await http.put(`/api/cases/${caseId}/nda`).send({ status: "accepted" }).expect(200);
    await http.put(`/api/cases/${caseId}/engagement`).send({ status: "accepted" }).expect(200);
  }

  async function ready() {
    const { company, agent, project } = await seedCompany("Greatstone");
    const { caseId, stageId } = await seedClient(company.id, project.id);
    const deliverable = await seedDeliverable(company.id, project.id, caseId, stageId("deep-dive"));
    const http = request(app());
    await http.post(`/api/cases/${caseId}/approvers`).send({ userId: "approver-user" }).expect(201);
    const draft = await http.post(`/api/cases/${caseId}/publications`).send({ stageLinkId: deliverable.stageLinkId }).expect(201);
    return { company, agent, project, caseId, stageId, deliverable, http, publicationId: draft.body.id as string };
  }

  /** The database's own message for a refused write (drizzle wraps it in "Failed query"). */
  async function refusal(write: PromiseLike<unknown>) {
    try {
      await write;
    } catch (error) {
      const cause = (error as { cause?: { message?: string } }).cause;
      return cause?.message ?? (error as Error).message;
    }
    return "accepted";
  }

  const errorCode = (body: { details?: { code?: string }; code?: string }) => body.details?.code ?? body.code;

  it("publishes only after the registered approver approves, then the client accepts and gets a receipt", async () => {
    const { company, agent, caseId, http, publicationId } = await ready();
    const approver = request(app(person("approver-user", company.id)));
    const someoneElse = request(app(person("other-user", company.id)));
    const agentHttp = request(app({ type: "agent", agentId: agent.id, companyId: company.id, runId: randomUUID(), source: "agent_key" }));

    // Nothing can be approved or published from draft.
    await approver.post(`/api/client-publications/${publicationId}/approve`).expect(409);
    await http.post(`/api/client-publications/${publicationId}/publish`).expect(409);

    // Only a registered approver can be named.
    const notRegistered = await http.post(`/api/client-publications/${publicationId}/submit`).send({ approverUserId: "other-user" }).expect(422);
    expect(errorCode(notRegistered.body)).toBe("approver_not_registered");
    const submitted = await http.post(`/api/client-publications/${publicationId}/submit`).send({ approverUserId: "approver-user" }).expect(200);
    expect(submitted.body).toMatchObject({ status: "pending_approval", version: 1, approverUserId: "approver-user" });
    expect(submitted.body.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(submitted.body).not.toHaveProperty("acceptanceTokenHash");

    // Not the board user who sent it, not another person, not an agent: only the named approver.
    await http.post(`/api/client-publications/${publicationId}/approve`).expect(403);
    await someoneElse.post(`/api/client-publications/${publicationId}/approve`).expect(403);
    await agentHttp.post(`/api/client-publications/${publicationId}/approve`).expect(403);
    await http.post(`/api/client-publications/${publicationId}/publish`).expect(409);
    const approved = await approver.post(`/api/client-publications/${publicationId}/approve`).expect(200);
    expect(approved.body).toMatchObject({ status: "approved", approvedByUserId: "approver-user", approvedFingerprint: submitted.body.fingerprint });

    // The NDA gate and the engagement acceptance come first.
    const ndaBlocked = await http.post(`/api/client-publications/${publicationId}/publish`).expect(409);
    expect(errorCode(ndaBlocked.body)).toBe("nda_required");
    await http.put(`/api/cases/${caseId}/nda`).send({ status: "accepted" }).expect(200);
    const engagementBlocked = await http.post(`/api/client-publications/${publicationId}/publish`).expect(409);
    expect(errorCode(engagementBlocked.body)).toBe("engagement_not_accepted");
    await http.put(`/api/cases/${caseId}/engagement`).send({ status: "accepted" }).expect(200);

    // Agents never publish.
    await agentHttp.post(`/api/client-publications/${publicationId}/publish`).expect(403);
    const published = await http.post(`/api/client-publications/${publicationId}/publish`).expect(200);
    expect(published.body).toMatchObject({ status: "published", publishedFingerprint: submitted.body.fingerprint });

    // The client's link, shown once.
    const link = await http.post(`/api/client-publications/${publicationId}/acceptance-link`).expect(201);
    expect(link.body.url).toMatch(/^https:\/\/gsam\.example\.com\/deliverable\/gsa_deliver_/);
    const token = decodeURIComponent(link.body.path.replace("/deliverable/", ""));
    const client = request(app(anonymous));
    const view = await client.get(`/api/client-deliverable/${token}`).expect(200);
    expect(view.body).toMatchObject({
      companyName: "Greatstone",
      clientName: "Northwind Logistics",
      title: "North Star summary",
      version: 1,
      status: "open",
      contentPath: `/api/client-deliverable/${token}/content`,
    });
    expect(view.headers["cache-control"]).toBe("no-store");
    const file = await client.get(`/api/client-deliverable/${token}/content`).expect(200);
    expect(file.text).toBe("<h1>North Star</h1>");
    expect(file.headers["content-security-policy"]).toContain("sandbox");

    await client.post(`/api/client-deliverable/${token}/accept`).send({ name: "Ada Mensah", email: "ada@example.com" }).expect(400);
    const accepted = await client
      .post(`/api/client-deliverable/${token}/accept`)
      .send({ name: "Ada Mensah", role: "Chief Executive", email: "ada@example.com", agree: true })
      .expect(200);
    expect(accepted.body).toMatchObject({ status: "accepted", acceptedName: "Ada Mensah" });
    await client.post(`/api/client-deliverable/${token}/accept`).send({ name: "Ada Mensah", email: "ada@example.com", agree: true }).expect(409);

    // The receipt went to the person who accepted, naming the published content.
    expect(receipts.sent).toEqual([
      expect.objectContaining({
        companyId: company.id,
        receipt: expect.objectContaining({
          to: "ada@example.com",
          recipientName: "Ada Mensah",
          deliverableTitle: "North Star summary",
          fingerprint: submitted.body.fingerprint,
          idempotencyKey: `client-receipt-${publicationId}`,
        }),
      }),
    ]);

    const list = await http.get(`/api/cases/${caseId}/publications`).expect(200);
    const [publication] = list.body.publications;
    expect(list.body.gates).toEqual([]);
    expect(list.body.approvers.map((row: { userId: string }) => row.userId)).toEqual(["approver-user"]);
    expect(publication).toMatchObject({
      status: "accepted",
      acceptedEmail: "ada@example.com",
      receipt: { status: "sent", error: null },
    });
    expect(publication.events.map((event: { action: string }) => event.action)).toEqual([
      "created",
      "submitted",
      "approved",
      "published",
      "acceptance_link_created",
      "accepted",
      "receipt_sent",
    ]);
    expect(JSON.stringify(list.body)).not.toContain("acceptanceTokenHash");
  });

  it("refuses to approve or publish content whose fingerprint changed, and freezes the version on submit", async () => {
    const { company, caseId, deliverable, http, publicationId } = await ready();
    await clearGates(caseId);
    const approver = request(app(person("approver-user", company.id)));
    await http.post(`/api/client-publications/${publicationId}/submit`).send({ approverUserId: "approver-user" }).expect(200);

    // A newer version does not change what is waiting for approval.
    await deliverable.addVersion(2, "<h1>North Star v2</h1>");
    let list = await http.get(`/api/cases/${caseId}/publications`).expect(200);
    expect(list.body.publications[0]).toMatchObject({ version: 1, latestVersion: 2 });

    // The frozen file's bytes are swapped underneath: approval is refused.
    const original = deliverable.first.asset.sha256;
    await db.update(assets).set({ sha256: "f".repeat(64) }).where(eq(assets.id, deliverable.first.asset.id));
    const changed = await approver.post(`/api/client-publications/${publicationId}/approve`).expect(409);
    expect(errorCode(changed.body)).toBe("fingerprint_mismatch");

    // Put it back, approve, then swap again: publishing is refused.
    await db.update(assets).set({ sha256: original }).where(eq(assets.id, deliverable.first.asset.id));
    await approver.post(`/api/client-publications/${publicationId}/approve`).expect(200);
    await db.update(assets).set({ sha256: "e".repeat(64) }).where(eq(assets.id, deliverable.first.asset.id));
    const stale = await http.post(`/api/client-publications/${publicationId}/publish`).expect(409);
    expect(errorCode(stale.body)).toBe("fingerprint_mismatch");

    // Sent back by the approver, it is a draft again and takes the newest version on the next submit.
    await approver.post(`/api/client-publications/${publicationId}/reject`).send({ reason: "Use version 2" }).expect(200);
    const resubmitted = await http.post(`/api/client-publications/${publicationId}/submit`).send({ approverUserId: "approver-user" }).expect(200);
    expect(resubmitted.body).toMatchObject({ status: "pending_approval", version: 2, rejectedReason: null });
    list = await http.get(`/api/cases/${caseId}/publications`).expect(200);
    expect(list.body.publications[0].events.map((event: { action: string }) => event.action)).toEqual([
      "created",
      "submitted",
      "approved",
      "rejected",
      "submitted",
    ]);
  });

  it("has the database refuse a publication that skips approval or publishes other content", async () => {
    const { company, caseId, http, publicationId } = await ready();
    await clearGates(caseId);
    await http.post(`/api/client-publications/${publicationId}/submit`).send({ approverUserId: "approver-user" }).expect(200);

    // Straight to published, with no approval.
    await expect(db.update(clientDeliverablePublications)
      .set({ status: "published", publishedAt: new Date(), publishedFingerprint: "x" })
      .where(eq(clientDeliverablePublications.id, publicationId))).rejects.toThrow();
    // Approved by someone who is not the named approver.
    const [row] = await db.select().from(clientDeliverablePublications).where(eq(clientDeliverablePublications.id, publicationId));
    await expect(db.update(clientDeliverablePublications)
      .set({ status: "approved", approvedByUserId: "board-user", approvedFingerprint: row!.fingerprint })
      .where(eq(clientDeliverablePublications.id, publicationId))).rejects.toThrow();

    // Approved properly, then published with a different fingerprint.
    await request(app(person("approver-user", company.id))).post(`/api/client-publications/${publicationId}/approve`).expect(200);
    await expect(db.update(clientDeliverablePublications)
      .set({ status: "published", publishedAt: new Date(), publishedFingerprint: "0".repeat(64) })
      .where(eq(clientDeliverablePublications.id, publicationId))).rejects.toThrow();

    // Once published, what was approved cannot be swapped, and the row cannot be deleted.
    await http.post(`/api/client-publications/${publicationId}/publish`).expect(200);
    await expect(db.update(clientDeliverablePublications)
      .set({ fingerprint: "1".repeat(64), approvedFingerprint: "1".repeat(64), publishedFingerprint: "1".repeat(64) })
      .where(eq(clientDeliverablePublications.id, publicationId))).rejects.toThrow();
    await expect(db.delete(clientDeliverablePublications).where(eq(clientDeliverablePublications.id, publicationId))).rejects.toThrow();
  });

  it("keeps the audit append-only: no update, no delete, until the client itself is deleted", async () => {
    const { caseId, http, publicationId } = await ready();
    await http.post(`/api/client-publications/${publicationId}/submit`).send({ approverUserId: "approver-user" }).expect(200);
    const events = await db.select().from(clientDeliverablePublicationEvents)
      .where(eq(clientDeliverablePublicationEvents.publicationId, publicationId));
    expect(events.map((event) => event.action)).toEqual(["created", "submitted"]);

    expect(await refusal(db.update(clientDeliverablePublicationEvents)
      .set({ action: "approved" })
      .where(eq(clientDeliverablePublicationEvents.id, events[1]!.id)))).toMatch(/append-only/);
    expect(await refusal(db.delete(clientDeliverablePublicationEvents)
      .where(eq(clientDeliverablePublicationEvents.id, events[0]!.id)))).toMatch(/append-only/);
    expect(await refusal(db.execute(sql`UPDATE "client_deliverable_publication_events" SET detail = '{}'::jsonb`))).toMatch(/append-only/);
    expect(await refusal(db.execute(sql`DELETE FROM "client_deliverable_publication_events"`))).toMatch(/append-only/);
    expect(await db.select().from(clientDeliverablePublicationEvents)
      .where(eq(clientDeliverablePublicationEvents.publicationId, publicationId))).toHaveLength(2);

    // Nor can the publication be deleted to take its audit with it.
    expect(await refusal(db.delete(clientDeliverablePublications)
      .where(eq(clientDeliverablePublications.id, publicationId)))).toMatch(/withdrawn, not deleted/);

    // Deleting the client removes its publications and their audit together.
    await db.delete(pipelineCases).where(eq(pipelineCases.id, caseId));
    expect(await db.select().from(clientDeliverablePublicationEvents)).toHaveLength(0);
    expect(await db.select().from(clientDeliverablePublications)).toHaveLength(0);
  });

  it("records a receipt that could not be sent, and sends it again when asked", async () => {
    receipts = fakeReceipts(() => ({ status: "not_configured", error: "No sending key" }), false);
    const { company, caseId, http, publicationId } = await ready();
    await clearGates(caseId);
    await http.post(`/api/client-publications/${publicationId}/submit`).send({ approverUserId: "approver-user" }).expect(200);
    await request(app(person("approver-user", company.id))).post(`/api/client-publications/${publicationId}/approve`).expect(200);
    await http.post(`/api/client-publications/${publicationId}/publish`).expect(200);
    const link = await http.post(`/api/client-publications/${publicationId}/acceptance-link`).expect(201);
    const token = decodeURIComponent(link.body.path.replace("/deliverable/", ""));
    await request(app(anonymous))
      .post(`/api/client-deliverable/${token}/accept`)
      .send({ name: "Ada Mensah", email: "ada@example.com", agree: true })
      .expect(200);

    let list = await http.get(`/api/cases/${caseId}/publications`).expect(200);
    expect(list.body.receiptSenderConfigured).toBe(false);
    expect(list.body.publications[0]).toMatchObject({ status: "accepted", receipt: { status: "not_configured", error: "No sending key" } });

    // The sending key is set now: resend.
    let next: ClientReceiptOutcome = { status: "sent", messageId: "msg-2" };
    receipts.sender.send = async (companyId, receipt) => {
      receipts.sent.push({ companyId, receipt });
      return next;
    };
    const resent = await http.post(`/api/client-publications/${publicationId}/receipt`).expect(200);
    expect(resent.body).toEqual({ status: "sent", messageId: "msg-2" });
    next = { status: "sent", messageId: "msg-3" };
    await http.post(`/api/client-publications/${publicationId}/receipt`).expect(409);
    list = await http.get(`/api/cases/${caseId}/publications`).expect(200);
    expect(list.body.publications[0].receipt.status).toBe("sent");
    expect(list.body.publications[0].events.map((event: { action: string }) => event.action).slice(-2))
      .toEqual(["receipt_not_configured", "receipt_sent"]);
  });

  it("keeps another company out, and stops the client's link once withdrawn", async () => {
    const { caseId, http, publicationId, company } = await ready();
    const other = await seedCompany("Other");
    const outsider = request(app(person("approver-user", other.company.id)));
    await outsider.get(`/api/cases/${caseId}/publications`).expect(404);
    await outsider.get(`/api/cases/${caseId}/timeline`).expect(404);
    await outsider.post(`/api/cases/${caseId}/approvers`).send({ userId: "approver-user" }).expect(404);
    await outsider.post(`/api/client-publications/${publicationId}/submit`).send({ approverUserId: "approver-user" }).expect(404);
    await outsider.post(`/api/client-publications/${publicationId}/approve`).expect(404);
    await outsider.post(`/api/client-publications/${publicationId}/publish`).expect(404);

    // An approver must be a member of the company.
    const notMember = await http.post(`/api/cases/${caseId}/approvers`).send({ userId: "stranger" }).expect(422);
    expect(errorCode(notMember.body)).toBe("approver_not_member");

    await clearGates(caseId);
    await http.post(`/api/client-publications/${publicationId}/submit`).send({ approverUserId: "approver-user" }).expect(200);
    await request(app(person("approver-user", company.id))).post(`/api/client-publications/${publicationId}/approve`).expect(200);
    await http.post(`/api/client-publications/${publicationId}/publish`).expect(200);
    const link = await http.post(`/api/client-publications/${publicationId}/acceptance-link`).expect(201);
    const token = decodeURIComponent(link.body.path.replace("/deliverable/", ""));
    await http.post(`/api/client-publications/${publicationId}/withdraw`).send({ reason: "Wrong client" }).expect(200);
    await request(app(anonymous)).get(`/api/client-deliverable/${token}`).expect(404);
    await request(app(anonymous)).get("/api/client-deliverable/gsa_deliver_madeup").expect(404);
    await http.post(`/api/client-publications/${publicationId}/withdraw`).send({ reason: "Again" }).expect(409);
  });

  it("serves the engagement timeline from stored events, with a client-safe view", async () => {
    const { caseId, http, publicationId, company } = await ready();
    await clearGates(caseId);
    const current = await http.get(`/api/cases/${caseId}`).expect(200);
    await http
      .post(`/api/cases/${caseId}/transition`)
      .send({ toStageKey: "deep-dive", expectedVersion: (current.body.case ?? current.body).version, force: true })
      .expect(200);
    await http.post(`/api/client-publications/${publicationId}/submit`).send({ approverUserId: "approver-user" }).expect(200);
    await request(app(person("approver-user", company.id))).post(`/api/client-publications/${publicationId}/approve`).expect(200);
    await http.post(`/api/client-publications/${publicationId}/publish`).expect(200);

    const timeline = await http.get(`/api/cases/${caseId}/timeline`).expect(200);
    expect(timeline.body.stages.map((stage: { name: string; current: boolean }) => [stage.name, stage.current])).toEqual([
      ["Executive Discovery", false],
      ["Deep Dive", true],
    ]);
    expect(timeline.body.milestones.map((milestone: { kind: string }) => milestone.kind)).toEqual([
      "nda_accepted",
      "engagement_sent",
      "engagement_accepted",
      "deliverable_published",
    ]);

    const clientView = await http.get(`/api/cases/${caseId}/timeline?view=client`).expect(200);
    expect(JSON.stringify(clientView.body)).not.toContain("forced");
    expect(JSON.stringify(clientView.body)).not.toContain(publicationId);
  });
});
