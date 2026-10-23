import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assets,
  companies,
  createDb,
  issueAttachments,
  issueComments,
  issueWorkProducts,
  issues,
  projects,
} from "@greatstone/db";
import type { WebsiteHub, WebsiteProperty } from "@greatstone/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { websiteRoutes } from "../routes/website.js";
import { instanceSettingsService } from "../services/index.js";
import { createFixtureGoogleClient } from "../services/website/google-client.js";
import { findNetlifyUrls } from "../services/website/hub.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

describe("findNetlifyUrls", () => {
  it("finds site and deploy-preview links, each once, without trailing punctuation", () => {
    expect(findNetlifyUrls(
      "Preview: https://deploy-preview-12--greatstone-site.netlify.app/about. Also https://greatstone-site.netlify.app, "
        + "and again https://greatstone-site.netlify.app; not http://plain.netlify.app or https://example.com",
    )).toEqual([
      "https://deploy-preview-12--greatstone-site.netlify.app/about",
      "https://greatstone-site.netlify.app",
    ]);
  });
});

describeEmbeddedPostgres("website hub routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-website-hub-");
    db = createDb(tempDb.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const localBoard: Express.Request["actor"] = {
    type: "board",
    userId: "local-board",
    source: "local_implicit",
    isInstanceAdmin: true,
  };

  function app(actor: Express.Request["actor"] = localBoard) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", websiteRoutes(db, { googleClient: createFixtureGoogleClient() }));
    instance.use(errorHandler);
    return instance;
  }

  async function seedCompany(name = "Greatstone") {
    const [company] = await db.insert(companies).values({
      name,
      issuePrefix: `H${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    return company!;
  }

  async function seedProperty(companyId: string) {
    const response = await request(app())
      .post(`/api/companies/${companyId}/website/properties`)
      .send({ name: "Greatstone website", siteUrl: "https://www.example.com/", ga4PropertyId: "123456789" })
      .expect(201);
    return response.body as WebsiteProperty;
  }

  async function seedProject(companyId: string, name = "Greatstone Website") {
    const [project] = await db.insert(projects).values({ companyId, name }).returning();
    return project!;
  }

  async function seedAttachment(companyId: string, issueId: string, filename: string, contentType: string, at: Date) {
    const [asset] = await db.insert(assets).values({
      companyId,
      provider: "local_disk",
      objectKey: `test/${randomUUID()}`,
      contentType,
      byteSize: 10,
      sha256: randomUUID(),
      originalFilename: filename,
      createdAt: at,
    }).returning();
    const [attachment] = await db.insert(issueAttachments).values({
      companyId,
      issueId,
      assetId: asset!.id,
      createdAt: at,
    }).returning();
    return attachment!;
  }

  it("links a project from the same company, refuses another company's, and unlinks", async () => {
    const company = await seedCompany();
    const other = await seedCompany("Other");
    const property = await seedProperty(company.id);
    const project = await seedProject(company.id);
    const foreign = await seedProject(other.id, "Not ours");
    const http = request(app());

    expect(property.projectId).toBeNull();
    const refused = await http
      .patch(`/api/companies/${company.id}/website/properties/${property.id}`)
      .send({ projectId: foreign.id })
      .expect(422);
    expect(refused.body.details?.code ?? refused.body.code).toBe("website_project_not_found");

    const linked = await http
      .patch(`/api/companies/${company.id}/website/properties/${property.id}`)
      .send({ projectId: project.id })
      .expect(200);
    expect(linked.body.projectId).toBe(project.id);

    const overview = await http.get(`/api/companies/${company.id}/website`).expect(200);
    expect(overview.body.properties[0].projectId).toBe(project.id);

    const unlinked = await http
      .patch(`/api/companies/${company.id}/website/properties/${property.id}`)
      .send({ projectId: null })
      .expect(200);
    expect(unlinked.body.projectId).toBeNull();
  });

  it("returns an empty hub while no project is linked", async () => {
    const company = await seedCompany();
    const property = await seedProperty(company.id);
    const hub = await request(app()).get(`/api/companies/${company.id}/website/properties/${property.id}/hub`).expect(200);
    expect(hub.body).toEqual({ propertyId: property.id, projectId: null, recentWork: [], sitemap: null, previewLinks: [] });
  });

  it("reads recent work, the newest sitemap and preview links from the linked project only", async () => {
    const company = await seedCompany();
    const property = await seedProperty(company.id);
    const project = await seedProject(company.id);
    const elsewhere = await seedProject(company.id, "Something else");
    const [task] = await db.insert(issues).values({ companyId: company.id, projectId: project.id, title: "Build the sitemap", identifier: "GRE-1" }).returning();
    const [hidden] = await db.insert(issues).values({ companyId: company.id, projectId: project.id, title: "Hidden", hiddenAt: new Date() }).returning();
    const [outside] = await db.insert(issues).values({ companyId: company.id, projectId: elsewhere.id, title: "Outside" }).returning();
    const t = (minutes: number) => new Date(Date.UTC(2026, 9, 23, 9, minutes));

    const sitemapFile = await seedAttachment(company.id, task!.id, "website-sitemap-v2.html", "text/html", t(5));
    await seedAttachment(company.id, task!.id, "home.png", "image/png", t(6));
    await seedAttachment(company.id, outside!.id, "website-sitemap-other.html", "text/html", t(30));
    for (const version of [1, 2]) {
      await db.insert(issueWorkProducts).values({
        companyId: company.id,
        projectId: project.id,
        issueId: task!.id,
        type: "deliverable",
        provider: "paperclip",
        externalId: "website-sitemap",
        title: "website-sitemap",
        status: "ready_for_review",
        reviewState: version === 2 ? "needs_board_review" : "none",
        metadata: { attachmentId: sitemapFile.id, contentType: "text/html", version, deliverableStatus: "draft", originalFilename: "website-sitemap-v2.html" },
        createdAt: t(version),
      });
    }
    await db.insert(issueWorkProducts).values({
      companyId: company.id,
      projectId: project.id,
      issueId: task!.id,
      type: "preview_url",
      provider: "custom",
      title: "Deploy preview",
      url: "https://deploy-preview-7--greatstone.netlify.app",
      status: "active",
      createdAt: t(4),
    });
    await db.insert(issueComments).values([
      { companyId: company.id, issueId: task!.id, body: "Preview is up at https://deploy-preview-8--greatstone.netlify.app/services.", createdAt: t(7) },
      { companyId: company.id, issueId: hidden!.id, body: "https://hidden--greatstone.netlify.app", createdAt: t(8) },
      { companyId: company.id, issueId: outside!.id, body: "https://outside--greatstone.netlify.app", createdAt: t(9) },
    ]);

    await request(app())
      .patch(`/api/companies/${company.id}/website/properties/${property.id}`)
      .send({ projectId: project.id })
      .expect(200);
    const response = await request(app()).get(`/api/companies/${company.id}/website/properties/${property.id}/hub`).expect(200);
    const hub = response.body as WebsiteHub;

    expect(hub.projectId).toBe(project.id);
    expect(hub.recentWork.map((item) => item.type)).toEqual(["screenshot", "preview_url", "deliverable", "deliverable"]);
    expect(hub.recentWork[0]!.contentPath).toMatch(/^\/api\/attachments\/.+\/content$/);
    expect(hub.sitemap).toMatchObject({
      source: "deliverable",
      version: 2,
      versionCount: 2,
      status: "draft",
      reviewState: "needs_board_review",
      contentPath: `/api/attachments/${sitemapFile.id}/content`,
      task: { id: task!.id, identifier: "GRE-1" },
    });
    expect(hub.previewLinks.map((link) => [link.url, link.source])).toEqual([
      ["https://deploy-preview-8--greatstone.netlify.app/services", "comment"],
      ["https://deploy-preview-7--greatstone.netlify.app", "work_product"],
    ]);
  });

  it("falls back to a plain sitemap attachment, and keeps other companies out", async () => {
    const company = await seedCompany();
    const other = await seedCompany("Other");
    const property = await seedProperty(company.id);
    const project = await seedProject(company.id);
    const [task] = await db.insert(issues).values({ companyId: company.id, projectId: project.id, title: "Sitemap" }).returning();
    const file = await seedAttachment(company.id, task!.id, "Website-Sitemap.html", "text/html", new Date());
    await request(app())
      .patch(`/api/companies/${company.id}/website/properties/${property.id}`)
      .send({ projectId: project.id })
      .expect(200);

    const hub = await request(app()).get(`/api/companies/${company.id}/website/properties/${property.id}/hub`).expect(200);
    expect(hub.body.sitemap).toMatchObject({ source: "attachment", version: 1, status: null, contentPath: `/api/attachments/${file.id}/content` });

    // The property is not in the other company's path.
    await request(app()).get(`/api/companies/${other.id}/website/properties/${property.id}/hub`).expect(404);
    // A member of only the other company cannot read this company's hub.
    const outsider = {
      type: "board",
      userId: "outsider",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [other.id],
      memberships: [{ companyId: other.id, membershipRole: "owner", status: "active" }],
    } as Express.Request["actor"];
    await request(app(outsider)).get(`/api/companies/${company.id}/website/properties/${property.id}/hub`).expect(403);
  });
});
