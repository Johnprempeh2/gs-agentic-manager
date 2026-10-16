import express, { Router } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INSTANCE_FEATURE_CATALOG, INSTANCE_FEATURE_KEYS, type InstanceFeatureKey } from "@greatstone/shared";

// GRE-1077: every managed switch has a server gate entry, and every `api`
// gate answers 403 not_entitled on each probe with the switch off. The real
// routers are mounted over a fake db; the gate must refuse before any query.
// GRE-1090: each probe runs with only its own switch off, so a gate layered
// on another (Deep Dive on Cases) proves its own check.

const mockGetExperimental = vi.hoisted(() => vi.fn());

vi.mock("../services/instance-settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/instance-settings.js")>()),
  instanceSettingsService: () => ({ getExperimental: mockGetExperimental }),
}));

const { FEATURE_ENTITLEMENT_GATES, NOT_ENTITLED_ERROR_CODE, assertEntitled } = await import(
  "../services/entitlements.js"
);
const { errorHandler } = await import("../middleware/error-handler.js");

const fakeDb = {} as never;

/** One real router per `api` gate. A new `api` gate without a mount here fails the build. */
const GATED_ROUTERS: Partial<Record<InstanceFeatureKey, () => Promise<Router>>> = {
  enablePipelines: async () => (await import("../routes/pipelines.js")).pipelineRoutes(fakeDb),
  enableCases: async () => (await import("../routes/cases.js")).caseRoutes(fakeDb, {} as never),
  enableConferenceRoomChat: async () =>
    (await import("../routes/board-chat.js")).boardChatRoutes(fakeDb, { deploymentMode: "local_trusted" }),
  enableExternalObjects: async () =>
    Router()
      .use(await issueRouter())
      .use((await import("../routes/projects.js")).projectRoutes(fakeDb)),
  enableDeepDive: async () => (await import("../routes/cases.js")).caseRoutes(fakeDb, {} as never),
  enableStrategy: async () => (await import("../routes/goals.js")).goalRoutes(fakeDb),
  enableStrategyBoard: async () => (await import("../routes/strategy-board.js")).strategyBoardRoutes(fakeDb),
  enableEnvironments: async () => (await import("../routes/environments.js")).environmentRoutes(fakeDb),
  enableWebsiteView: async () => (await import("../routes/website.js")).websiteRoutes(fakeDb),
  enableIntelligence: async () => (await import("../routes/intelligence.js")).intelligenceRoutes(fakeDb),
  enableTeamChat: async () => (await import("../routes/team-chats.js")).teamChatRoutes(fakeDb, { service: {} as never }),
};

const allOff = Object.fromEntries(INSTANCE_FEATURE_KEYS.map((key) => [key, false]));
const onlyOff = (feature: InstanceFeatureKey) => ({ ...Object.fromEntries(INSTANCE_FEATURE_KEYS.map((key) => [key, true])), [feature]: false });

async function appFor(feature: InstanceFeatureKey) {
  const mount = GATED_ROUTERS[feature];
  if (!mount) throw new Error(`no router mount for ${feature}`);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: true };
    next();
  });
  app.use("/api", await mount());
  app.use(errorHandler);
  return app;
}

const gateEntries = Object.entries(FEATURE_ENTITLEMENT_GATES) as [
  InstanceFeatureKey,
  (typeof FEATURE_ENTITLEMENT_GATES)[InstanceFeatureKey],
][];
const apiGates = gateEntries.flatMap(([feature, gate]) => (gate.kind === "api" ? [{ feature, gate }] : []));

