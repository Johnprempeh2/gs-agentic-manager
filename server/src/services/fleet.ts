import { createHash, createPublicKey, randomBytes, verify, type KeyObject } from "node:crypto";
import { and, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { fleetCheckIns, fleetInstances } from "@greatstone/db";
import {
  FLEET_AUDIENCE,
  FLEET_JWS_TYPE,
  FLEET_MAX_CLOCK_SKEW_SECONDS,
  FLEET_MAX_MESSAGE_LIFETIME_SECONDS,
  FLEET_REGISTRATION_CODE_PREFIX,
  FLEET_REGISTRATION_CODE_TTL_HOURS,
  fleetClaimsSchema,
  type FleetAction,
  type FleetClaims,
  type FleetPublicKey,
} from "@greatstone/shared/fleet";

// Hub side of the fleet channel (GRE-1082). Same shape as the Cloud control
// assertion (services/cloud-runtime-identity.ts): a compact EdDSA JWS, a
// short lifetime, one action per message and a replay fence. The difference
// is the key: each spoke has its own, and the hub stores only its public half.

const CHECK_IN_RETENTION_DAYS = 7;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The hub side is off unless this instance is the Greatstone hub. A client instance never answers fleet calls. */
export function fleetHubEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GSAM_FLEET_HUB?.trim() === "true";
}

export type FleetRejection =
  | "fleet_bad_message"
  | "fleet_bad_signature"
  | "fleet_bad_registration_code"
  | "fleet_not_registered"
  | "fleet_key_revoked"
  | "fleet_replay";

export class FleetMessageError extends Error {
  constructor(
    readonly code: FleetRejection,
    readonly status: 400 | 401 | 409,
  ) {
    super(code);
  }
}

const reject = (code: FleetRejection, status: 400 | 401 | 409 = 401): never => {
  throw new FleetMessageError(code, status);
};

export function hashRegistrationCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("base64url");
}

function decodePart(part: string | undefined): Record<string, unknown> {
  if (!part) return reject("fleet_bad_message", 400);
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  return reject("fleet_bad_message", 400);
}

function splitMessage(compactJws: string) {
  const parts = compactJws.split(".");
  if (parts.length !== 3) reject("fleet_bad_message", 400);
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decodePart(headerPart);
  if (header.alg !== "EdDSA" || header.typ !== FLEET_JWS_TYPE) reject("fleet_bad_message", 400);
  return { header, payload: decodePart(payloadPart), signingInput: Buffer.from(`${headerPart}.${payloadPart}`), signature: Buffer.from(signaturePart, "base64url") };
}

function publicKeyFromX(x: string): KeyObject {
  try {
    return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
  } catch {
    return reject("fleet_bad_message", 400);
  }
}

/** Signature, then claims, then the time window. Throws a FleetMessageError. */
function verifyMessage(compactJws: string, key: KeyObject, expected: { act: FleetAction; sub: string }, now: Date): FleetClaims {
  const { payload, signingInput, signature } = splitMessage(compactJws);
  if (!verify(null, signingInput, key, signature)) reject("fleet_bad_signature");
  const parsed = fleetClaimsSchema.safeParse(payload);
  if (!parsed.success) return reject("fleet_bad_message", 400);
  const claims = parsed.data;
  if (claims.aud !== FLEET_AUDIENCE || claims.act !== expected.act || claims.sub !== expected.sub) reject("fleet_bad_message", 400);
  if ((claims.act === "check-in") !== Boolean(claims.checkIn)) reject("fleet_bad_message", 400);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (
    claims.exp <= claims.iat
    || claims.exp - claims.iat > FLEET_MAX_MESSAGE_LIFETIME_SECONDS
    || claims.iat > nowSeconds + FLEET_MAX_CLOCK_SKEW_SECONDS
    || claims.exp < nowSeconds - FLEET_MAX_CLOCK_SKEW_SECONDS
  ) {
    reject("fleet_replay", 409);
  }
  return claims;
}

export type FleetInstanceRow = typeof fleetInstances.$inferSelect;

/** What the hub shows about an instance. Never the registration code hash. */
function view(row: FleetInstanceRow) {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    registeredAt: row.registeredAt,
    lastCheckInAt: row.lastCheckInAt,
    revokedAt: row.revokedAt,
    revokedBy: row.revokedBy,
    registrationCodeExpiresAt: row.status === "pending" ? row.registrationCodeExpiresAt : null,
    createdAt: row.createdAt,
  };
}

function newRegistrationCode(now: Date) {
  const code = `${FLEET_REGISTRATION_CODE_PREFIX}${randomBytes(32).toString("base64url")}`;
  return {
    code,
    hash: hashRegistrationCode(code),
    expiresAt: new Date(now.getTime() + FLEET_REGISTRATION_CODE_TTL_HOURS * 60 * 60 * 1000),
  };
}

