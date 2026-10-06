import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  assets,
  companies,
  createDb,
  deliverableComments,
  issueAttachments,
  issueComments,
  issues,
  issueWorkProducts,
} from "@greatstone/db";
import { HTML_ATTACHMENT_CSP } from "@greatstone/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { deliverableRoutes } from "../routes/deliverables.js";
import { injectDeliverableReviewScript } from "../services/deliverable-review-script.js";
import { buildDeliverableCommentsBody } from "../services/deliverable-comments.js";
import type { StorageService } from "../storage/types.js";

// GRE-982: comments on a deliverable version — draft, edit, delete, send.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres deliverable comments tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const otherAgentId = "44444444-4444-4444-8444-444444444444";
const issueId = "66666666-6666-4666-8666-666666666666";
const otherIssueId = "88888888-8888-4888-8888-888888888888";

const files: Record<string, string> = {
  "v1.html": "<html><body><h1>Q3 board pack</h1><p>Revenue grew in Accra.</p><p>Costs fell in Kumasi.</p></body></html>",
  "v2.html": "<html><body><h1>Q3 board pack</h1><p>Revised.</p></body></html>",
  "notes.txt": "plain",
};

function createStorageService(): StorageService {
  return {
    provider: "local_disk",
    putFile: vi.fn(),
    getObject: vi.fn(async (_companyId: string, objectKey: string) => {
      const body = Buffer.from(files[objectKey] ?? "", "utf8");
      return { stream: Readable.from(body), contentType: "text/html", contentLength: body.length };
    }),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  } as unknown as StorageService;
}

describe("deliverable comment helpers", () => {
  it("puts the review script inside the body", () => {
    const html = injectDeliverableReviewScript("<html><body><p>Hi</p></body></html>");
    expect(html).toMatch(/<script data-gsam-review-script>[\s\S]*<\/script><\/body><\/html>$/);
    expect(injectDeliverableReviewScript("<p>No body</p>")).toMatch(/^<p>No body<\/p><script data-gsam-review-script>/);
  });

  it("quotes each passage with its note in one task comment", () => {
    const body = buildDeliverableCommentsBody({
      deliverable: { title: "Q3 board pack", version: 2, key: "q3-board-pack" },
      comments: [
        { quote: "Revenue grew in Accra.", body: "Give the figure." },
        { quote: "Line one\nLine two", body: "Merge these." },
      ],
    });
    expect(body).toContain('**Comments on the deliverable "Q3 board pack" (v2)**');
    expect(body).toContain("**1.**\n> Revenue grew in Accra.\n\nGive the figure.");
    expect(body).toContain("**2.**\n> Line one\n> Line two\n\nMerge these.");
    expect(body).toContain("key `q3-board-pack`");
  });
});

