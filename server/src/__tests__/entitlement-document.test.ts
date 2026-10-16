import { generateKeyPairSync } from "node:crypto";
import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ENTITLEMENT_BASE_FLOOR,
  ENTITLEMENT_FEATURE_KEYS,
  ENTITLEMENT_RELOAD_INTERVAL_MS,
  RESTART_WIRED_ENTITLEMENT_KEYS,
} from "@greatstone/shared";
import {
  ENTITLEMENT_PUBLIC_KEY_ENV,
  parseEntitlementPublicKey,
  readEntitlementConfig,
  verifyEntitlementEnvelope,
} from "../services/entitlement-document.js";
import {
  applyEntitlementsToExperimental,
  createEntitlementRuntime,
  effectiveEntitlements,
  setEntitlementRuntime,
  type EntitlementAuditEvent,
} from "../services/entitlement-runtime.js";
import { FEATURE_ENTITLEMENT_GATES, assertEntitled, isEntitled } from "../services/entitlements.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { HUB_KEYS, documentFor, entitlementTempDir, signedFile } from "./helpers/entitlement-documents.js";

// GRE-1078: the instance reads a signed entitlement document from a file and
// applies it without a restart. Each "done when" case has a test below.

const DAY = 24 * 60 * 60 * 1000;
const allOn = Object.fromEntries(ENTITLEMENT_FEATURE_KEYS.map((key) => [key, true]));

describe("signed entitlement document", () => {
  it("verifies with the hub public key and refuses a wrong key or a changed document", () => {
    const file = signedFile(documentFor());
    expect(verifyEntitlementEnvelope(file, HUB_KEYS.publicKey).version).toBe(1);

    const otherHub = generateKeyPairSync("ed25519");
    expect(() => verifyEntitlementEnvelope(file, otherHub.publicKey)).toThrow(/signature is invalid/);

    const envelope = JSON.parse(file);
    const tampered = Buffer.from(envelope.document, "base64url").toString("utf8").replace('"enableCases":true', '"enableCases":true,"enableSummaries":true');
    envelope.document = Buffer.from(tampered).toString("base64url");
    expect(() => verifyEntitlementEnvelope(JSON.stringify(envelope), HUB_KEYS.publicKey)).toThrow(/signature is invalid/);

    expect(() => verifyEntitlementEnvelope("not json", HUB_KEYS.publicKey)).toThrow(/not valid JSON/);
    expect(() => verifyEntitlementEnvelope(signedFile({ v: 1, client: "acme" }), HUB_KEYS.publicKey)).toThrow(/malformed/);
    expect(() => verifyEntitlementEnvelope(file, HUB_KEYS.publicKey, "other-client")).toThrow(/for client "acme"/);
  });

  it("reads the hub key as PEM or raw base64url, and fails closed on a bad key", () => {
    const pem = HUB_KEYS.publicKey.export({ format: "pem", type: "spki" }).toString();
    const raw = (HUB_KEYS.publicKey.export({ format: "jwk" }) as { x: string }).x;
    expect(parseEntitlementPublicKey(pem).asymmetricKeyType).toBe("ed25519");
    expect(parseEntitlementPublicKey(raw).asymmetricKeyType).toBe("ed25519");
    expect(readEntitlementConfig({}, "/tmp/instance")).toBeNull();
    expect(() => readEntitlementConfig({ [ENTITLEMENT_PUBLIC_KEY_ENV]: " " }, "/tmp/instance")).toThrow(/blank/);
    expect(() => readEntitlementConfig({ [ENTITLEMENT_PUBLIC_KEY_ENV]: "nope" }, "/tmp/instance")).toThrow(/not a valid/);
    expect(readEntitlementConfig({ [ENTITLEMENT_PUBLIC_KEY_ENV]: raw }, "/tmp/instance")).toMatchObject({
      filePath: "/tmp/instance/entitlements/entitlement.json",
      lastGoodPath: "/tmp/instance/entitlements/last-good.json",
    });
  });

  it("governs exactly the api and pending gates, with an all-off base floor", () => {
    const governed = Object.entries(FEATURE_ENTITLEMENT_GATES)
      .filter(([, gate]) => gate.kind === "api" || gate.kind === "pending")
      .map(([key]) => key)
      .sort();
    expect([...ENTITLEMENT_FEATURE_KEYS].sort()).toEqual(governed);
    expect(Object.values(ENTITLEMENT_BASE_FLOOR).every((value) => value === false)).toBe(true);
    for (const key of RESTART_WIRED_ENTITLEMENT_KEYS) expect(ENTITLEMENT_FEATURE_KEYS).toContain(key);
  });
});