describe("managed feature entitlement registry", () => {
  it("names every catalog key, and only tier managed keys are entitlements", () => {
    expect(Object.keys(FEATURE_ENTITLEMENT_GATES).sort()).toEqual([...INSTANCE_FEATURE_KEYS].sort());
    for (const [feature, gate] of gateEntries) {
      const managed = INSTANCE_FEATURE_CATALOG[feature].tier === "managed";
      expect({ feature, preference: gate.kind === "preference" }).toEqual({ feature, preference: !managed });
    }
  });

  it("gives every api gate probes and a router mount", () => {
    expect(apiGates.map(({ feature }) => feature)).toContain("enablePipelines");
    for (const { feature, gate } of apiGates) {
      expect(gate.probes.length, feature).toBeGreaterThan(0);
      expect(GATED_ROUTERS[feature], `${feature} has no router mount in GATED_ROUTERS`).toBeTypeOf("function");
    }
  });

  it("ties every pending gap to a follow-up issue", () => {
    for (const [feature, gate] of gateEntries) {
      if (gate.kind !== "pending") continue;
      expect(gate.followUp, feature).toMatch(/^GRE-\d+$/);
      expect(gate.reason.length, feature).toBeGreaterThan(0);
    }
  });
});

describe("managed feature server gates with the switch off", () => {
  beforeEach(() => {
    mockGetExperimental.mockReset();
    mockGetExperimental.mockResolvedValue(allOff);
  });

  for (const { feature, gate } of apiGates) {
    for (const probe of gate.probes) {
      it(`${feature}: ${probe.method.toUpperCase()} ${probe.path} → 403 not_entitled`, async () => {
        mockGetExperimental.mockResolvedValue(onlyOff(feature));
        const app = await appFor(feature);
        const res = await request(app)[probe.method](`/api${probe.path}`).send(probe.body ?? {});
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: NOT_ENTITLED_ERROR_CODE, feature });
      });
    }
  }

  it("lets a pipelines call through the gate once enablePipelines is on", async () => {
    mockGetExperimental.mockResolvedValue({ ...allOff, enablePipelines: true });
    const app = await appFor("enablePipelines");
    const res = await request(app).get(`/api/pipelines/00000000-0000-4000-8000-000000000001`);
    expect(res.body.code).not.toBe(NOT_ENTITLED_ERROR_CODE);
  });
});

describe("managed feature reads that stay open with the switch off (GRE-1090)", () => {
  beforeEach(() => {
    mockGetExperimental.mockReset();
  });

  it("keeps environment reads open for agent setup and onboarding", async () => {
    mockGetExperimental.mockResolvedValue(onlyOff("enableEnvironments"));
    const app = await appFor("enableEnvironments");
    const res = await request(app).get(`/api/environments/00000000-0000-4000-8000-000000000001`);
    expect(res.body.code).not.toBe(NOT_ENTITLED_ERROR_CODE);
  });

  it("keeps plain goal routes open with Strategy off (GRE-1382)", async () => {
    mockGetExperimental.mockResolvedValue(onlyOff("enableStrategy"));
    const app = await appFor("enableStrategy");
    const goal = "/api/goals/00000000-0000-4000-8000-000000000001";
    const company = "/api/companies/00000000-0000-4000-8000-000000000001";
    for (const res of [
      await request(app).get(`${company}/goals`),
      await request(app).post(`${company}/goals`).send({ title: "Ship the website" }),
      await request(app).get(goal),
      await request(app).get(`${goal}/check-ins`),
    ]) {
      expect(res.body.code).not.toBe(NOT_ENTITLED_ERROR_CODE);
    }
  });

  it("lets ordinary case types through with Deep Dive off", async () => {
    mockGetExperimental.mockResolvedValue(onlyOff("enableDeepDive"));
    const app = await appFor("enableDeepDive");
    const res = await request(app).get(`/api/companies/00000000-0000-4000-8000-000000000001/cases?types=lead`);
    expect(res.body.code).not.toBe(NOT_ENTITLED_ERROR_CODE);
  });
});

describe("assertEntitled", () => {
  it("reads the effective setting and names the feature", async () => {
    const reader = { getExperimental: async () => ({ enableWebsiteView: false }) };
    await expect(assertEntitled(reader, "enableWebsiteView")).rejects.toMatchObject({
      status: 403,
      details: { code: "not_entitled", feature: "enableWebsiteView" },
    });
    await expect(
      assertEntitled({ getExperimental: async () => ({ enableWebsiteView: true }) }, "enableWebsiteView"),
    ).resolves.toBeUndefined();
  });
});