describeEmbeddedPostgres("deliverable comments", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const storage = createStorageService();
  const wakeup = vi.fn(async () => null);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-deliverable-comments-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    wakeup.mockClear();
    await db.delete(deliverableComments);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueWorkProducts);
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function addAttachment(company: string, issue: string, objectKey: string, contentType = "text/html") {
    const assetId = randomUUID();
    const attachmentId = randomUUID();
    await db.insert(assets).values({
      id: assetId,
      companyId: company,
      provider: "local_disk",
      objectKey,
      contentType,
      byteSize: Buffer.byteLength(files[objectKey] ?? "x"),
      sha256: `sha-${assetId}`,
      originalFilename: objectKey,
      createdByAgentId: company === companyId ? agentId : otherAgentId,
    });
    await db.insert(issueAttachments).values({ id: attachmentId, companyId: company, issueId: issue, assetId });
    return attachmentId;
  }

  async function seed(issueStatus = "in_progress") {
    await db.insert(companies).values([
      { id: companyId, name: "Greatstone", issuePrefix: "GRE", requireBoardApprovalForNewAgents: false },
      { id: otherCompanyId, name: "OtherCo", issuePrefix: "OTH", requireBoardApprovalForNewAgents: false },
    ]);
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Everest", role: "engineer" },
      { id: otherAgentId, companyId: otherCompanyId, name: "Outsider", role: "engineer" },
    ]);
    await db.insert(issues).values([
      { id: issueId, companyId, identifier: "GRE-1", title: "Quarterly pack", status: issueStatus, priority: "medium", assigneeAgentId: agentId },
      { id: otherIssueId, companyId: otherCompanyId, identifier: "OTH-1", title: "Other", status: "in_progress", priority: "medium", assigneeAgentId: otherAgentId },
    ]);
  }

  function boardApp(userId = "user-1") {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId,
        source: "session",
        isInstanceAdmin: false,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      } as typeof req.actor;
      next();
    });
    app.use("/api", deliverableRoutes(db, storage, { heartbeat: { wakeup } }));
    app.use(errorHandler);
    return app;
  }

  function agentApp(actorAgentId: string, actorCompanyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", agentId: actorAgentId, companyId: actorCompanyId, source: "agent_key" } as typeof req.actor;
      next();
    });
    app.use("/api", deliverableRoutes(db, storage, { heartbeat: { wakeup } }));
    app.use(errorHandler);
    return app;
  }

  async function registerVersion(objectKey: string) {
    const attachmentId = await addAttachment(companyId, issueId, objectKey);
    const res = await request(agentApp(agentId, companyId)).post(`/api/issues/${issueId}/deliverables`).send({
      attachmentId,
      title: "Q3 board pack",
      key: "q3-board-pack",
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  function commentsPath(deliverableId: string) {
    return `/api/companies/${companyId}/deliverables/${deliverableId}/comments`;
  }

  it("drafts, edits, deletes and sends comments as one task comment that wakes the assignee", async () => {
    await seed();
    const deliverableId = await registerVersion("v1.html");
    const board = boardApp();

    const first = await request(board).post(commentsPath(deliverableId)).send({
      quote: "Revenue grew in Accra.",
      prefix: "Q3 board pack ",
      suffix: " Costs fell",
      textStart: 14,
      body: "Give the figure.",
    });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: "draft", quote: "Revenue grew in Accra.", deliverableId, issueId });
    const second = await request(board).post(commentsPath(deliverableId)).send({ quote: "Costs fell in Kumasi.", body: "Why?" });
    const third = await request(board).post(commentsPath(deliverableId)).send({ quote: "Q3 board pack", body: "Drop me" });

    const edited = await request(board).patch(`${commentsPath(deliverableId)}/${second.body.id}`).send({ body: "Say by how much." });
    expect(edited.status).toBe(200);
    expect(edited.body.body).toBe("Say by how much.");
    const removed = await request(board).delete(`${commentsPath(deliverableId)}/${third.body.id}`);
    expect(removed.status).toBe(204);

    const listed = await request(board).get(commentsPath(deliverableId));
    expect(listed.body.comments.map((c: { id: string }) => c.id)).toEqual([first.body.id, second.body.id]);

    const sent = await request(board).post(`${commentsPath(deliverableId)}/send`);
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ agentId, woken: true });
    expect(sent.body.sent.map((c: { status: string }) => c.status)).toEqual(["sent", "sent"]);

    const taskComments = await db.select().from(issueComments);
    expect(taskComments).toHaveLength(1);
    expect(taskComments[0]!.id).toBe(sent.body.commentId);
    expect(taskComments[0]!.authorUserId).toBe("user-1");
    expect(taskComments[0]!.body).toContain("> Revenue grew in Accra.\n\nGive the figure.");
    expect(taskComments[0]!.body).toContain("> Costs fell in Kumasi.\n\nSay by how much.");
    expect(taskComments[0]!.body).not.toContain("Drop me");
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      reason: "issue_commented",
      payload: expect.objectContaining({ issueId, commentId: sent.body.commentId }),
    }));

    // Sent notes are read only, and sending again has nothing to send.
    const lateEdit = await request(board).patch(`${commentsPath(deliverableId)}/${first.body.id}`).send({ body: "Changed" });
    expect(lateEdit.status).toBe(409);
    const lateDelete = await request(board).delete(`${commentsPath(deliverableId)}/${first.body.id}`);
    expect(lateDelete.status).toBe(409);
    const again = await request(board).post(`${commentsPath(deliverableId)}/send`);
    expect(again.status).toBe(422);
    expect(await db.select().from(issueComments)).toHaveLength(1);

    const afterSend = await request(board).get(commentsPath(deliverableId));
    expect(afterSend.body.comments).toHaveLength(2);
    expect(afterSend.body.comments.every((c: { status: string; sentCommentId: string }) =>
      c.status === "sent" && c.sentCommentId === sent.body.commentId)).toBe(true);
  });

  it("starts a new version with no comments and keeps the old version's", async () => {
    await seed();
    const v1 = await registerVersion("v1.html");
    await request(boardApp()).post(commentsPath(v1)).send({ quote: "Revenue grew in Accra.", body: "Note" });
    await request(boardApp()).post(`${commentsPath(v1)}/send`);
    const v2 = await registerVersion("v2.html");

    expect((await request(boardApp()).get(commentsPath(v2))).body.comments).toEqual([]);
    expect((await request(boardApp()).get(commentsPath(v1))).body.comments).toHaveLength(1);
  });

  it("reopens finished work so the assignee can revise", async () => {
    await seed("done");
    const deliverableId = await registerVersion("v1.html");
    await request(boardApp()).post(commentsPath(deliverableId)).send({ quote: "Q3 board pack", body: "Retitle" });
    const sent = await request(boardApp()).post(`${commentsPath(deliverableId)}/send`);
    expect(sent.status).toBe(201);
    const [issue] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    expect(issue!.status).toBe("todo");
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("keeps drafts private to their author", async () => {
    await seed();
    const deliverableId = await registerVersion("v1.html");
    const mine = await request(boardApp("user-1")).post(commentsPath(deliverableId)).send({ quote: "Q3 board pack", body: "Mine" });

    const otherUser = boardApp("user-2");
    expect((await request(otherUser).get(commentsPath(deliverableId))).body.comments).toEqual([]);
    expect((await request(otherUser).patch(`${commentsPath(deliverableId)}/${mine.body.id}`).send({ body: "Theirs" })).status).toBe(404);
    expect((await request(otherUser).delete(`${commentsPath(deliverableId)}/${mine.body.id}`)).status).toBe(404);
    expect((await request(otherUser).post(`${commentsPath(deliverableId)}/send`)).status).toBe(422);
    // Agents read sent notes only.
    expect((await request(agentApp(agentId, companyId)).get(commentsPath(deliverableId))).body.comments).toEqual([]);
  });

  it("lets agents read but not write, and keeps other companies out", async () => {
    await seed();
    const deliverableId = await registerVersion("v1.html");
    const agent = agentApp(agentId, companyId);
    expect((await request(agent).post(commentsPath(deliverableId)).send({ quote: "Q3", body: "x" })).status).toBe(403);
    expect((await request(agent).post(`${commentsPath(deliverableId)}/send`)).status).toBe(403);
    expect((await request(agent).get(commentsPath(deliverableId))).status).toBe(200);

    const outsider = agentApp(otherAgentId, otherCompanyId);
    expect((await request(outsider).get(commentsPath(deliverableId))).status).toBe(403);
    expect((await request(outsider).post(commentsPath(deliverableId)).send({ quote: "Q3", body: "x" })).status).toBe(403);
    expect((await request(outsider).get(`/api/companies/${companyId}/deliverables/${deliverableId}/review-content`)).status).toBe(403);

    // A deliverable id from another company is not found under this company.
    const otherAttachment = await addAttachment(otherCompanyId, otherIssueId, "v2.html");
    const other = await request(agentApp(otherAgentId, otherCompanyId)).post(`/api/issues/${otherIssueId}/deliverables`).send({
      attachmentId: otherAttachment,
      title: "Other",
    });
    expect((await request(boardApp()).get(commentsPath(other.body.id))).status).toBe(404);
    expect((await request(boardApp()).post(commentsPath(other.body.id)).send({ quote: "Q3", body: "x" })).status).toBe(404);
  });

  it("validates the note and the quote", async () => {
    await seed();
    const deliverableId = await registerVersion("v1.html");
    expect((await request(boardApp()).post(commentsPath(deliverableId)).send({ quote: " ", body: "x" })).status).toBe(400);
    expect((await request(boardApp()).post(commentsPath(deliverableId)).send({ quote: "Q3", body: "" })).status).toBe(400);
  });

  it("serves the HTML with the review script under the attachment sandbox", async () => {
    await seed();
    const deliverableId = await registerVersion("v1.html");
    const res = await request(boardApp()).get(`/api/companies/${companyId}/deliverables/${deliverableId}/review-content`);
    expect(res.status).toBe(200);
    expect(res.headers["content-security-policy"]).toBe(HTML_ATTACHMENT_CSP);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
    expect(res.text).toContain("<p>Revenue grew in Accra.</p>");
    expect(res.text).toContain("data-gsam-review-script");

    const textAttachment = await addAttachment(companyId, issueId, "notes.txt", "text/plain");
    const textDeliverable = await request(agentApp(agentId, companyId)).post(`/api/issues/${issueId}/deliverables`).send({
      attachmentId: textAttachment,
      title: "Notes",
    });
    const refused = await request(boardApp()).get(`/api/companies/${companyId}/deliverables/${textDeliverable.body.id}/review-content`);
    expect(refused.status).toBe(422);
  });
});
