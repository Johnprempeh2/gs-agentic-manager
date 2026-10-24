import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  principalPermissionGrants,
  websiteEntry,
  websitePage,
  websiteRelease,
  websiteSite,
} from "@greatstone/db";
import type { WebsiteEntryDetail, WebsitePageDetail, WebsiteRelease, WebsiteSite } from "@greatstone/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { websiteModuleRoutes } from "../routes/website-module.js";
import { instanceSettingsService } from "../services/index.js";
import type { NetlifyDeploy, WebsiteNetlifyClient } from "../services/website/netlify-publish-client.js";
import { websitePublishService, type FetchedPage, type WebsitePublishOptions } from "../services/website/publish.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres website publish tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

type Actor = Express.Request["actor"];

/**
 * A fake Netlify site: Blobs, production deploys and the public pages. A
 * build bakes the release `current` points at into a new deploy; the public
 * pages show the release of the published deploy.
 */
function fakeNetlify() {
  const blobs = new Map<string, { body: string; contentType: string }>();
  const deploys = new Map<string, NetlifyDeploy & { release: number | null }>();
  const state = {
    engineCommit: "engine-1",
    publishedDeployId: null as string | null,
    nextBuild: "ready" as "ready" | "error" | "building",
    /** When set, the public pages show this release whatever is deployed (a stale cache). */
    stalePagesShow: null as number | null,
    builds: 0,
    restores: 0,
    engineDeploys: 0,
    fetches: 0,
    deploySeq: 0,
  };

  function currentRelease(): number | null {
    const current = blobs.get("current");
    return current ? (JSON.parse(current.body) as { release: number }).release : null;
  }

  function addDeploy(kind: "build" | "engine", outcome: "ready" | "error" | "building") {
    state.deploySeq += 1;
    const id = `deploy-${state.deploySeq}`;
    const deploy = { id, state: outcome, commitRef: state.engineCommit, createdAt: new Date().toISOString(), errorMessage: outcome === "error" ? "Build script returned non-zero exit code: 2" : null, release: currentRelease() };
    deploys.set(id, deploy);
    if (outcome === "ready") state.publishedDeployId = id;
    if (kind === "engine") state.engineDeploys += 1;
    return deploy;
  }

  const client: WebsiteNetlifyClient = {
    async blobExists(key) {
      return blobs.has(key);
    },
    async putBlob(key, body, contentType) {
      blobs.set(key, { body: body.toString(), contentType });
    },
    async startBuild() {
      state.builds += 1;
      return { deployId: addDeploy("build", state.nextBuild).id };
    },
    async getDeploy(deployId) {
      return deploys.get(deployId) ?? null;
    },
    async findProductionDeploySince(since) {
      const found = [...deploys.values()].filter((d) => Date.parse(d.createdAt!) >= since.getTime() - 5_000);
      return found.at(-1) ?? null;
    },
    async publishedDeploy() {
      return state.publishedDeployId ? deploys.get(state.publishedDeployId) ?? null : null;
    },
    async restoreDeploy(deployId) {
      state.restores += 1;
      const deploy = deploys.get(deployId);
      if (!deploy) throw new Error("no such deploy");
      state.publishedDeployId = deployId;
      return deploy;
    },
  };

  async function fetchPage(url: string): Promise<FetchedPage> {
    state.fetches += 1;
    const published = state.publishedDeployId ? deploys.get(state.publishedDeployId) : null;
    const release = state.stalePagesShow ?? published?.release ?? null;
    const headers = new Headers();
    if (new URL(url).pathname === "/_release") return { status: 200, headers, body: JSON.stringify({ release }) };
    return { status: 200, headers, body: `<html><head><meta name="gsam-release" content="${release}"></head><body>ok</body></html>` };
  }

  return {
    client,
    blobs,
    deploys,
    state,
    fetchPage,
    currentRelease,
    /** A merged engine pull request: a new production deploy with new code. */
    engineDeploy(commit: string) {
      state.engineCommit = commit;
      addDeploy("engine", "ready");
    },
  };
}

