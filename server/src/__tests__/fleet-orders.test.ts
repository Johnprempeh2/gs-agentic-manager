import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, companies, createDb, fleetCheckIns, fleetInstances, fleetOrders } from "@greatstone/db";
import { FLEET_CHECK_IN_SCHEMA_V3, FLEET_CHECK_IN_SCHEMA_V4, fleetCheckInSchema } from "@greatstone/shared/fleet";
import { fleetPlatform, generateFleetKey, nextSeq, registrationSubject, signFleetMessage } from "@greatstone/shared/fleet-spoke";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { fleetHubRoutes, fleetSpokeRoutes } from "../routes/fleet.js";
import { readHubSigningKey } from "../services/fleet-entitlements.js";
import { fleetTailscaleAuthKey, signFleetOrder, verifyFleetOrder } from "../services/fleet-orders.js";
import { fleetSpokePaths, readFleetSpokeConfig } from "../services/fleet-spoke-config.js";
import { obeySpokeOrders, readSpokeOrders, sendSpokeCheckIn, updaterCommand } from "../services/fleet-spoke.js";
import { currentServiceHold, serviceHoldHealth, setServiceHoldSpoke } from "../services/service-hold.js";
import { setEntitlementRuntime, type EntitlementRuntime } from "../services/entitlement-runtime.js";
import { resolveHeartbeatSchedulingSuppression } from "../services/heartbeat.js";

// GSAM for Mac P2: signed operator orders from the hub Fleet page, obeyed by
// the install and reported back; the audit trail; the Tailscale key at activation.

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

const hubSeed = randomBytes(32).toString("base64url");
const inOneMonth = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

describe("order signatures", () => {
  const key = readHubSigningKey({ GSAM_ENTITLEMENT_SIGN_PRIVATE_KEY: hubSeed })!;
  const target = { instanceId: "8a1f3c3e-1b7e-4c8f-9d0a-2b3c4d5e6f70", code: "mac-1a2b3c4d" };

  it("verifies with the pinned key, and refuses another key, another install or an old order", () => {
    const { message } = signFleetOrder({ ...target, seq: 3, kind: "stop" }, key);
    expect(verifyFleetOrder(message, key.publicKey, target)).toMatchObject({ ok: true, claims: { seq: 3, kind: "stop", client: target.code } });

    const other = readHubSigningKey({ GSAM_ENTITLEMENT_SIGN_PRIVATE_KEY: randomBytes(32).toString("base64url") })!;
    expect(verifyFleetOrder(message, other.publicKey, target)).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(verifyFleetOrder(message, key.publicKey, { ...target, code: "mac-other" })).toMatchObject({ ok: false, reason: "wrong_instance" });
    const tomorrow = new Date(Date.now() + 25 * 60 * 60 * 1000);
    expect(verifyFleetOrder(message, key.publicKey, target, tomorrow)).toMatchObject({ ok: false, reason: "expired", seq: 3 });
    // A changed claim breaks the signature.
    const [h, p, s] = message.split(".");
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
    const tampered = `${h}.${Buffer.from(JSON.stringify({ ...claims, kind: "resume" })).toString("base64url")}.${s}`;
    expect(verifyFleetOrder(tampered, key.publicKey, target)).toMatchObject({ ok: false, reason: "bad_signature" });
  });
});

describe("Tailscale auth key for activation", () => {
  it("is null with nothing set, the pre-made key when set, and a minted one-use key with an OAuth client", async () => {
    expect(await fleetTailscaleAuthKey({})).toBeNull();
    expect(await fleetTailscaleAuthKey({ GSAM_FLEET_TAILSCALE_AUTH_KEY: "tskey-auth-premade" })).toBe("tskey-auth-premade");
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      const answer = url.endsWith("/oauth/token") ? { access_token: "at" } : { key: "tskey-auth-minted" };
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as unknown as typeof fetch;
    const minted = await fleetTailscaleAuthKey(
      { GSAM_FLEET_TAILSCALE_OAUTH_CLIENT_ID: "id", GSAM_FLEET_TAILSCALE_OAUTH_CLIENT_SECRET: "secret", GSAM_FLEET_TAILSCALE_AUTH_KEY: "ignored" },
      fetchImpl,
    );
    expect(minted).toBe("tskey-auth-minted");
    expect(JSON.parse(calls[1]!.body).capabilities.devices.create).toEqual({ reusable: false, ephemeral: false, preauthorized: true, tags: ["tag:gsam-customer"] });
  });
});

