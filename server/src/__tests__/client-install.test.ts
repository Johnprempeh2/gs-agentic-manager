import { readdir, readFile } from "node:fs/promises";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLIENT_WEBSITE_FEATURE_KEYS,
  GREATSTONE_ONLY_ERROR_CODE,
  GREATSTONE_ONLY_FEATURE_KEYS,
  GREATSTONE_ONLY_WEBSITE_FEATURE_KEYS,
  INSTANCE_FEATURE_KEYS,
} from "@greatstone/shared";
import type { Db } from "@greatstone/db";
import { buildEditionValues, MANAGED_FEATURES_OFF } from "../../../scripts/client-instance/editions.js";
import { errorHandler } from "../middleware/error-handler.js";
import { fleetHubRoutes, fleetSpokeRoutes } from "../routes/fleet.js";
import { releasesFloorRoutes } from "../routes/releases-floor.js";
import { GREATSTONE_ONLY_SURFACES } from "../services/client-install.js";
import { createEntitlementRuntime, setEntitlementRuntime } from "../services/entitlement-runtime.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { HUB_KEYS, documentFor, entitlementTempDir, signedFile } from "./helpers/entitlement-documents.js";

// GRE-2346: the never-in-a-client test. A client install (any managed
// edition, with or without the signed `enableWebsiteView` key) can never
// reach a Greatstone-only switch, website feature or surface. Each check
// runs in the worst case: every other layer tries to turn the thing on.

const EDITIONS = {
  managed: buildEditionValues({ edition: "managed", catalogVersion: "test" }),
  // Every beta Managed plus can take, so nothing is off only by luck.
  "managed-plus": buildEditionValues({
    edition: "managed-plus",
    catalogVersion: "test",
    passedBetaFeatures: MANAGED_FEATURES_OFF.filter(
      (key) =>
        !(GREATSTONE_ONLY_FEATURE_KEYS as readonly string[]).includes(key) &&
        !["enableOwnerInstanceAdmin", "enableManagedSandboxOnly", "enableStrategyBoard"].includes(key),
    ),
  }),
};

/** The edition's managed config, edited by hand to pin every Greatstone-only switch on. */
function hostileManagedConfig(managedConfig: string) {
  const parsed = JSON.parse(managedConfig) as { features: Record<string, boolean> };
  for (const key of GREATSTONE_ONLY_FEATURE_KEYS) parsed.features[key] = true;
  return JSON.stringify(parsed);
}

/** A stored row with every switch on. */
function stubDb(): Db {
  const experimental = Object.fromEntries(INSTANCE_FEATURE_KEYS.map((key) => [key, true]));
  const row = { id: "settings-1", singletonKey: "default", general: {}, experimental, createdAt: new Date(), updatedAt: new Date() };
  return { select: () => ({ from: () => ({ where: () => Promise.resolve([row]) }) }) } as unknown as Db;
}

const ENV_KEYS = ["GSAM_MANAGED_CONFIG", "GSAM_HIDDEN_SETTINGS", "GSAM_FLEET_HUB"] as const;
let savedEnv: Record<string, string | undefined> = {};
let paths: Awaited<ReturnType<typeof entitlementTempDir>>;

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  paths = await entitlementTempDir();
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  setEntitlementRuntime(null);
  await paths.remove();
});

/** A signed document that grants every governed switch, the Greatstone-only ones too. */
async function installSignedKeyForEverything() {
  const { writeFile } = await import("node:fs/promises");
  const features = Object.fromEntries(INSTANCE_FEATURE_KEYS.map((key) => [key, true]));
  await writeFile(paths.filePath, signedFile(documentFor({ features })));
  const runtime = createEntitlementRuntime({
    publicKey: HUB_KEYS.publicKey,
    filePath: paths.filePath,
    lastGoodPath: paths.lastGoodPath,
    expectedClient: null,
  });
  await runtime.start();
  setEntitlementRuntime(runtime);
}

const CASES = Object.entries(EDITIONS).flatMap(([edition, values]) =>
  [false, true].map((websiteKey) => ({ name: `${edition}, ${websiteKey ? "with" : "without"} the website key`, values, websiteKey })),
);

