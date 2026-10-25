import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  companySecrets,
  companySecretVersions,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  instanceSettings,
  issueCreateIdempotencyKeys,
  issues,
  principalPermissionGrants,
  projects,
  websitePage,
  websiteProperties,
  websiteSite,
} from "@greatstone/db";
import type { WebsiteChangeRequestResult, WebsitePageComment, WebsitePageDetail, WebsiteSite } from "@greatstone/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { websiteModuleRoutes } from "../routes/website-module.js";
import { instanceSettingsService } from "../services/index.js";
import { WEBSITE_CHANGE_REQUEST_ORIGIN_KIND } from "../services/website/change-request.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres website change request tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

type Actor = Express.Request["actor"];

const COMMIT = "c".repeat(40);

// GRE-2121: click to change. A confirmed pick makes exactly one task for the
// website agent with the durable block reference; website:edit, company-scoped.
describeEmbeddedPostgres("website click to change", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const keyFolder = mkdtempSync(path.join(os.tmpdir(), "paperclip-website-change-key-"));
  const previousKeyFile = process.env.GSAM_SECRETS_MASTER_KEY_FILE;
  const wakeup = vi.fn(async () => undefined);

  beforeAll(async () => {
    process.env.GSAM_SECRETS_MASTER_KEY_FILE = path.join(keyFolder, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-website-change-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    wakeup.mockClear();
    await db.delete(activityLog);
    await db.delete(issueCreateIdempotencyKeys);
    await db.delete(issues);
    await db.delete(websitePage);
    await db.delete(websiteSite);
    await db.delete(websiteProperties);
    await db.delete(projects);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) delete process.env.GSAM_SECRETS_MASTER_KEY_FILE;
    else process.env.GSAM_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(keyFolder, { recursive: true, force: true });
  });

  const localBoard: Actor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };

  function app(actor: Actor = localBoard) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", websiteModuleRoutes(db, { gsamOrigins: ["https://gsam.example.test"], heartbeat: { wakeup } }));
    instance.use(errorHandler);
    return instance;
  }

  async function seedAgent(companyId: string, grantKeys: string[], name = `Agent ${randomUUID().slice(0, 4)}`) {
    const [agent] = await db
      .insert(agents)
      .values({ companyId, name, role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
      .returning();
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agent!.id, status: "active", membershipRole: "member" });
    for (const key of grantKeys) {
      await db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: agent!.id, permissionKey: key, scope: null });
    }
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id }).returning();
    return { agent: agent!, actor: { type: "agent", agentId: agent!.id, companyId, runId: run!.id, source: "agent_key" } as Actor };
  }

  /** A company whose site belongs to the website project; Lintel leads it. */
  async function seedWorld(name: string, domain: string) {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const [company] = await db
      .insert(companies)
      .values({ name, issuePrefix: `C${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}` })
      .returning();
    const { agent: lintel } = await seedAgent(company!.id, ["website:view", "website:edit"], "Lintel");
    const [project] = await db.insert(projects).values({ companyId: company!.id, name: `${name} Website`, leadAgentId: lintel.id }).returning();
    const [property] = await db
      .insert(websiteProperties)
      .values({ companyId: company!.id, name, siteUrl: `https://${domain}`, projectId: project!.id })
      .returning();
    const http = request(app());
    const site = (await http
      .post(`/api/companies/${company!.id}/website/sites`)
      .send({ name: `${name} site`, domain, netlifySiteId: `netlify-${domain}`, propertyId: property!.id })
      .expect(201)).body as WebsiteSite;
    const page = (await http
      .post(`/api/companies/${company!.id}/website/sites/${site.id}/pages`)
      .send({
        slug: "/",
        title: `${name} home`,
        content: { root: { props: {} }, content: [{ type: "Hero", props: { id: "hero-1", title: "Welcome" } }] },
      })
      .expect(201)).body as WebsitePageDetail;
    return { company: company!, lintel, project: project!, site, page };
  }

  function body(page: WebsitePageDetail, extra: Record<string, unknown> = {}) {
    return {
      requestId: randomUUID(),
      pageRevisionId: page.latestRevisionId,
      blockId: "hero-1",
      blockType: "Hero",
      blockLabel: "Hero",
      engine: { version: "1.4.0", commit: COMMIT },
      source: { file: "src/blocks/Hero.tsx", line: 12 },
      request: "Make the heading shorter.\nUse our new tagline.",
      ...extra,
    };
  }

  const url = (companyId: string, siteId: string, pageId: string) =>
    `/api/companies/${companyId}/website/sites/${siteId}/pages/${pageId}/change-requests`;

  async function changeTasks(companyId: string) {
    return db.select().from(issues).where(eq(issues.companyId, companyId)).then((rows) => rows.filter((row) => row.originKind === WEBSITE_CHANGE_REQUEST_ORIGIN_KIND));
  }

  it("confirm creates exactly one task for the website agent with the durable reference", async () => {
    const a = await seedWorld("Alpha", "alpha.test");
    const sent = body(a.page);
    const http = request(app());
    const first = (await http.post(url(a.company.id, a.site.id, a.page.id)).send(sent).expect(201)).body as WebsiteChangeRequestResult;
    // The same confirm again (double click, retry) returns the same task.
    const again = (await http.post(url(a.company.id, a.site.id, a.page.id)).send(sent).expect(200)).body as WebsiteChangeRequestResult;
    expect(again.issueId).toBe(first.issueId);

    const tasks = await changeTasks(a.company.id);
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task.assigneeAgentId).toBe(a.lintel.id);
    expect(task.projectId).toBe(a.project.id);
    expect(task.status).toBe("todo");
    expect(task.createdByUserId).toBe("local-board");
    expect(task.title).toBe("Website change: Hero on Alpha home");
    expect(task.description).toContain(`Page: Alpha home (\`/\`, id \`${a.page.id}\`)`);
    expect(task.description).toContain(`Page revision: \`${a.page.latestRevisionId}\``);
    expect(task.description).toContain("Block id: `hero-1`");
    expect(task.description).toContain("Block type: `Hero`");
    expect(task.description).toContain(`commit \`${COMMIT}\``);
    expect(task.description).toContain("> Make the heading shorter.\n> Use our new tagline.");
    expect(task.description).toContain("Hint only, may be out of date: the frame says the block is drawn in `src/blocks/Hero.tsx` line 12.");
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(a.lintel.id, expect.objectContaining({ source: "assignment", payload: expect.objectContaining({ issueId: first.issueId }) }));

    const [logged] = await db.select().from(activityLog).where(eq(activityLog.action, "website.change_requested"));
    expect(logged).toMatchObject({ entityId: a.page.id, details: expect.objectContaining({ issueId: first.issueId, blockId: "hero-1" }) });
  });

  it("without a source hint the task says so; a second request for the block is its own task", async () => {
    const a = await seedWorld("Alpha", "alpha.test");
    const http = request(app());
    await http.post(url(a.company.id, a.site.id, a.page.id)).send(body(a.page, { source: null })).expect(201);
    await http.post(url(a.company.id, a.site.id, a.page.id)).send(body(a.page, { source: undefined, request: "Change the photo." })).expect(201);
    const tasks = await changeTasks(a.company.id);
    expect(tasks).toHaveLength(2);
    expect(tasks.every((task) => task.description?.includes("No source hint was sent."))).toBe(true);
  });

  it("refuses a block that is not in that revision and a revision of another page; nothing is created", async () => {
    const a = await seedWorld("Alpha", "alpha.test");
    const http = request(app());
    const other = (await http
      .post(`/api/companies/${a.company.id}/website/sites/${a.site.id}/pages`)
      .send({ slug: "/about", title: "About", content: { root: { props: {} }, content: [] } })
      .expect(201)).body as WebsitePageDetail;
    const target = url(a.company.id, a.site.id, a.page.id);
    await http.post(target).send(body(a.page, { blockId: "nope" })).expect(422);
    await http.post(target).send(body(a.page, { blockType: "Text" })).expect(422);
    await http.post(target).send(body(a.page, { pageRevisionId: other.latestRevisionId })).expect(422);
    await http.post(target).send(body(a.page, { source: { file: "/etc/passwd", line: 1 } })).expect(400);
    await http.post(target).send(body(a.page, { request: "   " })).expect(400);
    expect(await changeTasks(a.company.id)).toHaveLength(0);
  });

  it("cross-company: company B's page answers 404 and no task is made", async () => {
    const a = await seedWorld("Alpha", "alpha.test");
    const b = await seedWorld("Bravo", "bravo.test");
    const { actor } = await seedAgent(a.company.id, ["website:view", "website:edit"]);
    const http = request(app(actor));
    await http.post(url(a.company.id, b.site.id, b.page.id)).send(body(b.page)).expect(404);
    await http.post(url(a.company.id, a.site.id, b.page.id)).send(body(b.page)).expect(404);
    expect(await changeTasks(a.company.id)).toHaveLength(0);
    expect(await changeTasks(b.company.id)).toHaveLength(0);
    // The same agent asks for a change on its own company's page.
    await http.post(url(a.company.id, a.site.id, a.page.id)).send(body(a.page)).expect(201);
  });

  it("an agent key with only website:view is refused", async () => {
    const a = await seedWorld("Alpha", "alpha.test");
    const { actor } = await seedAgent(a.company.id, ["website:view"]);
    const response = await request(app(actor)).post(url(a.company.id, a.site.id, a.page.id)).send(body(a.page)).expect(403);
    expect(response.body.details).toMatchObject({ code: "website_permission_missing", permission: "website:edit" });
    expect(await changeTasks(a.company.id)).toHaveLength(0);
    expect(wakeup).not.toHaveBeenCalled();
  });
  // GRE-2350: Ask an agent from the full-screen editor.
  it("with nothing selected the task is about the whole page, with its address and width", async () => {
    const a = await seedWorld("Alpha", "alpha.test");
    const http = request(app());
    const sent = {
      requestId: randomUUID(),
      pageRevisionId: a.page.latestRevisionId,
      width: "phone",
      request: "The page feels too long on a phone.",
    };
    const created = (await http.post(url(a.company.id, a.site.id, a.page.id)).send(sent).expect(201)).body as WebsiteChangeRequestResult;
    expect(created.assigneeAgentId).toBe(a.lintel.id);

    const [task] = await changeTasks(a.company.id);
    expect(task!.title).toBe("Website change: the whole page on Alpha home");
    expect(task!.originId).toBe(a.page.id);
    expect(task!.description).toContain("Page address: https://alpha.test/");
    expect(task!.description).toContain(`Page revision: \`${a.page.latestRevisionId}\``);
    expect(task!.description).toContain("Seen at: Phone (390 px)");
    expect(task!.description).toContain("No block was selected: the comment is about the whole page.");
    expect(task!.description).toContain("Do not publish");
    expect(task!.description).not.toContain("Block id:");
  });

  it("a block id without its type, or a type without an id, is refused", async () => {
    const a = await seedWorld("Alpha", "alpha.test");
    const http = request(app());
    const target = url(a.company.id, a.site.id, a.page.id);
    const base = { requestId: randomUUID(), pageRevisionId: a.page.latestRevisionId, request: "Change it." };
    await http.post(target).send({ ...base, blockId: "hero-1" }).expect(400);
    await http.post(target).send({ ...base, blockType: "Hero" }).expect(400);
    await http.post(target).send({ ...base, width: "watch" }).expect(400);
    expect(await changeTasks(a.company.id)).toHaveLength(0);
  });

  it("lists the page's open comments oldest first and numbered; a done task drops off", async () => {
    const a = await seedWorld("Alpha", "alpha.test");
    const http = request(app());
    const target = url(a.company.id, a.site.id, a.page.id);
    const first = (await http.post(target).send(body(a.page, { width: "laptop", request: "Shorter <b>heading</b> -->" })).expect(201)).body as WebsiteChangeRequestResult;
    const second = (await http
      .post(target)
      .send({ requestId: randomUUID(), pageRevisionId: a.page.latestRevisionId, request: "Whole page: warmer colours." })
      .expect(201)).body as WebsiteChangeRequestResult;

    const listed = (await http.get(target).expect(200)).body as WebsitePageComment[];
    expect(listed.map((entry) => [entry.number, entry.issueId])).toEqual([
      [1, first.issueId],
      [2, second.issueId],
    ]);
    expect(listed[0]).toMatchObject({
      request: "Shorter <b>heading</b> -->",
      blockId: "hero-1",
      blockType: "Hero",
      blockLabel: "Hero",
      width: "laptop",
      pageRevisionId: a.page.latestRevisionId,
      assigneeAgentId: a.lintel.id,
    });
    expect(listed[1]).toMatchObject({ request: "Whole page: warmer colours.", blockId: null, blockType: null, width: null });

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, first.issueId));
    const after = (await http.get(target).expect(200)).body as WebsitePageComment[];
    expect(after.map((entry) => [entry.number, entry.issueId])).toEqual([[1, second.issueId]]);
  });

  it("the list is company-scoped and needs only website:view", async () => {
    const a = await seedWorld("Alpha", "alpha.test");
    const b = await seedWorld("Bravo", "bravo.test");
    await request(app()).post(url(b.company.id, b.site.id, b.page.id)).send(body(b.page)).expect(201);
    const { actor } = await seedAgent(a.company.id, ["website:view"]);
    const http = request(app(actor));
    expect((await http.get(url(a.company.id, a.site.id, a.page.id)).expect(200)).body).toEqual([]);
    await http.get(url(a.company.id, b.site.id, b.page.id)).expect(404);
    await http.get(url(a.company.id, a.site.id, b.page.id)).expect(404);
  });
});
