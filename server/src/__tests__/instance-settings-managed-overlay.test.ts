import { describe, expect, it } from "vitest";
import type { Db } from "@greatstone/db";
import {
  applyManagedExperimentalOverlay,
  instanceSettingsService,
  normalizeExperimentalSettings,
} from "../services/instance-settings.js";
import { parseManagedConfigEnv } from "../services/managed-config.js";

const MANAGED_RAW = JSON.stringify({
  v: 1,
  mode: "cloud",
  catalogVersion: "2026.720.0",
  // enableApps is retained only for compatibility and must be ignored;
  // enablePipelines remains a live managed feature.
  features: { enableApps: false, enablePipelines: true },
  plugins: { autoInstall: [] },
});

function managedEnv(raw: string | undefined = MANAGED_RAW) {
  return { GSAM_MANAGED_CONFIG: raw };
}

/**
 * Minimal stand-in for the drizzle query chains instanceSettingsService uses.
 * Captures every `update().set()` payload so tests can assert what would be
 * persisted.
 */
function stubDb(row: Record<string, unknown>) {
  const persistedSets: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({ from: () => ({ where: () => Promise.resolve([row]) }) }),
    insert: () => {
      throw new Error("unexpected insert in test");
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        persistedSets.push(values);
        return { where: () => ({ returning: () => Promise.resolve([{ ...row, ...values }]) }) };
      },
    }),
  } as unknown as Db;
  return { db, persistedSets };
}

function settingsRow(experimental: Record<string, unknown>) {
  return {
    id: "row-1",
    singletonKey: "default",
    defaultEnvironmentId: null,
    general: {},
    experimental,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  };
}

describe("applyManagedExperimentalOverlay", () => {
  it("is the identity with no managed config (self-hosted)", () => {
    const experimental = normalizeExperimentalSettings({ enableApps: true });
    const result = applyManagedExperimentalOverlay(experimental, null);
    expect(result.experimental).toEqual(experimental);
    expect(result.managedKeys).toEqual({});
  });

  it("ignores the retired Apps flag while overlaying live managed values", () => {
    const config = parseManagedConfigEnv(managedEnv())!;
    const stored = normalizeExperimentalSettings({ enableApps: true });
    const { experimental, managedKeys } = applyManagedExperimentalOverlay(stored, config);

    expect(experimental.enableApps).toBe(true);
    // managed overlay > schema default
    expect(experimental.enablePipelines).toBe(true);
    // unmanaged keys keep their stored/default values
    expect(experimental.enableWebsiteView).toBe(false);
    expect(managedKeys).toEqual({
      enablePipelines: { managed: true, managedBy: "paperclip-cloud" },
    });
    // input is not mutated
    expect(stored.enableApps).toBe(true);
  });

  it("keeps a managed Environments off, which client editions use to pin it off (GRE-1623)", () => {
    const config = parseManagedConfigEnv(managedEnv(JSON.stringify({
      v: 1,
      mode: "cloud",
      catalogVersion: "gre-1623",
      features: { enableEnvironments: false },
      plugins: { autoInstall: [] },
    })))!;
    const stored = normalizeExperimentalSettings({ enableEnvironments: false });
    // A stored off is ignored: Environments graduated.
    expect(stored.enableEnvironments).toBe(true);
    const { experimental, managedKeys } = applyManagedExperimentalOverlay(stored, config);

    expect(experimental.enableEnvironments).toBe(false);
    expect(managedKeys).toEqual({ enableEnvironments: { managed: true, managedBy: "paperclip-cloud" } });
  });
});

