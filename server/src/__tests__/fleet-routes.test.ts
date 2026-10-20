import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, fleetCheckIns, fleetInstances } from "@greatstone/db";
import { eq } from "drizzle-orm";
import { FLEET_CHECK_IN_SCHEMA, FLEET_CHECK_IN_SCHEMA_V1, fleetCheckInSchema, type FleetCheckIn } from "@greatstone/shared/fleet";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { fleetHubRoutes, fleetSpokeRoutes } from "../routes/fleet.js";
import { fleetService } from "../services/fleet.js";
// The spoke's own helpers: the test proves the script and the hub agree.
import {
  generateFleetKey,
  nextSeq,
  registrationSubject,
  signFleetMessage,
  type FleetKey,
} from "../../../scripts/client-instance/fleet.js";

// GRE-1082: fleet registration, signed check-in and revoke, from both sides.
// GRE-1366: check-in v2 with lifecycle and connection counts (AT-3.3, AT-3.8).
// GRE-1367: delete removes the hub record and its check-ins (AT-4.8).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres fleet tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const checkIn: FleetCheckIn = {
  schema: FLEET_CHECK_IN_SCHEMA,
  edition: "managed",
  health: { app: "ok", backupAgeMinutes: 12, restoreCheck: { ok: true, ageMinutes: 600 }, offsiteBackup: null },
  version: { releaseTag: "stable-2026-10-01.1", appVersion: "0.3.1", lastUpgrade: null },
  usage: { companies: 1, activeAgents: 3, runsLast24h: 20, runsFailedLast24h: 2, spendCentsMonth: 1234, budgetCentsMonth: 15000, storageBytes: 1024 },
  alerts: [{ key: "health", ok: true }, { key: "ai-connections", ok: false }],
  lifecycle: "active",
  connections: { ai: { healthy: 2, needsAttention: 1 }, tools: { active: 4, disabled: 1 } },
};

const { lifecycle: _lifecycle, connections: _connections, ...v1Fields } = checkIn;
const { runsFailedLast24h: _runsFailed, ...usageV1 } = checkIn.usage;
const checkInV1 = { ...v1Fields, usage: usageV1, schema: FLEET_CHECK_IN_SCHEMA_V1 };