describe("entitlement runtime", () => {
  let paths: Awaited<ReturnType<typeof entitlementTempDir>>;
  let clock: Date;
  let events: EntitlementAuditEvent[];

  function runtime(extra: Partial<Parameters<typeof createEntitlementRuntime>[0]> = {}) {
    return createEntitlementRuntime({
      publicKey: HUB_KEYS.publicKey,
      filePath: paths.filePath,
      lastGoodPath: paths.lastGoodPath,
      expectedClient: null,
      now: () => clock,
      onAudit: (event) => {
        events.push(event);
      },
      ...extra,
    });
  }

  beforeEach(async () => {
    paths = await entitlementTempDir();
    clock = new Date("2026-10-09T12:00:00.000Z");
    events = [];
  });

  afterEach(async () => {
    vi.useRealTimers();
    await paths.remove();
  });

  it("starts on the base floor, never all on, when there is no document", async () => {
    const rt = runtime();
    const started = await rt.start();
    expect(started.entitlements.state).toBe("floor");
    expect(started.error).toMatch(/missing/);
    expect(rt.entitled()).toEqual(ENTITLEMENT_BASE_FLOOR);
    expect(applyEntitlementsToExperimental(allOn, rt)).toEqual(ENTITLEMENT_BASE_FLOOR);
  });

  it("keeps the last good copy when the file turns bad, goes missing, or is older", async () => {
    await fs.writeFile(paths.filePath, signedFile(documentFor({ version: 2 })));
    const rt = runtime();
    await rt.start();
    expect(rt.entitled().enablePipelines).toBe(true);

    const otherHub = generateKeyPairSync("ed25519");
    await fs.writeFile(paths.filePath, signedFile(documentFor({ version: 3, features: {} }), otherHub.privateKey));
    let result = await rt.sync({ trigger: "file_reload" });
    expect(result.applied).toBe(false);
    expect(result.error).toMatch(/signature is invalid; keeping the last good copy v2/);
    expect(rt.entitled().enablePipelines).toBe(true);

    await fs.writeFile(paths.filePath, "{ broken");
    result = await rt.sync({ trigger: "file_reload" });
    expect(result.error).toMatch(/not valid JSON/);
    expect(rt.entitled().enablePipelines).toBe(true);

    await fs.writeFile(paths.filePath, signedFile(documentFor({ version: 1, features: {} })));
    result = await rt.sync({ trigger: "file_reload" });
    expect(result.error).toMatch(/v1 is not newer than the last good copy v2/);
    expect(rt.entitled().enablePipelines).toBe(true);

    await fs.rm(paths.filePath);
    result = await rt.sync({ trigger: "file_reload" });
    expect(result.error).toMatch(/missing; keeping the last good copy v2/);
    expect(rt.entitled().enablePipelines).toBe(true);
    expect(events.filter((event) => event.kind === "rejected")).toHaveLength(3);

    // The same refused bytes coming back report their own error again, not "missing".
    await fs.writeFile(paths.filePath, signedFile(documentFor({ version: 1, features: {} })));
    result = await rt.sync({ trigger: "file_reload" });
    expect(result.error).toMatch(/v1 is not newer/);
    expect(events.filter((event) => event.kind === "rejected")).toHaveLength(3);
  });

  it("restores the saved last good copy after a restart with no file", async () => {
    await fs.writeFile(paths.filePath, signedFile(documentFor()));
    await runtime().start();
    await fs.rm(paths.filePath);

    const restarted = runtime();
    const started = await restarted.start();
    expect(started.entitlements.state).toBe("active");
    expect(started.entitlements.document?.version).toBe(1);
    expect(restarted.entitled().enableCases).toBe(true);
  });

  it("applies a new valid document on the next reload, and re-reads at least every 5 minutes", async () => {
    await fs.writeFile(paths.filePath, signedFile(documentFor()));
    const rt = runtime();
    await rt.start();
    expect(rt.entitled().enableSummaries).toBe(false);

    await fs.writeFile(
      paths.filePath,
      signedFile(documentFor({ version: 2, features: { enablePipelines: true, enableSummaries: true } })),
    );
    expect(ENTITLEMENT_RELOAD_INTERVAL_MS).toBeLessThanOrEqual(5 * 60 * 1000);
    vi.useFakeTimers();
    rt.startPolling();
    await vi.advanceTimersByTimeAsync(ENTITLEMENT_RELOAD_INTERVAL_MS);
    rt.stop();
    vi.useRealTimers();

    // The tick reads the file asynchronously; wait for it to land.
    await vi.waitFor(() => expect(rt.entitled()).toMatchObject({ enableSummaries: true, enableCases: false }));
    const change = events.at(-1);
    expect(change).toMatchObject({
      kind: "changed",
      trigger: "file_reload",
      issuedBy: "hub-admin@greatstone",
      reason: "CRM bundle",
      fromVersion: 1,
      toVersion: 2,
      at: clock.toISOString(),
    });
    expect(change?.kind === "changed" && change.changes).toEqual([
      { key: "enableCases", from: true, to: false },
      { key: "enableSummaries", from: false, to: true },
    ]);
  });

  it("is idempotent: an unchanged file adds no audit record", async () => {
    await fs.writeFile(paths.filePath, signedFile(documentFor()));
    const rt = runtime();
    await rt.start();
    const count = events.length;
    await rt.sync({ trigger: "file_reload" });
    await Promise.all([rt.sync({ trigger: "file_reload" }), rt.sync({ trigger: "sync_now", requestedBy: "user-1" })]);
    expect(events).toHaveLength(count);
  });

  it("applies at once on sync now and records who asked", async () => {
    const rt = runtime();
    await rt.start();
    await fs.writeFile(paths.filePath, signedFile(documentFor()));
    const result = await rt.sync({ trigger: "sync_now", requestedBy: "user-1" });
    expect(result.applied).toBe(true);
    expect(rt.entitled().enablePipelines).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "changed", trigger: "sync_now", requestedBy: "user-1" });
  });

  it("marks start-up wired switches pending restart instead of applying them live", async () => {
    await fs.writeFile(paths.filePath, signedFile(documentFor({ features: { enablePipelines: true } })));
    const rt = runtime({ restartWiredKeys: ["enableEnvironments"] });
    await rt.start();
    await fs.writeFile(
      paths.filePath,
      signedFile(documentFor({ version: 2, features: { enablePipelines: false, enableEnvironments: true } })),
    );
    await rt.sync({ trigger: "file_reload" });

    expect(rt.entitled()).toMatchObject({ enablePipelines: false, enableEnvironments: false });
    const effective = effectiveEntitlements({ enableEnvironments: true }, rt);
    expect(effective.features.enableEnvironments).toEqual({ entitled: false, effective: false, pendingRestart: true });
    expect(effective.features.enablePipelines.pendingRestart).toBe(false);

    const restarted = runtime({ restartWiredKeys: ["enableEnvironments"] });
    await restarted.start();
    expect(restarted.entitled().enableEnvironments).toBe(true);
    expect(effectiveEntitlements({}, restarted).features.enableEnvironments.pendingRestart).toBe(false);
  });

  it("keeps the document for 14 days past valid until, then falls back to the base floor", async () => {
    await fs.writeFile(paths.filePath, signedFile(documentFor()));
    const rt = runtime();
    await rt.start();

    clock = new Date(Date.parse("2026-11-01T00:00:00.000Z") + 13 * DAY);
    await rt.sync({ trigger: "file_reload" });
    expect(rt.summary().state).toBe("grace");
    expect(rt.entitled().enablePipelines).toBe(true);

    clock = new Date(Date.parse("2026-11-01T00:00:00.000Z") + 14 * DAY + 1);
    // The floor applies from the clock on every read, before any timer tick.
    expect(rt.entitled()).toEqual(ENTITLEMENT_BASE_FLOOR);
    await rt.sync({ trigger: "file_reload" });
    expect(rt.summary()).toMatchObject({ state: "floor", limits: {} });
    expect(events.at(-1)).toMatchObject({ kind: "changed", trigger: "grace_expired", toState: "floor", issuedBy: null });
  });

  it("only narrows settings: stored values are untouched, so a downgrade deletes nothing", async () => {
    await fs.writeFile(paths.filePath, signedFile(documentFor({ features: { enableCases: true } })));
    const rt = runtime();
    await rt.start();
    const stored = { enablePipelines: true, enableCases: true, enableStreamlinedUi: true, enableNativeRunner: true };
    const view = applyEntitlementsToExperimental(stored, rt);
    expect(view).toEqual({ ...view, enablePipelines: false, enableCases: true, enableStreamlinedUi: true, enableNativeRunner: true });
    expect(stored.enablePipelines).toBe(true);
    // Entitled but switched off by the client admin stays off.
    expect(applyEntitlementsToExperimental({ enableCases: false }, rt).enableCases).toBe(false);
  });

  it("passes settings through unchanged when entitlements are not configured", () => {
    expect(applyEntitlementsToExperimental(allOn, null)).toEqual(allOn);
    expect(effectiveEntitlements({ enablePipelines: true }, null)).toMatchObject({
      state: "disabled",
      features: { enablePipelines: { entitled: true, effective: true, pendingRestart: false } },
    });
  });
});