describe("never in a client install (GRE-2346)", () => {
  for (const { name, values, websiteKey } of CASES) {
    describe(name, () => {
      beforeEach(async () => {
        if (websiteKey) await installSignedKeyForEverything();
      });

      it("reads every Greatstone-only switch off, even when stored, pinned and signed on", async () => {
        const experimental = await instanceSettingsService(stubDb(), {
          runtimeEnv: { GSAM_MANAGED_CONFIG: hostileManagedConfig(values.managedConfig) },
        }).getExperimental();
        for (const key of GREATSTONE_ONLY_FEATURE_KEYS) expect({ key, on: experimental[key] }).toEqual({ key, on: false });
        // The Website screens follow the signed key alone.
        expect(experimental.enableWebsiteView).toBe(websiteKey);
      });

      for (const [surface, { probes }] of Object.entries(GREATSTONE_ONLY_SURFACES)) {
        for (const probe of probes) {
          it(`refuses ${surface}: ${probe.method.toUpperCase()} ${probe.path}`, async () => {
            // Worst case: hub switch on and nothing hidden.
            process.env.GSAM_MANAGED_CONFIG = values.managedConfig;
            process.env.GSAM_FLEET_HUB = "true";
            process.env.GSAM_HIDDEN_SETTINGS = "";
            const res = await request(surfacesApp())[probe.method](probe.path).send({});
            expect([403, 404], `${probe.method} ${probe.path} answered ${res.status}`).toContain(res.status);
            if (res.status === 403) expect(res.body.code).toBe(GREATSTONE_ONLY_ERROR_CODE);
          });
        }
      }
    });
  }

  it("lets Greatstone's own install reach every surface (so the refusals above are the client rule)", async () => {
    delete process.env.GSAM_MANAGED_CONFIG;
    process.env.GSAM_FLEET_HUB = "true";
    process.env.GSAM_HIDDEN_SETTINGS = "";
    for (const { probes } of Object.values(GREATSTONE_ONLY_SURFACES)) {
      for (const probe of probes) {
        const res = await request(surfacesApp())[probe.method](probe.path).send({});
        expect([403, 404], `${probe.method} ${probe.path}`).not.toContain(res.status);
      }
    }
  });

  it("classifies every website feature a migration seeds, so a new Greatstone one is covered by default", async () => {
    const dir = new URL("../../../packages/db/src/migrations/", import.meta.url);
    const seeded = new Set<string>();
    for (const file of (await readdir(dir)).filter((name) => name.endsWith(".sql"))) {
      for (const statement of (await readFile(new URL(file, dir), "utf8")).split("--> statement-breakpoint")) {
        if (!/INSERT INTO "website_feature"/.test(statement)) continue;
        for (const match of statement.matchAll(/^\s*\('([a-z][a-z0-9-]*)',/gm)) seeded.add(match[1]!);
      }
    }
    expect(seeded.size).toBeGreaterThan(0);
    const known = new Set<string>([...GREATSTONE_ONLY_WEBSITE_FEATURE_KEYS, ...CLIENT_WEBSITE_FEATURE_KEYS]);
    const unclassified = [...seeded].filter((key) => !known.has(key));
    expect(unclassified, "add each to GREATSTONE_ONLY_WEBSITE_FEATURE_KEYS or CLIENT_WEBSITE_FEATURE_KEYS").toEqual([]);
    for (const key of ["shop", "client-portal", "front-door", "intelligence-hub"]) {
      expect(GREATSTONE_ONLY_WEBSITE_FEATURE_KEYS).toContain(key);
    }
  });
});

/** The real Fleet routers and the release floor; a route past the floor answers 299 "reached". */
function surfacesApp() {
  const fakeDb = {} as never;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: true } as never;
    next();
  });
  app.use(fleetSpokeRoutes(fakeDb));
  app.use("/api", releasesFloorRoutes());
  app.use("/api", fleetHubRoutes(fakeDb));
  app.use("/api/companies/:companyId/releases", (_req, res) => res.status(299).json({ reached: true }));
  app.use(errorHandler);
  return app;
}
