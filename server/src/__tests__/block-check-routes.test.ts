import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueRelations,
  issueThreadInteractions,
  issues,
  projects,
} from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { blockCheckRoutes } from "../routes/block-check.ts";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres block check tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("block check route", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-block-check-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function appFor(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor as never;
      next();
    });
    app.use("/api", blockCheckRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("lists each kind per project, for the lead, and keeps other companies out", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const lintel = randomUUID();
    const everest = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Check", issuePrefix: `C${companyId.slice(0, 6).toUpperCase()}` },
      { id: otherCompanyId, name: "Other", issuePrefix: `O${otherCompanyId.slice(0, 6).toUpperCase()}` },
    ]);
    await db.insert(agents).values([
      { id: lintel, companyId, name: "Lintel", role: "engineer", status: "idle", adapterType: "codex_local" },
      { id: everest, companyId, name: "Everest", role: "general", status: "idle", adapterType: "codex_local" },
    ]);
    const website = randomUUID();
    const platform = randomUUID();
    await db.insert(projects).values([
      { id: website, companyId, name: "Website", leadAgentId: lintel },
      { id: platform, companyId, name: "Platform", leadAgentId: everest },
    ]);

    const now = Date.now();
    const ago = (hours: number) => new Date(now - hours * 60 * 60 * 1000);
    const ids = {
      unexplained: randomUUID(),
      closedBlocker: randomUUID(),
      waitsOnClosed: randomUUID(),
      answered: randomUUID(),
      titled: randomUUID(),
      oldAsk: randomUUID(),
      explained: randomUUID(),
      hidden: randomUUID(),
      platformBlocked: randomUUID(),
      foreign: randomUUID(),
    };
    await db.insert(issues).values([
      { id: ids.unexplained, companyId, projectId: website, title: "No reason", identifier: "GRE-1", status: "blocked" },
      { id: ids.closedBlocker, companyId, projectId: website, title: "Finished", identifier: "GRE-2", status: "done" },
      { id: ids.waitsOnClosed, companyId, projectId: website, title: "Waits on done", identifier: "GRE-3", status: "blocked" },
      {
        id: ids.answered,
        companyId,
        projectId: website,
        title: "Deploy",
        identifier: "GRE-1989",
        status: "blocked",
        blockedTransitionAt: ago(3),
        unblockDescriptor: { owner: "board", action: "Resume after John accepts the staging upload card" },
      },
      { id: ids.titled, companyId, projectId: website, title: "Go live (after John accepts the proof)", identifier: "GRE-5", status: "todo" },
      { id: ids.oldAsk, companyId, projectId: website, title: "Turnstile", identifier: "GRE-1808", status: "in_progress" },
      {
        id: ids.explained,
        companyId,
        projectId: website,
        title: "Explained",
        identifier: "GRE-7",
        status: "blocked",
        unblockDescriptor: { owner: { agentId: lintel }, action: "Finish the page" },
      },
      { id: ids.hidden, companyId, projectId: website, title: "Hidden", identifier: "GRE-8", status: "blocked", hiddenAt: new Date() },
      { id: ids.platformBlocked, companyId, projectId: platform, title: "Platform", identifier: "GRE-9", status: "blocked" },
      { id: ids.foreign, companyId: otherCompanyId, title: "Not yours", identifier: "OTH-1", status: "blocked" },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: ids.closedBlocker,
      relatedIssueId: ids.waitsOnClosed,
      type: "blocks",
    });
    const answeredCard = randomUUID();
    const oldCard = randomUUID();
    await db.insert(issueThreadInteractions).values([
      {
        id: answeredCard,
        companyId,
        issueId: ids.answered,
        kind: "request_confirmation",
        status: "accepted",
        title: "Approve staging upload",
        payload: { version: 1, prompt: "Approve?" } as never,
        resolvedAt: ago(2),
        createdAt: ago(4),
      },
      {
        id: oldCard,
        companyId,
        issueId: ids.oldAsk,
        kind: "ask_user_questions",
        status: "pending",
        title: "Turnstile keys",
        payload: { version: 1, questions: [] } as never,
        createdAt: ago(30),
      },
    ]);

    const board = appFor({ type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: true });
    const res = await request(board).get(`/api/companies/${companyId}/block-check`);
    expect(res.status).toBe(200);
    const byProject = new Map<string, { kind: string; issue: { id: string }; cardId: string | null }[]>(
      res.body.projects.map((project: { projectId: string; items: never[] }) => [project.projectId, project.items]),
    );
    expect(
      byProject.get(website)!.map((item) => [item.kind, item.issue.id, item.cardId]),
    ).toEqual([
      ["blockers_closed", ids.waitsOnClosed, null],
      ["card_answered", ids.answered, answeredCard],
      ["unexplained", ids.unexplained, null],
      ["condition_in_title", ids.titled, null],
      ["old_human_ask", ids.oldAsk, oldCard],
    ]);
    expect(byProject.get(platform)!.map((item) => item.issue.id)).toEqual([ids.platformBlocked]);
    expect(res.body.projects[0]).toMatchObject({ projectId: website, projectName: "Website", leadAgentId: lintel });
    expect(JSON.stringify(res.body)).not.toContain(ids.foreign);
    expect(JSON.stringify(res.body)).not.toContain(ids.hidden);

    const asLintel = appFor({ type: "agent", agentId: lintel, companyId, source: "agent_key" });
    const mine = await request(asLintel).get(`/api/companies/${companyId}/block-check?leadAgentId=me`);
    expect(mine.status).toBe(200);
    expect(mine.body.projects.map((project: { projectId: string }) => project.projectId)).toEqual([website]);

    const one = await request(board).get(`/api/companies/${companyId}/block-check?projectId=${platform}`);
    expect(one.body.projects.map((project: { projectId: string }) => project.projectId)).toEqual([platform]);

    expect((await request(board).get(`/api/companies/${companyId}/block-check?projectId=nope`)).status).toBe(400);
    expect((await request(board).get(`/api/companies/${companyId}/block-check?leadAgentId=me`)).status).toBe(400);

    const outsider = appFor({ type: "agent", agentId: randomUUID(), companyId: otherCompanyId, source: "agent_key" });
    expect((await request(outsider).get(`/api/companies/${companyId}/block-check`)).status).toBe(403);
  });
});
