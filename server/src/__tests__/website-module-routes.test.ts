import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
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
  websiteProperties,
  websiteRelease,
  websiteSite,
} from "@greatstone/db";
import { companySearchQuerySchema, type WebsitePageDetail, type WebsiteSite } from "@greatstone/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { gsamServedOrigins, websiteModuleRoutes } from "../routes/website-module.js";
import { websiteModuleService } from "../services/website/module.js";
import { accessService, instanceSettingsService } from "../services/index.js";
import { companySearchService } from "../services/company-search.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres website module tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

type Actor = Express.Request["actor"];

// GRE-2105: ADR GRE-1914 section 7 isolation tests, revision conflicts and the
// rule that an agent can never hold website:publish.
describeEmbeddedPostgres("website module routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const keyFolder = mkdtempSync(path.join(os.tmpdir(), "paperclip-website-module-key-"));
  const previousKeyFile = process.env.GSAM_SECRETS_MASTER_KEY_FILE;

  beforeAll(async () => {
    process.env.GSAM_SECRETS_MASTER_KEY_FILE = path.join(keyFolder, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-website-module-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(websiteRelease);
    await db.delete(websiteEntry);
    await db.delete(websitePage);
    await db.delete(websiteSite);
    await db.delete(websiteProperties);
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

  const localBoard: Actor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };

  function app(actor: Actor = localBoard) {
    const instance = express();
    instance.use(express.json({ limit: "10mb" }));
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", websiteModuleRoutes(db, { gsamOrigins: ["https://gsam.example.test"] }));
    instance.use(errorHandler);
    return instance;
  }

  async function seedCompany(name: string) {
    const [company] = await db
      .insert(companies)
      .values({ name, issuePrefix: `W${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}` })
      .returning();
    return company!;
  }

  async function seedUser(companyId: string, role: "owner" | "admin" | "operator" | "viewer", grants: Array<{ key: string; scope?: Record<string, unknown> }> = []) {
    const userId = `user-${randomUUID().slice(0, 8)}`;
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: role });
    for (const grant of grants) {
      await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: grant.key, scope: grant.scope ?? null });
    }
    return {
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: role, status: "active" }],
    } as Actor;
  }

  async function seedAgent(companyId: string, grantKeys: string[]) {
    const [agent] = await db
      .insert(agents)
      .values({ companyId, name: `Agent ${randomUUID().slice(0, 4)}`, role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
      .returning();
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agent!.id, status: "active", membershipRole: "member" });
    for (const key of grantKeys) {
      // Inserted directly, as an import could: the route-level refusal is tested separately.
      await db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: agent!.id, permissionKey: key, scope: null });
    }
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id }).returning();
    return { agent: agent!, actor: { type: "agent", agentId: agent!.id, companyId, runId: run!.id, source: "agent_key" } as Actor };
  }

  /** A company with a site, a page and an entry, created as the local board. */
  async function seedWorld(name: string, domain: string) {
    const company = await seedCompany(name);
    const http = request(app());
    const site = (await http
      .post(`/api/companies/${company.id}/website/sites`)
      .send({ name: `${name} site`, domain, netlifySiteId: `netlify-${domain}`, netlifyToken: "nfp_test_token_value_123" })
      .expect(201)).body as WebsiteSite;
    const page = (await http
      .post(`/api/companies/${company.id}/website/sites/${site.id}/pages`)
      .send({ slug: "/", title: `${name} home`, menu: "header", menuOrder: 0, content: { root: { props: { title: `${name} secret draft` } }, content: [] } })
      .expect(201)).body as WebsitePageDetail;
    const entry = (await http
      .post(`/api/companies/${company.id}/website/sites/${site.id}/entries`)
      .send({ collection: "product", entryKey: "aspose-pdf-net", content: { data: {
        id: "product-1", slug: "aspose-pdf-net", name: `${name} product`, short_description: "Test product",
        from_price_minor: null, from_price_currency: null, featured: false, platforms: [], type: "product",
        attributes: {}, vendor: { id: "vendor-1", name: "Aspose", slug: "aspose", logo_url: "" },
        category: { id: "category-1", name: "PDF", slug: "pdf" },
      } } })
      .expect(201)).body;
    return { company, site, page, entry };
  }

  async function revisionCount(documentId: string) {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(documentRevisions).where(eq(documentRevisions.documentId, documentId));
    return row!.n;
  }

  it("connects a site, stores the Netlify token in the vault and never returns it", async () => {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const { company, site } = await seedWorld("Greatstone", "www.greatstone.test");
    expect(site.hasNetlifyToken).toBe(true);
    expect(JSON.stringify(site)).not.toContain("nfp_test_token_value_123");
    const [row] = await db.select().from(websiteSite).where(eq(websiteSite.id, site.id));
    const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, row!.netlifyTokenSecretId!));
    expect(secret!.companyId).toBe(company.id);
    const listed = await request(app()).get(`/api/companies/${company.id}/website/sites`).expect(200);
    expect(JSON.stringify(listed.body)).not.toContain("nfp_test_token_value_123");
    await request(app())
      .post(`/api/companies/${company.id}/website/sites`)
      .send({ name: "Again", domain: "www.greatstone.test", netlifySiteId: "x" })
      .expect(409);
  });

  it("isolation 1, 2, 8: company A cannot read or list company B's site, page, entry or revisions", async () => {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const a = await seedWorld("Alpha", "alpha.test");
    const b = await seedWorld("Bravo", "bravo.test");
    const actorA = await seedUser(a.company.id, "owner");
    const http = request(app(actorA));
    const base = `/api/companies/${a.company.id}/website/sites`;
    for (const url of [
      `${base}/${b.site.id}`,
      `${base}/${b.site.id}/pages`,
      `${base}/${b.site.id}/pages/${b.page.id}`,
      `${base}/${b.site.id}/pages/${b.page.id}/revisions`,
      `${base}/${b.site.id}/entries/${b.entry.id}`,
      `${base}/${a.site.id}/pages/${b.page.id}`,
      `${base}/${a.site.id}/entries/${b.entry.id}`,
      `${base}/${a.site.id}/pages/${b.page.id}/revisions`,
    ]) {
      const response = await http.get(url);
      expect(response.status, url).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain("Bravo");
    }
    const sites = (await http.get(base).expect(200)).body as WebsiteSite[];
    expect(sites.map((site) => site.id)).toEqual([a.site.id]);
    const pages = (await http.get(`${base}/${a.site.id}/pages`).expect(200)).body;
    expect(JSON.stringify(pages)).not.toContain(b.page.id);
    const entries = (await http.get(`${base}/${a.site.id}/entries?collection=product`).expect(200)).body;
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(a.entry.id);
  });

  it("isolation 3: a person of A calling under B's company id gets 403", async () => {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const a = await seedWorld("Alpha", "alpha.test");
    const b = await seedWorld("Bravo", "bravo.test");
    const actorA = await seedUser(a.company.id, "owner");
    await request(app(actorA)).get(`/api/companies/${b.company.id}/website/sites`).expect(403);
    await request(app(actorA)).get(`/api/companies/${b.company.id}/website/sites/${b.site.id}/pages/${b.page.id}`).expect(403);
  });

  it("isolation 4: an agent of A with website:edit gets 404 for B's page and cannot save to it", async () => {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const a = await seedWorld("Alpha", "alpha.test");
    const b = await seedWorld("Bravo", "bravo.test");
    const { actor } = await seedAgent(a.company.id, ["website:view", "website:edit"]);
    const http = request(app(actor));
    const before = await revisionCount(b.page.documentId);
    await http.get(`/api/companies/${a.company.id}/website/sites/${b.site.id}/pages/${b.page.id}`).expect(404);
    await http
      .put(`/api/companies/${a.company.id}/website/sites/${a.site.id}/pages/${b.page.id}/content`)
      .send({ baseRevisionId: b.page.latestRevisionId, content: { hijack: true } })
      .expect(404);
    await http
      .put(`/api/companies/${a.company.id}/website/sites/${b.site.id}/pages/${b.page.id}/content`)
      .send({ baseRevisionId: b.page.latestRevisionId, content: { hijack: true } })
      .expect(404);
    expect(await revisionCount(b.page.documentId)).toBe(before);
    // The same agent works on its own company's page.
    await http
      .put(`/api/companies/${a.company.id}/website/sites/${a.site.id}/pages/${a.page.id}/content`)
      .send({ baseRevisionId: a.page.latestRevisionId, content: { ok: true } })
      .expect(200);
  });

  it("isolation 5: a page cannot be created in another company's site, by route or by a row", async () => {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const a = await seedWorld("Alpha", "alpha.test");
    const b = await seedWorld("Bravo", "bravo.test");
    const actorA = await seedUser(a.company.id, "owner");
    await request(app(actorA))
      .post(`/api/companies/${a.company.id}/website/sites/${b.site.id}/pages`)
      .send({ slug: "/injected", title: "Injected" })
      .expect(404);
    // The composite foreign key refuses a row whose company does not own the site.
    await expect(
      db.insert(websitePage).values({ companyId: a.company.id, siteId: b.site.id, slug: "/x", title: "X", documentId: a.page.documentId }),
    ).rejects.toThrow();
    const rows = await db.select().from(websitePage).where(eq(websitePage.siteId, b.site.id));
    expect(rows).toHaveLength(1);
  });

  it("isolation 6 and revision conflicts: saved, conflict on a stale or foreign base, failed on bad content", async () => {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const a = await seedWorld("Alpha", "alpha.test");
    const b = await seedWorld("Bravo", "bravo.test");
    const http = request(app());
    const url = `/api/companies/${a.company.id}/website/sites/${a.site.id}/pages/${a.page.id}/content`;

    const saved = await http.put(url).send({ baseRevisionId: a.page.latestRevisionId, content: { v: 2 }, changeSummary: "Second" }).expect(200);
    expect(saved.body).toMatchObject({ state: "saved", revisionNumber: 2 });

    const stale = await http.put(url).send({ baseRevisionId: a.page.latestRevisionId, content: { v: 3 } }).expect(409);
    expect(stale.body).toMatchObject({ state: "conflict", latestRevisionId: saved.body.revisionId, latestRevisionNumber: 2 });

    const foreign = await http.put(url).send({ baseRevisionId: b.page.latestRevisionId, content: { v: 3 } }).expect(409);
    expect(foreign.body.state).toBe("conflict");

    const tooBig = await http.put(url).send({ baseRevisionId: saved.body.revisionId, content: { blob: "x".repeat(2 * 1024 * 1024 + 10) } }).expect(422);
    expect(tooBig.body.state).toBe("failed");

    expect(await revisionCount(a.page.documentId)).toBe(2);
    expect(await revisionCount(b.page.documentId)).toBe(1);

    const detail = (await http.get(`/api/companies/${a.company.id}/website/sites/${a.site.id}/pages/${a.page.id}`).expect(200)).body;
    expect(detail.content).toEqual({ v: 2 });
    expect(detail.latestRevisionNumber).toBe(2);
    const history = (await http.get(`/api/companies/${a.company.id}/website/sites/${a.site.id}/pages/${a.page.id}/revisions`).expect(200)).body;
    expect(history.map((row: { revisionNumber: number }) => row.revisionNumber)).toEqual([2, 1]);
  });

  it("validates collection fields before save and approves only a reviewed revision", async () => {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const { company, site, entry } = await seedWorld("Fields", "fields.test");
    const http = request(app());
    const base = `/api/companies/${company.id}/website/sites/${site.id}/entries/${entry.id}`;
    await http.put(`${base}/content`).send({ baseRevisionId: entry.latestRevisionId, content: { data: { name: "Incomplete" } } }).expect(422);
    expect(await revisionCount(entry.documentId)).toBe(1);
    await http.post(`${base}/approve`).send({}).expect(422);
    await http.post(`${base}/submit`).send({}).expect(200);
    const approved = await http.post(`${base}/approve`).send({}).expect(200);
    expect(approved.body).toMatchObject({ status: "approved", approvedRevisionId: entry.latestRevisionId });
    const saved = await http.put(`${base}/content`).send({ baseRevisionId: entry.latestRevisionId, content: entry.content }).expect(200);
    expect(saved.body.state).toBe("saved");
    const changed = await http.get(base).expect(200);
    expect(changed.body).toMatchObject({ status: "draft", approvedRevisionId: null });
  });

  it("imports the dated public snapshot once as drafts", async () => {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const { company, site } = await seedWorld("Import", "import.test");
    const http = request(app());
    const path = `/api/companies/${company.id}/website/sites/${site.id}/entries/import-public-drafts`;
    const first = await http.post(path).send({}).expect(200);
    expect(first.body).toMatchObject({ imported: 75, skipped: 0 });
    const second = await http.post(path).send({}).expect(200);
    expect(second.body).toMatchObject({ imported: 0, skipped: 75 });
    const team = await http.get(`/api/companies/${company.id}/website/sites/${site.id}/entries?collection=public-person`).expect(200);
    expect(team.body).toHaveLength(6);
    expect(JSON.stringify(team.body)).not.toContain("inviteToken");
  });

  it("isolation 9: page and entry documents never show in company search", async () => {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const a = await seedWorld("Alpha", "alpha.test");
    const result = await companySearchService(db).search(a.company.id, companySearchQuerySchema.parse({ q: "Alpha secret draft" }));
    expect(JSON.stringify(result.results)).not.toContain(a.page.documentId);
    expect(result.results.filter((row) => row.type === "document")).toHaveLength(0);
  });

  it("isolation 11: a grant scoped to one site answers 404 for another site of the same company", async () => {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const a = await seedWorld("Alpha", "alpha.test");
    const second = (await request(app())
      .post(`/api/companies/${a.company.id}/website/sites`)
      .send({ name: "Second", domain: "second.alpha.test", netlifySiteId: "n2" })
      .expect(201)).body as WebsiteSite;
    const { actor } = await seedAgent(a.company.id, []);
    await db.insert(principalPermissionGrants).values({
      companyId: a.company.id,
      principalType: "agent",
      principalId: (actor as { agentId: string }).agentId,
      permissionKey: "website:view",
      scope: { siteIds: [a.site.id] },
    });
    const http = request(app(actor));
    await http.get(`/api/companies/${a.company.id}/website/sites/${a.site.id}`).expect(200);
    await http.get(`/api/companies/${a.company.id}/website/sites/${second.id}`).expect(404);
    const listed = (await http.get(`/api/companies/${a.company.id}/website/sites`).expect(200)).body as WebsiteSite[];
    expect(listed.map((site) => site.id)).toEqual([a.site.id]);
  });

  it("isolation 12: an agent can never hold website:publish, even with a grant row", async () => {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const a = await seedWorld("Alpha", "alpha.test");
    const { agent, actor } = await seedAgent(a.company.id, ["website:view", "website:edit", "website:publish"]);
    const http = request(app(actor));
    await http.post(`/api/companies/${a.company.id}/website/sites`).send({ name: "Agent site", domain: "agent.test", netlifySiteId: "n" }).expect(403);
    await http.patch(`/api/companies/${a.company.id}/website/sites/${a.site.id}`).send({ name: "Renamed" }).expect(403);
    const access = accessService(db);
    expect(await access.hasPermission(a.company.id, "agent", agent.id, "website:publish")).toBe(false);
    await expect(access.setPrincipalPermission(a.company.id, "agent", agent.id, "website:publish", true, null)).rejects.toThrow(/Agents cannot have Publish rights/);
    await expect(
      access.setPrincipalGrants(a.company.id, "agent", agent.id, [{ permissionKey: "website:publish" }], null),
    ).rejects.toThrow(/Agents cannot have Publish rights/);
  });

  it("role defaults: owner publishes, operator edits but cannot publish, viewer only views", async () => {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const a = await seedWorld("Alpha", "alpha.test");
    const base = `/api/companies/${a.company.id}/website/sites`;
    const owner = await seedUser(a.company.id, "owner");
    const operator = await seedUser(a.company.id, "operator");
    const viewer = await seedUser(a.company.id, "viewer");
    await request(app(owner)).patch(`${base}/${a.site.id}`).send({ name: "Renamed" }).expect(200);
    // A malformed id is not found, never a database error.
    await request(app(owner)).get(`${base}/not-a-uuid/pages`).expect(404);
    await request(app(owner)).get(`${base}/${a.site.id}/pages/123`).expect(404);
    await request(app(operator)).patch(`${base}/${a.site.id}`).send({ name: "Nope" }).expect(403);
    await request(app(operator)).post(`${base}/${a.site.id}/pages`).send({ slug: "/about", title: "About", status: "planned" }).expect(201);
    await request(app(viewer)).get(`${base}/${a.site.id}/pages`).expect(200);
    await request(app(viewer)).post(`${base}/${a.site.id}/pages`).send({ slug: "/no", title: "No" }).expect(403);
    // Agents have no default: they need an explicit grant.
    const { actor } = await seedAgent(a.company.id, []);
    await request(app(actor)).get(`${base}/${a.site.id}`).expect(403);
  });

  it("isolation 11 for a person: a scoped website:edit grant edits one site and gets 404 on another", async () => {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const a = await seedWorld("Alpha", "alpha.test");
    const second = (await request(app())
      .post(`/api/companies/${a.company.id}/website/sites`)
      .send({ name: "Second", domain: "second.alpha.test", netlifySiteId: "n2" })
      .expect(201)).body as WebsiteSite;
    // An operator edits every site by role default; a scoped grant row narrows that to one site.
    const person = await seedUser(a.company.id, "operator", [{ key: "website:edit", scope: { siteIds: [a.site.id] } }]);
    const http = request(app(person));
    const base = `/api/companies/${a.company.id}/website/sites`;
    await http.post(`${base}/${a.site.id}/pages`).send({ slug: "/about", title: "About" }).expect(201);
    await http.post(`${base}/${second.id}/pages`).send({ slug: "/about", title: "About" }).expect(404);
    // View has no grant row, so the role default still shows both sites.
    await http.get(`${base}/${second.id}`).expect(200);
  });

  it("a disconnected (archived) site answers 409 to page and entry writes; reads still work", async () => {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const a = await seedWorld("Alpha", "alpha.test");
    const http = request(app());
    const base = `/api/companies/${a.company.id}/website/sites/${a.site.id}`;
    await http.patch(base).send({ archived: true }).expect(200);
    const writes = [
      http.post(`${base}/pages`).send({ slug: "/about", title: "About" }),
      http.patch(`${base}/pages/${a.page.id}`).send({ title: "Renamed" }),
      http.put(`${base}/pages/${a.page.id}/content`).send({ baseRevisionId: a.page.latestRevisionId, content: { v: 2 } }),
      http.post(`${base}/pages/${a.page.id}/archive`),
      // The editor's save and restore are page writes too.
      http.put(`${base}/pages/${a.page.id}/content`).send({ baseRevisionId: a.page.latestRevisionId, content: { v: 2 }, editorOrigin: "https://editor.alpha.test" }),
      http.post(`${base}/pages/${a.page.id}/revisions/${a.page.latestRevisionId}/restore`).send({ baseRevisionId: a.page.latestRevisionId }),
      http.post(`${base}/entries`).send({ collection: "product", entryKey: "other" }),
      http.patch(`${base}/entries/${a.entry.id}`).send({ sortOrder: 2 }),
      http.put(`${base}/entries/${a.entry.id}/content`).send({ baseRevisionId: a.entry.latestRevisionId, content: { v: 2 } }),
      http.post(`${base}/entries/${a.entry.id}/archive`),
    ];
    for (const write of writes) {
      const response = await write;
      expect(response.status, response.req.path).toBe(409);
      expect(response.body.code).toBe("website_site_disconnected");
    }
    expect(await revisionCount(a.page.documentId)).toBe(1);
    expect(await revisionCount(a.entry.documentId)).toBe(1);
    const [page] = await db.select().from(websitePage).where(eq(websitePage.id, a.page.id));
    expect(page!.archivedAt).toBeNull();
    expect(page!.title).toBe("Alpha home");
    await http.get(`${base}/pages/${a.page.id}`).expect(200);
    await http.get(`${base}/entries`).expect(200);
    // Connecting it again lets edits through.
    await http.patch(base).send({ archived: false }).expect(200);
    await http.put(`${base}/pages/${a.page.id}/content`).send({ baseRevisionId: a.page.latestRevisionId, content: { v: 2 } }).expect(200);
  });

  it("restores an archived page and entry; a taken path answers 409", async () => {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const a = await seedWorld("Alpha", "alpha.test");
    const http = request(app());
    const base = `/api/companies/${a.company.id}/website/sites/${a.site.id}`;
    const about = (await http.post(`${base}/pages`).send({ slug: "/about", title: "About", parentPageId: a.page.id }).expect(201)).body;
    await http.post(`${base}/pages/${about.id}/archive`).expect(200);
    const archivedSave = await http.put(`${base}/pages/${about.id}/content`).send({ baseRevisionId: about.latestRevisionId, content: { v: 2 } }).expect(422);
    expect(archivedSave.body.message).toContain("Restore it");
    const replacement = (await http.post(`${base}/pages`).send({ slug: "/about", title: "About again" }).expect(201)).body;
    const clash = await http.patch(`${base}/pages/${about.id}`).send({ archived: false }).expect(409);
    expect(clash.body.code).toBe("website_page_slug_taken");
    expect(clash.body.error).toContain("/about");
    await http.post(`${base}/pages/${replacement.id}/archive`).expect(200);
    const restored = (await http.patch(`${base}/pages/${about.id}`).send({ archived: false }).expect(200)).body;
    expect(restored).toMatchObject({ archivedAt: null, parentPageId: null, slug: "/about" });
    await http.put(`${base}/pages/${about.id}/content`).send({ baseRevisionId: about.latestRevisionId, content: { v: 2 } }).expect(200);

    await http.post(`${base}/entries/${a.entry.id}/archive`).expect(200);
    const entry = (await http.patch(`${base}/entries/${a.entry.id}`).send({ archived: false }).expect(200)).body;
    expect(entry.archivedAt).toBeNull();
  });

  it("keeps the sitemap fields: parent in the same site, no cycles, archive moves sub-pages up", async () => {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const a = await seedWorld("Alpha", "alpha.test");
    const b = await seedWorld("Bravo", "bravo.test");
    const http = request(app());
    const pages = `/api/companies/${a.company.id}/website/sites/${a.site.id}/pages`;
    const consultancy = (await http.post(pages).send({ slug: "/consultancy", title: "DX Consultancy", parentPageId: a.page.id, menu: "header", menuOrder: 1, status: "planned" }).expect(201)).body;
    expect(consultancy).toMatchObject({ status: "planned", menu: "header", menuOrder: 1, parentPageId: a.page.id });
    const deepDive = (await http.post(pages).send({ slug: "/consultancy/deep-dive", title: "Deep Dive", parentPageId: consultancy.id }).expect(201)).body;
    await http.post(pages).send({ slug: "/x", title: "X", parentPageId: b.page.id }).expect(422);
    await http.patch(`${pages}/${a.page.id}`).send({ parentPageId: deepDive.id }).expect(422);
    await http.post(pages).send({ slug: "/consultancy", title: "Dup" }).expect(409);
    const moved = (await http.patch(`${pages}/${deepDive.id}`).send({ menu: "footer", menuOrder: 3, seo: { title: "Deep Dive | Greatstone", noindex: true } }).expect(200)).body;
    expect(moved).toMatchObject({ menu: "footer", menuOrder: 3, seo: { title: "Deep Dive | Greatstone", noindex: true } });
    await http.post(`${pages}/${consultancy.id}/archive`).expect(200);
    const after = (await http.get(`${pages}/${deepDive.id}`).expect(200)).body;
    expect(after.parentPageId).toBe(a.page.id);
    const live = (await http.get(pages).expect(200)).body as Array<{ id: string }>;
    expect(live.map((row) => row.id)).not.toContain(consultancy.id);
    const all = (await http.get(`${pages}?includeArchived=true`).expect(200)).body as Array<{ id: string }>;
    expect(all.map((row) => row.id)).toContain(consultancy.id);
  });

  describe("a saved company secret as the Netlify token", () => {
    const SHARED_VALUE = "nfp_fake_shared_agent_token_456";

    async function seedSharedSecret(companyId: string, name = "Netlify PAT (agents)") {
      return secretService(db).create(companyId, { name, provider: "local_encrypted", value: SHARED_VALUE }, { userId: "local-board" });
    }

    /** The secret row and every version, as stored, to compare byte for byte. */
    async function snapshot(secretId: string) {
      const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, secretId));
      const versions = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secretId));
      return JSON.stringify({ secret, versions: versions.sort((x, y) => x.version - y.version) });
    }

    it("links a shared secret by id, names it, and never returns its value", async () => {
      await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
      const company = await seedCompany("Greatstone");
      const shared = await seedSharedSecret(company.id);
      const http = request(app());
      const options = (await http.get(`/api/companies/${company.id}/website/token-secrets`).expect(200)).body;
      expect(options).toEqual([{ id: shared.id, name: "Netlify PAT (agents)" }]);
      const created = await http
        .post(`/api/companies/${company.id}/website/sites`)
        .send({ name: "Site", domain: "www.greatstone.test", netlifySiteId: "netlify-site", netlifyTokenSecretId: shared.id })
        .expect(201);
      expect(created.body).toMatchObject({ hasNetlifyToken: true, netlifyTokenSource: "shared", netlifyTokenSecretName: "Netlify PAT (agents)" });
      const listed = await http.get(`/api/companies/${company.id}/website/sites`).expect(200);
      const fetched = await http.get(`/api/companies/${company.id}/website/sites/${created.body.id}`).expect(200);
      for (const body of [options, created.body, listed.body, fetched.body]) expect(JSON.stringify(body)).not.toContain(SHARED_VALUE);
      const [row] = await db.select().from(websiteSite).where(eq(websiteSite.id, created.body.id));
      expect(row).toMatchObject({ netlifyTokenSecretId: shared.id, netlifyTokenSecretOwned: false });
      await http
        .post(`/api/companies/${company.id}/website/sites`)
        .send({ name: "Both", domain: "both.test", netlifySiteId: "x", netlifyToken: "nfp_test_token_value_123", netlifyTokenSecretId: shared.id })
        .expect(400);
    });

    it("refuses another company's secret with 404, on create and update", async () => {
      await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
      const a = await seedWorld("Alpha", "alpha.test");
      const b = await seedCompany("Bravo");
      const foreign = await seedSharedSecret(b.id);
      const http = request(app());
      await http
        .post(`/api/companies/${a.company.id}/website/sites`)
        .send({ name: "Other", domain: "other.test", netlifySiteId: "x", netlifyTokenSecretId: foreign.id })
        .expect(404);
      const response = await http.patch(`/api/companies/${a.company.id}/website/sites/${a.site.id}`).send({ netlifyTokenSecretId: foreign.id }).expect(404);
      expect(response.body.details?.code ?? response.body.code).toBe("website_token_secret_not_found");
      const options = (await http.get(`/api/companies/${a.company.id}/website/token-secrets`).expect(200)).body as Array<{ id: string }>;
      expect(options.map((option) => option.id)).not.toContain(foreign.id);
      const [row] = await db.select().from(websiteSite).where(eq(websiteSite.id, a.site.id));
      expect(row!.netlifyTokenSecretId).not.toBe(foreign.id);
    });

    it("an agent cannot list token secrets or link one, even with a website:publish grant", async () => {
      await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
      const a = await seedWorld("Alpha", "alpha.test");
      const shared = await seedSharedSecret(a.company.id);
      const { actor } = await seedAgent(a.company.id, ["website:view", "website:edit", "website:publish"]);
      const http = request(app(actor));
      await http.get(`/api/companies/${a.company.id}/website/token-secrets`).expect(403);
      const response = await http.patch(`/api/companies/${a.company.id}/website/sites/${a.site.id}`).send({ netlifyTokenSecretId: shared.id }).expect(403);
      expect(JSON.stringify(response.body)).toContain("website_publish_agent_refused");
      const [row] = await db.select().from(websiteSite).where(eq(websiteSite.id, a.site.id));
      expect(row!.netlifyTokenSecretId).not.toBe(shared.id);
    });

    it("pasting a token while linked to a shared secret makes a new site secret and leaves the shared one unchanged", async () => {
      await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
      const a = await seedWorld("Alpha", "alpha.test");
      const shared = await seedSharedSecret(a.company.id);
      const http = request(app());
      const site = `/api/companies/${a.company.id}/website/sites/${a.site.id}`;
      await http.patch(site).send({ netlifyTokenSecretId: shared.id }).expect(200);
      const before = await snapshot(shared.id);
      const pasted = (await http.patch(site).send({ netlifyToken: "nfp_fake_pasted_token_789" }).expect(200)).body;
      expect(pasted).toMatchObject({ hasNetlifyToken: true, netlifyTokenSource: "own" });
      expect(JSON.stringify(pasted)).not.toContain("nfp_fake_pasted_token_789");
      const [row] = await db.select().from(websiteSite).where(eq(websiteSite.id, a.site.id));
      expect(row!.netlifyTokenSecretId).not.toBe(shared.id);
      expect(row!.netlifyTokenSecretOwned).toBe(true);
      expect(await snapshot(shared.id)).toBe(before);
      // Pasting again now rotates the site's own secret, still without touching the shared one.
      const ownId = row!.netlifyTokenSecretId!;
      await http.patch(site).send({ netlifyToken: "nfp_fake_pasted_token_790" }).expect(200);
      const [again] = await db.select().from(websiteSite).where(eq(websiteSite.id, a.site.id));
      expect(again!.netlifyTokenSecretId).toBe(ownId);
      const [own] = await db.select().from(companySecrets).where(eq(companySecrets.id, ownId));
      expect(own!.latestVersion).toBe(2);
      expect(await snapshot(shared.id)).toBe(before);
    });

    it("unlinking a shared secret keeps the secret", async () => {
      await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
      const a = await seedWorld("Alpha", "alpha.test");
      const shared = await seedSharedSecret(a.company.id);
      const http = request(app());
      const site = `/api/companies/${a.company.id}/website/sites/${a.site.id}`;
      await http.patch(site).send({ netlifyTokenSecretId: shared.id }).expect(200);
      const before = await snapshot(shared.id);
      const unlinked = (await http.patch(site).send({ netlifyTokenSecretId: null }).expect(200)).body;
      expect(unlinked).toMatchObject({ hasNetlifyToken: false, netlifyTokenSource: null, netlifyTokenSecretName: null });
      expect(await snapshot(shared.id)).toBe(before);
      const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, shared.id));
      expect(secret!.status).toBe("active");
      const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, a.site.id));
      expect(JSON.stringify(activity)).not.toContain(SHARED_VALUE);
    });
  });

  // ---- GRE-2118: editor frame origin, history, restore, editor load and media ----

  async function seedAsset(companyId: string, name: string) {
    const [asset] = await db
      .insert(assets)
      .values({
        companyId,
        provider: "local_disk",
        objectKey: `${companyId}/website/${randomUUID()}.png`,
        contentType: "image/png",
        byteSize: 1234,
        sha256: randomUUID().replace(/-/g, ""),
        originalFilename: `${name}.png`,
      })
      .returning();
    return asset!;
  }

  it("editor frame origin: only a person who may publish sets it, C1.1 is checked, and the change is logged with old and new", async () => {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const a = await seedWorld("Alpha", "alpha.test");
    const url = `/api/companies/${a.company.id}/website/sites/${a.site.id}`;
    const operator = await seedUser(a.company.id, "operator");
    const { actor: agentActor } = await seedAgent(a.company.id, ["website:view", "website:edit"]);
    await request(app(operator)).patch(url).send({ editorFrameOrigin: "https://editor.alpha.test" }).expect(403);
    await request(app(agentActor)).patch(url).send({ editorFrameOrigin: "https://editor.alpha.test" }).expect(403);

    const owner = await seedUser(a.company.id, "owner");
    const http = request(app(owner));
    for (const refused of ["https://alpha.test", "https://gsam.example.test", "http://editor.alpha.test", "https://editor.alpha.test/editor", "https://*.alpha.test"]) {
      const response = await http.patch(url).send({ editorFrameOrigin: refused });
      expect(response.status, refused).toBe(422);
      expect(response.body.details?.code ?? response.body.code).toBe("website_editor_origin_refused");
    }
    const set = (await http.patch(url).send({ editorFrameOrigin: "https://editor.alpha.test/" }).expect(200)).body as WebsiteSite;
    expect(set.editorFrameOrigin).toBe("https://editor.alpha.test");
    await http.patch(url).send({ editorFrameOrigin: "https://edit2.alpha.test" }).expect(200);

    const changes = await db.select().from(activityLog).where(eq(activityLog.action, "website.site_editor_origin_changed"));
    expect(changes.map((row) => row.details)).toEqual([
      { from: null, to: "https://editor.alpha.test" },
      { from: "https://editor.alpha.test", to: "https://edit2.alpha.test" },
    ]);
    // The public domain cannot be moved onto the editor host either.
    await http.patch(url).send({ domain: "edit2.alpha.test" }).expect(422);
  });

  it("origin-changed (C2.4): a save from a session opened on the old editor address is refused and writes nothing", async () => {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const a = await seedWorld("Alpha", "alpha.test");
    const http = request(app());
    const siteUrl = `/api/companies/${a.company.id}/website/sites/${a.site.id}`;
    await http.patch(siteUrl).send({ editorFrameOrigin: "https://editor.alpha.test" }).expect(200);
    const content = `${siteUrl}/pages/${a.page.id}/content`;

    const saved = await http
      .put(content)
      .send({ baseRevisionId: a.page.latestRevisionId, content: { v: 2 }, editorOrigin: "https://editor.alpha.test" })
      .expect(200);
    expect(saved.body.state).toBe("saved");

    await http.patch(siteUrl).send({ editorFrameOrigin: "https://edit2.alpha.test" }).expect(200);
    const refused = await http
      .put(content)
      .send({ baseRevisionId: saved.body.revisionId, content: { v: 3 }, editorOrigin: "https://editor.alpha.test" })
      .expect(422);
    expect(refused.body).toMatchObject({ state: "failed", code: "origin-changed" });
    expect(await revisionCount(a.page.documentId)).toBe(2);
  });

  it("history and restore: restore makes a new revision with the old content, checks the base, and is company-scoped", async () => {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const a = await seedWorld("Alpha", "alpha.test");
    const b = await seedWorld("Bravo", "bravo.test");
    const http = request(app());
    const pageUrl = `/api/companies/${a.company.id}/website/sites/${a.site.id}/pages/${a.page.id}`;
    const first = a.page.latestRevisionId!;
    const second = (await http.put(`${pageUrl}/content`).send({ baseRevisionId: first, content: { v: 2 } }).expect(200)).body;

    const old = (await http.get(`${pageUrl}/revisions/${first}`).expect(200)).body;
    expect(old.revision.revisionNumber).toBe(1);
    expect(old.content).toEqual({ root: { props: { title: "Alpha secret draft" } }, content: [] });

    // A stale base is a conflict and nothing is restored.
    const stale = await http.post(`${pageUrl}/revisions/${first}/restore`).send({ baseRevisionId: first }).expect(409);
    expect(stale.body.state).toBe("conflict");
    expect(await revisionCount(a.page.documentId)).toBe(2);

    const restored = (await http.post(`${pageUrl}/revisions/${first}/restore`).send({ baseRevisionId: second.revisionId }).expect(200)).body;
    expect(restored).toMatchObject({ state: "saved", revisionNumber: 3 });
    const detail = (await http.get(pageUrl).expect(200)).body;
    expect(detail.content).toEqual(old.content);
    const history = (await http.get(`${pageUrl}/revisions`).expect(200)).body;
    expect(history[0]).toMatchObject({ revisionNumber: 3, changeSummary: "Restored version 1" });

    // Another page's revision, B's revision, a malformed id: all 404 and nothing written.
    await http.get(`${pageUrl}/revisions/${b.page.latestRevisionId}`).expect(404);
    await http.post(`${pageUrl}/revisions/${b.page.latestRevisionId}/restore`).send({ baseRevisionId: restored.revisionId }).expect(404);
    await http.get(`${pageUrl}/revisions/not-a-uuid`).expect(404);
    const viewer = await seedUser(a.company.id, "viewer");
    await request(app(viewer)).post(`${pageUrl}/revisions/${first}/restore`).send({ baseRevisionId: restored.revisionId }).expect(403);
    expect(await revisionCount(a.page.documentId)).toBe(3);
  });

  it("isolation: company A's people and agents get 404 for B's history, restore, editor load and media", async () => {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const a = await seedWorld("Alpha", "alpha.test");
    const b = await seedWorld("Bravo", "bravo.test");
    await request(app()).patch(`/api/companies/${b.company.id}/website/sites/${b.site.id}`).send({ editorFrameOrigin: "https://editor.bravo.test" }).expect(200);
    const owner = await seedUser(a.company.id, "owner");
    const { actor: agentActor } = await seedAgent(a.company.id, ["website:view", "website:edit"]);
    const base = `/api/companies/${a.company.id}/website/sites`;
    for (const actor of [owner, agentActor]) {
      const http = request(app(actor));
      for (const url of [
        `${base}/${b.site.id}/pages/${b.page.id}/revisions/${b.page.latestRevisionId}`,
        `${base}/${a.site.id}/pages/${b.page.id}/revisions/${b.page.latestRevisionId}`,
        `${base}/${b.site.id}/pages/${b.page.id}/editor`,
        `${base}/${a.site.id}/pages/${b.page.id}/editor`,
        `${base}/${b.site.id}/media`,
      ]) {
        const response = await http.get(url);
        expect(response.status, url).toBe(404);
        expect(JSON.stringify(response.body)).not.toContain("Bravo");
      }
      await http
        .post(`${base}/${b.site.id}/pages/${b.page.id}/revisions/${b.page.latestRevisionId}/restore`)
        .send({ baseRevisionId: b.page.latestRevisionId })
        .expect(404);
    }
    expect(await revisionCount(b.page.documentId)).toBe(1);
  });

  it("editor load: refused without a valid frame origin; sends draft, site, navigation and only same-company media", async () => {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const a = await seedWorld("Alpha", "alpha.test");
    const b = await seedWorld("Bravo", "bravo.test");
    const http = request(app());
    const siteUrl = `/api/companies/${a.company.id}/website/sites/${a.site.id}`;
    const editorUrl = `${siteUrl}/pages/${a.page.id}/editor`;
    const missing = await http.get(editorUrl).expect(422);
    expect(JSON.stringify(missing.body)).toContain("website_editor_origin_missing");

    // A value stored before the check (or by a bad import) is checked again on open.
    await db.update(websiteSite).set({ editorFrameOrigin: "https://alpha.test" }).where(eq(websiteSite.id, a.site.id));
    await http.get(editorUrl).expect(422);
    await http.patch(siteUrl).send({ editorFrameOrigin: "https://editor.alpha.test" }).expect(200);

    const own = await seedAsset(a.company.id, "hero");
    const foreign = await seedAsset(b.company.id, "bravo-logo");
    // The route refuses the bad ones, so these are stored as an import would store them.
    const addMedia = (entryKey: string, content: Record<string, unknown>) =>
      websiteModuleService(db).createEntry(a.company.id, a.site.id, { collection: "media", entryKey, content }, { agentId: null, userId: "local-board" });
    await addMedia("hero", { assetId: own.id, alt: "Our team", width: 1600, height: 900 });
    await addMedia("stolen", { assetId: foreign.id, alt: "Not ours" });
    await addMedia("empty", { alt: "No asset" });

    const load = (await http.get(editorUrl).expect(200)).body;
    expect(load).toMatchObject({
      revisionId: a.page.latestRevisionId,
      data: { root: { props: { title: "Alpha secret draft" } }, content: [] },
      editorFrameOrigin: "https://editor.alpha.test",
      site: { name: "Alpha site", settings: { domain: "alpha.test" }, navigation: [{ pageId: a.page.id, menu: "header" }] },
    });
    expect(load.media).toEqual([
      expect.objectContaining({ entryKey: "hero", assetId: own.id, alt: "Our team", width: 1600, height: 900, contentPath: `/api/assets/${own.id}/content` }),
    ]);
    expect(JSON.stringify(load)).not.toContain(foreign.id);
    const media = (await http.get(`${siteUrl}/media`).expect(200)).body;
    expect(media.map((item: { entryKey: string }) => item.entryKey)).toEqual(["hero"]);
  });

  it("media entries (GRE-2202): the route takes a same-company asset with alt text and refuses the rest", async () => {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const a = await seedWorld("Alpha", "alpha.test");
    const b = await seedWorld("Bravo", "bravo.test");
    const http = request(app());
    const siteUrl = `/api/companies/${a.company.id}/website/sites/${a.site.id}`;
    const own = await seedAsset(a.company.id, "harbour");
    const foreign = await seedAsset(b.company.id, "bravo-logo");
    const post = (entryKey: string, content: unknown) => http.post(`${siteUrl}/entries`).send({ collection: "media", entryKey, content });
    const valid = { assetId: own.id, alt: "Boats in a harbour at dawn", caption: null, focalPoint: { x: 0.5, y: 0.25 } };

    const created = (await post("studio-image-1", valid).expect(201)).body;
    expect(created).toMatchObject({ collection: "media", entryKey: "studio-image-1" });
    const media = (await http.get(`${siteUrl}/media`).expect(200)).body;
    expect(media).toEqual([expect.objectContaining({ entryKey: "studio-image-1", assetId: own.id, alt: "Boats in a harbour at dawn", caption: null })]);
    // Caption and focal point are optional.
    await post("bare", { assetId: own.id, alt: "Harbour" }).expect(201);

    const refused = async (entryKey: string, content: unknown, code: string) => {
      const response = await post(entryKey, content).expect(422);
      expect(JSON.stringify(response.body), entryKey).toContain(code);
    };
    await refused("stolen", { ...valid, assetId: foreign.id }, "website_media_asset_not_found");
    await refused("missing-asset", { ...valid, assetId: randomUUID() }, "website_media_asset_not_found");
    await refused("not-uuid", { ...valid, assetId: "asset-1" }, "website_media_fields_invalid");
    await refused("empty-alt", { ...valid, alt: "" }, "website_media_fields_invalid");
    await refused("blank-alt", { ...valid, alt: "   " }, "website_media_fields_invalid");
    await refused("no-alt", { assetId: own.id }, "website_media_fields_invalid");
    await refused("focal-high", { ...valid, focalPoint: { x: 1.5, y: 0.5 } }, "website_media_fields_invalid");
    await refused("focal-low", { ...valid, focalPoint: { x: 0.5, y: -0.1 } }, "website_media_fields_invalid");
    await refused("focal-half", { ...valid, focalPoint: { x: 0.5 } }, "website_media_fields_invalid");
    await refused("caption-number", { ...valid, caption: 3 }, "website_media_fields_invalid");
    await refused("no-content", undefined, "website_media_fields_invalid");
    const keys = (await http.get(`${siteUrl}/entries?collection=media`).expect(200)).body.map((item: { entryKey: string }) => item.entryKey);
    expect(keys.sort()).toEqual(["bare", "studio-image-1"]);

    // A save of the entry is checked the same way.
    const entryUrl = `${siteUrl}/entries/${created.id}`;
    const detail = (await http.get(entryUrl).expect(200)).body;
    await http.put(`${entryUrl}/content`).send({ content: { ...valid, assetId: foreign.id }, baseRevisionId: detail.latestRevisionId }).expect(422);
    await http.put(`${entryUrl}/content`).send({ content: { ...valid, alt: "" }, baseRevisionId: detail.latestRevisionId }).expect(422);
    await http.put(`${entryUrl}/content`).send({ content: { ...valid, alt: "Fishing boats" }, baseRevisionId: detail.latestRevisionId }).expect(200);
  });

  it("gsamServedOrigins lists the public URL and each allowed hostname", () => {
    expect(gsamServedOrigins("https://gsam.example.test/app", ["gsam.tail.ts.net", " "])).toEqual([
      "https://gsam.example.test",
      "https://gsam.tail.ts.net",
      "http://gsam.tail.ts.net",
    ]);
  });
});
