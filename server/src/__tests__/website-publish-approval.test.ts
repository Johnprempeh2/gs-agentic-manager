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
  agentWakeupRequests,
  agents,
  approvalComments,
  approvals,
  companies,
  companyMemberships,
  companySecrets,
  companySecretVersions,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  instanceSettings,
  issueApprovals,
  principalPermissionGrants,
  websiteEntry,
  websitePage,
  websiteRelease,
  websiteSite,
} from "@greatstone/db";
import type { WebsitePageDetail, WebsiteSite } from "@greatstone/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { approvalRoutes } from "../routes/approvals.js";
import { websiteModuleRoutes } from "../routes/website-module.js";
import { accessService, instanceSettingsService } from "../services/index.js";
import { HttpError } from "../errors.js";
import { WEBSITE_MESSAGES } from "../services/website/messages.js";
import { registerWebsitePublishStarter } from "../services/website/publish-approval.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres website publish approval tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

type Actor = Express.Request["actor"];

// GRE-2109 (plan 2.5 and 2.6, ADR GRE-1914 section 6): agents draft, submit
// and propose; only a person with website:publish for the site approves a
// page or a Publish, and "Approve and Publish" starts it in that person's name.
describeEmbeddedPostgres("website publish approvals", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const keyFolder = mkdtempSync(path.join(os.tmpdir(), "paperclip-website-publish-key-"));
  const previousKeyFile = process.env.GSAM_SECRETS_MASTER_KEY_FILE;

  beforeAll(async () => {
    process.env.GSAM_SECRETS_MASTER_KEY_FILE = path.join(keyFolder, "master.key");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-website-publish-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    registerWebsitePublishStarter(null);
    await db.delete(activityLog);
    await db.delete(issueApprovals);
    await db.delete(approvalComments);
    await db.delete(approvals);
    await db.delete(websiteRelease);
    await db.delete(websiteEntry);
    await db.delete(websitePage);
    await db.delete(websiteSite);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agentWakeupRequests);
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
    instance.use("/api", websiteModuleRoutes(db));
    instance.use("/api", approvalRoutes(db));
    instance.use(errorHandler);
    return instance;
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

  async function seedAgent(companyId: string, grantKeys: string[], name = "Quill") {
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

  async function seedWorld(name: string, domain: string) {
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const [company] = await db
      .insert(companies)
      .values({ name, issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}` })
      .returning();
    const http = request(app());
    const site = (await http
      .post(`/api/companies/${company!.id}/website/sites`)
      .send({ name: `${name} site`, domain, netlifySiteId: `netlify-${domain}` })
      .expect(201)).body as WebsiteSite;
    const base = `/api/companies/${company!.id}/website/sites/${site.id}`;
    return { company: company!, site, base };
  }

  /** An agent drafts a page and sends it for review; returns the page. */
  async function agentDraftsAndSubmits(base: string, agent: Actor, slug = "/about") {
    const http = request(app(agent));
    const page = (await http.post(`${base}/pages`).send({ slug, title: "About" }).expect(201)).body as WebsitePageDetail;
    const saved = await http
      .put(`${base}/pages/${page.id}/content`)
      .send({ baseRevisionId: page.latestRevisionId, content: { root: { props: {} }, content: [{ type: "Hero", props: { id: "h1", title: "Hello" } }] } })
      .expect(200);
    const submitted = await http.post(`${base}/pages/${page.id}/submit`).expect(200);
    expect(submitted.body.status).toBe("review");
    return { page, revisionId: saved.body.revisionId as string };
  }

  it("2.6: an agent with website:edit reads, drafts and submits; a person approves the latest revision", async () => {
    const { company, base } = await seedWorld("Alpha", "alpha.test");
    const { actor: agent } = await seedAgent(company.id, ["website:view", "website:edit"]);
    const { page, revisionId } = await agentDraftsAndSubmits(base, agent);

    const read = await request(app(agent)).get(`${base}/pages/${page.id}`).expect(200);
    expect(read.body.content.content[0].props.title).toBe("Hello");

    const refused = await request(app(agent)).post(`${base}/pages/${page.id}/approve`).expect(403);
    expect(refused.body.error).toBe(WEBSITE_MESSAGES["agent.approve_refused"]);

    const owner = await seedUser(company.id, "owner");
    const approved = await request(app(owner)).post(`${base}/pages/${page.id}/approve`).expect(200);
    expect(approved.body).toMatchObject({ status: "approved", approvedRevisionId: revisionId });
  });

  it("a person sends a page back to draft; only pages in review can be sent back", async () => {
    const { company, base } = await seedWorld("Alpha", "alpha.test");
    const { actor: agent } = await seedAgent(company.id, ["website:view", "website:edit"]);
    const { page } = await agentDraftsAndSubmits(base, agent);
    const owner = await seedUser(company.id, "owner");
    await request(app(owner)).post(`${base}/pages/${page.id}/send-back`).send({}).expect(400);
    const back = await request(app(owner)).post(`${base}/pages/${page.id}/send-back`).send({ note: "Shorter title" }).expect(200);
    expect(back.body.status).toBe("draft");
    await request(app(owner)).post(`${base}/pages/${page.id}/send-back`).send({ note: "Again" }).expect(422);
    await request(app(agent)).post(`${base}/pages/${page.id}/send-back`).send({ note: "Self" }).expect(403);
  });

  it("an operator (edit, no publish) can submit but not approve", async () => {
    const { company, base } = await seedWorld("Alpha", "alpha.test");
    const operator = await seedUser(company.id, "operator");
    const page = (await request(app(operator)).post(`${base}/pages`).send({ slug: "/x", title: "X" }).expect(201)).body;
    await request(app(operator)).post(`${base}/pages/${page.id}/submit`).expect(200);
    const refused = await request(app(operator)).post(`${base}/pages/${page.id}/approve`).expect(403);
    expect(refused.body.error).toBe(WEBSITE_MESSAGES["perm.publish_none"]);
  });

  it("a planned page cannot be sent for review", async () => {
    const { company, base } = await seedWorld("Alpha", "alpha.test");
    const { actor: agent } = await seedAgent(company.id, ["website:view", "website:edit"]);
    const page = (await request(app(agent)).post(`${base}/pages`).send({ slug: "/later", title: "Later", status: "planned" }).expect(201)).body;
    const refused = await request(app(agent)).post(`${base}/pages/${page.id}/submit`).expect(422);
    expect(refused.body.error).toBe(WEBSITE_MESSAGES["review.planned"]);
  });

  it("2.5: an agent proposes a Publish; a second proposal returns the open one", async () => {
    const { company, site, base } = await seedWorld("Alpha", "alpha.test");
    const { agent, actor } = await seedAgent(company.id, ["website:view", "website:edit"], "Quill");
    const nothing = await request(app(actor)).post(`${base}/publish-proposals`).expect(422);
    expect(nothing.body.error).toBe(WEBSITE_MESSAGES["proposal.publish.nothing"]);

    const { page, revisionId } = await agentDraftsAndSubmits(base, actor);
    const owner = await seedUser(company.id, "owner");
    await request(app(owner)).post(`${base}/pages/${page.id}/approve`).expect(200);

    const proposed = await request(app(actor)).post(`${base}/publish-proposals`).expect(201);
    expect(proposed.body).toMatchObject({
      type: "website_publish",
      status: "pending",
      requestedByAgentId: agent.id,
      payload: {
        siteId: site.id,
        title: "Quill proposes a Publish",
        summary: "1 change is ready. Approving starts a Publish in your name. It costs about 15 credits.",
        changeCount: 1,
        manifest: { pages: [{ pageId: page.id, revisionId }], entries: [] },
      },
    });
    const again = await request(app(actor)).post(`${base}/publish-proposals`).expect(200);
    expect(again.body.id).toBe(proposed.body.id);
  });

  it("the generic approval routes cannot create or rewrite a Publish proposal", async () => {
    const { company, base } = await seedWorld("Alpha", "alpha.test");
    const { actor } = await seedAgent(company.id, ["website:view", "website:edit"]);
    await request(app(actor))
      .post(`/api/companies/${company.id}/approvals`)
      .send({ type: "website_publish", payload: { siteId: randomUUID() } })
      .expect(422);
    const { page } = await agentDraftsAndSubmits(base, actor);
    await request(app()).post(`${base}/pages/${page.id}/approve`).expect(200);
    const proposal = (await request(app(actor)).post(`${base}/publish-proposals`).expect(201)).body;
    const owner = await seedUser(company.id, "owner");
    await request(app(owner)).post(`/api/approvals/${proposal.id}/request-revision`).send({ decisionNote: "Wait" }).expect(200);
    await request(app(actor)).post(`/api/approvals/${proposal.id}/resubmit`).send({ payload: { siteId: randomUUID() } }).expect(422);
  });

  it("Approve and Publish: only a person with publish rights for the site; the Publish runs in their name", async () => {
    const { company, site, base } = await seedWorld("Alpha", "alpha.test");
    const { agent, actor } = await seedAgent(company.id, ["website:view", "website:edit"]);
    const { page, revisionId } = await agentDraftsAndSubmits(base, actor);
    await request(app()).post(`${base}/pages/${page.id}/approve`).expect(200);
    const proposal = (await request(app(actor)).post(`${base}/publish-proposals`).expect(201)).body;

    // The agent cannot approve (approvals are for people), nor can an operator, nor a publish grant for another site.
    await request(app(actor)).post(`/api/approvals/${proposal.id}/approve`).send({}).expect(403);
    const operator = await seedUser(company.id, "operator");
    const noRights = await request(app(operator)).post(`/api/approvals/${proposal.id}/approve`).send({}).expect(403);
    expect(noRights.body.error).toBe(WEBSITE_MESSAGES["proposal.publish.no_rights"]);
    const scopedElsewhere = await seedUser(company.id, "operator", [{ key: "website:publish", scope: { siteIds: [randomUUID()] } }]);
    await request(app(scopedElsewhere)).post(`/api/approvals/${proposal.id}/approve`).send({}).expect(403);

    // No publish job on this server yet: 503 and the proposal stays open.
    const owner = await seedUser(company.id, "owner");
    const unavailable = await request(app(owner)).post(`/api/approvals/${proposal.id}/approve`).send({}).expect(503);
    expect(unavailable.body.error).toBe(WEBSITE_MESSAGES["proposal.publish.unavailable"]);
    const [stillOpen] = await db.select().from(approvals).where(eq(approvals.id, proposal.id));
    expect(stillOpen!.status).toBe("pending");

    // A publish grant scoped to this site is enough.
    const scopedHere = await seedUser(company.id, "operator", [{ key: "website:publish", scope: { siteIds: [site.id] } }]);
    const starter = vi.fn(async () => ({ releaseId: "release-1" }));
    registerWebsitePublishStarter(starter);
    const approved = await request(app(scopedHere)).post(`/api/approvals/${proposal.id}/approve`).send({}).expect(200);
    expect(approved.body).toMatchObject({ status: "approved", decidedByUserId: scopedHere.userId, payload: { releaseId: "release-1" } });
    expect(starter).toHaveBeenCalledTimes(1);
    expect(starter).toHaveBeenCalledWith({
      companyId: company.id,
      siteId: site.id,
      approvalId: proposal.id,
      publishedByUserId: scopedHere.userId,
      requestedByAgentId: agent.id,
      requestedByUserId: null,
      manifest: { pages: [{ pageId: page.id, revisionId }], entries: [] },
    });
  });

  it("a board actor with no user cannot decide a Publish: it must run in a person's name", async () => {
    const { company, base } = await seedWorld("Alpha", "alpha.test");
    const { actor } = await seedAgent(company.id, ["website:view", "website:edit"]);
    const { page } = await agentDraftsAndSubmits(base, actor);
    await request(app()).post(`${base}/pages/${page.id}/approve`).expect(200);
    const proposal = (await request(app(actor)).post(`${base}/publish-proposals`).expect(201)).body;
    const starter = vi.fn(async () => ({ releaseId: "r" }));
    registerWebsitePublishStarter(starter);
    const noUser = { type: "board", source: "local_implicit", isInstanceAdmin: true } as Actor;
    for (const decision of ["approve", "reject", "request-revision"]) {
      const refused = await request(app(noUser)).post(`/api/approvals/${proposal.id}/${decision}`).send({ decisionNote: "x" }).expect(403);
      expect(refused.body.error).toBe(WEBSITE_MESSAGES["proposal.publish.person_only"]);
    }
    expect(starter).not.toHaveBeenCalled();
    const [row] = await db.select().from(approvals).where(eq(approvals.id, proposal.id));
    expect(row!.status).toBe("pending");
  });

  it("the card is pinned: new changes replace the open proposal, and a stale card cannot start a Publish", async () => {
    const { company, base } = await seedWorld("Alpha", "alpha.test");
    const { actor } = await seedAgent(company.id, ["website:view", "website:edit"]);
    const owner = await seedUser(company.id, "owner");
    const starter = vi.fn(async () => ({ releaseId: "r" }));
    registerWebsitePublishStarter(starter);
    const first = await agentDraftsAndSubmits(base, actor, "/about");
    await request(app(owner)).post(`${base}/pages/${first.page.id}/approve`).expect(200);
    const oldCard = (await request(app(actor)).post(`${base}/publish-proposals`).expect(201)).body;

    // A second page is approved after the card was made: the old card no longer matches.
    const second = await agentDraftsAndSubmits(base, actor, "/contact");
    await request(app(owner)).post(`${base}/pages/${second.page.id}/approve`).expect(200);
    const moved = await request(app(owner)).post(`/api/approvals/${oldCard.id}/approve`).send({}).expect(409);
    expect(moved.body.error).toBe(WEBSITE_MESSAGES["proposal.publish.changed"]);
    expect(starter).not.toHaveBeenCalled();

    // Proposing again does not rewrite the old card; it replaces it with a new one.
    const newCard = (await request(app(actor)).post(`${base}/publish-proposals`).expect(201)).body;
    expect(newCard.id).not.toBe(oldCard.id);
    expect(newCard.payload.changeCount).toBe(2);
    const [old] = await db.select().from(approvals).where(eq(approvals.id, oldCard.id));
    expect(old).toMatchObject({ status: "cancelled", payload: { changeCount: 1 } });
    await request(app(owner)).post(`/api/approvals/${oldCard.id}/approve`).send({}).expect(422);

    await request(app(owner)).post(`/api/approvals/${newCard.id}/approve`).send({}).expect(200);
    expect(starter).toHaveBeenCalledWith(expect.objectContaining({ manifest: newCard.payload.manifest }));
  });

  it("if the Publish cannot start, the approval reopens and the approver sees why", async () => {
    const { company, base } = await seedWorld("Alpha", "alpha.test");
    const { actor } = await seedAgent(company.id, ["website:view", "website:edit"]);
    const { page } = await agentDraftsAndSubmits(base, actor);
    await request(app()).post(`${base}/pages/${page.id}/approve`).expect(200);
    const proposal = (await request(app(actor)).post(`${base}/publish-proposals`).expect(201)).body;
    registerWebsitePublishStarter(async () => {
      throw new HttpError(409, "A Publish is running for this site.", { code: "website_publish_busy" });
    });
    const owner = await seedUser(company.id, "owner");
    const busy = await request(app(owner)).post(`/api/approvals/${proposal.id}/approve`).send({}).expect(409);
    expect(busy.body.error).toBe("A Publish is running for this site.");
    const [row] = await db.select().from(approvals).where(eq(approvals.id, proposal.id));
    expect(row).toMatchObject({ status: "pending", decidedByUserId: null, decidedAt: null });
  });

  it("Not now: a person declines; the page stays approved for the next Publish", async () => {
    const { company, base } = await seedWorld("Alpha", "alpha.test");
    const { actor } = await seedAgent(company.id, ["website:view", "website:edit"]);
    const { page } = await agentDraftsAndSubmits(base, actor);
    await request(app()).post(`${base}/pages/${page.id}/approve`).expect(200);
    const proposal = (await request(app(actor)).post(`${base}/publish-proposals`).expect(201)).body;
    const operator = await seedUser(company.id, "operator");
    await request(app(operator)).post(`/api/approvals/${proposal.id}/reject`).send({}).expect(403);
    const owner = await seedUser(company.id, "owner");
    await request(app(owner)).post(`/api/approvals/${proposal.id}/reject`).send({}).expect(200);
    const after = await request(app(owner)).get(`${base}/pages/${page.id}`).expect(200);
    expect(after.body.status).toBe("approved");
  });

  it("agent refusals use the copy's words: publish routes and publish grants", async () => {
    const { company, site, base } = await seedWorld("Alpha", "alpha.test");
    const { agent, actor } = await seedAgent(company.id, ["website:view", "website:edit"]);
    const settings = await request(app(actor)).patch(base).send({ name: "Renamed" }).expect(403);
    expect(settings.body.error).toBe(WEBSITE_MESSAGES["agent.publish_refused"]);
    await expect(
      accessService(db).setPrincipalPermission(company.id, "agent", agent.id, "website:publish", true, null),
    ).rejects.toMatchObject({ message: WEBSITE_MESSAGES["agent.grant_refused"] });
    const operator = await seedUser(company.id, "operator");
    const person = await request(app(operator)).patch(base).send({ name: "Renamed" }).expect(403);
    expect(person.body.error).toBe(WEBSITE_MESSAGES["perm.settings"]);
    expect(site.name).toBe("Alpha site");
  });

  it("isolation: company B cannot propose on, approve or read company A's Publish", async () => {
    const a = await seedWorld("Alpha", "alpha.test");
    const b = await seedWorld("Bravo", "bravo.test");
    const { actor: agentA } = await seedAgent(a.company.id, ["website:view", "website:edit"]);
    const { actor: agentB } = await seedAgent(b.company.id, ["website:view", "website:edit"]);
    const { page } = await agentDraftsAndSubmits(a.base, agentA);
    await request(app()).post(`${a.base}/pages/${page.id}/approve`).expect(200);
    const proposal = (await request(app(agentA)).post(`${a.base}/publish-proposals`).expect(201)).body;

    await request(app(agentB)).post(`${a.base}/publish-proposals`).expect(403);
    await request(app(agentB)).post(`/api/companies/${b.company.id}/website/sites/${a.site.id}/publish-proposals`).expect(404);
    await request(app(agentB)).post(`/api/companies/${b.company.id}/website/sites/${b.site.id}/pages/${page.id}/submit`).expect(404);
    const ownerB = await seedUser(b.company.id, "owner");
    await request(app(ownerB)).post(`/api/companies/${b.company.id}/website/sites/${b.site.id}/pages/${page.id}/approve`).expect(404);
    registerWebsitePublishStarter(vi.fn(async () => ({ releaseId: "r" })));
    await request(app(ownerB)).post(`/api/approvals/${proposal.id}/approve`).send({}).expect(404);
    await request(app(ownerB)).get(`/api/approvals/${proposal.id}`).expect(404);
  });
});