describe("signed entitlements through the settings service and the GRE-1077 gate", () => {
  let paths: Awaited<ReturnType<typeof entitlementTempDir>>;

  beforeEach(async () => {
    paths = await entitlementTempDir();
  });

  afterEach(async () => {
    setEntitlementRuntime(null);
    await paths.remove();
  });

  it("narrows every reader of the experimental settings, and writes nothing when it does", async () => {
    const row = {
      id: "row-1",
      singletonKey: "default",
      defaultEnvironmentId: null,
      general: {},
      experimental: { enablePipelines: true, enableCases: true },
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    };
    const writes: unknown[] = [];
    const db = {
      select: () => ({ from: () => ({ where: () => Promise.resolve([row]) }) }),
      insert: () => {
        throw new Error("unexpected insert");
      },
      update: () => {
        writes.push("update");
        throw new Error("unexpected update");
      },
    } as never;

    expect(await isEntitled(db, "enablePipelines")).toBe(true);

    await fs.writeFile(paths.filePath, signedFile(documentFor({ features: { enableCases: true } })));
    const rt = createEntitlementRuntime({
      publicKey: HUB_KEYS.publicKey,
      filePath: paths.filePath,
      lastGoodPath: paths.lastGoodPath,
      expectedClient: null,
    });
    await rt.start();
    setEntitlementRuntime(rt);

    const experimental = await instanceSettingsService(db, { runtimeEnv: {} }).getExperimental();
    expect(experimental).toMatchObject({ enablePipelines: false, enableCases: true });
    expect(await isEntitled(db, "enablePipelines")).toBe(false);
    await expect(assertEntitled(db, "enablePipelines")).rejects.toMatchObject({ status: 403 });
    expect(row.experimental.enablePipelines).toBe(true);
    expect(writes).toEqual([]);
  });
});
