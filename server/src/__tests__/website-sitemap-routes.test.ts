import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  instanceSettings,
  principalPermissionGrants,
  websitePage,
  websiteSite,
  websiteSitemapOption,
} from "@greatstone/db";
import {
  diffSitemapTrees,
  importWebsiteSitemapOptionSchema,
  sitemapTreeFromImport,
  sitemapTreeProblems,
  websiteSitemapTreeSchema,
  type ImportWebsiteSitemapOption,
  type WebsiteHomeSummary,
  type WebsitePage,
  type WebsiteSitemapApproveResult,
  type WebsiteSitemapOption,
  type WebsiteSitemapTree,
} from "@greatstone/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { websiteModuleRoutes } from "../routes/website-module.js";
import { buildSitemapXml } from "../services/website/sitemap.js";
import { framingFromHeaders } from "../services/website/home.js";
import { instanceSettingsService } from "../services/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

type Actor = Express.Request["actor"];

describe("diffSitemapTrees", () => {
  const node = (id: string, title: string, path: string, parentId: string | null, pageId?: string) => ({
    id, title, path, parentId, order: 0, menu: "none" as const, menuOrder: null, ...(pageId ? { pageId } : {}),
  });
  it("marks added, removed, moved and renamed pages", () => {
    const a: WebsiteSitemapTree = {
      nodes: [node("1", "Home", "/", null), node("2", "About", "/about", "1"), node("3", "Old", "/old", "1"), node("4", "Team", "/team", "1", "p4")],
      journeys: [],
    };
    const b: WebsiteSitemapTree = {
      nodes: [node("a", "Home", "/", null), node("b", "About us", "/about", "a"), node("c", "New", "/new", "a"), node("d", "Team", "/about/team", "b", "p4")],
      journeys: [],
    };
    const byPath = new Map(diffSitemapTrees(a, b).map((entry) => [(entry.b ?? entry.a)!.path, entry.changes]));
    expect(byPath.get("/")).toEqual([]);
    expect(byPath.get("/about")).toEqual(["renamed"]);
    expect(byPath.get("/old")).toEqual(["removed"]);
    expect(byPath.get("/new")).toEqual(["added"]);
    // Same site page under a new path and parent: one moved page, not a remove and an add.
    expect(byPath.get("/about/team")).toEqual(["moved"]);
  });

  it("pairs a page with a new address by its title when no site page links them (GRE-2193)", () => {
    const a: WebsiteSitemapTree = {
      nodes: [
        node("1", "Services", "/services", null),
        node("2", "Business website build", "/services/business-website-build", "1"),
        node("3", "SEO", "/services/seo", "1"),
        node("4", "Overview", "/services/web-overview", "1"),
        node("5", "Overview", "/services/seo-overview", "1"),
        node("6", "Retainer", "/services/retainer", "1"),
      ],
      journeys: [],
    };
    const b: WebsiteSitemapTree = {
      nodes: [
        node("a", "Services", "/services", null),
        node("b", "Websites and web apps", "/services/websites-web-apps", "a"),
        node("c", "Business website build", "/services/websites-web-apps/business-website-build", "b"),
        node("d", "SEO", "/services/seo", "a"),
        node("e", "Overview", "/services/websites-web-apps/overview", "b"),
        node("f", "Overview", "/services/growth/overview", "a"),
      ],
      journeys: [],
    };
    const diff = diffSitemapTrees(a, b);
    const moved = diff.find((entry) => entry.a?.id === "2")!;
    // One moved row, with both addresses, not a removed row and an added row.
    expect(moved.b?.id).toBe("c");
    expect(moved.changes).toEqual(["moved"]);
    expect(diff.find((entry) => entry.a?.id === "3")!.changes).toEqual([]);
    // A title on two pages is not unique, so those stay removed and added.
    expect(diff.filter((entry) => entry.a?.title === "Overview" || entry.b?.title === "Overview").map((entry) => entry.changes)).toEqual([
      ["removed"], ["removed"], ["added"], ["added"],
    ]);
    expect(diff.find((entry) => entry.a?.id === "6")!.changes).toEqual(["removed"]);
    expect(diff.find((entry) => entry.b?.id === "b")!.changes).toEqual(["added"]);
  });
});

