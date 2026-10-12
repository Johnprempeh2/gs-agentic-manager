import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  activityLog,
  agents,
  clientSupportReplies,
  companies,
  companyMemberships,
  createDb,
  fleetSupportAttachments,
  fleetSupportTickets,
  issueAttachments,
  issueComments,
  issues,
  projects,
  supportTickets,
} from "@greatstone/db";
import {
  fleetSupportAttachmentSchema,
  fleetSupportSyncAnswerSchema,
  fleetSupportTicketSchema,
} from "@greatstone/shared/fleet-support";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { clientSupportRoutes } from "../routes/client-support.js";
import { fleetHubRoutes, fleetSpokeRoutes } from "../routes/fleet.js";
import { supportRoutes } from "../routes/support.js";
import { supportQueueService } from "../services/support-queue.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
// The host script's own code: the test proves script, spoke app and hub agree.
import { generateFleetKey, nextSeq, registrationSubject, signFleetMessage } from "../../../scripts/client-instance/fleet.js";
import { runSupportSync, type SupportSyncDeps } from "../../../scripts/client-instance/fleet-support.js";

// GRE-1084: support ticket bridge. Two sandbox instances, each with its own
// database and file store: the Greatstone hub and one client instance (the
// spoke). The round trip runs through the real routes on both sides and the
// host script's sync code in between.

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping fleet support bridge tests: ${support.reason ?? "unsupported environment"}`);

/** Words from the client's own records. They must never reach the hub. */
const PRIVATE_WORDS = "Project Lantern acquisition plan";
const HUB_ADMIN = { type: "board", userId: "hub-admin", source: "session", isInstanceAdmin: true, companyIds: [] as string[] };

describe("support bridge schemas", () => {
  const ticket = { ref: randomUUID(), revision: 1, kind: "support", title: "Export fails", summary: "The CSV export is empty", priority: "P2" };

  it("carries only kind, title, summary and priority; no linked issue, run log or record", () => {
    expect(fleetSupportTicketSchema.safeParse(ticket).success).toBe(true);
    for (const extra of [{ linkedIssueId: randomUUID() }, { runLog: "..." }, { records: [] }, { companyId: randomUUID() }, { from: "a@b.test" }]) {
      expect(fleetSupportTicketSchema.safeParse({ ...ticket, ...extra }).success).toBe(false);
    }
    expect(fleetSupportTicketSchema.safeParse({ ...ticket, kind: "purchase" }).success).toBe(false);
  });

  it("takes only listed file types, with no path in the name", () => {
    const file = { ticketRef: randomUUID(), ref: randomUUID(), name: "screen.png", contentType: "image/png", byteSize: 10, sha256: "a".repeat(64) };
    expect(fleetSupportAttachmentSchema.safeParse(file).success).toBe(true);
    expect(fleetSupportAttachmentSchema.safeParse({ ...file, name: "../../etc/passwd" }).success).toBe(false);
    expect(fleetSupportAttachmentSchema.safeParse({ ...file, contentType: "application/zip" }).success).toBe(false);
    expect(fleetSupportAttachmentSchema.safeParse({ ...file, byteSize: 6 * 1024 * 1024 }).success).toBe(false);
  });

  it("refuses a hub answer with fields the client should not see", () => {
    const state = {
      ref: randomUUID(),
      hubTicketId: "HUB-1",
      revision: 1,
      status: "open",
      priority: "P2",
      category: "general",
      receivedAt: new Date().toISOString(),
      firstResponseDueAt: new Date().toISOString(),
      firstResponseAt: null,
      owner: "Triage",
      replies: [],
    };
    expect(fleetSupportSyncAnswerSchema.safeParse({ at: new Date().toISOString(), refused: [], tickets: [state] }).success).toBe(true);
    expect(fleetSupportSyncAnswerSchema.safeParse({ at: new Date().toISOString(), refused: [], tickets: [{ ...state, internalComments: ["x"] }] }).success).toBe(false);
  });
});

describeEmbeddedPostgres("support bridge round trip with two sandbox instances", () => {
  let hubPg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let spokePg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let hubDb!: ReturnType<typeof createDb>;
  let spokeDb!: ReturnType<typeof createDb>;
  const dirs: string[] = [];
  let hubApp!: express.Express;
  let spokeApp!: express.Express;
  let hubActor: Record<string, unknown> = HUB_ADMIN;
  let spokeActor: Record<string, unknown> = {};
  let hub!: { companyId: string; projectId: string; queueId: string; triageAgentId: string };
  let spoke!: { companyId: string; linkedIssueId: string };

  const operator = { type: "board", userId: "operator", source: "session", isInstanceAdmin: true, companyIds: [] as string[] };
  const clientUser = () => ({
    type: "board",
    userId: "client-board",
    source: "session",
    isInstanceAdmin: false,
    companyIds: [spoke.companyId],
    memberships: [{ companyId: spoke.companyId, status: "active", membershipRole: "owner" }],
  });

  function appWith(getActor: () => Record<string, unknown>, mount: (app: express.Express) => void) {
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    app.use((req, _res, next) => {
      req.actor = getActor() as typeof req.actor;
      next();
    });
    mount(app);
    app.use(errorHandler);
    return app;
  }

  beforeAll(async () => {
    process.env.GSAM_FLEET_HUB = "true";
    hubPg = await startEmbeddedPostgresTestDatabase("paperclip-fleet-support-hub-");
    spokePg = await startEmbeddedPostgresTestDatabase("paperclip-fleet-support-spoke-");
    hubDb = createDb(hubPg.connectionString);
    spokeDb = createDb(spokePg.connectionString);
    const storage = (name: string) => {
      const dir = mkdtempSync(path.join(tmpdir(), `fleet-support-${name}-`));
      dirs.push(dir);
      return createStorageService(createLocalDiskStorageProvider(dir));
    };
    const hubStorage = storage("hub");
    hubApp = appWith(() => hubActor, (app) => {
      app.use(fleetSpokeRoutes(hubDb, { storage: hubStorage }));
      app.use("/api", fleetHubRoutes(hubDb));
      app.use("/api", supportRoutes(hubDb));
    });
    spokeApp = appWith(() => spokeActor, (app) => app.use("/api", clientSupportRoutes(spokeDb, { storage: storage("spoke") })));

    // Hub: Greatstone's support company, queue and triage agent.
    const companyId = randomUUID();
    const triageAgentId = randomUUID();
    const projectId = randomUUID();
    await hubDb.insert(companies).values({ id: companyId, name: "Greatstone", issuePrefix: "HUB" });
    await hubDb.insert(agents).values({ id: triageAgentId, companyId, name: "Triage", role: "general", status: "idle", adapterType: "codex_local" });
    await hubDb.insert(projects).values({ id: projectId, companyId, name: "Client support" });
    await hubDb.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "hub-admin", membershipRole: "owner" });
    const queue = await supportQueueService(hubDb).configureQueue(companyId, { clientCode: "C001", projectId, triageAgentId });
    hub = { companyId, projectId, queueId: queue.id, triageAgentId };
    HUB_ADMIN.companyIds = [companyId];

    // Spoke: the client's company and one of its own issues.
    const spokeCompanyId = randomUUID();
    await spokeDb.insert(companies).values({ id: spokeCompanyId, name: "Client", issuePrefix: "CLI" });
    const linkedIssueId = randomUUID();
    await spokeDb.insert(issues).values({ id: linkedIssueId, companyId: spokeCompanyId, title: PRIVATE_WORDS, description: PRIVATE_WORDS, status: "todo", priority: "medium" });
    spoke = { companyId: spokeCompanyId, linkedIssueId };
  }, 60_000);

  afterAll(async () => {
    delete process.env.GSAM_FLEET_HUB;
    await hubPg?.cleanup();
    await spokePg?.cleanup();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    hubActor = HUB_ADMIN;
    spokeActor = clientUser();
  });

  /** A spoke registered with the hub, and the host script's sync wired to both apps. */
  async function registerSpoke(code: string) {
    hubActor = HUB_ADMIN;
    const created = await request(hubApp).post("/api/fleet/instances").send({ code });
    expect(created.status).toBe(201);
    const key = generateFleetKey();
    let lastSeq = nextSeq(0);
    const proof = signFleetMessage(key.privateJwk, { act: "register", sub: registrationSubject(created.body.registrationCode), seq: lastSeq });
    const registered = await request(hubApp).post("/api/fleet/spoke/register").send({ registrationCode: created.body.registrationCode, publicKey: key.publicKey, proof });
    expect(registered.status).toBe(201);
    const instanceId = registered.body.instanceId as string;
    const sent: string[] = [];
    const deps: SupportSyncDeps = {
      spoke: async (method, route, body) => {
        const saved = spokeActor;
        spokeActor = operator;
        try {
          const res = method === "GET" ? await request(spokeApp).get(route) : await request(spokeApp).post(route).send(body as object);
          return { status: res.status, json: res.body };
        } finally {
          spokeActor = saved;
        }
      },
      hub: async (route, body) => {
        const res = await request(hubApp).post(route).send(body as object);
        return { status: res.status, json: res.body };
      },
      sign: (claims) => {
        lastSeq = nextSeq(lastSeq);
        const message = signFleetMessage(key.privateJwk, { ...claims, sub: instanceId, seq: lastSeq });
        sent.push(message);
        return message;
      },
    };
    let since: string | null = null;
    const sync = async () => {
      const outcome = await runSupportSync(deps, since);
      since = outcome.since ?? since;
      return outcome;
    };
    return { instanceId, key, deps, sync, sent };
  }

  const spokeTickets = async () => (await request(spokeApp).get(`/api/companies/${spoke.companyId}/client-support/tickets`)).body as Array<Record<string, any>>;

  it("files Get help tickets in our queue, sends picked files, and brings status, SLA times and replies back", async () => {
    const a = await registerSpoke("client-a");

    // The client opens three tickets and picks one file.
    const open = (body: object) => request(spokeApp).post(`/api/companies/${spoke.companyId}/client-support/tickets`).send(body);
    const fault = await open({ kind: "support", title: "CSV export is empty", summary: "Since Monday the export has no rows.", priority: "P2", linkedIssueId: spoke.linkedIssueId });
    const upgrade = await open({ kind: "upgrade", title: "Move to Managed plus", summary: "We want the beta features.", priority: "P1" });
    const review = await open({ kind: "quality-review", title: "Review our agent set-up", priority: "P2" });
    expect([fault.status, upgrade.status, review.status]).toEqual([201, 201, 201]);
    // Not a platform fault: never P1.
    expect([upgrade.body.priority, review.body.priority]).toEqual(["P3", "P3"]);
    const file = Buffer.from("row,count\nnone,0\n");
    const attached = await request(spokeApp)
      .post(`/api/companies/${spoke.companyId}/client-support/tickets/${fault.body.id}/attachments`)
      .send({ name: "export.csv", contentType: "text/csv", contentBase64: file.toString("base64") });
    expect(attached.status).toBe(201);

    // 1. The hub has no queue for this instance yet: it refuses, the tickets stay queued.
    const first = await a.sync();
    expect(first.ok).toBe(false);
    expect(first.detail).toContain("support_not_set_up");
    expect((await spokeTickets()).every((t) => t.status === "queued" && t.refusedReason === "support_not_set_up")).toBe(true);
    expect(await hubDb.select().from(fleetSupportTickets)).toHaveLength(0);

    // 2. The hub admin links the queue; the next pass files all three.
    hubActor = HUB_ADMIN;
    expect((await request(hubApp).put(`/api/fleet/instances/${a.instanceId}/support-queue`).send({ supportQueueId: hub.queueId })).status).toBe(200);
    const second = await a.sync();
    expect(second.ok).toBe(true);
    const hubIssues = await hubDb.select().from(issues).where(eq(issues.projectId, hub.projectId));
    expect(hubIssues.map((i) => i.title).sort()).toEqual([
      "[C001] CSV export is empty",
      "[C001] Quality review: Review our agent set-up",
      "[C001] Upgrade request: Move to Managed plus",
    ]);
    const upgradeIssue = hubIssues.find((i) => i.title.includes("Upgrade"))!;
    expect(upgradeIssue.description).toContain("does not approve a purchase or any spend");
    expect(hubIssues.find((i) => i.title.includes("Quality review"))!.description).toContain("Separate from platform support");
    expect(hubIssues.every((i) => i.assigneeAgentId === hub.triageAgentId)).toBe(true);
    const hubTickets = await hubDb.select().from(supportTickets);
    expect(hubTickets.find((t) => t.issueId === upgradeIssue.id)!.priority).toBe("P3");

    let tickets = await spokeTickets();
    const faultView = tickets.find((t) => t.id === fault.body.id)!;
    expect(faultView.status).toBe("open");
    expect(faultView.hubTicketId).toMatch(/^HUB-\d+$/);
    expect(faultView.hubOwner).toBe("Triage");
    expect(faultView.firstResponseDueAt).toBeTruthy();
    expect(faultView.refusedReason).toBeNull();
    expect(faultView.attachments[0].sentAt).toBeNull();

    // 3. Now the hub holds the ticket, the picked file goes.
    const third = await a.sync();
    expect(third.ok).toBe(true);
    const faultIssue = hubIssues.find((i) => i.title.includes("CSV"))!;
    expect(await hubDb.select().from(issueAttachments).where(eq(issueAttachments.issueId, faultIssue.id))).toHaveLength(1);
    expect(await hubDb.select().from(fleetSupportAttachments)).toHaveLength(1);
    expect((await spokeTickets()).find((t) => t.id === fault.body.id)!.attachments[0].sentAt).toBeTruthy();

    // 4. We reply and start work; the next pass brings both back.
    hubActor = HUB_ADMIN;
    const reply = await request(hubApp).post(`/api/issues/${faultIssue.id}/support-ticket/client-reply`).send({ body: "We found the fault. A fix is on the way." });
    expect(reply.status).toBe(201);
    await hubDb.update(issues).set({ status: "in_progress", updatedAt: new Date() }).where(eq(issues.id, faultIssue.id));
    const [stopped] = await hubDb.select().from(supportTickets).where(eq(supportTickets.issueId, faultIssue.id));
    expect(stopped!.firstResponseAt).toBeTruthy();
    expect((await a.sync()).ok).toBe(true);
    tickets = await spokeTickets();
    const after = tickets.find((t) => t.id === fault.body.id)!;
    expect(after.status).toBe("in_progress");
    expect(after.firstResponseAt).toBeTruthy();
    expect(after.replies.map((r: { body: string }) => r.body)).toEqual(["We found the fault. A fix is on the way."]);

    // An internal comment on our side never goes to the client.
    await hubDb.insert(issueComments).values({ companyId: hub.companyId, issueId: faultIssue.id, body: "Internal: customer DB looks odd", authorType: "system" });
    // 5. Again: nothing doubles.
    expect((await a.sync()).ok).toBe(true);
    expect(await spokeDb.select().from(clientSupportReplies)).toHaveLength(1);
    expect(JSON.stringify(await spokeTickets())).not.toContain("Internal:");
    expect(await hubDb.select().from(fleetSupportTickets)).toHaveLength(3);

    // The client edits the words: a new revision, filed as a comment on our ticket.
    const edited = await request(spokeApp).patch(`/api/companies/${spoke.companyId}/client-support/tickets/${fault.body.id}`).send({ summary: "Only the Monday export is empty." });
    expect(edited.body.revision).toBe(2);
    expect((await a.sync()).ok).toBe(true);
    const comments = await hubDb.select().from(issueComments).where(eq(issueComments.issueId, faultIssue.id));
    expect(comments.some((c) => c.body.includes("Client edited the ticket") && c.body.includes("Only the Monday export is empty."))).toBe(true);

    // A title edit keeps the kind in our queue title.
    const reviewIssue = hubIssues.find((i) => i.title.includes("Quality review"))!;
    expect((await request(spokeApp).patch(`/api/companies/${spoke.companyId}/client-support/tickets/${upgrade.body.id}`).send({ title: "Add two seats" })).status).toBe(200);
    expect((await request(spokeApp).patch(`/api/companies/${spoke.companyId}/client-support/tickets/${review.body.id}`).send({ title: "Check our routines" })).status).toBe(200);
    expect((await a.sync()).ok).toBe(true);
    const titleOf = async (id: string) => (await hubDb.select().from(issues).where(eq(issues.id, id)))[0]!.title;
    expect(await titleOf(upgradeIssue.id)).toBe("[C001] Upgrade request: Add two seats");
    expect(await titleOf(reviewIssue.id)).toBe("[C001] Quality review: Check our routines");

    // Triage cannot move an upgrade or quality review to P1 or P2; a platform fault can.
    hubActor = HUB_ADMIN;
    for (const issueId of [upgradeIssue.id, reviewIssue.id]) {
      for (const priority of ["P1", "P2"]) {
        expect((await request(hubApp).post(`/api/issues/${issueId}/support-ticket`).send({ priority })).status).toBe(422);
      }
      expect((await request(hubApp).post(`/api/issues/${issueId}/support-ticket`).send({ priority: "P3", category: "install" })).status).toBe(200);
    }
    const kept = await hubDb.select().from(supportTickets).where(inArray(supportTickets.issueId, [upgradeIssue.id, reviewIssue.id]));
    expect(kept.map((t) => t.priority)).toEqual(["P3", "P3"]);
    expect((await request(hubApp).post(`/api/issues/${faultIssue.id}/support-ticket`).send({ priority: "P1" })).status).toBe(200);

    // Done on our side: the client sees resolved and cannot edit any more.
    await hubDb.update(issues).set({ status: "done", updatedAt: new Date() }).where(eq(issues.id, faultIssue.id));
    expect((await a.sync()).ok).toBe(true);
    expect((await spokeTickets()).find((t) => t.id === fault.body.id)!.status).toBe("resolved");
    expect((await request(spokeApp).patch(`/api/companies/${spoke.companyId}/client-support/tickets/${fault.body.id}`).send({ title: "x" })).status).toBe(409);

    // The hub holds no linked issue, run log or record: the client's own words never left.
    const hubText = JSON.stringify([await hubDb.select().from(issues), await hubDb.select().from(issueComments), await hubDb.select().from(activityLog)]);
    expect(hubText).not.toContain(PRIVATE_WORDS);
    expect(hubText).not.toContain(spoke.linkedIssueId);
    expect(a.sent.join(" ")).not.toContain(spoke.linkedIssueId);

    // Every action is logged on both sides.
    const spokeActions = new Set((await spokeDb.select().from(activityLog)).map((row) => row.action));
    for (const action of ["ticket_created", "attachment_added", "ticket_refused", "ticket_sent", "ticket_updated", "attachment_sent", "reply_received", "ticket_edited"]) {
      expect(spokeActions).toContain(`client_support.${action}`);
    }
    const hubActions = new Set((await hubDb.select().from(activityLog)).map((row) => row.action));
    for (const action of ["queue_linked", "ticket_received", "attachment_received", "reply_sent", "ticket_edited"]) {
      expect(hubActions).toContain(`fleet_support.${action}`);
    }
  }, 60_000);

  it("keeps each instance to its own tickets and refuses a replayed message", async () => {
    const a = await registerSpoke("client-b");
    const other = await registerSpoke("client-c");
    hubActor = HUB_ADMIN;
    for (const id of [a.instanceId, other.instanceId]) {
      expect((await request(hubApp).put(`/api/fleet/instances/${id}/support-queue`).send({ supportQueueId: hub.queueId })).status).toBe(200);
    }
    const ticket = await request(spokeApp)
      .post(`/api/companies/${spoke.companyId}/client-support/tickets`)
      .send({ title: "Login page slow", priority: "P3" });
    expect((await a.sync()).ok).toBe(true);
    const [link] = await hubDb.select().from(fleetSupportTickets).where(and(eq(fleetSupportTickets.fleetInstanceId, a.instanceId), eq(fleetSupportTickets.spokeRef, ticket.body.id)));
    expect(link).toBeTruthy();

    // Another instance asks for everything: it gets none of a's tickets.
    const message = other.deps.sign({ act: "support-sync", support: { tickets: [], since: null } });
    const answer = await request(hubApp).post("/api/fleet/spoke/support-sync").send({ message });
    expect(answer.status).toBe(200);
    expect(answer.body.tickets).toEqual([]);
    // Nor can it send a file into a's ticket.
    const content = Buffer.from("x");
    const sha256 = (await import("node:crypto")).createHash("sha256").update(content).digest("hex");
    const intoA = other.deps.sign({ act: "support-attachment", attachment: { ticketRef: ticket.body.id, ref: randomUUID(), name: "x.txt", contentType: "text/plain", byteSize: 1, sha256 } });
    const refused = await request(hubApp).post("/api/fleet/spoke/support-attachment").send({ message: intoA, content: content.toString("base64") });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("fleet_support_unknown_ticket");

    // The same signed message twice: the second is a replay.
    const again = await request(hubApp).post("/api/fleet/spoke/support-sync").send({ message });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("fleet_replay");

    // A file whose bytes do not match the signed hash is refused.
    const badFile = a.deps.sign({ act: "support-attachment", attachment: { ticketRef: ticket.body.id, ref: randomUUID(), name: "x.txt", contentType: "text/plain", byteSize: 1, sha256 } });
    const bad = await request(hubApp).post("/api/fleet/spoke/support-attachment").send({ message: badFile, content: Buffer.from("y").toString("base64") });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("fleet_support_bad_file");
  }, 60_000);

  it("lets only the client's board users open tickets, and only the operator read the outbox", async () => {
    spokeActor = { type: "agent", agentId: randomUUID(), companyId: spoke.companyId, source: "agent_key" };
    expect((await request(spokeApp).post(`/api/companies/${spoke.companyId}/client-support/tickets`).send({ kind: "upgrade", title: "Buy more" })).status).toBe(403);
    spokeActor = clientUser();
    expect((await request(spokeApp).get("/api/instance/client-support/outbox")).status).toBe(403);
    spokeActor = { ...clientUser(), companyIds: [randomUUID()] };
    expect((await request(spokeApp).get(`/api/companies/${spoke.companyId}/client-support/tickets`)).status).toBe(403);
    spokeActor = clientUser();
    expect(
      (await request(spokeApp).post(`/api/companies/${spoke.companyId}/client-support/tickets`).send({ title: "x", linkedIssueId: randomUUID() })).status,
    ).toBe(422);
    // The hub's reply route is for our side only; a hub user outside our company cannot use it.
    const [anyLink] = await hubDb.select().from(fleetSupportTickets);
    hubActor = { type: "board", userId: "stranger", source: "session", isInstanceAdmin: false, companyIds: [] };
    expect(anyLink).toBeTruthy();
    expect((await request(hubApp).post(`/api/issues/${anyLink!.issueId}/support-ticket/client-reply`).send({ body: "hi" })).status).toBe(404);
  });
});