describe("instanceSettingsService managed overlay", () => {
  it("keeps the 4 retired flags off when stored and managed values say on (GRE-196)", async () => {
    const retired = {
      enableClassicTaskInterface: true,
      enableSmokeLab: true,
      enablePaperclipDeveloperMode: true,
      autoRestartDevServerWhenIdle: true,
    };
    const { db } = stubDb(settingsRow(retired));
    const service = instanceSettingsService(db, { runtimeEnv: managedEnv(JSON.stringify({
      v: 1, mode: "cloud", catalogVersion: "retired", features: { enableSmokeLab: true }, plugins: { autoInstall: [] },
    })) });
    expect(await service.getExperimental()).toMatchObject({
      enableClassicTaskInterface: false,
      enableSmokeLab: false,
      enablePaperclipDeveloperMode: false,
      autoRestartDevServerWhenIdle: false,
      managedKeys: {},
    });
  });

  it.each([{}, { enableMcpAggregators: false }])("keeps aggregators on with legacy stored and managed values: %j", async (stored) => {
    const { db } = stubDb(settingsRow({ ...stored, enableChatConnectors: true }));
    const service = instanceSettingsService(db, { runtimeEnv: managedEnv(JSON.stringify({
      v: 1, mode: "cloud", catalogVersion: "legacy", features: { enableMcpAggregators: false }, plugins: { autoInstall: [] },
    })) });
    expect(await service.getExperimental()).toMatchObject({ enableMcpAggregators: true, enableChatConnectors: true, managedKeys: {} });
    expect(await service.updateExperimental({ enableMcpAggregators: false })).toMatchObject({ experimental: { enableMcpAggregators: true, enableChatConnectors: true } });
  });

  it("keeps workspace branch reconcile forward on when stored and managed values say off (GRE-1438)", async () => {
    const { db } = stubDb(settingsRow({ enableWorkspaceBranchReconcileForward: false }));
    const service = instanceSettingsService(db, { runtimeEnv: managedEnv(JSON.stringify({
      v: 1, mode: "cloud", catalogVersion: "graduated", features: { enableWorkspaceBranchReconcileForward: false }, plugins: { autoInstall: [] },
    })) });
    expect(await service.getExperimental()).toMatchObject({ enableWorkspaceBranchReconcileForward: true, managedKeys: {} });
    expect(await service.updateExperimental({ enableWorkspaceBranchReconcileForward: false })).toMatchObject({
      experimental: { enableWorkspaceBranchReconcileForward: true },
    });
  });

  it("keeps workspace dirty quarantine repair on when stored and managed values say off (GRE-1439)", async () => {
    const { db } = stubDb(settingsRow({ enableWorkspaceDirtyQuarantineRepair: false }));
    const service = instanceSettingsService(db, { runtimeEnv: managedEnv(JSON.stringify({
      v: 1, mode: "cloud", catalogVersion: "graduated", features: { enableWorkspaceDirtyQuarantineRepair: false }, plugins: { autoInstall: [] },
    })) });
    expect(await service.getExperimental()).toMatchObject({ enableWorkspaceDirtyQuarantineRepair: true, managedKeys: {} });
    expect(await service.updateExperimental({ enableWorkspaceDirtyQuarantineRepair: false })).toMatchObject({
      experimental: { enableWorkspaceDirtyQuarantineRepair: true },
    });
  });

  it("keeps Chat and Memory connectors on when stored and managed values say off (GRE-1620)", async () => {
    const off = { enableChatConnectors: false, enableMemoryConnectors: false };
    const { db } = stubDb(settingsRow(off));
    const service = instanceSettingsService(db, { runtimeEnv: managedEnv(JSON.stringify({
      v: 1, mode: "cloud", catalogVersion: "graduated", features: off, plugins: { autoInstall: [] },
    })) });
    expect(await service.getExperimental()).toMatchObject({
      enableChatConnectors: true,
      enableMemoryConnectors: true,
      managedKeys: {},
    });
    expect(await service.updateExperimental(off)).toMatchObject({
      experimental: { enableChatConnectors: true, enableMemoryConnectors: true },
    });
  });
  it("keeps Summaries and Status Cards on when stored and managed values say off (GRE-1622)", async () => {
    const off = { enableSummaries: false, enableStatusCards: false };
    const on = { enableSummaries: true, enableStatusCards: true };
    const { db } = stubDb(settingsRow(off));
    const service = instanceSettingsService(db, { runtimeEnv: managedEnv(JSON.stringify({
      v: 1, mode: "cloud", catalogVersion: "graduated", features: off, plugins: { autoInstall: [] },
    })) });
    expect(await service.getExperimental()).toMatchObject({ ...on, managedKeys: {} });
    expect(await service.updateExperimental(off)).toMatchObject({ experimental: on });
  });

  it("ignores a stored Cases or External Objects off, but keeps a managed off for client editions (GRE-1622)", async () => {
    const off = { enableCases: false, enableExternalObjects: false };
    const stored = instanceSettingsService(stubDb(settingsRow(off)).db, { runtimeEnv: {} });
    expect(await stored.getExperimental()).toMatchObject({ enableCases: true, enableExternalObjects: true });

    const managed = instanceSettingsService(stubDb(settingsRow({})).db, { runtimeEnv: managedEnv(JSON.stringify({
      v: 1, mode: "cloud", catalogVersion: "graduated", features: off, plugins: { autoInstall: [] },
    })) });
    expect(await managed.getExperimental()).toMatchObject({
      ...off,
      managedKeys: {
        enableCases: { managed: true, managedBy: "paperclip-cloud" },
        enableExternalObjects: { managed: true, managedBy: "paperclip-cloud" },
      },
    });
  });

  it("fails closed at construction on a malformed managed config", () => {
    const { db } = stubDb(settingsRow({}));
    expect(() => instanceSettingsService(db, { runtimeEnv: managedEnv("{bad") })).toThrow(
      /GSAM_MANAGED_CONFIG is not valid JSON/,
    );
  });

  it("overlays managed values on getExperimental and exposes managedKeys", async () => {
    const { db } = stubDb(settingsRow({ enableApps: true }));
    const svc = instanceSettingsService(db, { runtimeEnv: managedEnv() });

    const experimental = await svc.getExperimental();
    expect(experimental.enableApps).toBe(true);
    expect(experimental.enablePipelines).toBe(true);
    expect(experimental.managedKeys).toEqual({
      enablePipelines: { managed: true, managedBy: "paperclip-cloud" },
    });
  });

  it("reads Board as off while Strategy is off, from a managed config or the stored row (GRE-1382)", async () => {
    const boardWithoutStrategy = JSON.stringify({
      v: 1,
      mode: "cloud",
      catalogVersion: "2026.1011.0",
      features: { enableStrategy: false, enableStrategyBoard: true },
      plugins: { autoInstall: [] },
    });
    const managed = instanceSettingsService(stubDb(settingsRow({})).db, { runtimeEnv: managedEnv(boardWithoutStrategy) });
    expect(await managed.getExperimental()).toMatchObject({ enableStrategy: false, enableStrategyBoard: false });

    const stored = instanceSettingsService(
      stubDb(settingsRow({ enableStrategy: false, enableStrategyBoard: true })).db,
      { runtimeEnv: {} },
    );
    expect(await stored.getExperimental()).toMatchObject({ enableStrategy: false, enableStrategyBoard: false });

    const bothOn = instanceSettingsService(stubDb(settingsRow({ enableStrategyBoard: true })).db, { runtimeEnv: {} });
    expect(await bothOn.getExperimental()).toMatchObject({ enableStrategy: true, enableStrategyBoard: true });
  });

  it("overlays managed values on get()", async () => {
    const { db } = stubDb(settingsRow({ enableApps: true }));
    const svc = instanceSettingsService(db, { runtimeEnv: managedEnv() });

    const settings = await svc.get();
    expect(settings.experimental.enableApps).toBe(true);
    expect(settings.experimental.managedKeys?.enableApps).toBeUndefined();
  });

  it("leaves the self-hosted read path unchanged (no managedKeys field)", async () => {
    const { db } = stubDb(settingsRow({ enableApps: true }));
    const svc = instanceSettingsService(db, { runtimeEnv: {} });

    const experimental = await svc.getExperimental();
    expect(experimental.enableApps).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(experimental, "managedKeys")).toBe(false);
    expect(experimental).toEqual(normalizeExperimentalSettings({ enableApps: true }));

    const settings = await svc.get();
    expect(Object.prototype.hasOwnProperty.call(settings.experimental, "managedKeys")).toBe(false);
  });

  it("never persists the overlay: updates write stored values, responses show managed ones", async () => {
    const { db, persistedSets } = stubDb(settingsRow({ enableApps: true }));
    const svc = instanceSettingsService(db, { runtimeEnv: managedEnv() });

    const updated = await svc.updateExperimental({ enableWebsiteView: true });

    expect(persistedSets).toHaveLength(1);
    const persisted = persistedSets[0]!.experimental as Record<string, unknown>;
    // The retired compatibility key normalizes on, independent of the
    // managed document's historical value.
    expect(persisted.enableApps).toBe(true);
    // The overlay-added value is not written.
    expect(persisted.enablePipelines).toBe(false);
    expect(persisted.enableWebsiteView).toBe(true);
    expect(persisted).not.toHaveProperty("managedKeys");

    // The response still reflects the overlay.
    expect(updated.experimental.enableApps).toBe(true);
    expect(updated.experimental.enablePipelines).toBe(true);
    expect(updated.experimental.managedKeys?.enableApps).toBeUndefined();
  });

  it("does not let managed metadata leak into self-hosted writes", async () => {
    const { db, persistedSets } = stubDb(settingsRow({}));
    const svc = instanceSettingsService(db, { runtimeEnv: {} });

    const updated = await svc.updateExperimental({ enableWebsiteView: true });
    expect(persistedSets).toHaveLength(1);
    expect(persistedSets[0]!.experimental).not.toHaveProperty("managedKeys");
    expect(Object.prototype.hasOwnProperty.call(updated.experimental, "managedKeys")).toBe(false);
  });
});
