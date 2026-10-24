import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
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
  issues,
  principalPermissionGrants,
  projects,
  websiteFeature,
  websitePage,
  websiteRelease,
  websiteSite,
  websiteSitemapOption,
} from "@greatstone/db";
import {
  createWebsiteFeatureSchema,
  websiteFeatureForPath,
  type ImportWebsiteSitemapOption,
  type WebsiteFeature,
  type WebsiteFeatureCard,
  type WebsiteFeatureDetail,
  type WebsiteSitemapApproveResult,
  type WebsiteSitemapOption,
} from "@greatstone/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { websiteModuleRoutes } from "../routes/website-module.js";
import { websiteFeaturesRoutes } from "../routes/website-features.js";
import { featureHealth, keyFromName, lastReleaseTouching, toWebsiteFeature } from "../services/website/features.js";
import { instanceSettingsService } from "../services/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

type Actor = Express.Request["actor"];

const GREATSTONE_COMPANY_ID = "34dad57e-b5ad-4a72-9400-9eba645c99f6";

/** Greatstone's six as migration 0392 seeds them (route prefixes from the Rev 10 sitemap). Test data only. */
const SIX = [
  { key: "public-site", name: "Public site", routePrefixes: ["/", "/consultancy", "/proof", "/insights", "/about", "/support", "/search", "/privacy", "/cookies", "/terms", "/refunds"] },
  { key: "shop", name: "Shop and licences", routePrefixes: ["/dev-tools", "/account/orders", "/account/quotes", "/account/licences"] },
  { key: "client-portal", name: "Client portal", routePrefixes: ["/account", "/portal"] },
  { key: "deep-dive", name: "Deep Dive portal", routePrefixes: ["/consultancy/deep-dive", "/portal/:client/deep-dive", "/portal/:client/discovery", "/portal/:client/blueprint"] },
  { key: "front-door", name: "Front door and enquiries", routePrefixes: ["/contact", "/consultancy/executive-discovery", "/newsletter"] },
  { key: "intelligence-hub", name: "Intelligence hub", routePrefixes: ["/consultancy/ai-market-intelligence"] },
];

/** The migration's last statement: the Greatstone-only seed. */
async function greatstoneSeedStatement() {
  const migration = await readFile(new URL("../../../packages/db/src/migrations/0392_website_features.sql", import.meta.url), "utf8");
  const statement = migration.split("--> statement-breakpoint").pop()!;
  expect(statement).toContain('INSERT INTO "website_feature"');
  return statement;
}

describe("websiteFeatureForPath", () => {
  const features = SIX;
  const keyOf = (path: string) => websiteFeatureForPath(path, features)?.key ?? null;

  it("gives each Rev 10 path to the feature with the longest matching prefix", () => {
    expect(keyOf("/")).toBe("public-site");
    expect(keyOf("/consultancy/how-we-work")).toBe("public-site");
    expect(keyOf("/consultancy/deep-dive")).toBe("deep-dive");
    expect(keyOf("/consultancy/executive-discovery")).toBe("front-door");
    expect(keyOf("/consultancy/ai-market-intelligence")).toBe("intelligence-hub");
    expect(keyOf("/dev-tools/products/ironpdf")).toBe("shop");
    expect(keyOf("/account/orders")).toBe("shop");
    expect(keyOf("/account/organisation")).toBe("client-portal");
    expect(keyOf("/portal/:client/doc/:id")).toBe("client-portal");
    expect(keyOf("/portal/:client/deep-dive")).toBe("deep-dive");
    expect(keyOf("/contact")).toBe("front-door");
    // A prefix matches whole segments only.
    expect(keyOf("/contacts")).toBe("public-site");
  });

  it("makes a free key from the name", () => {
    expect(keyFromName("Shop and licences", new Set())).toBe("shop-and-licences");
    expect(keyFromName("Careers", new Set(["careers", "careers-2"]))).toBe("careers-3");
    expect(keyFromName("2026 launch", new Set())).toBe("feature-2026-launch");
    expect(keyFromName("!!!", new Set())).toBe("feature");
  });
});

