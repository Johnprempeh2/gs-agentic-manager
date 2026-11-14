import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues } from "@greatstone/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { deliverableService } from "../services/deliverables.js";
import { getLiveDesign, replyLiveDesign, resetLiveDesignSessions } from "../services/live-design.js";

// GRE-5369: John kept a version in the live editor and it was never saved. Accept now saves through
// GSAM itself: one Accept makes exactly one new version of the deliverable, within moments, or says why not.

const wakeup = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../services/heartbeat.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/heartbeat.js")>()),
  heartbeatService: () => ({ wakeup, getRun: async () => null, getActiveRunForAgent: async () => null, reportRunActivity: async () => undefined }),
}));

const PAGE = `<!doctype html><html><head><title>Overnight GSAM quality review</title></head><body>
<header><h1 class="title">Overnight review</h1></header>
<section><p>Three findings.</p></section>
</body></html>`;
const PICKED = `<h1 class="title">Overnight review</h1>`;
const KEPT = { name: "Calm", html: `<h1 class="lv-calm">Overnight quality review</h1>`, css: ".lv-calm{font-weight:500}" };

describe("live design Accept saves the deliverable's next version", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  let app: express.Express;
  let companyId: string;
  let issueId: string;
  let fixture = 0;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("live-design-accept-");
    db = createDb(temporary.connectionString);
    root = await mkdtemp(path.join(tmpdir(), "live-design-accept-"));
    storage = createStorageService(createLocalDiskStorageProvider(path.join(root, "storage")));
  }, 90_000);
  afterAll(async () => {
    await temporary?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });
  afterEach(() => {
    resetLiveDesignSessions();
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    companyId = randomUUID();
    issueId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Accept fixture", issuePrefix: `ACC${++fixture}`, issueCounter: 1 });
    await db.insert(agents).values({ id: agentId, companyId, name: "Designer", adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Overnight GSAM quality review", issueNumber: 1, identifier: `ACC${fixture}-1`, status: "in_progress", assigneeAgentId: agentId });
    app = express();
    app.use(express.json({ limit: "10mb" }));
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "john", source: "local_implicit", companyIds: [companyId], isInstanceAdmin: false };
      next();
    });
    app.use("/api", issueRoutes(db, storage));
    app.use(errorHandler);
  });

  /** A deliverable at version 1, opened in the live editor, with one version from the agent waiting. */
  async function openWithOneVersion(open: "deliverable" | "file") {
    const upload = await request(app)
      .post(`/api/companies/${companyId}/issues/${issueId}/attachments`)
      .attach("file", Buffer.from(PAGE), { filename: "review.html", contentType: "text/html" });
    expect(upload.status).toBe(201);
    const deliverables = deliverableService(db, storage);
    const attachment = await deliverables.getAttachment(companyId, upload.body.id);
    const first = await deliverables.register({
      issue: { id: issueId, companyId, projectId: null },
      attachment: attachment!,
      fields: { key: "overnight-review", title: "Overnight GSAM quality review", status: "draft" },
      createdByAgentId: null,
      createdByRunId: null,
    });
    const started = await request(app)
      .post(`/api/attachments/${upload.body.id}/live`)
      .send(open === "deliverable" ? { deliverableId: first.id } : {});
    expect(started.status).toBe(200);
    const sessionId = started.body.id as string;
    const go = await request(app).post(`/api/live-design/${sessionId}/helper`).send({
      method: "POST",
      path: "/events",
      body: JSON.stringify({ type: "generate", id: "req1", element: { tagName: "h1", outerHTML: PICKED, textContent: "Overnight review" }, freeformPrompt: "Calmer heading" }),
      extra: { selector: "header:nth-of-type(1) > h1:nth-of-type(1)" },
    });
    expect(go.body.status).toBe(200);
    // The agent answers with one version (its reply route is covered elsewhere; this is the same call).
    expect(replyLiveDesign(getLiveDesign(sessionId)!, { requestId: "req1", variants: [KEPT] } as never)).toEqual({ ok: true });
    return { sessionId, deliverableId: first.id, deliverables };
  }

  const accept = (sessionId: string) =>
    request(app).post(`/api/live-design/${sessionId}/helper`).send({ method: "POST", path: "/events", body: JSON.stringify({ type: "accept", id: "req1", variantId: "1" }) });

  it("one Accept makes exactly one new version, with the kept version in it, in moments and with no agent", async () => {
    const { sessionId, deliverableId, deliverables } = await openWithOneVersion("deliverable");
    const startedAt = Date.now();
    const res = await accept(sessionId);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(200);
    expect(JSON.parse(res.body.body)).toMatchObject({ ok: true, saved: true });

    const detail = await deliverables.getDetail(companyId, deliverableId);
    expect(detail!.versions.map((v) => v.version)).toEqual([2, 1]);
    const newest = await storage.getObject(companyId, (await deliverables.getAttachment(companyId, detail!.versions[0]!.attachmentId!))!.objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of newest.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString("utf8")).toContain(KEPT.html);

    // The editor shows the saved version straight away.
    const view = await request(app).get(`/api/live-design/${sessionId}`);
    expect(view.body).toMatchObject({ attachmentId: detail!.versions[0]!.attachmentId, variants: [], request: null });
    expect(view.body.messages.at(-1).text).toBe("Kept version 1 (Calm). Saved as a new version of the file.");

    // A second Accept of the same versions makes nothing more.
    expect((await accept(sessionId)).body.status).toBe(409);
    expect((await deliverables.getDetail(companyId, deliverableId))!.versions).toHaveLength(2);
  });

  it("opened from the task's files, the Accept still becomes the deliverable's next version", async () => {
    const { sessionId, deliverableId, deliverables } = await openWithOneVersion("file");
    expect((await accept(sessionId)).body.status).toBe(200);
    expect((await deliverables.getDetail(companyId, deliverableId))!.versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it("a save that fails is an error on the page and in the chat, never a silent ready, and makes no version", async () => {
    const { sessionId, deliverableId, deliverables } = await openWithOneVersion("deliverable");
    vi.spyOn(storage, "putFile").mockRejectedValueOnce(new Error("disk full"));
    const res = await accept(sessionId);
    expect(res.body.status).toBe(500);
    expect(JSON.parse(res.body.body).error).toBe("Not saved: the page could not be saved");
    expect((await deliverables.getDetail(companyId, deliverableId))!.versions).toHaveLength(1);
    const view = await request(app).get(`/api/live-design/${sessionId}`);
    expect(view.body.status).toBe("ready");
    expect(view.body.messages.at(-1).text).toContain("Not saved");
    // John can press Accept again once the problem is gone.
    expect((await accept(sessionId)).body.status).toBe(200);
    expect((await deliverables.getDetail(companyId, deliverableId))!.versions).toHaveLength(2);
  });
});
