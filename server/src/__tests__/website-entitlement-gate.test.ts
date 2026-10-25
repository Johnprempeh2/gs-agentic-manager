import { generateKeyPairSync, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  instanceSettings,
  websiteFeature,
  websitePage,
  websiteSite,
  websiteSitemapOption,
} from "@greatstone/db";
import { EDITIONS, buildEditionValues } from "../../../scripts/client-instance/editions.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { HUB_KEYS, documentFor, entitlementTempDir, signedFile } from "./helpers/entitlement-documents.js";
import { errorHandler } from "../middleware/error-handler.js";
import { websiteRoutes } from "../routes/website.js";
import { websiteFeaturesRoutes } from "../routes/website-features.js";
import { websiteModuleRoutes } from "../routes/website-module.js";
import { createEntitlementRuntime, setEntitlementRuntime } from "../services/entitlement-runtime.js";
import { instanceSettingsService } from "../services/instance-settings.js";

// GRE-2346 (Site Studio): in a client install the Website screens are on only
// while a valid signed document carries the `enableWebsiteView` key. With no
// key, an expired key or a bad signature the menu switch reads off, every
// Website API route answers 403 and the stored rows stay. Both editions; no
// new edition value. Greatstone's own install keeps the screens as today.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

type Actor = Express.Request["actor"];
const localBoard: Actor = { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true };
const OTHER_KEYS = generateKeyPairSync("ed25519");

