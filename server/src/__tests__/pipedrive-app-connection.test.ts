import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companyMemberships, createDb, toolConnections } from "@greatstone/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { organisationRoutes } from "../routes/organisations.js";
import type { PipedriveFetch } from "../services/crm-sync-pipedrive.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { toolAccessService } from "../services/tool-access.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const TOKEN = "fixture-pipedrive-token";

/** Answers Pipedrive's /users/me like the real API, 401 for any other token. */
function stubPipedriveUsersMe() {
  const calls: Array<{ url: string; token: string | null }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
    const token = init.headers["x-api-token"] ?? null;
    calls.push({ url, token });
    const ok = token === TOKEN && new URL(url).pathname === "/api/v1/users/me";
    return {
      status: ok ? 200 : 401,
      headers: { get: () => null },
      json: async () => (ok ? { success: true, data: { id: 1, name: "John" } } : { success: false, error: "unauthorized" }),
    };
  }));
  return calls;
}

describeEmbeddedPostgres("Pipedrive from Apps feeds the organisation import", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pipedrive-app-");
    db = createDb(tempDb.connectionString);
    await instanceSettingsService(db).updateExperimental({ enablePipelines: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const [company] = await db
      .insert(companies)
      .values({ name: `Pipedrive ${randomUUID()}`, issuePrefix: `PD${randomUUID().slice(0, 5).toUpperCase()}` })
      .returning();
    await db.insert(companyMemberships).values({
      companyId: company!.id, principalType: "user", principalId: "owner-user", status: "active", membershipRole: "owner",
    });
    return company!.id;
  }

  it("checks the token with a read, activates the connection and lets the import route use it", async () => {
    const calls = stubPipedriveUsersMe();
    const companyId = await seedCompany();
    const service = toolAccessService(db);
    const actor = { actorType: "user" as const, actorId: "owner-user" };

    const connected = await service.connectGalleryApp(companyId, {
      galleryKey: "pipedrive",
      name: "Pipedrive",
      credentialValues: { "credentials.api_token": TOKEN },
      configValues: { companyDomain: "greatstone" },
    }, actor);
    expect(connected.catalog).toEqual([]);
    expect(calls.at(-1)).toEqual({ url: "https://greatstone.pipedrive.com/api/v1/users/me", token: TOKEN });
    await service.finishGalleryAppConnection(companyId, connected.connectionId, {
      enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: "all_agents",
    }, actor);

    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
    expect(row).toMatchObject({ transport: "rest_api", authKind: "api_key", status: "active", enabled: true, healthStatus: "ok" });
    expect(row!.config).toMatchObject({ sourceTemplateKey: "pipedrive", methodConfig: { companyDomain: "greatstone" } });
    expect(row!.credentialSecretRefs.map((ref) => ref.configPath)).toEqual(["credentials.api_token"]);
    expect(JSON.stringify(row!.config)).not.toContain(TOKEN);

    // The real credential resolver and base URL: the route reads the vaulted token from this row.
    const seen: Array<{ url: string; token: string | undefined }> = [];
    const pipedriveFetch: PipedriveFetch = async (url, init) => {
      seen.push({ url, token: init.headers["x-api-token"] });
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => ({ success: true, data: [], additional_data: { pagination: { more_items_in_collection: false } } }),
      };
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board", userId: "owner-user", source: "session", companyIds: [companyId], isInstanceAdmin: false,
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      } as Express.Request["actor"];
      next();
    });
    app.use("/api", organisationRoutes(db, { pipedriveFetch }));
    app.use(errorHandler);
    const res = await request(app)
      .post(`/api/companies/${companyId}/organisations/import/pipedrive`)
      .send({ connectionId: connected.connectionId });
    expect(res.status).toBe(200);
    expect(res.body.organisations).toEqual({ created: 0, updated: 0, skipped: 0, errors: 0 });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((call) => call.token === TOKEN && call.url.startsWith("https://greatstone.pipedrive.com/api/v1/"))).toBe(true);
  });

  it("refuses a token Pipedrive rejects and says where to find the right one", async () => {
    stubPipedriveUsersMe();
    const companyId = await seedCompany();
    const service = toolAccessService(db);
    await expect(service.connectGalleryApp(companyId, {
      galleryKey: "pipedrive",
      name: "Pipedrive",
      credentialValues: { "credentials.api_token": "wrong-token" },
    }, { actorType: "user", actorId: "owner-user" })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("Settings > Personal preferences > API"),
    });
  });
});
