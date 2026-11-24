import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { verifyPassword } from "better-auth/crypto";
import {
  authAccounts,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  fleetCheckIns,
  fleetInstances,
  instanceSettings,
  instanceUserRoles,
  invites,
  principalPermissionGrants,
} from "@greatstone/db";
import { generateFleetKey, nextSeq, registrationSubject, signFleetMessage } from "@greatstone/shared/fleet-spoke";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { fleetHubRoutes, fleetSpokeRoutes } from "../routes/fleet.js";
import { handOverLocalBoard, onlyLocalBoardIsAdmin } from "../board-claim.js";
import { readHubSigningKey } from "../services/fleet-entitlements.js";
import { readEntitlementConfig, resolveEntitlementState, verifyEntitlementEnvelope } from "../services/entitlement-document.js";
import { fleetSpokePaths, readFleetSpokeConfig } from "../services/fleet-spoke-config.js";
import { advanceSpokeSetup, sendSpokeCheckIn } from "../services/fleet-spoke.js";
import { hashInviteToken } from "../lib/invite-token-hash.js";

// GSAM for Mac P1: licence keys, activation, signed documents in check-in
// answers, and the server-side spoke (owner first, then the operator log-in).

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

const hubSeed = randomBytes(32).toString("base64url");
const inOneMonth = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

