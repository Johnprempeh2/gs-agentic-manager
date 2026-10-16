import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  issues,
  organisations,
  outboundWebhookDeliveries,
  outboundWebhooks,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { outboundWebhookRoutes } from "../routes/outbound-webhooks.js";
import {
  isBlockedAddress,
  maskWebhookUrl,
  outboundEventForActivity,
  outboundWebhookService,
  sendOverHttps,
  type OutboundSender,
} from "../services/outbound-webhooks.js";

describe("outbound webhook helpers", () => {
  it("masks the secret part of an address", () => {
    expect(maskWebhookUrl("https://hooks.slack.com/services/T000/B000/abcdWXYZ")).toBe("https://hooks.slack.com/…WXYZ");
  });

  it("blocks private and local addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1", "100.64.0.1"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
  });

  it("refuses plain http and local addresses before sending", async () => {
    expect(await sendOverHttps("http://example.com/hook", "{}", {})).toMatchObject({ ok: false });
    expect(await sendOverHttps("https://127.0.0.1/hook", "{}", {})).toMatchObject({ ok: false, error: expect.stringMatching(/Private/) });
  });

  it("maps activity to events", () => {
    expect(outboundEventForActivity({ action: "issue.created" })).toBe("task.created");
    expect(outboundEventForActivity({ action: "issue.updated", details: { status: "done", _previous: { status: "in_progress" } } })).toBe("task.done");
    expect(outboundEventForActivity({ action: "issue.updated", details: { status: "done", _previous: { status: "done" } } })).toBeNull();
    expect(outboundEventForActivity({ action: "issue.updated", details: { title: "x" } })).toBeNull();
    expect(outboundEventForActivity({ action: "approval.created" })).toBe("decision.needed");
    expect(outboundEventForActivity({ action: "issue.thread_interaction_created", details: { addresseeAgentId: "a" } })).toBeNull();
    expect(outboundEventForActivity({ action: "organisation.updated", details: { status: "client", previousStatus: "prospect" } })).toBe("client.stage_changed");
    expect(outboundEventForActivity({ action: "organisation.updated", details: { fields: ["name"] } })).toBeNull();
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

describeEmbeddedPostgres("outbound webhooks", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const sent: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  let answer: Awaited<ReturnType<OutboundSender>> = { ok: true, httpStatus: 200, error: null };
  const send = vi.fn<OutboundSender>(async (url, body, headers) => {
    sent.push({ url, body, headers });
    return answer;
  });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-outbound-hooks-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    sent.length = 0;
    answer = { ok: true, httpStatus: 200, error: null };
    send.mockClear();
    await db.delete(activityLog);
    await db.delete(outboundWebhookDeliveries);
    await db.delete(outboundWebhooks);
    await db.delete(issues);
    await db.delete(organisations);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const deps = { send, publicBaseUrl: "https://gsam.example.com" };

  function app(actor: Express.Request["actor"]) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", outboundWebhookRoutes(db, deps));
    instance.use(errorHandler);
    return instance;
  }

  async function seed() {
    const prefix = `W${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
    const [company] = await db.insert(companies).values({ name: "Greatstone", issuePrefix: prefix }).returning();
    const board = {
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      companyIds: [company!.id],
      memberships: [],
      isInstanceAdmin: false,
    } as unknown as Express.Request["actor"];
    return { companyId: company!.id, prefix, board };
  }

  it("adds a webhook, masks its address and sends a signed test", async () => {
    const { companyId, board } = await seed();
    const created = await request(app(board))
      .post(`/api/companies/${companyId}/outbound-webhooks`)
      .send({ name: "Slack #ops", url: "https://hooks.slack.com/services/T1/B1/secretABCD", events: ["task.done"] });
    expect(created.status).toBe(201);
    expect(created.body.maskedUrl).toBe("https://hooks.slack.com/…ABCD");
    expect(created.body.signingSecret).toMatch(/^gsam_whsec_/);
    expect(JSON.stringify(created.body)).not.toContain("secretABCD");

    const listed = await request(app(board)).get(`/api/companies/${companyId}/outbound-webhooks`);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].signingSecret).toBeUndefined();
    expect(JSON.stringify(listed.body)).not.toContain("secretABCD");

    const test = await request(app(board)).post(`/api/companies/${companyId}/outbound-webhooks/${created.body.id}/test`);
    expect(test.status).toBe(200);
    expect(test.body).toMatchObject({ event: "test", ok: true, httpStatus: 200 });
    const [call] = sent;
    expect(call!.url).toBe("https://hooks.slack.com/services/T1/B1/secretABCD");
    const payload = JSON.parse(call!.body);
    expect(payload).toMatchObject({ event: "test", text: "Test from GSAM: Slack #ops is connected" });
    const expected = createHmac("sha256", created.body.signingSecret)
      .update(`${call!.headers["x-gsam-timestamp"]}.${call!.body}`)
      .digest("hex");
    expect(call!.headers["x-gsam-signature"]).toBe(`sha256=${expected}`);

    const log = await request(app(board)).get(`/api/companies/${companyId}/outbound-webhooks/${created.body.id}/deliveries`);
    expect(log.body).toHaveLength(1);
  });

  it("sends task done and client stage events only to webhooks that want them, and logs failures", async () => {
    const { companyId, prefix, board } = await seed();
    const wantsDone = await request(app(board))
      .post(`/api/companies/${companyId}/outbound-webhooks`)
      .send({ name: "Zapier", url: "https://hooks.zapier.com/a", events: ["task.done", "client.stage_changed"] });
    await request(app(board))
      .post(`/api/companies/${companyId}/outbound-webhooks`)
      .send({ name: "Only new", url: "https://hooks.zapier.com/b", events: ["task.created"] });
    const off = await request(app(board))
      .post(`/api/companies/${companyId}/outbound-webhooks`)
      .send({ name: "Off", url: "https://hooks.zapier.com/c", events: ["task.done"] });
    await request(app(board)).patch(`/api/companies/${companyId}/outbound-webhooks/${off.body.id}`).send({ enabled: false });

    const [issue] = await db
      .insert(issues)
      .values({ companyId, title: "Send proposal to Kente", status: "done", identifier: `${prefix}-1`, issueNumber: 1 })
      .returning();
    const service = outboundWebhookService(db, deps);
    const deliveries = await service.handleActivity({
      companyId,
      payload: {
        action: "issue.updated",
        entityType: "issue",
        entityId: issue!.id,
        details: { status: "done", _previous: { status: "in_progress" } },
      },
      pluginEvent: null,
    });
    expect(deliveries).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://hooks.zapier.com/a");
    expect(JSON.parse(sent[0]!.body)).toMatchObject({
      event: "task.done",
      text: `Done: ${prefix}-1 Send proposal to Kente`,
      link: `https://gsam.example.com/${prefix}/issues/${prefix}-1`,
      data: { task: { title: "Send proposal to Kente", status: "done" } },
    });

    answer = { ok: false, httpStatus: 410, error: "The address answered 410" };
    const [org] = await db.insert(organisations).values({ companyId, name: "Kente Logistics", status: "client" }).returning();
    await service.handleActivity({
      companyId,
      payload: {
        action: "organisation.updated",
        entityType: "organisation",
        entityId: org!.id,
        details: { status: "client", previousStatus: "prospect" },
      },
      pluginEvent: null,
    });
    expect(JSON.parse(sent[1]!.body)).toMatchObject({
      event: "client.stage_changed",
      text: "Kente Logistics moved from prospect to client",
      data: { client: { stage: "client", previousStage: "prospect" } },
    });
    const [row] = await db.select().from(outboundWebhooks).where(eq(outboundWebhooks.id, wantsDone.body.id));
    expect(row).toMatchObject({ lastDeliveryOk: false, lastError: "The address answered 410" });
  });

  it("refuses http addresses and another company's webhook", async () => {
    const { companyId, board } = await seed();
    const bad = await request(app(board))
      .post(`/api/companies/${companyId}/outbound-webhooks`)
      .send({ name: "Plain", url: "http://example.com/hook", events: ["task.done"] });
    expect(bad.status).toBe(400);

    const other = await seed();
    const created = await request(app(other.board))
      .post(`/api/companies/${other.companyId}/outbound-webhooks`)
      .send({ name: "Theirs", url: "https://example.com/hook", events: ["task.done"] });
    const cross = await request(app(board)).post(`/api/companies/${companyId}/outbound-webhooks/${created.body.id}/test`);
    expect(cross.status).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });
});
