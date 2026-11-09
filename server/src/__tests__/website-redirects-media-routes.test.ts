import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
  principalPermissionGrants,
  websiteEntry,
  websitePage,
  websiteSite,
} from "@greatstone/db";
import type { WebsiteRedirect, WebsiteSite } from "@greatstone/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { websiteModuleRoutes } from "../routes/website-module.js";
import { instanceSettingsService } from "../services/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres website redirect and media tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

type Actor = Express.Request["actor"];

// GRE-4785 (GRE-4079 step 5d): redirects (list, add, change, delete) and media rename and delete in the Website
// module. Each is a draft change: a person approves it, and it reaches the site only with the next Publish.
describeEmbeddedPostgres("website redirects and media routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const localBoard: Actor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };
  // Connecting a site stores its Netlify token in the vault.
  const keyFolder = mkdtempSync(path.join(os.tmpdir(), "gsam-website-redirects-key-"));
  const previousKeyFile = process.env.GSAM_SECRETS_MASTER_KEY_FILE;

  beforeAll(async () => {
    process.env.GSAM_SECRETS_MASTER_KEY_FILE = path.join(keyFolder, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("gsam-website-redirects-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(websiteEntry);
    await db.delete(websitePage);
    await db.delete(websiteSite);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(assets);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(activityLog);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousKeyFile === undefined) delete process.env.GSAM_SECRETS_MASTER_KEY_FILE;
    else process.env.GSAM_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(keyFolder, { recursive: true, force: true });
  });

  function app(actor: Actor = localBoard) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", websiteModuleRoutes(db, { checkConnection: async () => ({ ok: true, engineVersion: "0.1.0", releaseSchemaVersion: 1 }) }));
    instance.use(errorHandler);
    return instance;
  }

  async function seedWorld(name: string, domain: string) {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const [company] = await db.insert(companies).values({ name, issuePrefix: `R${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}` }).returning();
    const http = request(app());
    const site = (await http
      .post(`/api/companies/${company!.id}/website/sites`)
      .send({ name: `${name} site`, domain, netlifySiteId: `netlify-${domain}`, netlifyToken: "nfp_test_token_value_123" })
      .expect(201)).body as WebsiteSite;
    const page = (await http
      .post(`/api/companies/${company!.id}/website/sites/${site.id}/pages`)
      .send({ slug: "/about", title: `${name} about`, menu: "header", menuOrder: 0, content: { root: { props: {} }, content: [] } })
      .expect(201)).body;
    return { company: company!, site, page, url: `/api/companies/${company!.id}/website/sites/${site.id}` };
  }

  async function seedAgent(companyId: string, grantKeys: string[]) {
    const [agent] = await db
      .insert(agents)
      .values({ companyId, name: `Agent ${randomUUID().slice(0, 4)}`, role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
      .returning();
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agent!.id, status: "active", membershipRole: "member" });
    for (const key of grantKeys) {
      await db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: agent!.id, permissionKey: key, scope: null });
    }
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id }).returning();
    return { type: "agent", agentId: agent!.id, companyId, runId: run!.id, source: "agent_key" } as Actor;
  }

  async function seedViewer(companyId: string) {
    const userId = `user-${randomUUID().slice(0, 8)}`;
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "viewer" });
    return { type: "board", userId, source: "session", isInstanceAdmin: false, companyIds: [companyId], memberships: [{ companyId, membershipRole: "viewer", status: "active" }] } as Actor;
  }

  async function seedAsset(companyId: string) {
    const [asset] = await db.insert(assets).values({
      companyId, provider: "local_disk", objectKey: `${companyId}/website/${randomUUID()}.png`, contentType: "image/png",
      byteSize: 1234, sha256: randomUUID().replace(/-/g, ""), originalFilename: "harbour.png",
    }).returning();
    return asset!;
  }

  async function actions(companyId: string) {
    return (await db.select({ action: activityLog.action }).from(activityLog).where(eq(activityLog.companyId, companyId))).map((row) => row.action);
  }

  it("adds, lists, changes and deletes a redirect as drafts; the same add twice makes one", async () => {
    const a = await seedWorld("Alpha", "alpha.test");
    const http = request(app());
    const created = (await http.post(`${a.url}/redirects`).send({ from: "/old-pricing", to: "/pricing" }).expect(201)).body as WebsiteRedirect;
    expect(created).toMatchObject({ from: "/old-pricing", to: "/pricing", status: 301, state: "draft" });
    const again = await http.post(`${a.url}/redirects`).send({ from: "/old-pricing", to: "/pricing", status: 301 }).expect(200);
    expect(again.body.entryId).toBe(created.entryId);
    await http.post(`${a.url}/redirects`).send({ from: "/blog", to: "https://blog.example.com/", status: 302 }).expect(201);

    const list = (await http.get(`${a.url}/redirects`).expect(200)).body as WebsiteRedirect[];
    expect(list.map((r) => [r.from, r.to, r.status])).toEqual([["/blog", "https://blog.example.com/", 302], ["/old-pricing", "/pricing", 301]]);
    // It is a redirect entry like any other: in the release schema's shape.
    const entry = (await http.get(`${a.url}/entries/${created.entryId}`).expect(200)).body;
    expect(entry).toMatchObject({ collection: "redirect", content: { id: created.key, from: "/old-pricing", to: "/pricing", status: 301 } });

    // Approved, then changed: a change is a new draft a person approves again.
    await http.post(`${a.url}/entries/${created.entryId}/submit`).expect(200);
    await http.post(`${a.url}/entries/${created.entryId}/approve`).expect(200);
    const changed = (await http.patch(`${a.url}/redirects/${created.entryId}`)
      .send({ from: "/old-pricing", to: "/prices", status: 308, baseRevisionId: created.latestRevisionId }).expect(200)).body as WebsiteRedirect;
    expect(changed).toMatchObject({ to: "/prices", status: 308, state: "draft" });
    expect(changed.latestRevisionId).not.toBe(created.latestRevisionId);
    const stale = await http.patch(`${a.url}/redirects/${created.entryId}`)
      .send({ from: "/old-pricing", to: "/x", baseRevisionId: created.latestRevisionId }).expect(409);
    expect(stale.body.details.code).toBe("website_redirect_stale");

    await http.delete(`${a.url}/redirects/${created.entryId}`).expect(200);
    expect(((await http.get(`${a.url}/redirects`).expect(200)).body as WebsiteRedirect[]).map((r) => r.from)).toEqual(["/blog"]);
    const [row] = await db.select().from(websiteEntry).where(eq(websiteEntry.id, created.entryId));
    expect(row!.archivedAt).not.toBeNull();
    await http.delete(`${a.url}/redirects/${created.entryId}`).expect(404);
    expect(await actions(a.company.id)).toEqual(expect.arrayContaining(["website.redirect_created", "website.redirect_saved", "website.redirect_deleted"]));
  });

  it("refuses a redirect the site cannot serve: bad paths, to itself, a second one from a path, a page's path, a loop", async () => {
    const a = await seedWorld("Alpha", "alpha.test");
    const http = request(app());
    const add = (body: Record<string, unknown>) => http.post(`${a.url}/redirects`).send(body);
    for (const body of [
      { from: "old", to: "/new" }, { from: "//evil.example", to: "/new" }, { from: "/old?x=1", to: "/new" },
      { from: "/old", to: "http://plain.example" }, { from: "/old", to: "//evil.example" }, { from: "/old", to: "/new", status: 303 },
      { from: "/old", to: "/new", extra: true },
    ]) {
      await add(body).expect(400);
    }
    expect((await add({ from: "/same", to: "/same" }).expect(422)).body.details.code).toBe("website_redirect_to_itself");
    await add({ from: "/a", to: "/b" }).expect(201);
    const taken = await add({ from: "/a", to: "/c" }).expect(409);
    expect(taken.body.details.code).toBe("website_redirect_from_taken");
    expect((await add({ from: "/about", to: "/team" }).expect(422)).body.details.code).toBe("website_redirect_from_is_page");
    await add({ from: "/b", to: "/c" }).expect(201);
    expect((await add({ from: "/c", to: "/a" }).expect(422)).body.details.code).toBe("website_redirect_loop");
    expect((await http.get(`${a.url}/redirects`).expect(200)).body).toHaveLength(2);
  });

  it("an agent with website:edit drafts and sends for review, never approves; a viewer reads only; other companies get 404", async () => {
    const a = await seedWorld("Alpha", "alpha.test");
    const b = await seedWorld("Bravo", "bravo.test");
    const bRedirect = (await request(app()).post(`${b.url}/redirects`).send({ from: "/b-old", to: "/b-new" }).expect(201)).body as WebsiteRedirect;
    const agent = request(app(await seedAgent(a.company.id, ["website:view", "website:edit"])));

    const drafted = (await agent.post(`${a.url}/redirects`).send({ from: "/old", to: "/new" }).expect(201)).body as WebsiteRedirect;
    await agent.post(`${a.url}/entries/${drafted.entryId}/submit`).expect(200);
    await agent.post(`${a.url}/entries/${drafted.entryId}/approve`).expect(403);
    await agent.post(`${a.url}/releases`).expect(403);

    // B's redirect is not found through A's site or B's.
    await agent.patch(`${a.url}/redirects/${bRedirect.entryId}`).send({ from: "/b-old", to: "/hijack", baseRevisionId: bRedirect.latestRevisionId }).expect(404);
    await agent.delete(`${a.url}/redirects/${bRedirect.entryId}`).expect(404);
    await agent.get(`${b.url}/redirects`).expect(403);
    // A page entry id is not a redirect.
    await agent.delete(`${a.url}/redirects/${randomUUID()}`).expect(404);

    const viewer = request(app(await seedViewer(a.company.id)));
    expect((await viewer.get(`${a.url}/redirects`).expect(200)).body).toHaveLength(1);
    await viewer.post(`${a.url}/redirects`).send({ from: "/v", to: "/w" }).expect(403);
    await viewer.delete(`${a.url}/redirects/${drafted.entryId}`).expect(403);
    const [bRow] = await db.select().from(websiteEntry).where(eq(websiteEntry.id, bRedirect.entryId));
    expect(bRow!.archivedAt).toBeNull();
  });

  it("renames media without touching its file; a taken name answers 409", async () => {
    const a = await seedWorld("Alpha", "alpha.test");
    const http = request(app());
    const asset = await seedAsset(a.company.id);
    const media = (await http.post(`${a.url}/entries`).send({ collection: "media", entryKey: "img-1", content: { assetId: asset.id, alt: "Harbour" } }).expect(201)).body;
    await http.post(`${a.url}/entries`).send({ collection: "media", entryKey: "logo", content: { assetId: asset.id, alt: "Logo" } }).expect(201);

    const renamed = (await http.patch(`${a.url}/media/${media.id}`).send({ name: "harbour-at-dawn" }).expect(200)).body;
    expect(renamed).toMatchObject({ entryId: media.id, entryKey: "harbour-at-dawn", assetId: asset.id, alt: "Harbour" });
    expect((await http.patch(`${a.url}/media/${media.id}`).send({ name: "logo" }).expect(409)).body.details.code).toBe("website_entry_key_taken");
    await http.patch(`${a.url}/media/${media.id}`).send({ name: "  " }).expect(400);
    // A non-media entry is not found here.
    const redirect = (await http.post(`${a.url}/redirects`).send({ from: "/x", to: "/y" }).expect(201)).body as WebsiteRedirect;
    await http.patch(`${a.url}/media/${redirect.entryId}`).send({ name: "z" }).expect(404);
    expect(await actions(a.company.id)).toContain("website.media_renamed");
  });

  it("deletes media no page uses; refuses while a page's draft or live version uses it, naming the page", async () => {
    const a = await seedWorld("Alpha", "alpha.test");
    const b = await seedWorld("Bravo", "bravo.test");
    const http = request(app());
    const unused = await seedAsset(a.company.id);
    const used = await seedAsset(a.company.id);
    const add = (world: typeof a, entryKey: string, assetId: string) =>
      request(app()).post(`${world.url}/entries`).send({ collection: "media", entryKey, content: { assetId, alt: entryKey } }).expect(201);
    const loose = (await add(a, "loose", unused.id)).body;
    const hero = (await add(a, "hero", used.id)).body;

    // The page's draft names the asset (block pages store media:<asset id>).
    const pageUrl = `${a.url}/pages/${a.page.id}`;
    const draft = (await http.get(pageUrl).expect(200)).body;
    const saved = (await http.put(`${pageUrl}/content`).send({ baseRevisionId: draft.latestRevisionId, content: { root: { props: {} }, content: [{ type: "Hero", props: { image: `media:${used.id}` } }] } }).expect(200)).body;
    const refused = await http.delete(`${a.url}/media/${hero.id}`).expect(409);
    expect(refused.body.details).toMatchObject({ code: "website_media_in_use", usedBy: [{ kind: "page", id: a.page.id, title: "Alpha about" }] });
    expect(refused.body.error).toContain("Alpha about");

    // Only the live version uses it now: still refused, or the next Publish would break the live page.
    await db.update(websitePage).set({ publishedRevisionId: saved.revisionId }).where(eq(websitePage.id, a.page.id));
    const latest = (await http.get(pageUrl).expect(200)).body;
    await http.put(`${pageUrl}/content`).send({ baseRevisionId: latest.latestRevisionId, content: { root: { props: {} }, content: [] } }).expect(200);
    await http.delete(`${a.url}/media/${hero.id}`).expect(409);
    // A second media entry for the same file keeps it in the release, so this one can go.
    await add(a, "hero-copy", used.id);
    await http.delete(`${a.url}/media/${hero.id}`).expect(200);

    // B cannot delete A's media, and A's media id is not found under B.
    const bAgent = request(app(await seedAgent(b.company.id, ["website:view", "website:edit"])));
    await bAgent.delete(`${b.url}/media/${loose.id}`).expect(404);
    await bAgent.delete(`${a.url}/media/${loose.id}`).expect(403);

    await http.delete(`${a.url}/media/${loose.id}`).expect(200);
    const keys = ((await http.get(`${a.url}/media`).expect(200)).body as Array<{ entryKey: string }>).map((item) => item.entryKey);
    expect(keys).toEqual(["hero-copy"]);
    // The file stays in the company's files.
    expect(await db.select().from(assets).where(and(eq(assets.companyId, a.company.id), eq(assets.id, unused.id)))).toHaveLength(1);
    expect(await actions(a.company.id)).toContain("website.media_deleted");
  });
});
