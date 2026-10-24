import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, websiteSite } from "@greatstone/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { websiteModuleRoutes, type WebsiteModuleRouteOptions } from "../routes/website-module.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const embedded = await getEmbeddedPostgresTestSupport();
const describeDb = embedded.supported ? describe.sequential : describe.skip;

describeDb("website enquiry routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-website-enquiry-routes-");
    db = createDb(tempDb.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true, enablePipelines: true });
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  function app(options: WebsiteModuleRouteOptions = {}) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };
      next();
    });
    instance.use("/api", websiteModuleRoutes(db, options));
    instance.use(errorHandler);
    return instance;
  }

  it("reads only the site's leads and checks the fake bridge on demand", async () => {
    const [company] = await db.insert(companies).values({
      name: "Greatstone", issuePrefix: `W${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
    }).returning();
    const [site] = await db.insert(websiteSite).values({
      companyId: company!.id, name: "Greatstone", domain: "greatstone.test", netlifySiteId: "staging",
    }).returning();
    const path = `/api/companies/${company!.id}/website/sites/${site!.id}/enquiries`;
    expect((await request(app()).get(path)).body).toEqual([]);
    expect((await request(app()).post(`${path}/check`).send({})).status).toBe(409);

    let copied = 0;
    const fake = app({
      enquiryReader: {
        listEnquiries: async () => ({ items: [{
          id: "staging-enquiry-1", name: "Jo Example", email: "jo@example.test",
          source: "contact", page: "/contact", createdAt: "2026-10-24T12:00:00Z",
        }] }),
      },
      enquiryCopy: async () => { copied += 1; },
    });
    expect((await request(fake).post(`${path}/check`).send({})).body).toEqual({ created: 1, skipped: 0 });
    expect((await request(fake).post(`${path}/check`).send({})).body).toEqual({ created: 0, skipped: 1 });
    const listed = await request(fake).get(path);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({ contactEmail: "jo@example.test", source: "contact", page: "/contact" });
    expect(copied).toBe(2); // the copy writer sees repeats and handles its own idempotency
    expect((await request(fake).get(path.replace(site!.id, randomUUID()))).status).toBe(404);
  });
});