describe("lastReleaseTouching and featureHealth", () => {
  const release = (number: number, pages: Array<[string, string]>, status = "superseded") => ({
    id: `r${number}`,
    number,
    status,
    manifest: { pages: pages.map(([pageId, revisionId]) => ({ pageId, revisionId })), entries: [] },
    liveAt: null,
    createdAt: new Date("2026-10-24T00:00:00Z"),
  });

  it("finds the newest release that changed, added or dropped one of the pages", () => {
    const releases = [
      release(3, [["a", "a2"], ["b", "b2"]], "live"),
      release(2, [["a", "a2"], ["b", "b1"]]),
      release(1, [["a", "a1"]]),
    ];
    expect(lastReleaseTouching(releases, new Set(["a"]), new Set())?.number).toBe(2);
    expect(lastReleaseTouching(releases, new Set(["b"]), new Set())?.number).toBe(3);
    expect(lastReleaseTouching(releases, new Set(["c"]), new Set())).toBeNull();
    // A release still building has no pages list yet and is skipped.
    expect(lastReleaseTouching([{ ...release(4, []), manifest: {} }, ...releases], new Set(["b"]), new Set())?.number).toBe(3);
  });

  it("is amber after a failed or pending release and green with traffic", () => {
    expect(featureHealth({ id: "r", number: 4, status: "failed", at: "" }, 120).state).toBe("attention");
    expect(featureHealth({ id: "r", number: 4, status: "pending", at: "" }, null).reason).toBe("Release 4 changed these pages and is pending.");
    expect(featureHealth(null, 12).state).toBe("ok");
    expect(featureHealth(null, null)).toEqual({ state: "unknown", reason: "No traffic or release data for these pages yet." });
  });
});