describe("hub signing key", () => {
  it("reads a raw seed or PEM, refuses anything else, and is off when unset", () => {
    expect(readHubSigningKey({})).toBeNull();
    const fromSeed = readHubSigningKey({ GSAM_ENTITLEMENT_SIGN_PRIVATE_KEY: hubSeed })!;
    expect(fromSeed.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const pem = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(readHubSigningKey({ GSAM_ENTITLEMENT_SIGN_PRIVATE_KEY: pem })!.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(() => readHubSigningKey({ GSAM_ENTITLEMENT_SIGN_PRIVATE_KEY: "not-a-key" })).toThrow(/not a valid Ed25519/);
  });
});

describeEmbeddedPostgres("fleet licences and the Mac spoke", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let actor: Record<string, unknown>;
  let root: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-fleet-licence-");
    db = createDb(tempDb.connectionString);
  });

  beforeEach(() => {
    process.env.GSAM_FLEET_HUB = "true";
    process.env.GSAM_ENTITLEMENT_SIGN_PRIVATE_KEY = hubSeed;
    process.env.GSAM_SECRETS_MASTER_KEY = randomBytes(32).toString("base64");
    actor = { type: "board", userId: "hub-admin", userEmail: "admin@hub.test", source: "session", isInstanceAdmin: true, companyIds: [] };
    root = mkdtempSync(path.join(os.tmpdir(), "gsam-spoke-"));
  });

  afterEach(async () => {
    delete process.env.GSAM_FLEET_HUB;
    delete process.env.GSAM_ENTITLEMENT_SIGN_PRIVATE_KEY;
    delete process.env.GSAM_SECRETS_MASTER_KEY;
    rmSync(root, { recursive: true, force: true });
    await db.delete(fleetCheckIns);
    await db.delete(fleetInstances);
    await db.delete(invites);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(instanceUserRoles);
    await db.delete(authAccounts);
    await db.delete(authUsers);
    await db.delete(instanceSettings);
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

  async function newLicence(body: Record<string, unknown> = {}) {
    const res = await request(app())
      .post("/api/fleet/licences")
      .send({ features: { enablePipelines: true }, limits: { maxUsers: 3 }, validUntil: inOneMonth(), ...body });
    expect(res.status).toBe(201);
    return res.body as { instance: { id: string; code: string }; licenceKey: string; licenceKeyExpiresAt: string };
  }

  function activationBody(licenceKey: string, key = generateFleetKey()) {
    const proof = signFleetMessage(key.privateJwk, { act: "register", sub: registrationSubject(licenceKey), seq: nextSeq(0) });
    return { key, body: { licenceKey, publicKey: key.publicKey, proof, facts: { os: "macos", arch: "arm64", releaseTag: null } } };
  }

  it("makes a one-use licence that expires in 30 days and stores only its hash", async () => {
    const { instance, licenceKey, licenceKeyExpiresAt } = await newLicence();
    expect(licenceKey).toMatch(/^gsamlk_/);
    const days = (Date.parse(licenceKeyExpiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    const [row] = await db.select().from(fleetInstances);
    expect(row).toMatchObject({ id: instance.id, status: "pending", entitlementVersion: 1 });
    expect(JSON.stringify(row)).not.toContain(licenceKey);
  });

  it("refuses a licence from a non-admin, with no signing key, or ending in the past", async () => {
    actor = { type: "board", userId: "client", source: "session", isInstanceAdmin: false, companyIds: [] };
    expect((await request(app()).post("/api/fleet/licences").send({ features: {}, validUntil: inOneMonth() })).status).toBe(403);
    actor.isInstanceAdmin = true;
    expect((await request(app()).post("/api/fleet/licences").send({ features: {}, validUntil: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);
    delete process.env.GSAM_ENTITLEMENT_SIGN_PRIVATE_KEY;
    expect((await request(app()).post("/api/fleet/licences").send({ features: {}, validUntil: inOneMonth() })).status).toBe(409);
  });

  it("activates once: registration, the pinned key, a signed grace-0 document and the operator log-in", async () => {
    const { instance, licenceKey } = await newLicence();
    const { key, body } = activationBody(licenceKey);
    const res = await request(app()).post("/api/fleet/spoke/activate").send(body);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ instanceId: instance.id, code: instance.code, entitlementPublicKey: readHubSigningKey()!.publicKey });
    expect(res.body.operator.email).toBe(`operator+${instance.code}@greatstone.invalid`);
    expect(res.body.operator.password.length).toBeGreaterThanOrEqual(24);

    const { parseEntitlementPublicKey } = await import("../services/entitlement-document.js");
    const doc = verifyEntitlementEnvelope(JSON.stringify(res.body.entitlement), parseEntitlementPublicKey(res.body.entitlementPublicKey), instance.code);
    expect(doc).toMatchObject({ version: 1, grace: 0, features: { enablePipelines: true }, limits: { maxUsers: 3 }, issuedBy: "admin@hub.test" });
    // grace 0: the service stops the moment validUntil passes.
    expect(resolveEntitlementState(doc, new Date(Date.parse(doc.validUntil) + 1000))).toBe("floor");

    const [row] = await db.select().from(fleetInstances);
    expect(row).toMatchObject({ status: "active", publicKeyX: key.publicKey.x, registrationCodeHash: null });
    // The password is kept encrypted, never in the clear.
    expect(JSON.stringify(row)).not.toContain(res.body.operator.password);
    const login = await request(app()).get(`/api/fleet/instances/${instance.id}/operator-login`);
    expect(login.body).toEqual(res.body.operator);

    // One use.
    const again = await request(app()).post("/api/fleet/spoke/activate").send(activationBody(licenceKey).body);
    expect(again.status).toBe(401);
    expect(again.body.error).toBe("fleet_bad_registration_code");
  });

  it("refuses an expired licence, a proof from another key, and a registration code at activate", async () => {
    const { licenceKey } = await newLicence();
    const thief = activationBody(licenceKey);
    const forged = { ...thief.body, publicKey: generateFleetKey().publicKey };
    expect((await request(app()).post("/api/fleet/spoke/activate").send(forged)).body.error).toBe("fleet_bad_signature");
    await db.update(fleetInstances).set({ registrationCodeExpiresAt: new Date(Date.now() - 1000) });
    expect((await request(app()).post("/api/fleet/spoke/activate").send(activationBody(licenceKey).body)).body.error).toBe("fleet_bad_registration_code");
    const notALicence = activationBody("gsamfr_abc").body;
    expect((await request(app()).post("/api/fleet/spoke/activate").send(notALicence)).status).toBe(400);
  });

  it("rate limits activation per address", async () => {
    const server = app();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await request(server).post("/api/fleet/spoke/activate").send({})).status);
    expect(statuses.slice(0, 10).every((status) => status === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("answers each check-in with the newest document; a hub admin issues a newer one", async () => {
    const { instance, licenceKey } = await newLicence();
    const { key, body } = activationBody(licenceKey);
    await request(app()).post("/api/fleet/spoke/activate").send(body);
    const issued = await request(app())
      .put(`/api/fleet/instances/${instance.id}/entitlement`)
      .send({ features: { enablePipelines: true, enableStrategy: true }, limits: {}, validUntil: inOneMonth(), reason: "added Strategy" });
    expect(issued.status).toBe(200);
    expect(issued.body.entitlementVersion).toBe(2);
    const checkIn = await request(app())
      .post("/api/fleet/spoke/check-in")
      .send({
        message: signFleetMessage(key.privateJwk, {
          act: "check-in",
          sub: instance.id,
          seq: nextSeq(Date.now() + 10),
          checkIn: {
            schema: "gsam-fleet-check-in/v2",
            edition: "managed",
            health: { app: "ok", backupAgeMinutes: null, restoreCheck: null, offsiteBackup: null },
            version: { releaseTag: null, appVersion: null, lastUpgrade: null },
            usage: { companies: 0, activeAgents: 0, runsLast24h: 0, runsFailedLast24h: 0, spendCentsMonth: 0, budgetCentsMonth: 0, storageBytes: 0 },
            alerts: [],
            lifecycle: "active",
            connections: null,
          },
        }),
      });
    expect(checkIn.status).toBe(200);
    const doc = JSON.parse(Buffer.from(checkIn.body.entitlement.document, "base64url").toString("utf8"));
    expect(doc).toMatchObject({ version: 2, reason: "added Strategy", features: { enableStrategy: true } });
  });

  async function activateSpoke() {
    const { instance, licenceKey } = await newLicence();
    const { key, body } = activationBody(licenceKey);
    const res = await request(app()).post("/api/fleet/spoke/activate").send(body);
    const paths = fleetSpokePaths(root);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.key, JSON.stringify({ privateJwk: key.privateJwk, publicKey: key.publicKey }), { mode: 0o600 });
    writeFileSync(paths.operator, JSON.stringify(res.body.operator), { mode: 0o600 });
    writeFileSync(paths.state, JSON.stringify({ lastSeq: JSON.parse(Buffer.from(body.proof.split(".")[1]!, "base64url").toString()).seq }));
    writeFileSync(
      paths.config,
      JSON.stringify({
        v: 1,
        hubUrl: "http://hub.test",
        instanceId: instance.id,
        code: instance.code,
        entitlementPublicKey: res.body.entitlementPublicKey,
        operatorEmail: res.body.operator.email,
        activatedAt: new Date().toISOString(),
      }),
    );
    const entitlementFile = path.join(root, "entitlements", "entitlement.json");
    mkdirSync(path.dirname(entitlementFile), { recursive: true });
    writeFileSync(entitlementFile, JSON.stringify(res.body.entitlement));
    return { instance, operator: res.body.operator as { email: string; password: string }, paths, config: readFleetSpokeConfig(root)!, entitlementFile };
  }

  it("pins the hub key from fleet/spoke.json when no env key is set", async () => {
    const { instance } = await activateSpoke();
    const config = readEntitlementConfig({}, root)!;
    expect(config.expectedClient).toBe(instance.code);
    expect(config.filePath).toBe(path.join(root, "entitlements", "entitlement.json"));
  });

  it("set-up: owner link first, then the operator log-in as instance admin, then 30-day backups", async () => {
    const { paths, config, operator } = await activateSpoke();
    expect(await advanceSpokeSetup(db, config, paths, "http://localhost:3479")).toBe(false);
    const link = JSON.parse(readFileSync(paths.ownerInvite, "utf8")) as { token: string; url: string };
    expect(link.url).toBe(`http://localhost:3479/invite/${link.token}`);
    expect(statSync(paths.ownerInvite).mode & 0o077).toBe(0);
    // Still no owner: the same link is kept.
    expect(await advanceSpokeSetup(db, config, paths, "http://localhost:3479")).toBe(false);
    expect(JSON.parse(readFileSync(paths.ownerInvite, "utf8")).token).toBe(link.token);
    expect(await db.select().from(invites).where(eq(invites.tokenHash, hashInviteToken(link.token)))).toHaveLength(1);

    // The owner signs up and accepts the bootstrap invite (here: the rows it leaves).
    const now = new Date();
    await db.insert(authUsers).values({ id: "owner-1", name: "Owner", email: "owner@client.test", emailVerified: false, createdAt: now, updatedAt: now });
    await db.insert(instanceUserRoles).values({ userId: "owner-1", role: "instance_admin" });

    expect(await advanceSpokeSetup(db, config, paths, "http://localhost:3479")).toBe(true);
    expect(existsSync(paths.operator)).toBe(false);
    expect(existsSync(paths.ownerInvite)).toBe(false);
    const [user] = await db.select().from(authUsers).where(eq(authUsers.email, operator.email));
    const [account] = await db.select().from(authAccounts).where(and(eq(authAccounts.userId, user!.id), eq(authAccounts.providerId, "credential")));
    expect(await verifyPassword({ hash: account!.password!, password: operator.password })).toBe(true);
    expect(await db.select().from(instanceUserRoles).where(eq(instanceUserRoles.userId, user!.id))).toHaveLength(1);
    const [settings] = await db.select().from(instanceSettings);
    expect((settings!.general as { backupRetention?: unknown }).backupRetention).toEqual({ dailyDays: 30, weeklyWeeks: 4, monthlyMonths: 1 });
  });

  it("an existing install: the local board is the only admin until the owner takes it over with the bootstrap invite", async () => {
    const { paths, config } = await activateSpoke();
    const [company] = await db.insert(companies).values({ name: "Will's company", issuePrefix: "WIL" }).returning();
    await db.insert(instanceUserRoles).values({ userId: "local-board", role: "instance_admin" });
    expect(await advanceSpokeSetup(db, config, paths, "http://localhost:3479")).toBe(false);
    expect(await onlyLocalBoardIsAdmin(db)).toBe(true);

    const link = JSON.parse(readFileSync(paths.ownerInvite, "utf8")) as { token: string };
    const [invite] = await db.select().from(invites).where(eq(invites.tokenHash, hashInviteToken(link.token)));
    const now = new Date();
    await db.insert(authUsers).values({ id: "will", name: "Will", email: "will@client.test", emailVerified: false, createdAt: now, updatedAt: now });
    // What the bootstrap accept route does when the local board is the only admin.
    await handOverLocalBoard(db, "will", async (tx) => {
      await tx.update(invites).set({ acceptedAt: now }).where(eq(invites.id, invite!.id));
    });
    expect(await onlyLocalBoardIsAdmin(db)).toBe(false);
    const [membership] = await db.select().from(companyMemberships).where(eq(companyMemberships.companyId, company!.id));
    expect(membership).toMatchObject({ principalId: "will", membershipRole: "owner", status: "active" });
    // The company and its data are untouched; set-up now finishes.
    expect(await db.select().from(companies)).toHaveLength(1);
    expect(await advanceSpokeSetup(db, config, paths, "http://localhost:3479")).toBe(true);
  });

  it("check-in from the server: signed, accepted, and a newer document from the hub is written and applied", async () => {
    const { instance, paths, config, entitlementFile } = await activateSpoke();
    const hub = app();
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const res = await request(hub).post(new URL(url).pathname).set("Content-Type", "application/json").send(init.body as string);
      return new Response(JSON.stringify(res.body), { status: res.status, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const input = { config, paths, backupDir: root, appVersion: "0.3.1", releaseTag: null, entitlementFile };

    const first = await sendSpokeCheckIn(db, input, fetchImpl);
    expect(first).toEqual({ ok: true, detail: "hub answered 200" });
    expect(await db.select().from(fleetCheckIns).where(eq(fleetCheckIns.fleetInstanceId, instance.id))).toHaveLength(1);

    await request(hub)
      .put(`/api/fleet/instances/${instance.id}/entitlement`)
      .send({ features: { enablePipelines: false }, limits: {}, validUntil: inOneMonth() });
    const second = await sendSpokeCheckIn(db, input, fetchImpl);
    expect(second).toEqual({ ok: true, detail: "hub answered 200, entitlement document v2 applied" });
    const applied = JSON.parse(Buffer.from(JSON.parse(readFileSync(entitlementFile, "utf8")).document, "base64url").toString());
    expect(applied.version).toBe(2);

    // A document not signed by the pinned key is refused and the file is kept.
    const otherKey = generateKeyPairSync("ed25519").privateKey;
    const { signEntitlementDocument } = await import("../services/fleet-entitlements.js");
    const forged = signEntitlementDocument({ ...applied, version: 3 }, { privateKey: otherKey, publicKey: "" });
    await db.update(fleetInstances).set({ entitlementDocument: forged, entitlementVersion: 3 });
    const third = await sendSpokeCheckIn(db, input, fetchImpl);
    expect(third.detail).toContain("entitlement document refused: entitlement signature is invalid");
    expect(JSON.parse(Buffer.from(JSON.parse(readFileSync(entitlementFile, "utf8")).document, "base64url").toString()).version).toBe(2);
  });
});