export function fleetService(db: Db) {
  async function signedSender(compactJws: string, act: Exclude<FleetAction, "register">, now: Date) {
    const { header, payload } = splitMessage(compactJws);
    const id = typeof payload.sub === "string" && UUID_PATTERN.test(payload.sub) ? payload.sub : null;
    if (!id || header.kid !== id) return reject("fleet_bad_message", 400);
    const row = await db.select().from(fleetInstances).where(eq(fleetInstances.id, id)).then((rows) => rows[0] ?? null);
    // The public key stays after a revoke so a revoked spoke still gets a clear answer.
    if (!row?.publicKeyX) return reject("fleet_bad_signature");
    const claims = verifyMessage(compactJws, publicKeyFromX(row.publicKeyX), { act, sub: row.id }, now);
    if (row.status === "revoked") reject("fleet_key_revoked");
    if (row.status !== "active") reject("fleet_not_registered");
    return { row, claims };
  }

  /** Move the replay fence; false when `seq` is not new or the row is no longer active. */
  async function advanceSeq(tx: Pick<Db, "update">, id: string, seq: number, now: Date, fields: Partial<FleetInstanceRow> = {}) {
    const rows = await tx
      .update(fleetInstances)
      .set({ lastSeq: seq, updatedAt: now, ...fields })
      .where(and(eq(fleetInstances.id, id), eq(fleetInstances.status, "active"), or(isNull(fleetInstances.lastSeq), lt(fleetInstances.lastSeq, seq))))
      .returning({ id: fleetInstances.id });
    return rows.length > 0;
  }

  return {
    async list() {
      const rows = await db.select().from(fleetInstances).orderBy(fleetInstances.code);
      return rows.map(view);
    },

    async get(id: string) {
      if (!UUID_PATTERN.test(id)) return null;
      const row = await db.select().from(fleetInstances).where(eq(fleetInstances.id, id)).then((rows) => rows[0] ?? null);
      return row ? view(row) : null;
    },

    /** A new pending instance and its one-time code. The code is returned once and stored only as a hash. */
    async create(code: string, createdByUserId: string | null, now = new Date()) {
      const registration = newRegistrationCode(now);
      const [row] = await db
        .insert(fleetInstances)
        .values({
          code,
          status: "pending",
          registrationCodeHash: registration.hash,
          registrationCodeExpiresAt: registration.expiresAt,
          createdByUserId,
        })
        .onConflictDoNothing({ target: fleetInstances.code })
        .returning();
      if (!row) return null;
      return { instance: view(row), registrationCode: registration.code };
    },

    /**
     * A fresh code for a pending or revoked instance (re-register after a
     * revoke, or a code that expired). The old key and replay fence go.
     */
    async reissueCode(id: string, now = new Date()) {
      const registration = newRegistrationCode(now);
      const [row] = await db
        .update(fleetInstances)
        .set({
          status: "pending",
          registrationCodeHash: registration.hash,
          registrationCodeExpiresAt: registration.expiresAt,
          publicKeyX: null,
          lastSeq: null,
          registeredAt: null,
          updatedAt: now,
        })
        .where(and(eq(fleetInstances.id, id), sql`${fleetInstances.status} <> 'active'`))
        .returning();
      return row ? { instance: view(row), registrationCode: registration.code } : null;
    },

    async revokeFromHub(id: string, now = new Date()) {
      const [row] = await db
        .update(fleetInstances)
        .set({ status: "revoked", revokedAt: now, revokedBy: "hub", registrationCodeHash: null, registrationCodeExpiresAt: null, updatedAt: now })
        .where(eq(fleetInstances.id, id))
        .returning();
      return row ? view(row) : null;
    },

    async checkIns(id: string, limit: number) {
      return db
        .select({ seq: fleetCheckIns.seq, receivedAt: fleetCheckIns.receivedAt, checkIn: fleetCheckIns.payload })
        .from(fleetCheckIns)
        .where(eq(fleetCheckIns.fleetInstanceId, id))
        .orderBy(desc(fleetCheckIns.receivedAt))
        .limit(limit);
    },

    /** Spoke: trade the one-time code and a signed proof for an active registration. */
    async register(input: { registrationCode: string; publicKey: FleetPublicKey; proof: string }, now = new Date()) {
      const codeHash = hashRegistrationCode(input.registrationCode);
      const claims = verifyMessage(input.proof, publicKeyFromX(input.publicKey.x), { act: "register", sub: codeHash }, now);
      const [row] = await db
        .update(fleetInstances)
        .set({
          status: "active",
          publicKeyX: input.publicKey.x,
          lastSeq: claims.seq,
          registeredAt: now,
          revokedAt: null,
          revokedBy: null,
          registrationCodeHash: null,
          registrationCodeExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(fleetInstances.registrationCodeHash, codeHash),
            eq(fleetInstances.status, "pending"),
            gt(fleetInstances.registrationCodeExpiresAt, now),
          ),
        )
        .returning();
      if (!row) return reject("fleet_bad_registration_code");
      return { instanceId: row.id, code: row.code };
    },

    /** Spoke: one signed check-in. Stored as parsed by the closed schema, nothing else. */
    async checkIn(compactJws: string, now = new Date()) {
      const { row, claims } = await signedSender(compactJws, "check-in", now);
      await db.transaction(async (tx) => {
        if (!(await advanceSeq(tx, row.id, claims.seq, now, { lastCheckInAt: now }))) reject("fleet_replay", 409);
        await tx.insert(fleetCheckIns).values({ fleetInstanceId: row.id, seq: claims.seq, payload: claims.checkIn!, receivedAt: now });
        const cutoff = new Date(now.getTime() - CHECK_IN_RETENTION_DAYS * 24 * 60 * 60 * 1000);
        await tx.delete(fleetCheckIns).where(and(eq(fleetCheckIns.fleetInstanceId, row.id), lt(fleetCheckIns.receivedAt, cutoff)));
      });
      return { receivedAt: now.toISOString() };
    },

    /** Spoke: revoke its own key. After this the hub refuses every message signed by it. */
    async revokeFromSpoke(compactJws: string, now = new Date()) {
      const { row, claims } = await signedSender(compactJws, "revoke", now);
      if (!(await advanceSeq(db, row.id, claims.seq, now, { status: "revoked", revokedAt: now, revokedBy: "spoke" }))) reject("fleet_replay", 409);
      return { revokedAt: now.toISOString() };
    },
  };
}
