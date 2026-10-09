import { promises as fs } from "node:fs";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";
import { HUB_KEYS, documentFor, entitlementTempDir, signedFile } from "./helpers/entitlement-documents.js";

// GRE-1078: the UI reads effective features from GET /instance/entitlements,
// "sync now" applies a new document at once, and a client admin cannot turn
// on a feature the signed document does not grant.

const mockInstanceSettingsService = vi.hoisted(() => ({
  getExperimental: vi.fn(),
  updateExperimental: vi.fn(),
  listCompanyIds: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({}),
    heartbeatService: () => ({}),
    instanceSettingsService: () => mockInstanceSettingsService,
    logActivity: vi.fn(),
    publishActivity: vi.fn(),
  }));
  vi.doMock("../services/environments.js", () => ({ environmentService: () => ({}) }));
}

const boardAdmin = { type: "board", userId: "admin-1", source: "session", isInstanceAdmin: true };
const boardMember = { type: "board", userId: "member-1", source: "session", isInstanceAdmin: false, companyIds: ["c1"] };

describe("entitlement routes", () => {
  const graph = hoistModuleGraph(registerModuleMocks, async () => {
    const [{ errorHandler }, { instanceSettingsRoutes }, runtime] = await Promise.all([
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
      vi.importActual<typeof import("../routes/instance-settings.js")>("../routes/instance-settings.js"),
      import("../services/entitlement-runtime.js"),
    ]);
    return { errorHandler, instanceSettingsRoutes, runtime };
  });

  let paths: Awaited<ReturnType<typeof entitlementTempDir>>;

  function app(actor: unknown) {
    const { errorHandler, instanceSettingsRoutes } = graph.value;
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = actor as never;
      next();
    });
    server.use("/api", instanceSettingsRoutes({} as never));
    server.use(errorHandler);
    return server;
  }

  async function installRuntime() {
    const { createEntitlementRuntime, setEntitlementRuntime } = graph.value.runtime;
    const rt = createEntitlementRuntime({
      publicKey: HUB_KEYS.publicKey,
      filePath: paths.filePath,
      lastGoodPath: paths.lastGoodPath,
      expectedClient: null,
    });
    await rt.start();
    setEntitlementRuntime(rt);
    return rt;
  }

  beforeEach(async () => {
    paths = await entitlementTempDir();
    vi.clearAllMocks();
    // The real service narrows by entitlement on read; mirror that here.
    mockInstanceSettingsService.getExperimental.mockImplementation(async () =>
      graph.value.runtime.applyEntitlementsToExperimental({ enablePipelines: true, enableCases: true }),
    );
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue([]);
  });

  afterEach(async () => {
    graph.value.runtime.setEntitlementRuntime(null);
    await paths.remove();
  });

  it("reports disabled with stored values when no hub key is configured", async () => {
    const res = await request(app(boardMember)).get("/api/instance/entitlements");
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("disabled");
    expect(res.body.features.enablePipelines).toEqual({ entitled: true, effective: true, pendingRestart: false });

    const sync = await request(app(boardAdmin)).post("/api/instance/entitlements/sync");
    expect(sync.status).toBe(409);
  });

  it("serves effective features, and sync now applies a new document at once", async () => {
    await fs.writeFile(paths.filePath, signedFile(documentFor({ features: { enableCases: true } })));
    await installRuntime();

    let res = await request(app(boardMember)).get("/api/instance/entitlements");
    expect(res.body).toMatchObject({
      state: "active",
      document: { client: "acme", version: 1, issuedBy: "hub-admin@greatstone" },
      limits: { maxAgents: 10 },
      features: {
        enablePipelines: { entitled: false, effective: false },
        enableCases: { entitled: true, effective: true },
      },
    });

    await fs.writeFile(paths.filePath, signedFile(documentFor({ version: 2, features: { enablePipelines: true } })));
    expect((await request(app(boardMember)).post("/api/instance/entitlements/sync")).status).toBe(403);
    res = await request(app(boardAdmin)).post("/api/instance/entitlements/sync");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      applied: true,
      error: null,
      entitlements: { document: { version: 2 }, features: { enablePipelines: { entitled: true, effective: true } } },
    });
  });

  it("refuses to turn on a feature the document does not grant, but allows turning one off", async () => {
    await fs.writeFile(paths.filePath, signedFile(documentFor({ features: { enableCases: true } })));
    await installRuntime();
    mockInstanceSettingsService.updateExperimental.mockResolvedValue({ id: "s1", experimental: {} });

    const denied = await request(app(boardAdmin)).patch("/api/instance/settings/experimental").send({ enablePipelines: true });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: "not_entitled", feature: "enablePipelines" });
    expect(mockInstanceSettingsService.updateExperimental).not.toHaveBeenCalled();

    const off = await request(app(boardAdmin)).patch("/api/instance/settings/experimental").send({ enablePipelines: false });
    expect(off.status).toBe(200);
    const on = await request(app(boardAdmin)).patch("/api/instance/settings/experimental").send({ enableCases: true });
    expect(on.status).toBe(200);
  });
});