// GRE-2108: Publish and rollback. The three tests the task names come first:
// an agent key cannot Publish; no code path publishes without a person's
// click; one Publish makes exactly one production deploy.
describeEmbeddedPostgres("website publish and rollback", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const keyFolder = mkdtempSync(path.join(os.tmpdir(), "paperclip-website-publish-key-"));
  const previousKeyFile = process.env.GSAM_SECRETS_MASTER_KEY_FILE;

  let netlify = fakeNetlify();
  let deferred: Array<() => Promise<void>> = [];
  let deferJobs = false;
  let running: Promise<void>[] = [];

  function publishOptions(): WebsitePublishOptions {
    return {
      netlifyFor: async () => netlify.client,
      fetchPage: (url) => netlify.fetchPage(url),
      readAsset: async () => Buffer.from("image-bytes"),
      runInBackground: (job) => {
        if (deferJobs) deferred.push(job);
        else running.push(job());
      },
      timing: { deployPollMs: 1, deployTimeoutMs: 30, verifyRounds: 2, verifyDelayMs: 1 },
    };
  }

  /** Waits for every background job the routes started. */
  async function settle() {
    while (running.length) {
      const batch = running;
      running = [];
      await Promise.all(batch);
    }
  }

  beforeAll(async () => {
    process.env.GSAM_SECRETS_MASTER_KEY_FILE = path.join(keyFolder, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-website-publish-");
    db = createDb(tempDb.connectionString);
  });

  beforeEach(async () => {
    netlify = fakeNetlify();
    deferred = [];
    deferJobs = false;
    running = [];
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
  });

  afterEach(async () => {
    await settle();
    await db.delete(activityLog);
    await db.delete(websiteRelease);
    await db.delete(websiteEntry);
    await db.delete(websitePage);
    await db.delete(websiteSite);
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
    instance.use(express.json({ limit: "10mb" }));
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", websiteModuleRoutes(db, { publish: publishOptions() }));
    instance.use(errorHandler);
    return instance;
  }

  async function seedSite() {
    const [company] = await db
      .insert(companies)
      .values({ name: "Greatstone", issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}` })
      .returning();
    const http = request(app());
    const site = (await http
      .post(`/api/companies/${company!.id}/website/sites`)
      .send({ name: "Site", domain: "www.greatstone.test", netlifySiteId: "netlify-site", netlifyToken: "nfp_test_token_value_123", checkPaths: ["/", "/about"] })
      .expect(201)).body as WebsiteSite;
    const page = (await http
      .post(`/api/companies/${company!.id}/website/sites/${site.id}/pages`)
      .send({ slug: "/", title: "Home", content: { root: { props: { title: "Home v1" } }, content: [] } })
      .expect(201)).body as WebsitePageDetail;
    return { company: company!, site, page, base: `/api/companies/${company!.id}/website/sites/${site.id}` };
  }

  async function approveLatest(pageId: string) {
    const [page] = await db.select().from(websitePage).where(eq(websitePage.id, pageId));
    const [doc] = await db.select().from(documents).where(eq(documents.id, page!.documentId));
    await db.update(websitePage).set({ approvedRevisionId: doc!.latestRevisionId, status: "approved" }).where(eq(websitePage.id, pageId));
    return doc!.latestRevisionId!;
  }

  async function saveAndApprove(base: string, pageId: string, title: string) {
    const [page] = await db.select().from(websitePage).where(eq(websitePage.id, pageId));
    const [doc] = await db.select().from(documents).where(eq(documents.id, page!.documentId));
    await request(app())
      .put(`${base}/pages/${pageId}/content`)
      .send({ baseRevisionId: doc!.latestRevisionId, content: { root: { props: { title } }, content: [] } })
      .expect(200);
    return approveLatest(pageId);
  }

  async function publish(base: string, actor: Actor = localBoard) {
    const res = await request(app(actor)).post(`${base}/releases`).send({}).expect(202);
    await settle();
    return releaseById(res.body.id);
  }

  async function releaseById(id: string) {
    const [row] = await db.select().from(websiteRelease).where(eq(websiteRelease.id, id));
    return row!;
  }

  async function seedAgent(companyId: string, grantKeys: string[]) {
    const [agent] = await db
      .insert(agents)
      .values({ companyId, name: `Agent ${randomUUID().slice(0, 4)}`, role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
      .returning();
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agent!.id, status: "active", membershipRole: "member" });
    for (const key of grantKeys) {
      // Inserted directly, as an import could.
      await db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: agent!.id, permissionKey: key, scope: null });
    }
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id }).returning();
    return { type: "agent", agentId: agent!.id, companyId, runId: run!.id, source: "agent_key" } as Actor;
  }

  async function releaseCount(siteId: string) {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(websiteRelease).where(eq(websiteRelease.siteId, siteId));
    return row!.n;
  }

  // ---- the three required tests ----

  it("an agent key cannot Publish, Retry or Roll back, even with a website:publish grant row", async () => {
    const { company, site, page, base } = await seedSite();
    await approveLatest(page.id);
    const live = await publish(base);
    expect(live.status).toBe("live");
    const buildsBefore = netlify.state.builds;

    const agent = await seedAgent(company.id, ["website:view", "website:edit", "website:publish"]);
    const refused = await request(app(agent)).post(`${base}/releases`).send({}).expect(403);
    expect(refused.body.details?.code).toBe("website_publish_agent_refused");
    await request(app(agent)).post(`${base}/releases/${live.id}/retry`).send({}).expect(403);
    await request(app(agent)).post(`${base}/releases/${live.id}/rollback`).send({ confirmRebuild: true }).expect(403);
    await settle();

    expect(await releaseCount(site.id)).toBe(1);
    expect(netlify.state.builds).toBe(buildsBefore);
    expect(netlify.state.restores).toBe(0);
    // An agent can still read the release list with website:view.
    await request(app(agent)).get(`${base}/releases`).expect(200);
  });

  it("no code path publishes without a person's click", async () => {
    const { company, site, page, base } = await seedSite();
    await approveLatest(page.id);

    // A board API key is a script, not a click.
    const boardKey = { type: "board", userId: "owner-1", source: "board_key", keyId: "key-1", isInstanceAdmin: true, companyIds: [company.id], memberships: [{ companyId: company.id, membershipRole: "owner", status: "active" }] } as Actor;
    const refused = await request(app(boardKey)).post(`${base}/releases`).send({}).expect(403);
    expect(refused.body.details?.code).toBe("website_publish_person_only");

    // Reading plans, approving content and restarting the server never deploy.
    await request(app()).get(`${base}/releases`).expect(200);
    await websitePublishService(db, publishOptions()).recoverOnStartup();
    await settle();
    expect(await releaseCount(site.id)).toBe(0);
    expect(netlify.state.builds + netlify.state.restores).toBe(0);
    expect(netlify.blobs.size).toBe(0);

    // Source guard: only the routes start a publish, retry or rollback, each
    // after personClick(req); only the publish service calls Netlify's build
    // and restore.
    const serverSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== "__tests__" && name !== "node_modules") walk(full);
        } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) files.push(full);
      }
    };
    walk(serverSrc);
    const callers = (pattern: RegExp) => files.filter((f) => pattern.test(readFileSync(f, "utf8"))).map((f) => path.relative(serverSrc, f));
    expect(callers(/\.(startPublish|retry|rollback)\(\s*(found\.)?site/)).toEqual([path.join("routes", "website-module.ts")]);
    expect(callers(/\.(startBuild|restoreDeploy)\(/)).toEqual([path.join("services", "website", "publish.ts")]);
    const routes = readFileSync(path.join(serverSrc, "routes", "website-module.ts"), "utf8");
    const handlers = routes.split("router.").filter((h) => /publish\.(startPublish|retry|rollback)\(/.test(h));
    expect(handlers).toHaveLength(3);
    for (const handler of handlers) {
      expect(handler.indexOf("personClick(req)")).toBeGreaterThan(-1);
      expect(handler.indexOf("personClick(req)")).toBeLessThan(handler.search(/publish\.(startPublish|retry|rollback)\(/));
    }
  });

  it("one Publish makes exactly one production deploy, then shows Live", async () => {
    const { site, page, base } = await seedSite();
    const revisionId = await approveLatest(page.id);
    const release = await publish(base);

    expect(netlify.state.builds).toBe(1);
    expect(netlify.state.restores).toBe(0);
    expect(release.status).toBe("live");
    expect(release.number).toBe(1);
    expect(release.publishedByUserId).toBe("local-board");
    expect(release.blobsKey).toBe("releases/1.json");
    expect(netlify.blobs.has("releases/1.json")).toBe(true);
    const current = JSON.parse(netlify.blobs.get("current")!.body);
    expect(current).toMatchObject({ schema: 1, release: 1, key: "releases/1.json", sha256: release.releaseSha256 });
    const file = JSON.parse(netlify.blobs.get("releases/1.json")!.body);
    expect(file).toMatchObject({ schema: 1, siteId: site.id, release: 1 });
    expect(file.pages[0].content.root.props.title).toBe("Home v1");
    expect((release.deploy as { state: string }).state).toBe("ready");
    expect((release.checks as Array<{ kind: string; ok: boolean }>).filter((c) => c.kind === "verify").every((c) => c.ok)).toBe(true);

    const [siteRow] = await db.select().from(websiteSite).where(eq(websiteSite.id, site.id));
    expect(siteRow!.liveReleaseId).toBe(release.id);
    expect(siteRow!.publishLeaseId).toBeNull();
    const [pageRow] = await db.select().from(websitePage).where(eq(websitePage.id, page.id));
    expect(pageRow!.publishedRevisionId).toBe(revisionId);
    expect(pageRow!.status).toBe("published");

    // A second Publish supersedes the first; still one deploy per Publish.
    await saveAndApprove(base, page.id, "Home v2");
    const second = await publish(base);
    expect(second.status).toBe("live");
    expect(netlify.state.builds).toBe(2);
    expect((await releaseById(release.id)).status).toBe("superseded");
  });

  it("publishes approved collection fields under the engine release key and keeps an unapproved draft out", async () => {
    const { page, base } = await seedSite();
    await approveLatest(page.id);
    const fields = { data: { id: "category-1", slug: "annotation", name: "Annotation", description: "Approved" } };
    const entry = (await request(app()).post(`${base}/entries`)
      .send({ collection: "category", entryKey: "annotation", content: fields }).expect(201)).body as WebsiteEntryDetail;
    await request(app()).post(`${base}/entries/${entry.id}/submit`).send({}).expect(200);
    await request(app()).post(`${base}/entries/${entry.id}/approve`).send({}).expect(200);

    const first = await publish(base);
    expect(first.status).toBe("live");
    const firstFile = JSON.parse(netlify.blobs.get("releases/1.json")!.body);
    expect(firstFile.collections.categories[0]).toMatchObject({ key: "annotation", fields });
    expect(firstFile.collections.category).toBeUndefined();

    await request(app()).put(`${base}/entries/${entry.id}/content`)
      .send({ baseRevisionId: entry.latestRevisionId, content: { data: { ...fields.data, description: "Unapproved" } } }).expect(200);
    const second = await publish(base);
    expect(second.status).toBe("live");
    const secondFile = JSON.parse(netlify.blobs.get("releases/2.json")!.body);
    expect(secondFile.collections.categories[0].fields).toEqual(fields);
  });

  // ---- lease and fence ----

  it("refuses a second Publish while one runs, with the running release id", async () => {
    const { page, base } = await seedSite();
    await approveLatest(page.id);
    deferJobs = true;
    const first = await request(app()).post(`${base}/releases`).send({}).expect(202);
    const second = await request(app()).post(`${base}/releases`).send({}).expect(409);
    expect(second.body.details).toMatchObject({ code: "website_publish_running", runningReleaseId: first.body.id });
    for (const job of deferred) running.push(job());
    await settle();
    expect((await releaseById(first.body.id)).status).toBe("live");
    expect(netlify.state.builds).toBe(1);
  });

  it("a job that lost its lease never writes current and never builds", async () => {
    const { site, page, base } = await seedSite();
    await approveLatest(page.id);
    deferJobs = true;
    const first = await request(app()).post(`${base}/releases`).send({}).expect(202);
    // The job hung past its lease and another publish took over.
    await db
      .update(websiteSite)
      .set({ publishLeaseId: randomUUID(), publishFence: sql`${websiteSite.publishFence} + 1`, publishLeaseExpiresAt: sql`now() + interval '10 minutes'` })
      .where(eq(websiteSite.id, site.id));
    for (const job of deferred) running.push(job());
    await settle();
    const stale = await releaseById(first.body.id);
    expect(stale.status).toBe("failed");
    expect(netlify.blobs.has("current")).toBe(false);
    expect(netlify.state.builds).toBe(0);
    // The stale job did not free the newer job's lease.
    const [siteRow] = await db.select().from(websiteSite).where(eq(websiteSite.id, site.id));
    expect(siteRow!.publishLeaseId).not.toBeNull();
  });

  it("failed checks upload nothing, build nothing and free the lease", async () => {
    const { site, base } = await seedSite();
    // No page is approved.
    const release = await publish(base);
    expect(release.status).toBe("checks_failed");
    expect((release.checks as Array<{ name: string; ok: boolean }>).find((c) => c.name === "has_pages")?.ok).toBe(false);
    expect(netlify.blobs.size).toBe(0);
    expect(netlify.state.builds).toBe(0);
    const [siteRow] = await db.select().from(websiteSite).where(eq(websiteSite.id, site.id));
    expect(siteRow!.publishLeaseId).toBeNull();
  });

  // ---- Pending and Retry ----

  it("Pending case A: the build worked but the pages are stale; Retry checks again for free", async () => {
    const { page, base } = await seedSite();
    await approveLatest(page.id);
    netlify.state.stalePagesShow = 0;
    const release = await publish(base);
    expect(release.status).toBe("pending");
    expect(release.pendingReason).toBe("verify_failed");
    expect(netlify.state.builds).toBe(1);

    const plan = await request(app()).get(`${base}/releases/${release.id}/retry`).expect(200);
    expect(plan.body).toMatchObject({ action: "verify", costsCredits: false });

    netlify.state.stalePagesShow = null;
    await request(app()).post(`${base}/releases/${release.id}/retry`).send({}).expect(202);
    await settle();
    expect((await releaseById(release.id)).status).toBe("live");
    expect(netlify.state.builds).toBe(1);
  });

  it("Pending case B: the build failed; Retry needs the rebuild confirmed, then makes exactly one new build", async () => {
    const { page, base } = await seedSite();
    await approveLatest(page.id);
    netlify.state.nextBuild = "error";
    const release = await publish(base);
    expect(release.status).toBe("pending");
    expect(release.pendingReason).toBe("build_failed");

    const plan = await request(app()).get(`${base}/releases/${release.id}/retry`).expect(200);
    expect(plan.body).toMatchObject({ action: "build", costsCredits: true });
    const unconfirmed = await request(app()).post(`${base}/releases/${release.id}/retry`).send({}).expect(409);
    expect(unconfirmed.body.details?.code).toBe("website_rebuild_needs_confirm");
    expect(netlify.state.builds).toBe(1);

    netlify.state.nextBuild = "ready";
    await request(app()).post(`${base}/releases/${release.id}/retry`).send({ confirmRebuild: true }).expect(202);
    await settle();
    expect((await releaseById(release.id)).status).toBe("live");
    expect(netlify.state.builds).toBe(2);
  });

  it("only a Pending release can be retried", async () => {
    const { page, base } = await seedSite();
    await approveLatest(page.id);
    const release = await publish(base);
    const res = await request(app()).post(`${base}/releases/${release.id}/retry`).send({}).expect(409);
    expect(res.body.details?.code).toBe("website_release_not_pending");
  });

  // ---- rollback ----

  it("rollback by restore makes zero new production deploys and brings the old release back", async () => {
    const { site, page, base } = await seedSite();
    const firstRevision = await approveLatest(page.id);
    const first = await publish(base);
    await saveAndApprove(base, page.id, "Home v2");
    await publish(base);
    expect(netlify.state.builds).toBe(2);

    const plan = await request(app()).get(`${base}/releases/${first.id}/rollback`).expect(200);
    expect(plan.body).toMatchObject({ action: "restore", costsCredits: false });
    const res = await request(app()).post(`${base}/releases/${first.id}/rollback`).send({}).expect(202);
    await settle();

    expect(netlify.state.builds).toBe(2);
    expect(netlify.state.restores).toBe(1);
    const rollback = await releaseById(res.body.id);
    expect(rollback).toMatchObject({ kind: "rollback", number: 3, rollbackOfReleaseId: first.id, status: "live", blobsKey: "releases/1.json" });
    expect(netlify.currentRelease()).toBe(1);
    const [siteRow] = await db.select().from(websiteSite).where(eq(websiteSite.id, site.id));
    expect(siteRow!.liveReleaseId).toBe(rollback.id);
    const [pageRow] = await db.select().from(websitePage).where(eq(websitePage.id, page.id));
    expect(pageRow!.publishedRevisionId).toBe(firstRevision);
  });

  it("rollback after a code deploy needs the rebuild confirmed, then makes exactly one production deploy", async () => {
    const { page, base } = await seedSite();
    await approveLatest(page.id);
    const first = await publish(base);
    await saveAndApprove(base, page.id, "Home v2");
    await publish(base);
    netlify.engineDeploy("engine-2");
    const buildsBefore = netlify.state.builds;

    const plan = await request(app()).get(`${base}/releases/${first.id}/rollback`).expect(200);
    expect(plan.body).toMatchObject({ action: "build", costsCredits: true });
    const unconfirmed = await request(app()).post(`${base}/releases/${first.id}/rollback`).send({}).expect(409);
    expect(unconfirmed.body.details?.code).toBe("website_rebuild_needs_confirm");

    const res = await request(app()).post(`${base}/releases/${first.id}/rollback`).send({ confirmRebuild: true }).expect(202);
    await settle();
    expect(netlify.state.builds).toBe(buildsBefore + 1);
    expect(netlify.state.restores).toBe(0);
    expect((await releaseById(res.body.id)).status).toBe("live");
    expect(netlify.currentRelease()).toBe(1);
  });

  it("rollback from Pending is free: the Live release's deploy goes back and the Pending one is superseded", async () => {
    const { page, base } = await seedSite();
    await approveLatest(page.id);
    const first = await publish(base);
    await saveAndApprove(base, page.id, "Home v2");
    netlify.state.nextBuild = "error";
    const stuck = await publish(base);
    expect(stuck.status).toBe("pending");
    const buildsBefore = netlify.state.builds;

    const plan = await request(app()).get(`${base}/releases/${first.id}/rollback`).expect(200);
    expect(plan.body).toMatchObject({ action: "restore", costsCredits: false });
    const res = await request(app()).post(`${base}/releases/${first.id}/rollback`).send({}).expect(202);
    await settle();
    expect(netlify.state.builds).toBe(buildsBefore);
    expect((await releaseById(res.body.id)).status).toBe("live");
    expect((await releaseById(stuck.id)).status).toBe("superseded");
    expect(netlify.currentRelease()).toBe(1);
  });

  it("refuses to roll back to a release whose file is missing", async () => {
    const { page, base } = await seedSite();
    await approveLatest(page.id);
    const first = await publish(base);
    await saveAndApprove(base, page.id, "Home v2");
    await publish(base);
    netlify.blobs.delete("releases/1.json");
    const res = await request(app()).post(`${base}/releases/${first.id}/rollback`).send({}).expect(409);
    expect(res.body.details?.code).toBe("website_rollback_file_missing");
    expect(netlify.state.restores).toBe(0);
  });

  // ---- server restart (ADR 4.2) ----

  it("on restart: half-built releases fail, switched ones go Pending, leases free, and nothing deploys", async () => {
    const { company, site } = await seedSite();
    const insert = (number: number, status: string) =>
      db.insert(websiteRelease).values({ companyId: company.id, siteId: site.id, number, kind: "publish", manifest: {}, status }).returning().then((r) => r[0]!);
    const building = await insert(1, "building");
    const switched = await insert(2, "switched");
    await db.update(websiteSite).set({ publishLeaseId: switched.id, publishLeaseKind: "publish", publishLeaseExpiresAt: sql`now() + interval '10 minutes'` }).where(eq(websiteSite.id, site.id));

    // A Publish clicked after the restart is not touched.
    const startedAt = new Date(Date.now() + 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const fresh = await insert(3, "building");
    const result = await websitePublishService(db, publishOptions()).recoverOnStartup({ untouchedSince: startedAt });
    expect(result).toEqual({ failed: 1, pending: 1 });
    expect((await releaseById(fresh.id)).status).toBe("building");
    expect((await releaseById(building.id)).status).toBe("failed");
    expect(await releaseById(switched.id)).toMatchObject({ status: "pending", pendingReason: "server_restarted" });
    const [siteRow] = await db.select().from(websiteSite).where(eq(websiteSite.id, site.id));
    expect(siteRow!.publishLeaseId).toBeNull();
    expect(netlify.state.builds + netlify.state.restores + netlify.state.fetches).toBe(0);
  });

  it("Retry after a restart finds the build that already ran instead of starting a second one", async () => {
    const { page, base, site } = await seedSite();
    await approveLatest(page.id);
    const release = await publish(base);
    expect(netlify.state.builds).toBe(1);
    // As if the server died after asking for the build but before saving its id.
    await db
      .update(websiteRelease)
      .set({ status: "pending", pendingReason: "server_restarted", deploy: { method: "build", requestedAt: new Date(Date.now() - 1_000).toISOString(), deployId: null, commitRef: null, state: "requested" } })
      .where(and(eq(websiteRelease.id, release.id), eq(websiteRelease.siteId, site.id)));

    const plan = await request(app()).get(`${base}/releases/${release.id}/retry`).expect(200);
    expect(plan.body).toMatchObject({ action: "verify", costsCredits: false });
    await request(app()).post(`${base}/releases/${release.id}/retry`).send({}).expect(202);
    await settle();
    expect((await releaseById(release.id)).status).toBe("live");
    expect(netlify.state.builds).toBe(1);
  });

  it("returns releases newest first to a viewer and hides other companies' releases", async () => {
    const { page, base } = await seedSite();
    await approveLatest(page.id);
    await publish(base);
    const list = (await request(app()).get(`${base}/releases`).expect(200)).body as WebsiteRelease[];
    expect(list.map((r) => r.number)).toEqual([1]);
    expect(JSON.stringify(list)).not.toContain("nfp_test_token_value_123");
    const other = `/api/companies/${randomUUID()}/website/sites/${randomUUID()}/releases/${list[0]!.id}`;
    await request(app()).get(other).expect(404);
  });
});
