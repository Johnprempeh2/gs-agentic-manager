import express, { type Router } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INSTANCE_FEATURE_CATALOG, INSTANCE_FEATURE_KEYS, type InstanceFeatureKey } from "@greatstone/shared";

// GRE-1077: every managed switch has a server gate entry, and every `api`
// gate answers 403 not_entitled on each probe with the switch off. The real
// routers are mounted over a fake db; the gate must refuse before any query.

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
  enableStatusCards: async () =>
    (await import("../routes/status-cards.js")).statusCardRoutes(fakeDb, { heartbeat: {} as never }),
  enableSummaries: async () => (await import("../routes/summary-slots.js")).summarySlotRoutes(fakeDb),
  enableBuiltInAgents: async () => (await import("../routes/built-in-agents.js")).builtInAgentRoutes(fakeDb),
  enableConferenceRoomChat: async () =>
    (await import("../routes/board-chat.js")).boardChatRoutes(fakeDb, { deploymentMode: "local_trusted" }),
};

const allOff = Object.fromEntries(INSTANCE_FEATURE_KEYS.map((key) => [key, false]));

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
        const app = await appFor(feature);
        const res = await request(app)[probe.method](`/api${probe.path}`).send({});
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

describe("assertEntitled", () => {
  it("reads the effective setting and names the feature", async () => {
    const reader = { getExperimental: async () => ({ enableStatusCards: false }) };
    await expect(assertEntitled(reader, "enableStatusCards")).rejects.toMatchObject({
      status: 403,
      details: { code: "not_entitled", feature: "enableStatusCards" },
    });
    await expect(
      assertEntitled({ getExperimental: async () => ({ enableStatusCards: true }) }, "enableStatusCards"),
    ).resolves.toBeUndefined();
  });
});