describeEmbeddedPostgres("website feature registry routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-website-features-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(websiteFeature);
    await db.delete(websiteRelease);
    await db.delete(websiteSitemapOption);
    await db.delete(websitePage);
    await db.delete(websiteSite);
    await db.delete(projects);
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
    instance.use("/api", websiteFeaturesRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function seedSite(name: string, domain: string) {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const [company] = await db.insert(companies).values({ name, issuePrefix: `M${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}` }).returning();
    const site = (await request(app()).post(`/api/companies/${company!.id}/website/sites`).send({ name, domain, netlifySiteId: "n" }).expect(201)).body;
    return { companyId: company!.id as string, siteId: site.id as string, base: `/api/companies/${company!.id}/website/sites/${site.id}` };
  }

  async function seedAgent(companyId: string, keys: string[]) {
    const [agent] = await db
      .insert(agents)
      .values({ companyId, name: "Lintel", role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
      .returning();
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agent!.id, status: "active", membershipRole: "member" });
    for (const key of keys) {
      await db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: agent!.id, permissionKey: key, scope: null });
    }
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id }).returning();
    return { actor: { type: "agent", agentId: agent!.id, companyId, runId: run!.id, source: "agent_key" } as Actor, agentId: agent!.id as string };
  }

  const rev10: ImportWebsiteSitemapOption = {
    name: "Rev 10 slice",
    pages: [
      {
        title: "Home",
        path: "/",
        children: [
          { title: "Deep Dive", path: "/consultancy/deep-dive" },
          { title: "Dev tools", path: "/dev-tools", children: [{ title: "IronPDF", path: "/dev-tools/products/ironpdf" }] },
          { title: "My account", path: "/account", noindex: true, children: [{ title: "Orders", path: "/account/orders", noindex: true }] },
          { title: "Begin the Conversation", path: "/contact" },
        ],
      },
    ],
  };

  async function addSix(base: string, http = request(app())) {
    const features: WebsiteFeature[] = [];
    for (const feature of SIX) features.push((await http.post(`${base}/features`).send(feature).expect(201)).body as WebsiteFeature);
    return features;
  }

  it("seeds Greatstone's six on Greatstone's site only; any other site starts empty", async () => {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    await db.insert(companies).values({ id: GREATSTONE_COMPANY_ID, name: "Greatstone International", issuePrefix: "GRT" });
    const greatstoneBase = `/api/companies/${GREATSTONE_COMPANY_ID}/website/sites`;
    const greatstone = (await request(app()).post(greatstoneBase).send({ name: "Greatstone", domain: "www.greatstone.co.uk", netlifySiteId: "n" }).expect(201)).body;
    const client = await seedSite("Client", "www.client.test");

    const seed = await greatstoneSeedStatement();
    await db.execute(sql.raw(seed));
    await db.execute(sql.raw(seed)); // Running it again adds nothing.

    const rows = await db.select().from(websiteFeature);
    expect(rows.every((row) => row.companyId === GREATSTONE_COMPANY_ID && row.siteId === greatstone.id)).toBe(true);
    const six = (await request(app()).get(`${greatstoneBase}/${greatstone.id}/features`).expect(200)).body as WebsiteFeature[];
    expect(six.map((feature) => feature.key)).toEqual(SIX.map((feature) => feature.key));
    expect(six.map((feature) => feature.routePrefixes)).toEqual(SIX.map((feature) => feature.routePrefixes));
    expect(six.find((feature) => feature.key === "deep-dive")).toMatchObject({ suggestedOwner: "Ben", ownerUserId: null });
    expect(six.find((feature) => feature.key === "front-door")!.adminScreens).toEqual([{ name: "Enquiries", issue: "GRE-2324" }, { name: "Forms", issue: "GRE-2324" }]);
    // Each seeded row is one the create form could have made.
    for (const row of rows) {
      const { id: _id, companyId: _c, siteId: _s, createdAt: _a, updatedAt: _u, ...input } = toWebsiteFeature(row);
      expect(createWebsiteFeatureSchema.safeParse(input).success, row.key).toBe(true);
    }
    expect((await request(app()).get(`${client.base}/features`).expect(200)).body).toEqual([]);
  });

  it("creates, changes, switches off and removes a feature; off and removed never touch pages", async () => {
    const { base, companyId } = await seedSite("Greatstone", "www.greatstone.test");
    const http = request(app());
    const option = (await http.post(`${base}/sitemap/options/import`).send(rev10).expect(201)).body as WebsiteSitemapOption;
    const approved = (await http.post(`${base}/sitemap/options/${option.id}/approve`).expect(200)).body as WebsiteSitemapApproveResult;
    const [project] = await db.insert(projects).values({ companyId, name: "Website" }).returning();

    const created = (await http.post(`${base}/features`).send({ name: "Careers", routePrefixes: ["/contact"], projectId: project!.id }).expect(201)).body as WebsiteFeature;
    expect(created).toMatchObject({ key: "careers", icon: "blocks", enabled: true, projectId: project!.id, adminScreens: [] });
    await http.post(`${base}/features`).send({ key: "careers", name: "Again" }).expect(409);
    expect((await http.post(`${base}/features`).send({ name: "Careers" }).expect(201)).body.key).toBe("careers-2");
    await http.post(`${base}/features`).send({ key: "x", name: "X", routePrefixes: ["/Bad Path"] }).expect(400);
    await http.post(`${base}/features`).send({ key: "y", name: "Y", ownerUserId: "nobody" }).expect(422);

    const off = (await http.patch(`${base}/features/${created.id}`).send({ enabled: false, name: "Jobs" }).expect(200)).body as WebsiteFeature;
    expect(off).toMatchObject({ enabled: false, name: "Jobs" });
    const detail = (await http.get(`${base}/features/${created.id}`).expect(200)).body as WebsiteFeatureDetail;
    expect(detail.pages.map((page) => page.slug)).toEqual(["/contact"]);

    await http.delete(`${base}/features/${created.id}`).expect(204);
    await http.get(`${base}/features/${created.id}`).expect(404);
    expect((await http.get(`${base}/pages`).expect(200)).body).toHaveLength(approved.pages.length);
    const actions = (await db.select().from(activityLog)).map((event) => event.action);
    expect(actions).toEqual(expect.arrayContaining(["website.feature_created", "website.feature_switched_off", "website.feature_removed"]));
  });

  it("builds the cards: pages by longest prefix, the last release that touched them, and the project's open tasks", async () => {
    const { base, companyId, siteId } = await seedSite("Greatstone", "www.greatstone.test");
    const http = request(app());
    const option = (await http.post(`${base}/sitemap/options/import`).send(rev10).expect(201)).body as WebsiteSitemapOption;
    const { pages } = (await http.post(`${base}/sitemap/options/${option.id}/approve`).expect(200)).body as WebsiteSitemapApproveResult;
    const features = await addSix(base, http);
    const shop = features.find((feature) => feature.key === "shop")!;
    const [project] = await db.insert(projects).values({ companyId, name: "Shop" }).returning();
    await http.patch(`${base}/features/${shop.id}`).send({ projectId: project!.id }).expect(200);
    await db.insert(issues).values([
      { companyId, projectId: project!.id, title: "Catalogue import", status: "todo" },
      { companyId, projectId: project!.id, title: "Approve prices", status: "in_review", assigneeUserId: "local-board" },
      { companyId, projectId: project!.id, title: "Old", status: "done" },
    ]);
    const page = (slug: string) => pages.find((entry) => entry.slug === slug)!.id;
    await db.insert(websiteRelease).values([
      { companyId, siteId, number: 1, status: "superseded", manifest: { pages: [{ pageId: page("/"), revisionId: "r1" }, { pageId: page("/dev-tools"), revisionId: "d1" }] } },
      { companyId, siteId, number: 2, status: "failed", manifest: { pages: [{ pageId: page("/"), revisionId: "r1" }, { pageId: page("/dev-tools"), revisionId: "d2" }] } },
    ]);

    const cards = (await http.get(`${base}/feature-cards`).expect(200)).body as WebsiteFeatureCard[];
    const card = (key: string) => cards.find((entry) => entry.feature.key === key)!;
    expect(card("shop")).toMatchObject({ pageCount: 3, openTasks: 2, needsPerson: 1, lastRelease: { number: 2, status: "failed" }, health: { state: "attention" } });
    expect(card("public-site")).toMatchObject({ pageCount: 1, openTasks: null, needsPerson: null, lastRelease: { number: 1 }, health: { state: "ok" } });
    expect(card("client-portal").pageCount).toBe(1);
    expect(card("deep-dive").pageCount).toBe(1);
    expect(card("front-door").pageCount).toBe(1);
    expect(card("intelligence-hub")).toMatchObject({ pageCount: 0, lastRelease: null, health: { state: "unknown" } });
  });

  it("lets an agent with website:view read the registry but never change it; other companies see 404", async () => {
    const { base, companyId } = await seedSite("Greatstone", "www.greatstone.test");
    await addSix(base);
    const viewer = await seedAgent(companyId, ["website:view"]);
    const reader = request(app(viewer.actor));
    expect((await reader.get(`${base}/features`).expect(200)).body).toHaveLength(6);
    const refused = await reader.post(`${base}/features`).send({ key: "z", name: "Z" }).expect(403);
    expect(refused.body.code).toBe("website_feature_agent_refused");
    const outsider = await seedAgent(companyId, []);
    await request(app(outsider.actor)).get(`${base}/features`).expect(403);

    const other = await seedSite("Other", "www.other.test");
    const otherBoardFeatures = await addSix(other.base);
    // The other company's feature id under this company's site is not found.
    await request(app()).get(`${base}/features/${otherBoardFeatures[0]!.id}`).expect(404);
    await request(app()).get(`${base}/features/not-a-uuid`).expect(404);
  });
});