describe("service hold", () => {
  afterEach(() => setServiceHoldSpoke(false, null));

  it("holds new agent runs only on a spoke that is paused or stopped", () => {
    setServiceHoldSpoke(false, "stopped");
    expect(currentServiceHold()).toBeNull();
    expect(resolveHeartbeatSchedulingSuppression({}).suppressed).toBe(false);
    setServiceHoldSpoke(true, "paused");
    expect(currentServiceHold()).toBe("paused");
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({ suppressed: true, reason: "service_hold" });
    setServiceHoldSpoke(true, null);
    expect(resolveHeartbeatSchedulingSuppression({}).suppressed).toBe(false);
    expect(serviceHoldHealth()).toMatchObject({ state: "active" });
  });

  it("is ended when the paid period is over (the base floor applies), and a stop order still wins", () => {
    const validUntil = "2026-11-01T23:59:59.000Z";
    setEntitlementRuntime({ stop() {}, summary: () => ({ state: "floor", document: { validUntil } }) } as unknown as EntitlementRuntime);
    try {
      setServiceHoldSpoke(true, "paused");
      expect(currentServiceHold()).toBe("ended");
      expect(serviceHoldHealth()).toEqual({ state: "ended", renewUrl: "https://greatstoneint.com", validUntil });
      setServiceHoldSpoke(true, "stopped");
      expect(currentServiceHold()).toBe("stopped");
      setServiceHoldSpoke(false, null);
      expect(serviceHoldHealth()).toBeNull();
    } finally {
      setEntitlementRuntime(null);
    }
  });
});

