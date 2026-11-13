import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  assets,
  companies,
  createDb,
  deliverableComments,
  issueAttachments,
  issues,
  issueWorkProducts,
  pipelineCaseIssueLinks,
  pipelineCaseProjectLinks,
  pipelineCases,
  pipelines,
  pipelineStages,
  projects,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { deliverableRoutes } from "../routes/deliverables.js";
import { deliverableStage } from "../services/deliverables.js";
import type { StorageService } from "../storage/types.js";

// The project Deliverables tab (Ben, 10 Nov): a project's deliverables only,
// releases newest first with who and the review note, and moving a
// deliverable to another project (people only, logged).

describe("deliverableStage", () => {
  it("reads Draft, In review, Approved and Delivered from what exists", () => {
    expect(deliverableStage({ status: "draft", issueStatus: "in_progress", publicationStatus: null })).toBe("draft");
    expect(deliverableStage({ status: "final", issueStatus: "in_progress", publicationStatus: null })).toBe("in_review");
    expect(deliverableStage({ status: "final", issueStatus: "done", publicationStatus: null })).toBe("delivered");
    expect(deliverableStage({ status: "final", issueStatus: "in_progress", publicationStatus: "pending_approval" })).toBe("in_review");
    expect(deliverableStage({ status: "draft", issueStatus: "in_progress", publicationStatus: "approved" })).toBe("approved");
    expect(deliverableStage({ status: "final", issueStatus: "todo", publicationStatus: "published" })).toBe("delivered");
    expect(deliverableStage({ status: "final", issueStatus: "todo", publicationStatus: "accepted" })).toBe("delivered");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const companyId = "11111111-1111-4111-8111-111111111111";
const agentId = "33333333-3333-4333-8333-333333333333";
const portalProjectId = "55555555-5555-4555-8555-555555555555";
const websiteProjectId = "77777777-7777-4777-8777-777777777777";
const issueId = "66666666-6666-4666-8666-666666666666";

const storage = {
  provider: "local_disk",
  putFile: vi.fn(),
  getObject: vi.fn(async () => ({ stream: Readable.from(Buffer.from("")), contentType: "text/html", contentLength: 0 })),
  headObject: vi.fn(),
  deleteObject: vi.fn(),
} as unknown as StorageService;

describeEmbeddedPostgres("project deliverables and moving them", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const screenshot = vi.fn(async (): Promise<Buffer | null> => null);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-deliverables-move-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(deliverableComments);
    await db.delete(issueWorkProducts);
    await db.delete(pipelineCaseIssueLinks);
    await db.delete(pipelineCaseProjectLinks);
    await db.delete(pipelineCases);
    await db.delete(pipelineStages);
    await db.delete(pipelines);
    await db.delete(issueAttachments);
    await db.delete(assets);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    await db.insert(companies).values({ id: companyId, name: "Greatstone", issuePrefix: "GRE", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Lintel", role: "engineer" });
    await db.insert(projects).values([
      { id: portalProjectId, companyId, name: "Discovery portal", status: "in_progress" },
      { id: websiteProjectId, companyId, name: "Company website", status: "in_progress" },
    ]);
    // The task sits under the website project: the misfiling Ben found.
    await db.insert(issues).values({
      id: issueId, companyId, projectId: websiteProjectId, identifier: "GRE-9", title: "Portal build", status: "done", priority: "medium", assigneeAgentId: agentId,
    });
    const [pipeline] = await db.insert(pipelines).values({ companyId, key: "clients", name: "Clients" }).returning();
    const [stage] = await db.insert(pipelineStages).values({
      pipelineId: pipeline!.id, key: "active", name: "Active", kind: "working", position: 0,
    }).returning();
    const [clientCase] = await db.insert(pipelineCases).values({
      companyId, pipelineId: pipeline!.id, stageId: stage!.id, caseKey: "example", title: "Example Client",
    }).returning();
    await db.insert(pipelineCaseProjectLinks).values({ companyId, caseId: clientCase!.id, projectId: portalProjectId });
  }

  function appAs(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", deliverableRoutes(db, storage, { screenshot }));
    app.use(errorHandler);
    return app;
  }
  const board = () => appAs({
    type: "board",
    userId: "user-1",
    source: "local_implicit",
    isInstanceAdmin: true,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
  } as Express.Request["actor"]);
  const agent = () => appAs({ type: "agent", agentId, companyId, source: "agent_key" } as Express.Request["actor"]);

  async function release(url: string, summary?: string) {
    const res = await request(board()).post(`/api/issues/${issueId}/deliverables`).send({
      url, title: "Discovery portal", kind: "mockup", confidentiality: "client", ...(summary ? { summary } : {}),
    });
    expect(res.status).toBe(201);
    return res.body as { id: string; version: number };
  }

  const listFor = async (projectId: string) =>
    (await request(board()).get(`/api/companies/${companyId}/deliverables?projectId=${projectId}`)).body.deliverables as Array<{ id: string; title: string; project: { id: string } | null; projectMoved: boolean; stage: string; clientCase: { name: string } | null }>;

  it("lists releases newest first with who and the review note", async () => {
    await seed();
    const r1 = await release("https://example.com/portal-1", "First cut");
    await release("https://example.com/portal-2");
    const r3 = await release("https://example.com/portal-3", "Adds the North Star instrument");
    await db.insert(deliverableComments).values({
      companyId, workProductId: r1.id, issueId, quote: "Overview", body: "The North Star instrument is missing.",
      status: "sent", authorUserId: "user-1", sentAt: new Date(),
    });
    const detail = (await request(board()).get(`/api/companies/${companyId}/deliverables/${r3.id}`)).body;
    expect(detail.versions.map((version: { version: number }) => version.version)).toEqual([3, 2, 1]);
    expect(detail.versions[0]).toMatchObject({ summary: "Adds the North Star instrument", reviewNote: null });
    expect(detail.versions[2]).toMatchObject({ reviewNote: "The North Star instrument is missing.", createdByAgent: null });
    expect(detail.stage).toBe("delivered");
  });

  it("filters by project and moves a deliverable for people only, with an activity row", async () => {
    await seed();
    const created = await release("https://example.com/portal");

    // Filed under the task's project, so invisible under the portal project.
    expect((await listFor(websiteProjectId)).map((item) => item.id)).toEqual([created.id]);
    expect(await listFor(portalProjectId)).toEqual([]);

    // Agents are refused and nothing changes.
    const refused = await request(agent()).post(`/api/companies/${companyId}/deliverables/${created.id}/move`).send({ projectId: portalProjectId });
    expect(refused.status).toBe(403);
    expect((await listFor(websiteProjectId)).map((item) => item.id)).toEqual([created.id]);

    const moved = await request(board()).post(`/api/companies/${companyId}/deliverables/${created.id}/move`).send({ projectId: portalProjectId });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ project: { id: portalProjectId, name: "Discovery portal" }, projectMoved: true, clientCase: { name: "Example Client" } });
    expect(await listFor(websiteProjectId)).toEqual([]);
    expect((await listFor(portalProjectId)).map((item) => item.id)).toEqual([created.id]);

    const [logged] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.deliverable_moved")));
    expect(logged).toMatchObject({ actorType: "user", entityId: issueId });
    expect(logged!.details).toMatchObject({ fromProjectId: websiteProjectId, toProjectId: portalProjectId, toProjectName: "Discovery portal" });

    // The next release stays where the person put it.
    const next = await release("https://example.com/portal-2");
    expect(next).toMatchObject({ version: 2 });
    expect((await listFor(portalProjectId)).map((item) => item.id)).toEqual([next.id]);

    // A project from nowhere is refused.
    const bad = await request(board()).post(`/api/companies/${companyId}/deliverables/${created.id}/move`).send({ projectId: "99999999-9999-4999-8999-999999999999" });
    expect(bad.status).toBe(422);
  });
});
