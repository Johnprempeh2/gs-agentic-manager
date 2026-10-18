import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  assets,
  agents,
  companies,
  companyMemberships,
  createDb,
  inboundTaskHooks,
  issueAttachments,
  issues,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { inboundTaskHookRoutes } from "../routes/inbound-task-hooks.js";
import { tokenFromHeaders } from "../services/inbound-task-hooks.js";
import type { StorageService } from "../storage/types.js";

describe("tokenFromHeaders", () => {
  it("reads a bearer token or the X-GSAM-Token header", () => {
    expect(tokenFromHeaders("Bearer abc", undefined)).toBe("abc");
    expect(tokenFromHeaders(undefined, " xyz ")).toBe("xyz");
    expect(tokenFromHeaders("Basic abc", undefined)).toBeNull();
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

describeEmbeddedPostgres("inbound task webhooks", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const stored: Array<{ namespace: string; body: Buffer }> = [];
  const storage = {
    putFile: vi.fn(async (input: { namespace: string; body: Buffer; contentType: string; originalFilename: string | null }) => {
      stored.push({ namespace: input.namespace, body: input.body });
      return {
        provider: "local_disk",
        objectKey: `${input.namespace}/${randomUUID()}`,
        contentType: input.contentType,
        byteSize: input.body.length,
        sha256: "0".repeat(64),
        originalFilename: input.originalFilename,
      };
    }),
  } as unknown as StorageService;
  const wakeup = vi.fn(async () => undefined);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-inbound-hooks-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    stored.length = 0;
    wakeup.mockClear();
    await db.delete(activityLog);
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(issues);
    await db.delete(inboundTaskHooks);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: Express.Request["actor"]) {
    const instance = express();
    instance.use(express.json({ limit: "10mb" }));
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", inboundTaskHookRoutes(db, { storage, heartbeat: { wakeup } }));
    instance.use(errorHandler);
    return instance;
  }

  async function seed() {
    const [company] = await db
      .insert(companies)
      .values({ name: "Greatstone", issuePrefix: `H${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}` })
      .returning();
    const board = {
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      companyIds: [company!.id],
      memberships: [],
      isInstanceAdmin: false,
    } as unknown as Express.Request["actor"];
    return { companyId: company!.id, board };
  }

  const none = { type: "none", source: "none" } as Express.Request["actor"];

  it("creates a task with files from an outside tool, and a repeat with the same id does nothing new", async () => {
    const { companyId, board } = await seed();
    const created = await request(app(board))
      .post(`/api/companies/${companyId}/inbound-task-hooks`)
      .send({ name: "Website form" });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^gsam_ith_/);
    expect(created.body.path).toMatch(/^\/api\/inbound\/tasks\/ith_[a-f0-9]{24}$/);

    const body = {
      title: "New enquiry from Kente Logistics",
      description: "Wants a fleet audit.",
      priority: "high",
      externalId: "form-17",
      files: [{ name: "brief.txt", contentType: "text/plain", data: Buffer.from("hello").toString("base64") }],
    };
    const first = await request(app(none))
      .post(created.body.path)
      .set("Authorization", `Bearer ${created.body.token}`)
      .send(body);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ attachments: 1, duplicate: false });
    expect(stored[0]!.body.toString()).toBe("hello");

    const [task] = await db.select().from(issues).where(eq(issues.id, first.body.taskId));
    expect(task).toMatchObject({ title: body.title, priority: "high", status: "todo", assigneeAgentId: null, originKind: "inbound_webhook" });
    // Unassigned: nothing wakes.
    expect(wakeup).not.toHaveBeenCalled();

    const again = await request(app(none)).post(created.body.path).set("Authorization", `Bearer ${created.body.token}`).send(body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ taskId: first.body.taskId, duplicate: true });

    const [hook] = await db.select().from(inboundTaskHooks).where(eq(inboundTaskHooks.companyId, companyId));
    expect(hook!.useCount).toBe(1);
    expect(hook!.tokenHash).not.toContain(created.body.token);
  });

  it("refuses a wrong token, a turned-off hook and a rotated token", async () => {
    const { companyId, board } = await seed();
    const created = await request(app(board)).post(`/api/companies/${companyId}/inbound-task-hooks`).send({ name: "Zapier" });
    const send = (token: string) =>
      request(app(none)).post(created.body.path).set("Authorization", `Bearer ${token}`).send({ title: "Hi" });

    expect((await send("wrong")).status).toBe(401);
    expect((await request(app(none)).post("/api/inbound/tasks/ith_000000000000000000000000").send({ title: "Hi" })).status).toBe(401);

    await request(app(board)).patch(`/api/companies/${companyId}/inbound-task-hooks/${created.body.id}`).send({ enabled: false }).expect(200);
    expect((await send(created.body.token)).status).toBe(403);
    await request(app(board)).patch(`/api/companies/${companyId}/inbound-task-hooks/${created.body.id}`).send({ enabled: true }).expect(200);

    const rotated = await request(app(board)).post(`/api/companies/${companyId}/inbound-task-hooks/${created.body.id}/rotate`);
    expect((await send(created.body.token)).status).toBe(401);
    expect((await send(rotated.body.token)).status).toBe(201);

    const bad = await request(app(none))
      .post(created.body.path)
      .set("Authorization", `Bearer ${rotated.body.token}`)
      .send({ title: "With a bad file", files: [{ name: "x.txt", data: "%%%" }] });
    expect(bad.status).toBe(422);
    const list = await request(app(board)).get(`/api/companies/${companyId}/inbound-task-hooks`);
    expect(list.body[0]).toMatchObject({ useCount: 1, lastError: expect.stringContaining("x.txt") });

    await request(app(board)).delete(`/api/companies/${companyId}/inbound-task-hooks/${created.body.id}`).expect(200);
    expect((await send(rotated.body.token)).status).toBe(401);
  });

  it("assigns to the chosen agent and wakes it", async () => {
    const { companyId, board } = await seed();
    const [agent] = await db.insert(agents).values({ companyId, name: "Ops", role: "general", adapterType: "process" }).returning();
    const created = await request(app(board))
      .post(`/api/companies/${companyId}/inbound-task-hooks`)
      .send({ name: "CRM", assigneeAgentId: agent!.id });
    const res = await request(app(none)).post(created.body.path).set("Authorization", `Bearer ${created.body.token}`).send({ title: "Follow up" });
    expect(res.status).toBe(201);
    const [task] = await db.select().from(issues).where(eq(issues.id, res.body.taskId));
    expect(task!.assigneeAgentId).toBe(agent!.id);
    expect(wakeup).toHaveBeenCalledWith(agent!.id, expect.objectContaining({ reason: "issue_assigned" }));
  });
});