describe("fleet check-in schema", () => {
  it("accepts facts and refuses any field it does not name", () => {
    expect(fleetCheckInSchema.safeParse(checkIn).success).toBe(true);
    expect(fleetCheckInSchema.safeParse({ ...checkIn, companyName: "Acme" }).success).toBe(false);
    expect(fleetCheckInSchema.safeParse({ ...checkIn, usage: { ...checkIn.usage, topClient: "Acme" } }).success).toBe(false);
    expect(fleetCheckInSchema.safeParse({ ...checkIn, alerts: [{ key: "health", ok: false, detail: "Acme Ltd board pack" }] }).success).toBe(false);
    expect(fleetCheckInSchema.safeParse({ ...checkIn, alerts: [{ key: "Issue: Acme merger", ok: false }] }).success).toBe(false);
    expect(fleetCheckInSchema.safeParse({ ...checkIn, version: { ...checkIn.version, releaseTag: "Acme merger plan" } }).success).toBe(false);
  });

  it("AT-3.3: connections are counts only; a name, id or other field is refused", () => {
    expect(fleetCheckInSchema.safeParse({ ...checkIn, connections: null }).success).toBe(true);
    const bad = [
      { ai: { ...checkIn.connections!.ai, names: ["Claude for Acme"] }, tools: checkIn.connections!.tools },
      { ai: checkIn.connections!.ai, tools: { ...checkIn.connections!.tools, ids: ["0d6f3c2a-1111-2222-3333-444455556666"] } },
      { ...checkIn.connections, byCompany: { acme: 1 } },
      { ai: { healthy: "Acme", needsAttention: 0 }, tools: checkIn.connections!.tools },
      { ai: { healthy: -1, needsAttention: 0 }, tools: checkIn.connections!.tools },
      { ai: checkIn.connections!.ai },
    ];
    for (const connections of bad) expect(fleetCheckInSchema.safeParse({ ...checkIn, connections }).success).toBe(false);
    expect(fleetCheckInSchema.safeParse({ ...checkIn, lifecycle: "deleted" }).success).toBe(false);
    const { connections: _c, ...noConnections } = checkIn;
    expect(fleetCheckInSchema.safeParse(noConnections).success).toBe(false);
  });

  it("takes v1 from a spoke not yet upgraded, but not v1 with v2 fields", () => {
    expect(fleetCheckInSchema.safeParse(checkInV1).success).toBe(true);
    expect(fleetCheckInSchema.safeParse({ ...checkInV1, lifecycle: "paused" }).success).toBe(false);
    expect(fleetCheckInSchema.safeParse({ ...checkInV1, usage: checkIn.usage }).success).toBe(false);
    expect(fleetCheckInSchema.safeParse({ ...checkInV1, schema: "gsam-fleet-check-in/v3" }).success).toBe(false);
  });

  it("GRE-144: v2 carries failed runs as one instance count, never per company", () => {
    expect(fleetCheckInSchema.safeParse(checkIn).success).toBe(true);
    for (const runsFailedLast24h of [-1, 1.5, "2", null]) {
      expect(fleetCheckInSchema.safeParse({ ...checkIn, usage: { ...checkIn.usage, runsFailedLast24h } }).success).toBe(false);
    }
    expect(fleetCheckInSchema.safeParse({ ...checkIn, usage: { ...checkIn.usage, runsFailedByCompany: { acme: 2 } } }).success).toBe(false);
    expect(fleetCheckInSchema.safeParse({ ...checkIn, usage: usageV1 }).success).toBe(false);
  });

  it("refuses a company id in an alert key", () => {
    for (const key of ["ai-connections:abcdef12", "ai-failed-auth:11111111", "health:0d6f3c2a-1111-2222-3333-444455556666"]) {
      expect(fleetCheckInSchema.safeParse({ ...checkIn, alerts: [{ key, ok: false }] }).success).toBe(false);
    }
  });
});