describe("framingFromHeaders", () => {
  it("reads X-Frame-Options and CSP frame-ancestors", () => {
    expect(framingFromHeaders(new Headers({ "x-frame-options": "SAMEORIGIN" }))).toBe("refused");
    expect(framingFromHeaders(new Headers({ "content-security-policy": "default-src 'self'; frame-ancestors 'none'" }))).toBe("refused");
    expect(framingFromHeaders(new Headers({ "content-security-policy": "frame-ancestors *" }))).toBe("allowed");
    expect(framingFromHeaders(new Headers({ "content-security-policy": "default-src 'self'" }))).toBe("allowed");
    expect(framingFromHeaders(new Headers())).toBe("allowed");
  });
});

describe("private pattern pages", () => {
  const portal: ImportWebsiteSitemapOption = {
    name: "Portal lane",
    pages: [
      {
        title: "Home",
        path: "/",
        children: [
          { title: "Portal overview", path: "/portal/:client/overview" },
          { title: "Insight", path: "/insights/:slug" },
        ],
      },
    ],
  };

  it("accepts :param paths and still refuses badly formed ones", () => {
    expect(importWebsiteSitemapOptionSchema.safeParse(portal).success).toBe(true);
    for (const path of ["/portal/:/overview", "/portal/:1client", "/Portal", "/portal/#packages", "/portal/"]) {
      expect(importWebsiteSitemapOptionSchema.safeParse({ name: "x", pages: [{ title: "x", path }] }).success, path).toBe(false);
    }
  });

  it("imports pattern pages as noindex and never as menu links", () => {
    const tree = sitemapTreeFromImport(portal);
    expect(tree.nodes.find((node) => node.path === "/portal/:client/overview")).toMatchObject({ menu: "none", noindex: true });
    expect(tree.nodes.find((node) => node.path === "/")!.noindex).toBe(false);
    expect(websiteSitemapTreeSchema.safeParse(tree).success).toBe(true);
    const inMenu = structuredClone(tree);
    inMenu.nodes[1]!.menu = "header";
    expect(sitemapTreeProblems(inMenu)).toEqual(["Portal overview is a private page (/portal/:client/overview) and cannot be a menu link."]);
  });

  it("leaves pattern pages out of sitemap.xml even when not marked noindex", () => {
    const updatedAt = new Date("2026-10-23T00:00:00Z");
    const xml = buildSitemapXml("www.example.test", [
      { slug: "/", seo: {}, updatedAt },
      { slug: "/portal/:client/overview", seo: {}, updatedAt },
    ]);
    expect(xml).toContain("<loc>https://www.example.test/</loc>");
    expect(xml).not.toContain("portal");
  });
});