describeEmbeddedPostgres("Website screens behind the signed key (GRE-2346)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let paths: Awaited<ReturnType<typeof entitlementTempDir>>;
  const savedManagedConfig = process.env.GSAM_MANAGED_CONFIG;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-website-entitlement-");
    db = createDb(tempDb.connectionString);
  });

  beforeEach(async () => {
    paths = await entitlementTempDir();
  });

  afterEach(async () => {
    setEntitlementRuntime(null);
    if (savedManagedConfig === undefined) delete process.env.GSAM_MANAGED_CONFIG;
    else process.env.GSAM_MANAGED_CONFIG = savedManagedConfig;
    await paths.remove();
    await db.delete(activityLog);
    await db.delete(websiteFeature);
    await db.delete(websiteSitemapOption);
    await db.delete(websitePage);
    await db.delete(websiteSite);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app() {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = localBoard;
      next();
    });
    instance.use("/api", websiteRoutes(db));
    instance.use("/api", websiteModuleRoutes(db));
    instance.use("/api", websiteFeaturesRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  /** Start a fresh runtime over whatever the entitlement file holds now (no last good copy). */
  async function freshRuntime(file: string | null) {
    setEntitlementRuntime(null);
    await paths.remove();
    paths = await entitlementTempDir();
    if (file !== null) await writeFile(paths.filePath, file);
    const runtime = createEntitlementRuntime({
      publicKey: HUB_KEYS.publicKey,
      filePath: paths.filePath,
      lastGoodPath: paths.lastGoodPath,
      expectedClient: null,
    });
    await runtime.start();
    setEntitlementRuntime(runtime);
  }

  const websiteKey = () => signedFile(documentFor({ features: { enableWebsiteView: true } }));

  async function websiteSwitch() {
    return (await instanceSettingsService(db).getExperimental()).enableWebsiteView;
  }

  async function seed() {
    const [company] = await db
      .insert(companies)
      .values({ name: "Sandbox client", issuePrefix: `S${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}` })
      .returning();
    const companyId = company!.id as string;
    const site = (
      await request(app()).post(`/api/companies/${companyId}/website/sites`).send({ name: "Sandbox", domain: "sandbox.example", netlifySiteId: "n" }).expect(201)
    ).body;
    const base = `/api/companies/${companyId}/website/sites/${site.id}`;
    await request(app()).post(`${base}/features`).send({ key: "careers", name: "Careers" }).expect(201);
    return { companyId, siteId: site.id as string, base };
  }

  /** Every Website router the client reaches: the old view, the module and the feature registry. */
  const probes = (companyId: string, base: string) => [
    `/api/companies/${companyId}/website`,
    `/api/companies/${companyId}/website/sites`,
    `${base}/features`,
    `${base}/feature-cards`,
  ];

  for (const edition of EDITIONS) {
    describe(`${edition} edition`, () => {
      beforeEach(() => {
        process.env.GSAM_MANAGED_CONFIG = buildEditionValues({ edition, catalogVersion: "test" }).managedConfig;
      });

      it("shows the screens and answers 200 with the signed key", async () => {
        await freshRuntime(websiteKey());
        const { companyId, base } = await seed();
        expect(await websiteSwitch()).toBe(true);
        for (const path of probes(companyId, base)) {
          const res = await request(app()).get(path);
          expect({ path, status: res.status }).toEqual({ path, status: 200 });
        }
        const features = (await request(app()).get(`${base}/features`)).body as Array<{ key: string }>;
        expect(features.map((feature) => feature.key)).toEqual(["careers"]);
      });

      const withoutKey: Array<[string, () => string | null]> = [
        ["no key file", () => null],
        ["a document without the key", () => signedFile(documentFor({ features: { enablePipelines: true } }))],
        // Past validUntil and the 14 grace days.
        ["an expired key", () => signedFile(documentFor({ validUntil: "2026-09-01T00:00:00.000Z", features: { enableWebsiteView: true } }))],
        ["a bad signature", () => signedFile(documentFor({ features: { enableWebsiteView: true } }), OTHER_KEYS.privateKey)],
      ];

      for (const [label, file] of withoutKey) {
        it(`hides the screens, answers 403 and keeps the rows with ${label}`, async () => {
          await freshRuntime(websiteKey());
          const { companyId, siteId, base } = await seed();

          await freshRuntime(file());
          expect(await websiteSwitch()).toBe(false);
          for (const path of probes(companyId, base)) {
            const res = await request(app()).get(path);
            expect({ path, status: res.status, code: res.body.code }).toEqual({ path, status: 403, code: "not_entitled" });
          }
          const write = await request(app()).post(`${base}/features`).send({ key: "events", name: "Events" });
          expect(write.status).toBe(403);
          expect(await db.select().from(websiteFeature).where(eq(websiteFeature.siteId, siteId))).toHaveLength(1);

          // The key returns: the same rows are back, nothing was deleted.
          await freshRuntime(websiteKey());
          expect(await websiteSwitch()).toBe(true);
          const back = await request(app()).get(`${base}/features`);
          expect(back.status).toBe(200);
          expect((back.body as Array<{ key: string }>).map((feature) => feature.key)).toEqual(["careers"]);
        });
      }

      it("keeps the screens off with no hub key at all, even when the stored switch is on", async () => {
        await freshRuntime(websiteKey());
        const { companyId, base } = await seed();
        setEntitlementRuntime(null);
        await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
        expect(await websiteSwitch()).toBe(false);
        expect((await request(app()).get(`/api/companies/${companyId}/website`)).status).toBe(403);
        expect((await request(app()).get(`${base}/features`)).status).toBe(403);
      });

      it("refuses Greatstone's own website features, with the key on", async () => {
        await freshRuntime(websiteKey());
        const { companyId, siteId, base } = await seed();
        for (const body of [{ key: "shop", name: "Shop" }, { name: "Client portal" }, { key: "front-door", name: "Enquiries" }, { key: "intelligence-hub", name: "Hub" }]) {
          const res = await request(app()).post(`${base}/features`).send(body);
          expect({ body, status: res.status, code: res.body.code }).toEqual({ body, status: 403, code: "greatstone_only" });
        }
        // A row that got in some other way cannot be switched on.
        const [row] = await db
          .insert(websiteFeature)
          .values({ companyId, siteId, key: "shop", name: "Shop and licences", enabled: false })
          .returning();
        const patch = await request(app()).patch(`${base}/features/${row!.id}`).send({ enabled: true });
        expect(patch.status).toBe(403);
        expect(patch.body.code).toBe("greatstone_only");
      });
    });
  }

  it("keeps the screens on in Greatstone's own install (no managed config, no hub key)", async () => {
    delete process.env.GSAM_MANAGED_CONFIG;
    await instanceSettingsService(db).updateExperimental({ enableWebsiteView: true });
    const { companyId, base } = await seed();
    expect(await websiteSwitch()).toBe(true);
    expect((await request(app()).get(`/api/companies/${companyId}/website`)).status).toBe(200);
    expect((await request(app()).post(`${base}/features`).send({ key: "shop", name: "Shop" })).status).toBe(201);
  });
});