describeEmbeddedPostgres("fleet hub and spoke", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let actor: Record<string, unknown>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-fleet-");
    db = createDb(tempDb.connectionString);
  });

  beforeEach(() => {
    process.env.GSAM_FLEET_HUB = "true";
    actor = { type: "board", userId: "hub-admin", source: "session", isInstanceAdmin: true, companyIds: [] };
  });

  afterEach(async () => {
    delete process.env.GSAM_FLEET_HUB;
    await db.delete(fleetCheckIns);
    await db.delete(fleetInstances);
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

  async function newCode(code: string) {
    const res = await request(app()).post("/api/fleet/instances").send({ code });
    expect(res.status).toBe(201);
    return res.body as { instance: { id: string }; registrationCode: string };
  }

  async function register(code: string) {
    const { registrationCode } = await newCode(code);
    const key = generateFleetKey();
    const seq = nextSeq(0);
    const proof = signFleetMessage(key.privateJwk, { act: "register", sub: registrationSubject(registrationCode), seq });
    const res = await request(app()).post("/api/fleet/spoke/register").send({ registrationCode, publicKey: key.publicKey, proof });
    expect(res.status).toBe(201);
    return { id: res.body.instanceId as string, key, seq, registrationCode };
  }

  const sendCheckIn = (key: FleetKey, id: string, seq: number, body: unknown = checkIn) =>
    request(app())
      .post("/api/fleet/spoke/check-in")
      .send({ message: signFleetMessage(key.privateJwk, { act: "check-in", sub: id, seq, checkIn: body as FleetCheckIn }) });

  it("is off unless GSAM_FLEET_HUB=true, on both sides", async () => {
    delete process.env.GSAM_FLEET_HUB;
    expect((await request(app()).get("/api/fleet/instances")).status).toBe(404);
    expect((await request(app()).post("/api/fleet/spoke/check-in").send({ message: "x" })).status).toBe(404);
  });

  it("lets only the hub's instance admins create and read instances", async () => {
    actor = { type: "board", userId: "client-user", source: "session", isInstanceAdmin: false, companyIds: [] };
    expect((await request(app()).post("/api/fleet/instances").send({ code: "c001" })).status).toBe(403);
    expect((await request(app()).get("/api/fleet/instances")).status).toBe(403);
    actor = { type: "none", source: "none" };
    expect((await request(app()).get("/api/fleet/instances")).status).toBe(403);
  });

  it("registers with a one-time code and stores only the public key", async () => {
    const { id, key, registrationCode } = await register("c001");
    const [row] = await db.select().from(fleetInstances);
    expect(row).toMatchObject({ id, code: "c001", status: "active", publicKeyX: key.publicKey.x, registrationCodeHash: null });
    expect(JSON.stringify(row)).not.toContain(key.privateJwk.d);

    // The code works once.
    const other = generateFleetKey();
    const proof = signFleetMessage(other.privateJwk, { act: "register", sub: registrationSubject(registrationCode), seq: nextSeq(0) });
    const again = await request(app()).post("/api/fleet/spoke/register").send({ registrationCode, publicKey: other.publicKey, proof });
    expect(again.status).toBe(401);
    expect(again.body.error).toBe("fleet_bad_registration_code");
  });

  it("refuses a registration whose proof is not signed by the key it sends", async () => {
    const { registrationCode } = await newCode("c001");
    const key = generateFleetKey();
    const thief = generateFleetKey();
    const proof = signFleetMessage(thief.privateJwk, { act: "register", sub: registrationSubject(registrationCode), seq: nextSeq(0) });
    const res = await request(app()).post("/api/fleet/spoke/register").send({ registrationCode, publicKey: key.publicKey, proof });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("fleet_bad_signature");
    expect((await db.select().from(fleetInstances))[0]?.status).toBe("pending");
  });

  it("refuses an expired code", async () => {
    const { registrationCode } = await newCode("c001");
    await db.update(fleetInstances).set({ registrationCodeExpiresAt: new Date(Date.now() - 1000) });
    const key = generateFleetKey();
    const proof = signFleetMessage(key.privateJwk, { act: "register", sub: registrationSubject(registrationCode), seq: nextSeq(0) });
    const res = await request(app()).post("/api/fleet/spoke/register").send({ registrationCode, publicKey: key.publicKey, proof });
    expect(res.body.error).toBe("fleet_bad_registration_code");
  });

  it("accepts a signed check-in and the hub admin reads it back", async () => {
    const { id, key, seq } = await register("c001");
    const res = await sendCheckIn(key, id, nextSeq(seq));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["receivedAt"]);
    const list = await request(app()).get(`/api/fleet/instances/${id}/check-ins`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].checkIn).toEqual(checkIn);
    const instances = await request(app()).get("/api/fleet/instances");
    expect(instances.body[0]).toMatchObject({ code: "c001", status: "active" });
    expect(instances.body[0].lastCheckInAt).toBeTruthy();
    expect(instances.body[0]).not.toHaveProperty("registrationCodeHash");
  });

  it("GRE-1083: the list carries each instance's newest check-in, and null when none is kept", async () => {
    const { id, key, seq } = await register("c001");
    await newCode("c002");
    const older = { ...checkIn, usage: { ...checkIn.usage, runsLast24h: 5 } };
    const firstSeq = nextSeq(seq);
    expect((await sendCheckIn(key, id, firstSeq, older)).status).toBe(200);
    // Both writes can land in the same millisecond; move the first one back.
    await db.update(fleetCheckIns).set({ receivedAt: new Date(Date.now() - 60_000) });
    expect((await sendCheckIn(key, id, nextSeq(firstSeq))).status).toBe(200);
    const [first, second] = (await request(app()).get("/api/fleet/instances")).body;
    expect(first.code).toBe("c001");
    expect(first.latestCheckIn.checkIn).toEqual(checkIn);
    expect(second).toMatchObject({ code: "c002", state: "pending", latestCheckIn: null });
  });

  it("refuses a bad signature", async () => {
    const { id, seq } = await register("c001");
    const res = await sendCheckIn(generateFleetKey(), id, nextSeq(seq));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("fleet_bad_signature");
    expect(await db.select().from(fleetCheckIns)).toHaveLength(0);
  });

  it("refuses a tampered message", async () => {
    const { id, key, seq } = await register("c001");
    const message = signFleetMessage(key.privateJwk, { act: "check-in", sub: id, seq: nextSeq(seq), checkIn });
    const [header, payload, signature] = message.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    claims.checkIn.usage.spendCentsMonth = 0;
    const tampered = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
    const res = await request(app()).post("/api/fleet/spoke/check-in").send({ message: tampered });
    expect(res.body.error).toBe("fleet_bad_signature");
  });

  it("refuses a replay and an older seq", async () => {
    const { id, key, seq } = await register("c001");
    const message = signFleetMessage(key.privateJwk, { act: "check-in", sub: id, seq: nextSeq(seq), checkIn });
    expect((await request(app()).post("/api/fleet/spoke/check-in").send({ message })).status).toBe(200);
    const replay = await request(app()).post("/api/fleet/spoke/check-in").send({ message });
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe("fleet_replay");
    expect((await sendCheckIn(key, id, seq)).body.error).toBe("fleet_replay");
    expect(await db.select().from(fleetCheckIns)).toHaveLength(1);
  });

  it("refuses a message that has expired", async () => {
    const { id, key, seq } = await register("c001");
    const old = signFleetMessage(key.privateJwk, { act: "check-in", sub: id, seq: nextSeq(seq), checkIn }, Date.now() - 20 * 60 * 1000);
    const res = await request(app()).post("/api/fleet/spoke/check-in").send({ message: old });
    expect(res.body.error).toBe("fleet_replay");
  });

  it("refuses a check-in with a field outside the schema, even when signed", async () => {
    const { id, key, seq } = await register("c001");
    const res = await sendCheckIn(key, id, nextSeq(seq), { ...checkIn, clientName: "Acme" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("fleet_bad_message");
  });

  it("AT-3.3: refuses a signed check-in that names a connection", async () => {
    const { id, key, seq } = await register("c001");
    const named = { ...checkIn, connections: { ...checkIn.connections, tools: { active: 1, disabled: 0, names: ["Acme CRM"] } } };
    const res = await sendCheckIn(key, id, nextSeq(seq), named);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("fleet_bad_message");
    expect(await db.select().from(fleetCheckIns)).toHaveLength(0);
  });

  it("AT-3.8: after pause the hub shows paused, not down, even when no check-in follows", async () => {
    const { id, key, seq } = await register("c001");
    let last = seq;
    const next = () => (last = nextSeq(last));
    const state = async () => (await request(app()).get("/api/fleet/instances")).body[0];
    expect(await state()).toMatchObject({ state: "waiting", lifecycle: null });

    await sendCheckIn(key, id, next());
    expect(await state()).toMatchObject({ state: "ok", lifecycle: "active" });
    const activeSince = (await state()).lifecycleChangedAt;

    // The final check-in `pause` sends: the app is stopped on purpose.
    const paused = { ...checkIn, lifecycle: "paused", health: { ...checkIn.health, app: "down" }, connections: null };
    expect((await sendCheckIn(key, id, next(), paused)).status).toBe(200);
    const afterPause = await state();
    expect(afterPause).toMatchObject({ state: "paused", lifecycle: "paused" });
    expect(new Date(afterPause.lifecycleChangedAt).getTime()).toBeGreaterThanOrEqual(new Date(activeSince).getTime());

    // Days later, with nothing more sent: still paused, never stale or down.
    await db.update(fleetInstances).set({ lastCheckInAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) }).where(eq(fleetInstances.id, id));
    expect(await state()).toMatchObject({ state: "paused" });

    // An active instance in the same place is down.
    await sendCheckIn(key, id, next());
    const resumedAt = (await state()).lifecycleChangedAt;
    await db.update(fleetInstances).set({ lastCheckInAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) }).where(eq(fleetInstances.id, id));
    expect(await state()).toMatchObject({ state: "down", lifecycle: "active", lifecycleChangedAt: resumedAt });
  });

  it("shows an active instance stale, then down, at the limits the hub sets; app down is down", async () => {
    process.env.GSAM_FLEET_STALE_AFTER_MINUTES = "5";
    process.env.GSAM_FLEET_DOWN_AFTER_MINUTES = "30";
    try {
      const { id, key, seq } = await register("c001");
      let last = seq;
      const next = () => (last = nextSeq(last));
      const state = async () => (await request(app()).get("/api/fleet/instances")).body[0].state;
      await sendCheckIn(key, id, next());
      const ago = (minutes: number) =>
        db.update(fleetInstances).set({ lastCheckInAt: new Date(Date.now() - minutes * 60 * 1000) }).where(eq(fleetInstances.id, id));
      await ago(10);
      expect(await state()).toBe("stale");
      await ago(31);
      expect(await state()).toBe("down");
      await sendCheckIn(key, id, next(), { ...checkIn, health: { ...checkIn.health, app: "down" } });
      expect(await state()).toBe("down");
    } finally {
      delete process.env.GSAM_FLEET_STALE_AFTER_MINUTES;
      delete process.env.GSAM_FLEET_DOWN_AFTER_MINUTES;
    }
  });

  it("a v1 check-in is stored and keeps the lifecycle the hub knows", async () => {
    const { id, key, seq } = await register("c001");
    let last = seq;
    const next = () => (last = nextSeq(last));
    await sendCheckIn(key, id, next(), { ...checkIn, lifecycle: "paused" });
    expect((await sendCheckIn(key, id, next(), checkInV1)).status).toBe(200);
    const [instance] = (await request(app()).get("/api/fleet/instances")).body;
    expect(instance).toMatchObject({ lifecycle: "paused", state: "paused" });
    expect((await request(app()).get(`/api/fleet/instances/${id}/check-ins`)).body[0].checkIn).toEqual(checkInV1);
  });

  it("revokes from the hub: the spoke's key is refused after", async () => {
    const { id, key, seq } = await register("c001");
    expect((await request(app()).post(`/api/fleet/instances/${id}/revoke`)).body).toMatchObject({ status: "revoked", revokedBy: "hub" });
    const res = await sendCheckIn(key, id, nextSeq(seq));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("fleet_key_revoked");
  });

  it("revokes from the spoke: a signed revoke, then the key is refused", async () => {
    const { id, key, seq } = await register("c001");
    const revoke = signFleetMessage(key.privateJwk, { act: "revoke", sub: id, seq: nextSeq(seq) });
    expect((await request(app()).post("/api/fleet/spoke/revoke").send({ message: revoke })).status).toBe(200);
    expect((await db.select().from(fleetInstances))[0]).toMatchObject({ status: "revoked", revokedBy: "spoke" });
    expect((await sendCheckIn(key, id, nextSeq(seq) + 10)).body.error).toBe("fleet_key_revoked");
    // Someone else cannot revoke an instance.
    const other = await register("c002");
    const forged = signFleetMessage(key.privateJwk, { act: "revoke", sub: other.id, seq: nextSeq(other.seq) });
    expect((await request(app()).post("/api/fleet/spoke/revoke").send({ message: forged })).body.error).toBe("fleet_bad_signature");
  });

  it("AT-4.8: a signed spoke delete removes the record and its check-ins, once", async () => {
    const { id, key, seq } = await register("c001");
    const other = await register("c002");
    expect((await sendCheckIn(key, id, nextSeq(seq))).status).toBe(200);
    expect((await sendCheckIn(other.key, other.id, nextSeq(other.seq))).status).toBe(200);
    // Someone else's key cannot delete an instance.
    const forged = signFleetMessage(key.privateJwk, { act: "delete", sub: other.id, seq: nextSeq(other.seq) + 10 });
    expect((await request(app()).post("/api/fleet/spoke/delete").send({ message: forged })).body.error).toBe("fleet_bad_signature");
    // A revoke message is not a delete.
    const wrongAct = signFleetMessage(key.privateJwk, { act: "revoke", sub: id, seq: nextSeq(seq) + 10 });
    expect((await request(app()).post("/api/fleet/spoke/delete").send({ message: wrongAct })).body.error).toBe("fleet_bad_message");

    const message = signFleetMessage(key.privateJwk, { act: "delete", sub: id, seq: nextSeq(seq) + 20 });
    const res = await request(app()).post("/api/fleet/spoke/delete").send({ message });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["deletedAt"]);
    expect((await db.select().from(fleetInstances)).map((row) => row.code)).toEqual(["c002"]);
    expect((await db.select().from(fleetCheckIns)).map((row) => row.fleetInstanceId)).toEqual([other.id]);
    // Sent again, or anything else from the old key: nothing is there to answer.
    expect((await request(app()).post("/api/fleet/spoke/delete").send({ message })).body.error).toBe("fleet_bad_signature");
    expect((await sendCheckIn(key, id, nextSeq(seq) + 30)).body.error).toBe("fleet_bad_signature");
  });

  it("AT-4.8: a revoked instance cannot delete itself; the hub admin removes it", async () => {
    const { id, key, seq } = await register("c001");
    await request(app()).post(`/api/fleet/instances/${id}/revoke`);
    const message = signFleetMessage(key.privateJwk, { act: "delete", sub: id, seq: nextSeq(seq) });
    expect((await request(app()).post("/api/fleet/spoke/delete").send({ message })).body.error).toBe("fleet_key_revoked");
    actor = { type: "board", userId: "client-user", source: "session", isInstanceAdmin: false, companyIds: [] };
    expect((await request(app()).delete(`/api/fleet/instances/${id}`)).status).toBe(403);
    actor = { type: "board", userId: "hub-admin", source: "session", isInstanceAdmin: true, companyIds: [] };
    expect((await request(app()).delete(`/api/fleet/instances/${id}`)).body).toEqual({ id, removed: true });
    expect(await db.select().from(fleetInstances)).toHaveLength(0);
    expect((await request(app()).delete(`/api/fleet/instances/${id}`)).status).toBe(404);
  });


  it("re-registers after a revoke with a new code and a new key", async () => {
    const { id, key, seq } = await register("c001");
    await request(app()).post(`/api/fleet/instances/${id}/revoke`);
    const reissued = await request(app()).post(`/api/fleet/instances/${id}/registration-code`);
    expect(reissued.status).toBe(201);
    const fresh = generateFleetKey();
    const registrationCode = reissued.body.registrationCode as string;
    const proof = signFleetMessage(fresh.privateJwk, { act: "register", sub: registrationSubject(registrationCode), seq: nextSeq(0) });
    const res = await request(app()).post("/api/fleet/spoke/register").send({ registrationCode, publicKey: fresh.publicKey, proof });
    expect(res.body.instanceId).toBe(id);
    expect((await sendCheckIn(key, id, nextSeq(seq) + 100)).body.error).toBe("fleet_bad_signature");
    expect((await sendCheckIn(fresh, id, nextSeq(seq) + 200)).status).toBe(200);
    // A registered instance must be revoked before a new code.
    expect((await request(app()).post(`/api/fleet/instances/${id}/registration-code`)).status).toBe(409);
  });

  // A message is verified with the key read before the write. If the hub
  // revokes, makes a new code and a new key registers in that gap, the old
  // key's message must still be refused (review of PR #466).
  function raceAfterVerify(old: Awaited<ReturnType<typeof register>>) {
    const base = fleetService(db);
    const replacement = generateFleetKey();
    return new Proxy(db, {
      get(target, property, receiver) {
        if (property === "transaction") {
          return async (callback: Parameters<typeof db.transaction>[0]) => {
            await base.revokeFromHub(old.id);
            const code = await base.reissueCode(old.id);
            await base.register({
              registrationCode: code!.registrationCode,
              publicKey: replacement.publicKey,
              proof: signFleetMessage(replacement.privateJwk, {
                act: "register",
                sub: registrationSubject(code!.registrationCode),
                seq: old.seq + 1,
              }),
            });
            return target.transaction(callback);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
  }

  it("refuses an old-key check-in when the key is replaced between verify and write", async () => {
    const old = await register("c001");
    const stale = signFleetMessage(old.key.privateJwk, { act: "check-in", sub: old.id, seq: old.seq + 1000, checkIn });
    await expect(fleetService(raceAfterVerify(old)).checkIn(stale)).rejects.toThrow("fleet_replay");
    expect(await db.select().from(fleetCheckIns)).toHaveLength(0);
    expect((await db.select().from(fleetInstances))[0]).toMatchObject({ status: "active", lastCheckInAt: null });
  });

  it("refuses an old-key spoke revoke when the key is replaced between verify and write", async () => {
    const old = await register("c001");
    const stale = signFleetMessage(old.key.privateJwk, { act: "revoke", sub: old.id, seq: old.seq + 1000 });
    await expect(fleetService(raceAfterVerify(old)).revokeFromSpoke(stale)).rejects.toThrow("fleet_replay");
    expect((await db.select().from(fleetInstances))[0]).toMatchObject({ status: "active", revokedBy: null });
  });

  it("refuses an old-key spoke delete when the key is replaced between verify and write", async () => {
    const old = await register("c001");
    const stale = signFleetMessage(old.key.privateJwk, { act: "delete", sub: old.id, seq: old.seq + 1000 });
    await expect(fleetService(raceAfterVerify(old)).deleteFromSpoke(stale)).rejects.toThrow("fleet_replay");
    expect(await db.select().from(fleetInstances)).toHaveLength(1);
  });

  it("keeps each instance's facts apart: one key cannot write as another, and no spoke route reads facts", async () => {
    const a = await register("c001");
    const b = await register("c002");
    expect((await sendCheckIn(a.key, a.id, nextSeq(a.seq))).status).toBe(200);
    // A signs a check-in that names B.
    const asB = await sendCheckIn(a.key, b.id, nextSeq(b.seq));
    expect(asB.status).toBe(401);
    expect(asB.body.error).toBe("fleet_bad_signature");
    expect((await request(app()).get(`/api/fleet/instances/${b.id}/check-ins`)).body).toHaveLength(0);
    // The spoke side has no read route at all.
    actor = { type: "none", source: "none" };
    for (const path of ["/api/fleet/spoke/check-in", "/api/fleet/spoke/register", "/api/fleet/spoke/check-ins"]) {
      expect([403, 404]).toContain((await request(app()).get(path)).status);
    }
    expect((await request(app()).get(`/api/fleet/instances/${a.id}/check-ins`)).status).toBe(403);
  });

  it("has no route that sends a command to a spoke", () => {
    const paths = [fleetHubRoutes(db), fleetSpokeRoutes(db)].flatMap((router) =>
      (router.stack as Array<{ route?: { path: string } }>).flatMap((layer) => (layer.route ? [layer.route.path] : [])),
    );
    expect(paths.sort()).toEqual([
      "/api/fleet/spoke/check-in",
      "/api/fleet/spoke/delete",
      "/api/fleet/spoke/register",
      "/api/fleet/spoke/revoke",
      "/api/fleet/spoke/support-attachment",
      "/api/fleet/spoke/support-sync",
      "/fleet/instances",
      "/fleet/instances",
      "/fleet/instances/:id",
      "/fleet/instances/:id/check-ins",
      "/fleet/instances/:id/registration-code",
      "/fleet/instances/:id/revoke",
      "/fleet/instances/:id/support-queue",
    ]);
  });
});