describeEmbeddedPostgres("website sitemap routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-website-sitemap-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(websiteSitemapOption);
    await db.delete(websitePage);
    await db.delete(websiteSite);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const localBoard: Actor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };

  function app(actor: Actor = localBoard) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", websiteModuleRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function seedSite(name: string, domain: string) {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const [company] = await db.insert(companies).values({ name, issuePrefix: `S${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}` }).returning();
    const site = (await request(app()).post(`/api/companies/${company!.id}/website/sites`).send({ name, domain, netlifySiteId: "n" }).expect(201)).body;
    return { companyId: company!.id as string, siteId: site.id as string, base: `/api/companies/${company!.id}/website/sites/${site.id}` };
  }

  async function seedAgent(companyId: string, keys: string[]) {
    const [agent] = await db
      .insert(agents)
      .values({ companyId, name: "Mikey", role: "designer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
      .returning();
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agent!.id, status: "active", membershipRole: "member" });
    for (const key of keys) {
      await db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: agent!.id, permissionKey: key, scope: null });
    }
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id }).returning();
    return { type: "agent", agentId: agent!.id, companyId, runId: run!.id, source: "agent_key" } as Actor;
  }

  const optionA: ImportWebsiteSitemapOption = {
    name: "Option A: two doors",
    pages: [
      {
        title: "Home",
        path: "/",
        children: [
          {
            title: "DX Consultancy",
            path: "/consultancy",
            menu: "header",
            menuOrder: 1,
            children: [
              { title: "How we work", path: "/consultancy/how-we-work", menu: "header", menuOrder: 1, menuColumn: "Consultancy" },
              { title: "Executive Discovery", path: "/consultancy/executive-discovery", seoTitle: "Executive Discovery | Greatstone" },
              { title: "Deep Dive", path: "/consultancy/deep-dive" },
            ],
          },
          { title: "DX Dev Tools", path: "/tools", menu: "header", menuOrder: 2 },
          { title: "Privacy", path: "/privacy", menu: "footer", menuOrder: 1, menuColumn: "Legal" },
          { title: "Client sign-in", path: "/portal", noindex: true },
        ],
      },
    ],
    journeys: [{ name: "Leader", paths: ["/", "/consultancy", "/consultancy/how-we-work", "/consultancy/executive-discovery", "/consultancy/deep-dive"] }],
  };

  it("sums up the site for the Home: page counts, the approved option, options awaiting review and recent events (GRE Website Home)", async () => {
    const { base, siteId } = await seedSite("Greatstone", "www.greatstone.test");
    const http = request(app());
    const empty = (await http.get(`${base}/home`).expect(200)).body as WebsiteHomeSummary;
    expect(empty.pages).toEqual({ planned: 0, draft: 0, review: 0, approved: 0, published: 0 });
    expect(empty.sitemap).toEqual({ approved: null, awaitingReview: 0 });
    expect(empty.releases).toEqual({ latest: null, live: null });
    expect(empty.publishApproval).toBeNull();

    const a = (await http.post(`${base}/sitemap/options/import`).send(optionA).expect(201)).body as WebsiteSitemapOption;
    await http.post(`${base}/sitemap/options/${a.id}/approve`).expect(200);
    await http.post(`${base}/sitemap/options/import`).send({ ...optionA, name: "Option B" }).expect(201);
    const home = (await http.get(`${base}/home`).expect(200)).body as WebsiteHomeSummary;
    expect(home.pages.planned).toBe(8);
    expect(home.sitemap.approved).toMatchObject({ id: a.id, name: "Option A: two doors", changedSinceApproval: false });
    expect(home.sitemap.awaitingReview).toBe(1);
    expect(home.activity[0]).toMatchObject({ action: "website.sitemap_option_imported", subject: "Option B", actorName: "Board" });
    expect(home.activity.map((event) => event.action)).toContain("website.sitemap_option_approved");
    expect(home.activity.length).toBeLessThanOrEqual(8);

    // Another company's site is not found, never forbidden.
    const other = await seedSite("Other", "www.other.test");
    await http.get(`/api/companies/${other.companyId}/website/sites/${siteId}/home`).expect(404);
  });

  it("lets an agent propose and import options, but only a person approves", async () => {
    const { companyId, base } = await seedSite("Greatstone", "www.greatstone.test");
    const agent = await seedAgent(companyId, ["website:view", "website:edit", "website:publish"]);
    const imported = (await request(app(agent)).post(`${base}/sitemap/options/import`).send(optionA).expect(201)).body as WebsiteSitemapOption;
    expect(imported.status).toBe("draft");
    expect(imported.proposedByAgentId).toBe((agent as { agentId: string }).agentId);
    expect(imported.tree.nodes).toHaveLength(8);
    expect(imported.tree.journeys[0]!.steps).toHaveLength(5);
    await request(app(agent)).post(`${base}/sitemap/options/${imported.id}/approve`).expect(403);
    const pages = (await request(app()).get(`${base}/pages`).expect(200)).body;
    expect(pages).toHaveLength(0);
  });

  it("approving writes planned pages with parents, menus and SEO; a second option moves, renames and archives", async () => {
    const { base } = await seedSite("Greatstone", "www.greatstone.test");
    const http = request(app());
    const a = (await http.post(`${base}/sitemap/options/import`).send(optionA).expect(201)).body as WebsiteSitemapOption;
    const first = (await http.post(`${base}/sitemap/options/${a.id}/approve`).expect(200)).body as WebsiteSitemapApproveResult;
    expect(first.summary).toEqual({ created: 8, updated: 0, archived: 0 });
    expect(first.option.status).toBe("approved");
    expect(first.option.tree.nodes.every((node) => node.pageId)).toBe(true);
    const bySlug = new Map(first.pages.map((page) => [page.slug, page]));
    expect(bySlug.get("/consultancy")).toMatchObject({ status: "planned", menu: "header", menuOrder: 1, parentPageId: bySlug.get("/")!.id });
    expect(bySlug.get("/consultancy/deep-dive")!.parentPageId).toBe(bySlug.get("/consultancy")!.id);
    expect(bySlug.get("/consultancy/executive-discovery")!.seo).toMatchObject({ title: "Executive Discovery | Greatstone" });
    expect(bySlug.get("/portal")!.seo).toMatchObject({ noindex: true });

    // Option B: Deep Dive moves to the top level and swaps paths with Dev Tools' old place, Privacy goes.
    const tree: WebsiteSitemapTree = structuredClone(first.option.tree);
    const deepDive = tree.nodes.find((node) => node.path === "/consultancy/deep-dive")!;
    const tools = tree.nodes.find((node) => node.path === "/tools")!;
    deepDive.parentId = tree.nodes.find((node) => node.path === "/")!.id;
    deepDive.path = "/tools";
    tools.path = "/dev-tools";
    tools.title = "Developer tools";
    tree.nodes = tree.nodes.filter((node) => node.path !== "/privacy");
    const b = (await http.post(`${base}/sitemap/options`).send({ name: "Option B", tree }).expect(201)).body as WebsiteSitemapOption;
    const second = (await http.post(`${base}/sitemap/options/${b.id}/approve`).expect(200)).body as WebsiteSitemapApproveResult;
    expect(second.summary).toEqual({ created: 0, updated: 7, archived: 1 });
    const after = new Map(second.pages.map((page: WebsitePage) => [page.slug, page]));
    expect(after.get("/tools")!.id).toBe(bySlug.get("/consultancy/deep-dive")!.id);
    expect(after.get("/tools")!.parentPageId).toBe(bySlug.get("/")!.id);
    expect(after.get("/dev-tools")).toMatchObject({ id: bySlug.get("/tools")!.id, title: "Developer tools" });
    expect(after.has("/privacy")).toBe(false);
    const options = (await http.get(`${base}/sitemap/options`).expect(200)).body as WebsiteSitemapOption[];
    expect(options.map((option) => [option.name, option.status])).toEqual([["Option A: two doors", "draft"], ["Option B", "approved"]]);
  });

  it("refuses a stale save, an invalid tree and archiving the approved option", async () => {
    const { base } = await seedSite("Greatstone", "www.greatstone.test");
    const http = request(app());
    const a = (await http.post(`${base}/sitemap/options/import`).send(optionA).expect(201)).body as WebsiteSitemapOption;
    const renamed = (await http.put(`${base}/sitemap/options/${a.id}`).send({ name: "Renamed", baseUpdatedAt: a.updatedAt }).expect(200)).body;
    await http.put(`${base}/sitemap/options/${a.id}`).send({ name: "Stale", baseUpdatedAt: a.updatedAt }).expect(409);
    const cyclic = structuredClone(a.tree);
    cyclic.nodes[0]!.parentId = cyclic.nodes[1]!.id;
    await http.put(`${base}/sitemap/options/${a.id}`).send({ tree: cyclic, baseUpdatedAt: renamed.updatedAt }).expect(400);
    const duplicate = structuredClone(a.tree);
    duplicate.nodes[2]!.path = duplicate.nodes[1]!.path;
    await http.put(`${base}/sitemap/options/${a.id}`).send({ tree: duplicate }).expect(400);
    await http.post(`${base}/sitemap/options/${a.id}/approve`).expect(200);
    await http.post(`${base}/sitemap/options/${a.id}/archive`).expect(422);
    // An approved option edited later says so until it is approved again.
    const edited = (await http.put(`${base}/sitemap/options/${a.id}`).send({ description: "More" }).expect(200)).body as WebsiteSitemapOption;
    expect(edited.changedSinceApproval).toBe(true);
  });

  it("builds sitemap.xml from live, non-noindex pages", async () => {
    const { base } = await seedSite("Greatstone", "www.greatstone.test");
    const http = request(app());
    const a = (await http.post(`${base}/sitemap/options/import`).send(optionA).expect(201)).body as WebsiteSitemapOption;
    await http.post(`${base}/sitemap/options/${a.id}/approve`).expect(200);
    const xml = await http.get(`${base}/sitemap.xml`).expect(200);
    expect(xml.headers["content-type"]).toContain("application/xml");
    expect(xml.text).toContain("<loc>https://www.greatstone.test/</loc>");
    expect(xml.text).toContain("<loc>https://www.greatstone.test/consultancy/deep-dive</loc>");
    expect(xml.text).not.toContain("/portal");
    expect(xml.text.match(/<url>/g)).toHaveLength(7);
  });

  it("imports and approves a private portal page, which sitemap.xml leaves out and no menu may link", async () => {
    const { base } = await seedSite("Greatstone", "www.greatstone.test");
    const http = request(app());
    const withPortal = structuredClone(optionA);
    withPortal.pages[0]!.children!.push({ title: "Portal overview", path: "/portal/:client/overview" });
    const a = (await http.post(`${base}/sitemap/options/import`).send(withPortal).expect(201)).body as WebsiteSitemapOption;
    const approved = (await http.post(`${base}/sitemap/options/${a.id}/approve`).expect(200)).body as WebsiteSitemapApproveResult;
    expect(approved.pages.find((page) => page.slug === "/portal/:client/overview")).toMatchObject({ menu: "none", seo: { noindex: true } });
    const xml = await http.get(`${base}/sitemap.xml`).expect(200);
    expect(xml.text).not.toContain(":client");
    expect(xml.text.match(/<url>/g)).toHaveLength(7);
    const inMenu = structuredClone(approved.option.tree);
    inMenu.nodes.find((node) => node.path === "/portal/:client/overview")!.menu = "footer";
    await http.put(`${base}/sitemap/options/${a.id}`).send({ tree: inMenu }).expect(400);
    await http.post(`${base}/sitemap/options/import`).send({ name: "Bad", pages: [{ title: "Portal", path: "/portal/:client", menu: "header" }] }).expect(422);
  });

  it("keeps options inside their company: A gets 404 for B's options", async () => {
    const a = await seedSite("Alpha", "alpha.test");
    const b = await seedSite("Bravo", "bravo.test");
    const optionB = (await request(app()).post(`${b.base}/sitemap/options/import`).send(optionA).expect(201)).body as WebsiteSitemapOption;
    const userA = await (async () => {
      const userId = `user-${randomUUID().slice(0, 6)}`;
      await db.insert(companyMemberships).values({ companyId: a.companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
      return { type: "board", userId, source: "session", isInstanceAdmin: false, companyIds: [a.companyId], memberships: [{ companyId: a.companyId, membershipRole: "owner", status: "active" }] } as Actor;
    })();
    const http = request(app(userA));
    await http.get(`/api/companies/${a.companyId}/website/sites/${a.siteId}/sitemap/options/${optionB.id}`).expect(404);
    await http.post(`/api/companies/${a.companyId}/website/sites/${a.siteId}/sitemap/options/${optionB.id}/approve`).expect(404);
    await http.get(`/api/companies/${a.companyId}/website/sites/${b.siteId}/sitemap/options`).expect(404);
    await http.get(`/api/companies/${a.companyId}/website/sites/${b.siteId}/sitemap.xml`).expect(404);
    const listed = (await http.get(`/api/companies/${a.companyId}/website/sites/${a.siteId}/sitemap/options`).expect(200)).body;
    expect(listed).toEqual([]);
  });
});