describeEmbeddedPostgres("fleet orders", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let root: string;
  const actor = { type: "board", userId: "hub-admin", userEmail: "admin@hub.test", source: "session", isInstanceAdmin: true, companyIds: [] };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-fleet-orders-");
    db = createDb(tempDb.connectionString);
  });

  beforeEach(async () => {
    process.env.GSAM_FLEET_HUB = "true";
    process.env.GSAM_ENTITLEMENT_SIGN_PRIVATE_KEY = hubSeed;
    process.env.GSAM_SECRETS_MASTER_KEY = randomBytes(32).toString("base64");
    root = mkdtempSync(path.join(os.tmpdir(), "gsam-orders-"));
    await db.insert(companies).values({ name: "Greatstone", issuePrefix: "GRE" });
  });

  afterEach(async () => {
    delete process.env.GSAM_FLEET_HUB;
    delete process.env.GSAM_ENTITLEMENT_SIGN_PRIVATE_KEY;
    delete process.env.GSAM_SECRETS_MASTER_KEY;
    delete process.env.GSAM_FLEET_TAILSCALE_AUTH_KEY;
    setServiceHoldSpoke(false, null);
    rmSync(root, { recursive: true, force: true });
    await db.delete(activityLog);
    await db.delete(fleetOrders);
    await db.delete(fleetCheckIns);
    await db.delete(fleetInstances);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app() {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = actor as typeof req.actor;
      next();
    });
    server.use(fleetSpokeRoutes(db));
    server.use("/api", fleetHubRoutes(db));
    server.use(errorHandler);
    return server;
  }

  /** A licensed, activated install whose files sit in `root`, and a fetch that reaches the hub app. */
  async function activatedInstall() {
    const hub = app();
    const licence = await request(hub)
      .post("/api/fleet/licences")
      .send({ features: { enablePipelines: true }, limits: { maxUsers: 3 }, validUntil: inOneMonth(), reason: "Monthly plan" });
    const key = generateFleetKey();
    const seq = nextSeq(0);
    const proof = signFleetMessage(key.privateJwk, { act: "register", sub: registrationSubject(licence.body.licenceKey), seq });
    const res = await request(hub)
      .post("/api/fleet/spoke/activate")
      .send({ licenceKey: licence.body.licenceKey, publicKey: key.publicKey, proof, facts: { os: "macos", arch: "arm64", releaseTag: null } });
    expect(res.status).toBe(201);
    const paths = fleetSpokePaths(root);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.key, JSON.stringify({ privateJwk: key.privateJwk, publicKey: key.publicKey }), { mode: 0o600 });
    writeFileSync(paths.state, JSON.stringify({ lastSeq: seq }));
    writeFileSync(
      paths.config,
      JSON.stringify({
        v: 1,
        hubUrl: "http://hub.test",
        instanceId: res.body.instanceId,
        code: res.body.code,
        entitlementPublicKey: res.body.entitlementPublicKey,
        operatorEmail: res.body.operator.email,
        activatedAt: new Date().toISOString(),
      }),
    );
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const answer = await request(hub).post(new URL(url).pathname).set("Content-Type", "application/json").send(init.body as string);
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const updates: string[] = [];
    const input = {
      config: readFleetSpokeConfig(root)!,
      paths,
      backupDir: root,
      appVersion: "0.3.1",
      releaseTag: null,
      entitlementFile: null,
      runUpdate: async () => {
        updates.push("kicked");
        return null;
      },
    };
    return { hub, id: res.body.instanceId as string, activation: res.body, paths, input, fetchImpl, updates };
  }

  const order = (hub: express.Express, id: string, kind: string, reason = "Customer asked") =>
    request(hub).post(`/api/fleet/instances/${id}/orders`).send({ kind, reason });

  it("pause, stop, resume and update each round-trip: signed, obeyed once, reported, recorded with who and why", async () => {
    const { hub, id, paths, input, fetchImpl, updates } = await activatedInstall();

    const pause = await order(hub, id, "pause", "Invoice overdue");
    expect(pause.status).toBe(201);
    expect(pause.body).toMatchObject({ seq: 1, kind: "pause", status: "pending", issuedBy: "admin@hub.test", reason: "Invoice overdue" });

    // Check-in 1 carries the order; the install obeys it.
    const first = await sendSpokeCheckIn(db, input, fetchImpl);
    expect(first.detail).toContain("orders obeyed: pause #1");
    expect(readSpokeOrders(paths)).toMatchObject({ lastSeq: 1, hold: "paused" });
    expect(currentServiceHold()).toBe("paused");

    // Check-in 2 reports it; the hub records it and stops sending it.
    const second = await sendSpokeCheckIn(db, input, fetchImpl);
    expect(second.detail).toBe("hub answered 200");
    const [paused] = await db.select().from(fleetInstances).where(eq(fleetInstances.id, id));
    expect(paused!.lifecycle).toBe("paused");
    const list = await request(hub).get("/api/fleet/instances");
    expect(list.body[0]).toMatchObject({ state: "paused", orders: [{ seq: 1, status: "done" }] });
    const stored = await db.select().from(fleetCheckIns).where(eq(fleetCheckIns.fleetInstanceId, id));
    const reported = stored.map((row) => row.payload as { schema: string; orders: unknown[] }).find((p) => p.orders.length > 0)!;
    expect(reported).toMatchObject({
      schema: FLEET_CHECK_IN_SCHEMA_V4,
      orders: [{ seq: 1, result: "done", code: null }],
      platform: fleetPlatform(),
    });

    await order(hub, id, "stop", "Contract ended");
    await sendSpokeCheckIn(db, input, fetchImpl);
    expect(currentServiceHold()).toBe("stopped");
    await sendSpokeCheckIn(db, input, fetchImpl);
    expect((await request(hub).get("/api/fleet/instances")).body[0].state).toBe("stopped");

    await order(hub, id, "resume", "Paid");
    await order(hub, id, "update", "Security fix");
    const both = await sendSpokeCheckIn(db, input, fetchImpl);
    expect(both.detail).toContain("orders obeyed: resume #3, update #4");
    expect(currentServiceHold()).toBeNull();
    expect(updates).toEqual(["kicked"]);
    await sendSpokeCheckIn(db, input, fetchImpl);
    const rows = await db.select().from(fleetOrders).where(eq(fleetOrders.fleetInstanceId, id));
    expect(rows.map((r) => [r.seq, r.kind, r.result]).sort()).toEqual([
      [1, "pause", "done"],
      [2, "stop", "done"],
      [3, "resume", "done"],
      [4, "update", "done"],
    ]);
    expect((await request(hub).get("/api/fleet/instances")).body[0].state).toBe("ok");

    // The activity log has who and why for each order, and each result.
    const actions = await db.select().from(activityLog);
    const created = actions.filter((a) => a.action === "fleet.order.created");
    expect(created).toHaveLength(4);
    expect(created.find((a) => (a.details as { kind: string }).kind === "stop")).toMatchObject({
      actorType: "user",
      actorId: "hub-admin",
      entityId: id,
      details: expect.objectContaining({ reason: "Contract ended", issuedBy: "admin@hub.test" }),
    });
    expect(actions.filter((a) => a.action === "fleet.order.result")).toHaveLength(4);
  });

  it("is idempotent: an order sent again is not obeyed again, and its result is reported again", async () => {
    const { hub, id, paths, input, fetchImpl } = await activatedInstall();
    await order(hub, id, "stop");
    const [row] = await db.select().from(fleetOrders);
    const config = input.config;
    expect(await obeySpokeOrders([row!.message], config, paths)).toEqual(["stop #1"]);
    // Resume locally, then the old stop arrives again: it must not stop the service a second time.
    writeFileSync(paths.orders, JSON.stringify({ ...readSpokeOrders(paths), hold: null }));
    setServiceHoldSpoke(true, null);
    expect(await obeySpokeOrders([row!.message], config, paths)).toEqual([]);
    expect(readSpokeOrders(paths).hold).toBeNull();
    expect(readSpokeOrders(paths).results).toEqual([{ seq: 1, result: "done", code: null, reported: false }]);
    await sendSpokeCheckIn(db, input, fetchImpl);
    expect((await db.select().from(fleetOrders))[0]!.result).toBe("done");
  });

  it("refuses orders signed by another key, for another install, or expired", async () => {
    const { id, paths, input, activation } = await activatedInstall();
    const otherKey = { privateKey: generateKeyPairSync("ed25519").privateKey, publicKey: "" };
    const forged = signFleetOrder({ instanceId: id, code: activation.code, seq: 9, kind: "stop" }, otherKey).message;
    const hubKey = readHubSigningKey()!;
    const elsewhere = signFleetOrder({ instanceId: id, code: "mac-someone-else", seq: 10, kind: "stop" }, hubKey).message;
    const old = signFleetOrder({ instanceId: id, code: activation.code, seq: 11, kind: "stop" }, hubKey, new Date(Date.now() - 25 * 60 * 60 * 1000)).message;
    expect(await obeySpokeOrders([forged, elsewhere, old], input.config, paths)).toEqual([]);
    expect(readSpokeOrders(paths)).toMatchObject({ hold: null, lastSeq: 11, results: [{ seq: 11, result: "refused", code: "expired", reported: false }] });
  });

  it("only signs orders for a registered install, needs a reason, and still takes a v2 check-in", async () => {
    const hub = app();
    const pending = await request(hub).post("/api/fleet/licences").send({ features: {}, validUntil: inOneMonth() });
    expect((await order(hub, pending.body.instance.id, "pause")).status).toBe(409);
    const { id } = await activatedInstall();
    expect((await request(hub).post(`/api/fleet/instances/${id}/orders`).send({ kind: "pause" })).status).toBe(400);
    expect((await request(hub).post(`/api/fleet/instances/${id}/orders`).send({ kind: "delete", reason: "x" })).status).toBe(400);
    // The closed schema: v3 refuses free text in order results.
    expect(
      fleetCheckInSchema.safeParse({ schema: FLEET_CHECK_IN_SCHEMA_V3, orders: [{ seq: 1, result: "failed", code: "disk full on Acme Mac" }] }).success,
    ).toBe(false);
  });

  it("names the platform in a closed form and starts the updater the platform's own way", () => {
    expect(fleetPlatform("win32", "x64")).toEqual({ os: "windows", arch: "x64" });
    expect(fleetPlatform("darwin", "arm64")).toEqual({ os: "macos", arch: "arm64" });
    expect(fleetPlatform("linux", "s390x")).toEqual({ os: "linux", arch: "other" });
    // The closed schema: v4 refuses an operating system it does not list.
    const base = { schema: FLEET_CHECK_IN_SCHEMA_V4, platform: { os: "Windows 11 Pro on ACME-PC", arch: "x64" } };
    expect(fleetCheckInSchema.safeParse(base).success).toBe(false);

    expect(updaterCommand({ GSAM_LAUNCHD_LABEL: "co.greatstone.gsam" }, "darwin", 501))
      .toEqual({ file: "launchctl", args: ["kickstart", "gui/501/co.greatstone.gsam.update"] });
    expect(updaterCommand({ GSAM_SCHEDULED_TASK: "co.greatstone.gsam" }, "win32"))
      .toEqual({ file: "schtasks.exe", args: ["/Run", "/TN", "co.greatstone.gsam.update"] });
    expect(updaterCommand({ GSAM_SCHEDULED_TASK: "x & calc" }, "win32")).toBeNull();
    expect(updaterCommand({ GSAM_LAUNCHD_LABEL: "co.greatstone.gsam" }, "win32")).toBeNull();
    expect(updaterCommand({}, "linux")).toBeNull();
  });

  it("reveals the operator log-in to an instance admin and logs every read", async () => {
    const { hub, id, activation } = await activatedInstall();
    const res = await request(hub).get(`/api/fleet/instances/${id}/operator-login`);
    expect(res.body).toEqual(activation.operator);
    const reads = (await db.select().from(activityLog)).filter((a) => a.action === "fleet.operator_login.read");
    expect(reads).toHaveLength(1);
    expect(JSON.stringify(reads[0]!.details)).not.toContain(activation.operator.password);
  });

  it("hands the install a Tailscale key at activation when the hub has one, and reports the tailnet name", async () => {
    process.env.GSAM_FLEET_TAILSCALE_AUTH_KEY = "tskey-auth-test";
    const { hub, activation, paths, input, fetchImpl } = await activatedInstall();
    expect(activation.tailscale).toEqual({ authKey: "tskey-auth-test" });
    writeFileSync(paths.tailnet, JSON.stringify({ name: "gsam-mac-1a2b.tail1234.ts.net." }));
    await sendSpokeCheckIn(db, input, fetchImpl);
    const list = await request(hub).get("/api/fleet/instances");
    expect(list.body[0].latestCheckIn.checkIn.remote).toEqual({ tailnetName: "gsam-mac-1a2b.tail1234.ts.net" });
    expect(list.body[0].entitlement).toMatchObject({ version: 1, features: { enablePipelines: true }, limits: { maxUsers: 3 }, grace: 0, reason: "Monthly plan" });
    // Nothing else of the file leaves the install.
    expect(readFileSync(paths.tailnet, "utf8")).toContain("ts.net");
  });
});
