import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, issues, projects, websiteProperties, websiteRelease, websiteSite } from "@greatstone/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { raiseWebsitePendingAlerts, WEBSITE_PENDING_LONG_ORIGIN_KIND } from "../services/website/pending-alert.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres website pending alert tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

const MINUTE = 60_000;

// GRE-2132: a release Pending 30 minutes raises one alert (copy
// `alert.pending_long`) and never retries, publishes or calls Netlify.
describeEmbeddedPostgres("website 30-minute Pending alert", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-website-pending-alert-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(websiteRelease);
    await db.delete(websiteSite);
    await db.delete(websiteProperties);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(opts: { withProject?: boolean } = {}) {
    const [company] = await db
      .insert(companies)
      .values({ name: "Greatstone", issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}` })
      .returning();
    const agent = (name: string, role: string) =>
      db
        .insert(agents)
        .values({ companyId: company!.id, name, role, adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
        .returning()
        .then((rows) => rows[0]!);
    const chief = await agent("Everest", "ceo");
    const lead = await agent("Website lead", "engineer");
    let propertyId: string | null = null;
    let projectId: string | null = null;
    if (opts.withProject) {
      const [project] = await db.insert(projects).values({ companyId: company!.id, name: "Website", leadAgentId: lead.id }).returning();
      const [property] = await db
        .insert(websiteProperties)
        .values({ companyId: company!.id, name: "Greatstone", siteUrl: "https://www.greatstone.test", projectId: project!.id })
        .returning();
      propertyId = property!.id;
      projectId = project!.id;
    }
    const [site] = await db
      .insert(websiteSite)
      .values({ companyId: company!.id, name: "Greatstone site", domain: "www.greatstone.test", netlifySiteId: "netlify-site", propertyId })
      .returning();
    let number = 0;
    const release = async (status: string, minutesAgo: number, extra: Partial<typeof websiteRelease.$inferInsert> = {}) => {
      number += 1;
      const at = new Date(Date.now() - minutesAgo * MINUTE);
      const [row] = await db
        .insert(websiteRelease)
        .values({
          companyId: company!.id,
          siteId: site!.id,
          number,
          manifest: {},
          status,
          pendingReason: status === "pending" ? "verify_failed" : null,
          publishedByUserId: "person-1",
          switchedAt: at,
          updatedAt: at,
          ...extra,
        })
        .returning();
      return row!;
    };
    return { company: company!, site: site!, chief, lead, projectId, release };
  }

  async function alertsFor(releaseId: string) {
    const rows = await db.select().from(issues).where(eq(issues.originKind, WEBSITE_PENDING_LONG_ORIGIN_KIND));
    return rows.filter((row) => row.originId === releaseId);
  }

  it("raises one alert for a release Pending 30 minutes, to the site's project lead, and not again on the next sweeps", async () => {
    const { site, lead, projectId, release } = await seed({ withProject: true });
    const pending = await release("pending", 31);

    expect(await raiseWebsitePendingAlerts(db)).toEqual({ raised: 1 });
    expect(await raiseWebsitePendingAlerts(db)).toEqual({ raised: 0 });
    expect(await raiseWebsitePendingAlerts(db)).toEqual({ raised: 0 });

    const alerts = await alertsFor(pending.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      title: `Release 1 of ${site.name} pending for 30 minutes`,
      status: "todo",
      priority: "high",
      assigneeAgentId: lead.id,
      projectId,
    });
    expect(alerts[0]!.description).toContain(
      `Release 1 of ${site.name} pending for 30 minutes. Reason: the live pages do not show this release yet. Rollback is offered to the person who started the Publish.`,
    );
  });

  it("is not raised before 30 minutes, nor for Live, superseded, failed or switched releases", async () => {
    const { release } = await seed();
    const young = await release("pending", 29);
    const others = [
      await release("live", 120, { liveAt: new Date(Date.now() - 120 * MINUTE) }),
      await release("superseded", 120),
      await release("failed", 120),
      await release("switched", 120),
      await release("checks_failed", 120),
    ];

    expect(await raiseWebsitePendingAlerts(db)).toEqual({ raised: 0 });
    for (const row of [young, ...others]) expect(await alertsFor(row.id)).toHaveLength(0);
  });

  it("is not raised again after a Retry (still Pending) or after a rollback supersedes the release", async () => {
    const { chief, release } = await seed();
    const pending = await release("pending", 45);
    expect(await raiseWebsitePendingAlerts(db)).toEqual({ raised: 1 });

    // A Retry keeps the release Pending and touches the row (deploy, updatedAt); the spell goes on.
    await db
      .update(websiteRelease)
      .set({ pendingReason: "build_failed", deploy: { method: "build", state: "error" }, updatedAt: new Date() })
      .where(eq(websiteRelease.id, pending.id));
    expect(await raiseWebsitePendingAlerts(db)).toEqual({ raised: 0 });

    // A rollback supersedes it.
    await db.update(websiteRelease).set({ status: "superseded", updatedAt: new Date() }).where(eq(websiteRelease.id, pending.id));
    expect(await raiseWebsitePendingAlerts(db)).toEqual({ raised: 0 });

    const alerts = await alertsFor(pending.id);
    expect(alerts).toHaveLength(1);
    // No project for the site: the company's lead agent gets it.
    expect(alerts[0]!.assigneeAgentId).toBe(chief.id);
  });

  it("makes no Netlify or network call and does not change the release", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { release } = await seed({ withProject: true });
    const pending = await release("pending", 40, { deploy: { method: "build", deployId: "deploy-1", state: "error" } });
    const before = (await db.select().from(websiteRelease).where(eq(websiteRelease.id, pending.id)))[0]!;

    expect(await raiseWebsitePendingAlerts(db)).toEqual({ raised: 1 });

    expect(fetchSpy).not.toHaveBeenCalled();
    const after = (await db.select().from(websiteRelease).where(eq(websiteRelease.id, pending.id)))[0]!;
    expect(after).toEqual(before);

    // Source guard: the sweep cannot reach Netlify, the vault or the publish job.
    const source = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "services", "website", "pending-alert.ts"),
      "utf8",
    );
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.filter((spec) => /netlify|publish|secret/i.test(spec!))).toEqual([]);
    expect(source).not.toMatch(/\.(startBuild|restoreDeploy|putBlob|startPublish|retry|rollback)\(/);
  });
});
