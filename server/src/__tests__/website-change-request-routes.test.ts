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
  assets,
  companies,
  companyMemberships,
  companySecrets,
  companySecretVersions,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  instanceSettings,
  issueAttachments,
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
import { WEBSITE_CHANGE_REQUEST_ORIGIN_KIND, sniffWebsiteChangeImage } from "../services/website/change-request.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";

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
  const storage = createStorageService(createLocalDiskStorageProvider(path.join(keyFolder, "files")));
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
    await db.delete(issueAttachments);
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
    await db.delete(assets);
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
    instance.use("/api", websiteModuleRoutes(db, { gsamOrigins: ["https://gsam.example.test"], heartbeat: { wakeup }, storage }));
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
    expect(task!.description).toContain("No screenshot was sent");
  });

  // GRE-2361: the editor captured a PNG; GSAM attaches it right after.
  it("with a screenshot the task says one is attached", async () => {
    const a = await seedWorld("Alpha", "alpha.test");
    const sent = { requestId: randomUUID(), pageRevisionId: a.page.latestRevisionId, request: "Shorter, please.", screenshot: true };
    await request(app()).post(url(a.company.id, a.site.id, a.page.id)).send(sent).expect(201);
    const [task] = await changeTasks(a.company.id);
    expect(task!.description).toContain("A screenshot of the page as the person saw it is attached to this task.");
    expect(task!.description).not.toContain("No screenshot was sent");
  });

  // GRE-2518: the person drew on the screenshot.
  it("with a drawing the task names the marked-up files and lists the markers and labels", async () => {
    const a = await seedWorld("Alpha", "alpha.test");
    const sent = {
      ...body(a.page, { request: "Fix these." }),
      screenshot: true,
      markup: { marks: 4, markers: 2, labels: ["Too big", "Use `lime` --> here"] },
    };
    await request(app()).post(url(a.company.id, a.site.id, a.page.id)).send(sent).expect(201);
    const [task] = await changeTasks(a.company.id);
    expect(task!.description).toContain("They drew 4 marks on the screenshot of the block.");
    expect(task!.description).toContain("`website-hero-1-markup.png`");
    expect(task!.description).toContain("`website-hero-1-markup.json`");
    expect(task!.description).toContain("- Numbered markers: 1 to 2, in the order placed");
    expect(task!.description).toContain("- Label: `Too big`");
    // A backtick in a label cannot break out of its code span.
    expect(task!.description).toContain("- Label: `Use  lime  --> here`");
    expect(task!.description).toContain("> Fix these.");
  });

  it("a drawing with no words makes a task; the Comments list says it is a drawing", async () => {
    const a = await seedWorld("Alpha", "alpha.test");
    const http = request(app());
    const target = url(a.company.id, a.site.id, a.page.id);
    const sent = { requestId: randomUUID(), pageRevisionId: a.page.latestRevisionId, request: "  ", screenshot: true, markup: { marks: 1, markers: 1, labels: [] } };
    await http.post(target).send(sent).expect(201);
    const [task] = await changeTasks(a.company.id);
    expect(task!.description).toContain("They wrote no words: the drawing says what to change.");
    expect(task!.description).toContain("They drew 1 mark on the screenshot of the page.");
    expect(task!.description).toContain("`website-page-markup.png`");
    expect(task!.description).toContain("- Numbered marker: 1");
    expect(task!.description).not.toContain("**The change, in their words**");
    const [listed] = (await http.get(target).expect(200)).body as WebsitePageComment[];
    expect(listed!.request).toBe("Drawing on the page");
  });

  it("no words and no drawing, or a drawing without its screenshot, is refused", async () => {
    const a = await seedWorld("Alpha", "alpha.test");
    const http = request(app());
    const target = url(a.company.id, a.site.id, a.page.id);
    const base = { requestId: randomUUID(), pageRevisionId: a.page.latestRevisionId };
    await http.post(target).send({ ...base, request: " ", screenshot: true }).expect(400);
    await http.post(target).send({ ...base, request: "Here.", markup: { marks: 1, markers: 0, labels: [] } }).expect(400);
    await http.post(target).send({ ...base, request: "Here.", screenshot: true, markup: { marks: 0, markers: 0, labels: [] } }).expect(400);
    await http.post(target).send({ ...base, request: "Here.", screenshot: true, markup: { marks: 101, markers: 0, labels: [] } }).expect(400);
    await http.post(target).send({ ...base, request: "Here.", screenshot: true, markup: { marks: 1, markers: 0, labels: ["x".repeat(121)] } }).expect(400);
    expect(await changeTasks(a.company.id)).toHaveLength(0);
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

  // GRE-2527: images, media, links and effects on the request.
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4d10000000049454e44ae426082", "hex");
  const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

  async function seedAsset(companyId: string) {
    const [asset] = await db
      .insert(assets)
      .values({ companyId, provider: "local_disk", objectKey: `assets/${randomUUID()}.png`, contentType: "image/png", byteSize: PNG.length, sha256: "0".repeat(64) })
      .returning();
    return asset!;
  }

  it("the task lists every attachment with its note, in order", async () => {
    const a = await seedWorld("Alpha", "alpha.test");
    const asset = await seedAsset(a.company.id);
    const target = url(a.company.id, a.site.id, a.page.id);
    await request(app())
      .post(target)
      .send(
        body(a.page, {
          attachments: [
            { kind: "upload", name: "mood.png", note: "This colour" },
            { kind: "media", source: "website", assetId: asset.id, label: "Team photo" },
            { kind: "media", source: "studio", assetId: asset.id, label: "Sunset", note: "Crop like this" },
            { kind: "link", url: "https://example.com/inspo", note: "The header spacing" },
            { kind: "effect", effectId: "aurora", label: "Aurora", note: "Slower" },
          ],
        }),
      )
      .expect(201);
    const [task] = await changeTasks(a.company.id);
    const text = task!.description!;
    expect(text).toContain("**What they attached**");
    expect(text).toContain("1. Image they uploaded, attached to this task as `mood.png`. Their note: `This colour`");
    expect(text).toContain(`2. Image from Website media \`Team photo\`: asset \`${asset.id}\`, at \`/api/assets/${asset.id}/content\`.`);
    expect(text).toContain("3. Image from GS Studio `Sunset`");
    expect(text).toContain("Their note: `Crop like this`");
    expect(text).toContain("4. Reference site: `https://example.com/inspo`. Look at it for the idea; do not copy its words, images or code. Their note: `The header spacing`");
    expect(text).toContain("5. Effect from the effects library: `aurora` (Aurora). Their note: `Slower`");
  });

  it("attachments alone make a task; the Comments list says so", async () => {
    const a = await seedWorld("Alpha", "alpha.test");
    const http = request(app());
    const target = url(a.company.id, a.site.id, a.page.id);
    await http
      .post(target)
      .send({ requestId: randomUUID(), pageRevisionId: a.page.latestRevisionId, request: "", attachments: [{ kind: "link", url: "https://example.com" }] })
      .expect(201);
    const [task] = await changeTasks(a.company.id);
    expect(task!.description).toContain("They wrote no words: what they attached says what to change.");
    const [listed] = (await http.get(target).expect(200)).body as WebsitePageComment[];
    expect(listed!.request).toBe("Images and references");
  });

  it("refuses another company's asset, a non-web link, a two-line note and too many attachments", async () => {
    const a = await seedWorld("Alpha", "alpha.test");
    const b = await seedWorld("Bravo", "bravo.test");
    const theirs = await seedAsset(b.company.id);
    const http = request(app());
    const target = url(a.company.id, a.site.id, a.page.id);
    const res = await http
      .post(target)
      .send(body(a.page, { attachments: [{ kind: "media", source: "website", assetId: theirs.id, label: "x" }] }))
      .expect(422);
    expect(res.body.code).toBe("website_change_attachment_unknown");
    await http.post(target).send(body(a.page, { attachments: [{ kind: "link", url: "javascript:alert(1)" }] })).expect(400);
    await http.post(target).send(body(a.page, { attachments: [{ kind: "link", url: "https://a.test", note: "one\ntwo" }] })).expect(400);
    await http.post(target).send(body(a.page, { attachments: [{ kind: "link", url: "https://a.test", note: "x".repeat(141) }] })).expect(400);
    const eleven = Array.from({ length: 11 }, () => ({ kind: "link", url: "https://a.test" }));
    await http.post(target).send(body(a.page, { attachments: eleven })).expect(400);
    expect(await changeTasks(a.company.id)).toHaveLength(0);
  });

  it("stores an uploaded image on the task; refuses SVG, a renamed file, a big file and a task from another page", async () => {
    const a = await seedWorld("Alpha", "alpha.test");
    const http = request(app());
    const target = url(a.company.id, a.site.id, a.page.id);
    const created = (await http.post(target).send(body(a.page, { attachments: [{ kind: "upload", name: "mood.png" }] })).expect(201)).body as WebsiteChangeRequestResult;
    const images = `${target}/${created.issueId}/images`;

    const stored = await http.post(images).attach("file", PNG, { filename: "mood.png", contentType: "image/png" }).expect(201);
    expect(stored.body).toMatchObject({ issueId: created.issueId, contentType: "image/png", byteSize: PNG.length, originalFilename: "mood.png" });
    const rows = await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, created.issueId));
    expect(rows).toHaveLength(1);
    const [storedAsset] = await db.select().from(assets).where(eq(assets.id, rows[0]!.assetId));
    expect(storedAsset!.contentType).toBe("image/png");

    // The bytes decide, not the name or the browser's type.
    const svg = await http.post(images).attach("file", SVG, { filename: "logo.svg", contentType: "image/svg+xml" }).expect(422);
    expect(svg.body.code).toBe("website_change_image_type");
    await http.post(images).attach("file", SVG, { filename: "photo.png", contentType: "image/png" }).expect(422);
    const big = Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)]);
    const tooBig = await http.post(images).attach("file", big, { filename: "big.png", contentType: "image/png" }).expect(422);
    expect(tooBig.body.code).toBe("website_change_image_too_large");
    await http.post(images).field("note", "no file").expect(422);

    // A task that is not a change request on this page.
    const [other] = await db.insert(issues).values({ companyId: a.company.id, title: "Other work" }).returning();
    await http.post(`${target}/${other!.id}/images`).attach("file", PNG, { filename: "a.png", contentType: "image/png" }).expect(404);
    expect(await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, created.issueId))).toHaveLength(1);
  });

  it("a task takes at most 13 files through the image route", async () => {
    const a = await seedWorld("Alpha", "alpha.test");
    const http = request(app());
    const target = url(a.company.id, a.site.id, a.page.id);
    const created = (await http.post(target).send(body(a.page)).expect(201)).body as WebsiteChangeRequestResult;
    const images = `${target}/${created.issueId}/images`;
    for (let n = 0; n < 13; n += 1) await http.post(images).attach("file", PNG, { filename: `${n}.png`, contentType: "image/png" }).expect(201);
    const over = await http.post(images).attach("file", PNG, { filename: "14.png", contentType: "image/png" }).expect(422);
    expect(over.body.code).toBe("website_change_image_limit");
  });

  it("image upload is company-scoped and needs website:edit", async () => {
    const a = await seedWorld("Alpha", "alpha.test");
    const b = await seedWorld("Bravo", "bravo.test");
    const target = url(a.company.id, a.site.id, a.page.id);
    const created = (await request(app()).post(target).send(body(a.page)).expect(201)).body as WebsiteChangeRequestResult;
    // Company B's site path with company A's task.
    await request(app())
      .post(`${url(b.company.id, b.site.id, b.page.id)}/${created.issueId}/images`)
      .attach("file", PNG, { filename: "a.png", contentType: "image/png" })
      .expect(404);
    const { actor } = await seedAgent(a.company.id, ["website:view"]);
    await request(app(actor)).post(`${target}/${created.issueId}/images`).attach("file", PNG, { filename: "a.png", contentType: "image/png" }).expect(403);
    expect(await db.select().from(issueAttachments)).toHaveLength(0);
  });

  it("knows image types by their bytes", () => {
    expect(sniffWebsiteChangeImage(PNG)).toBe("image/png");
    expect(sniffWebsiteChangeImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffWebsiteChangeImage(Buffer.from("GIF89a....."))).toBe("image/gif");
    expect(sniffWebsiteChangeImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffWebsiteChangeImage(SVG)).toBeNull();
    expect(sniffWebsiteChangeImage(Buffer.from("RIFF\0\0\0\0WAVE"))).toBeNull();
  });
});
