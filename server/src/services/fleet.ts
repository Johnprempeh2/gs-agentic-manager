import { createHash, createPublicKey, randomBytes, verify, type KeyObject } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { Db } from "@greatstone/db";
import { fleetBillingCustomers, fleetCheckIns, fleetInstances, fleetOrders } from "@greatstone/db";
import type { EntitlementEnvelope } from "@greatstone/shared";
import {
  FLEET_AUDIENCE,
  FLEET_CHECK_IN_SCHEMA_V1,
  FLEET_CHECK_IN_SCHEMA_V3,
  FLEET_CHECK_IN_SCHEMA_V4,
  FLEET_LICENCE_KEY_PREFIX,
  FLEET_LICENCE_TTL_DAYS,
  FLEET_JWS_TYPE,
  FLEET_MAX_CLOCK_SKEW_SECONDS,
  FLEET_MAX_MESSAGE_LIFETIME_SECONDS,
  FLEET_REGISTRATION_CODE_PREFIX,
  FLEET_REGISTRATION_CODE_TTL_HOURS,
  fleetClaimsSchema,
  fleetInstanceState,
  type FleetActivateRequest,
  type FleetActivateResponse,
  type FleetAction,
  type FleetCheckInResponse,
  type FleetClaims,
  type FleetEntitlementInput,
  type FleetEntitlementSummary,
  type FleetOrderKind,
  type FleetOrderView,
  type FleetInstanceStatus,
  type FleetLifecycle,
  type FleetPublicKey,
  type FleetReceivedCheckIn,
} from "@greatstone/shared/fleet";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { signEntitlementDocument, type HubSigningKey } from "./fleet-entitlements.js";
import { signFleetOrder } from "./fleet-orders.js";

// Hub side of the fleet channel (GRE-1082). Same shape as the Cloud control
// assertion (services/cloud-runtime-identity.ts): a compact EdDSA JWS, a
// short lifetime, one action per message and a replay fence. The difference
// is the key: each spoke has its own, and the hub stores only its public half.

const CHECK_IN_RETENTION_DAYS = 7;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * When the hub shows an active instance as stale or down (AT-3.2). Hub
 * settings: GSAM_FLEET_STALE_AFTER_MINUTES and GSAM_FLEET_DOWN_AFTER_MINUTES.
 */
export function fleetStateLimits(env: NodeJS.ProcessEnv = process.env) {
  const minutes = (raw: string | undefined, fallback: number) => {
    const value = Number.parseInt(raw?.trim() ?? "", 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const staleAfterMinutes = minutes(env.GSAM_FLEET_STALE_AFTER_MINUTES, 15);
  return { staleAfterMinutes, downAfterMinutes: Math.max(staleAfterMinutes, minutes(env.GSAM_FLEET_DOWN_AFTER_MINUTES, 60)) };
}

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
  | "fleet_replay"
  | "fleet_support_unknown_ticket"
  | "fleet_support_bad_file";

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
  if ((claims.act === "support-sync") !== Boolean(claims.support)) reject("fleet_bad_message", 400);
  if ((claims.act === "support-attachment") !== Boolean(claims.attachment)) reject("fleet_bad_message", 400);
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
type FleetOrderRow = typeof fleetOrders.$inferSelect;

/** What the newest signed document grants, read back from the bytes the hub signed. */
function entitlementSummary(row: FleetInstanceRow): FleetEntitlementSummary | null {
  const envelope = row.entitlementDocument as EntitlementEnvelope | null;
  if (!envelope?.document) return null;
  try {
    const doc = JSON.parse(Buffer.from(envelope.document, "base64url").toString("utf8"));
    return {
      version: doc.version,
      features: doc.features ?? {},
      limits: doc.limits ?? {},
      validUntil: doc.validUntil,
      grace: typeof doc.grace === "number" ? doc.grace : 14,
      issuedAt: doc.issuedAt,
      issuedBy: doc.issuedBy,
      reason: doc.reason ?? null,
    };
  } catch {
    return null;
  }
}

function orderView(row: FleetOrderRow, now: Date): FleetOrderView {
  const status = (row.result as FleetOrderView["status"] | null) ?? (row.expiresAt <= now ? "expired" : "pending");
  return {
    id: row.id,
    seq: row.seq,
    kind: row.kind as FleetOrderKind,
    reason: row.reason,
    issuedBy: row.issuedBy,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    status,
    resultCode: (row.resultCode as FleetOrderView["resultCode"]) ?? null,
    resultAt: row.resultAt?.toISOString() ?? null,
  };
}

/** Orders shown per instance on the fleet page. */
const ORDERS_SHOWN = 5;

/** What the hub shows about an instance. Never the registration code hash. */
function view(row: FleetInstanceRow, now = new Date()) {
  const lifecycle = (row.lifecycle as FleetLifecycle | null) ?? null;
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    /** ok, stale, down, or paused / archived when the operator stopped it on purpose. */
    state: fleetInstanceState(
      {
        status: row.status as FleetInstanceStatus,
        lifecycle,
        lastCheckInAt: row.lastCheckInAt,
        lastAppHealth: (row.lastAppHealth as "ok" | "down" | null) ?? null,
      },
      fleetStateLimits(),
      now,
    ),
    lifecycle,
    lifecycleChangedAt: row.lifecycleChangedAt,
    registeredAt: row.registeredAt,
    lastCheckInAt: row.lastCheckInAt,
    revokedAt: row.revokedAt,
    revokedBy: row.revokedBy,
    registrationCodeExpiresAt: row.status === "pending" ? row.registrationCodeExpiresAt : null,
    /** GRE-1084: where this instance's "Get help" tickets land; null refuses them. */
    supportQueueId: row.supportQueueId,
    /** GSAM for Mac: the version of the newest signed document the hub holds, and the operator log-in's email. Never the password. */
    entitlementVersion: row.entitlementVersion,
    operatorEmail: row.operatorEmail,
    entitlement: entitlementSummary(row),
    createdAt: row.createdAt,
  };
}

/** The Greatstone operator log-in of a licensed install. `.invalid` never receives mail. */
export function fleetOperatorEmail(code: string): string {
  return `operator+${code}@greatstone.invalid`;
}

function newLicenceKey(now: Date) {
  const key = `${FLEET_LICENCE_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { key, hash: hashRegistrationCode(key), expiresAt: new Date(now.getTime() + FLEET_LICENCE_TTL_DAYS * 24 * 60 * 60 * 1000) };
}

function entitlementDocumentFor(code: string, version: number, input: FleetEntitlementInput, issuedBy: string, now: Date) {
  return {
    v: 1 as const,
    client: code,
    version,
    issuedAt: now.toISOString(),
    validUntil: new Date(input.validUntil).toISOString(),
    issuedBy,
    ...(input.reason ? { reason: input.reason } : {}),
    features: input.features,
    limits: input.limits,
    grace: input.grace,
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

export async function signedSender(db: Db, compactJws: string, act: Exclude<FleetAction, "register">, now: Date) {
  const { header, payload } = splitMessage(compactJws);
  const id = typeof payload.sub === "string" && UUID_PATTERN.test(payload.sub) ? payload.sub : null;
  if (!id || header.kid !== id) return reject("fleet_bad_message", 400);
  const row = await db.select().from(fleetInstances).where(eq(fleetInstances.id, id)).then((rows) => rows[0] ?? null);
  // The public key stays after a revoke so a revoked spoke still gets a clear answer.
  if (!row?.publicKeyX) return reject("fleet_bad_signature");
  const claims = verifyMessage(compactJws, publicKeyFromX(row.publicKeyX), { act, sub: row.id }, now);
  if (row.status === "revoked") reject("fleet_key_revoked");
  if (row.status !== "active") reject("fleet_not_registered");
  return { signer: { id: row.id, publicKeyX: row.publicKeyX }, claims };
}

/**
 * Move the replay fence; false when `seq` is not new, the row is no longer
 * active, or the key that signed the message is no longer the stored key.
 * The key check closes the gap between verify and write: a revoke and
 * re-register in that gap must not let a message from the old key land.
 */
export async function advanceSeq(
  tx: Pick<Db, "update">,
  signer: { id: string; publicKeyX: string },
  seq: number,
  now: Date,
  fields: PgUpdateSetSource<typeof fleetInstances> = {},
) {
  const rows = await tx
    .update(fleetInstances)
    .set({ lastSeq: seq, updatedAt: now, ...fields })
    .where(
      and(
        eq(fleetInstances.id, signer.id),
        eq(fleetInstances.status, "active"),
        eq(fleetInstances.publicKeyX, signer.publicKeyX),
        or(isNull(fleetInstances.lastSeq), lt(fleetInstances.lastSeq, seq)),
      ),
    )
    .returning({ id: fleetInstances.id });
  return rows.length > 0;
}

export function fleetService(
  db: Db,
  opts: { onOrderResult?: (instanceId: string, order: { id: string; seq: number; kind: string; result: string; code: string | null }) => Promise<void> } = {},
) {
  const { onOrderResult } = opts;
  const signedSenderFor = (compactJws: string, act: Exclude<FleetAction, "register">, now: Date) => signedSender(db, compactJws, act, now);

  return {
    /** Every instance with its newest stored check-in (F2 fleet page, GRE-1083). Null when none is kept. */
    async list(now = new Date()) {
      const rows = await db.select().from(fleetInstances).orderBy(fleetInstances.code);
      const latest = await db
        .selectDistinctOn([fleetCheckIns.fleetInstanceId], {
          fleetInstanceId: fleetCheckIns.fleetInstanceId,
          receivedAt: fleetCheckIns.receivedAt,
          checkIn: fleetCheckIns.payload,
        })
        .from(fleetCheckIns)
        .orderBy(fleetCheckIns.fleetInstanceId, desc(fleetCheckIns.receivedAt));
      const latestById = new Map(latest.map((entry) => [entry.fleetInstanceId, entry]));
      // ponytail: every order of the last 30 days in one read, grouped here; page it if a fleet grows into thousands.
      const orders = await db
        .select()
        .from(fleetOrders)
        .where(gt(fleetOrders.createdAt, new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)))
        .orderBy(desc(fleetOrders.seq));
      const ordersById = new Map<string, FleetOrderView[]>();
      for (const order of orders) {
        const list = ordersById.get(order.fleetInstanceId) ?? [];
        if (list.length < ORDERS_SHOWN) list.push(orderView(order, now));
        ordersById.set(order.fleetInstanceId, list);
      }
      // P3: the Stripe customer and subscription driving each install.
      const billingById = new Map((await db.select().from(fleetBillingCustomers)).map((link) => [link.fleetInstanceId, link]));
      return rows.map((row) => {
        const entry = latestById.get(row.id);
        const link = billingById.get(row.id);
        return {
          ...view(row, now),
          orders: ordersById.get(row.id) ?? [],
          billing: link
            ? { stripeCustomerId: link.stripeCustomerId, stripeSubscriptionId: link.stripeSubscriptionId, subscriptionStatus: link.subscriptionStatus, cancelAtPeriodEnd: link.cancelAtPeriodEnd }
            : null,
          latestCheckIn: entry ? { receivedAt: entry.receivedAt, checkIn: entry.checkIn as FleetReceivedCheckIn } : null,
        };
      });
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

    /**
     * GSAM for Mac: a new pending instance with a licence key and its first
     * signed document. The key is returned once and stored only as a hash.
     * Null when the code is taken.
     */
    async createLicence(input: FleetEntitlementInput & { code?: string }, issuedBy: { userId: string | null; label: string }, key: HubSigningKey, now = new Date()) {
      const code = input.code ?? `mac-${randomBytes(4).toString("hex")}`;
      const licence = newLicenceKey(now);
      const envelope = signEntitlementDocument(entitlementDocumentFor(code, 1, input, issuedBy.label, now), key);
      const [row] = await db
        .insert(fleetInstances)
        .values({
          code,
          status: "pending",
          registrationCodeHash: licence.hash,
          registrationCodeExpiresAt: licence.expiresAt,
          createdByUserId: issuedBy.userId,
          entitlementDocument: envelope,
          entitlementVersion: 1,
        })
        .onConflictDoNothing({ target: fleetInstances.code })
        .returning();
      if (!row) return null;
      return { instance: view(row, now), licenceKey: licence.key, licenceKeyExpiresAt: licence.expiresAt.toISOString() };
    },

    /** A newer signed document for the instance. It reaches the install with its next check-in answer. Null when not found. */
    async issueEntitlement(id: string, input: FleetEntitlementInput, issuedBy: string, key: HubSigningKey, now = new Date()) {
      if (!UUID_PATTERN.test(id)) return null;
      const row = await db.select().from(fleetInstances).where(eq(fleetInstances.id, id)).then((rows) => rows[0] ?? null);
      if (!row) return null;
      const version = (row.entitlementVersion ?? 0) + 1;
      const envelope = signEntitlementDocument(entitlementDocumentFor(row.code, version, input, issuedBy, now), key);
      const [updated] = await db
        .update(fleetInstances)
        .set({ entitlementDocument: envelope, entitlementVersion: version, updatedAt: now })
        .where(and(eq(fleetInstances.id, id), sql`${fleetInstances.entitlementVersion} is not distinct from ${row.entitlementVersion}`))
        .returning();
      if (!updated) return reject("fleet_replay", 409);
      return view(updated, now);
    },

    /**
     * Spoke (Mac app): trade a licence key and a signed proof for an active
     * registration, the first signed document and the Greatstone operator
     * log-in. One use: the key hash is cleared in the same update. A used,
     * expired or unknown key gets the same refusal.
     */
    async activate(
      input: FleetActivateRequest,
      key: HubSigningKey,
      now = new Date(),
      tailscaleAuthKey: () => Promise<string | null> = async () => null,
    ): Promise<FleetActivateResponse> {
      const codeHash = hashRegistrationCode(input.licenceKey);
      const claims = verifyMessage(input.proof, publicKeyFromX(input.publicKey.x), { act: "register", sub: codeHash }, now);
      const password = randomBytes(24).toString("base64url");
      const secret = await localEncryptedProvider.createSecret({ value: password });
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
          operatorEmail: sql`'operator+' || ${fleetInstances.code} || '@greatstone.invalid'`,
          operatorSecret: { provider: "local_encrypted", material: secret.material },
          updatedAt: now,
        })
        .where(
          and(
            eq(fleetInstances.registrationCodeHash, codeHash),
            eq(fleetInstances.status, "pending"),
            gt(fleetInstances.registrationCodeExpiresAt, now),
            sql`${fleetInstances.entitlementDocument} is not null`,
          ),
        )
        .returning();
      if (!row) return reject("fleet_bad_registration_code");
      // Remote network access is optional: an install without a key still works, it just cannot be reached.
      const authKey = await tailscaleAuthKey().catch(() => null);
      return {
        instanceId: row.id,
        code: row.code,
        entitlementPublicKey: key.publicKey,
        entitlement: row.entitlementDocument!,
        operator: { email: fleetOperatorEmail(row.code), password },
        tailscale: authKey ? { authKey } : null,
      };
    },

    /** Hub admin: the operator log-in of a licensed install, for remote help. Null when there is none. */
    async operatorLogin(id: string) {
      if (!UUID_PATTERN.test(id)) return null;
      const row = await db.select().from(fleetInstances).where(eq(fleetInstances.id, id)).then((rows) => rows[0] ?? null);
      const secret = row?.operatorSecret as { provider?: string; material?: Record<string, unknown> } | null | undefined;
      if (!row?.operatorEmail || secret?.provider !== "local_encrypted" || !secret.material) return null;
      return { email: row.operatorEmail, password: await localEncryptedProvider.resolveVersion({ material: secret.material, externalRef: null }) };
    },

    /** Spoke: one signed check-in. Stored as parsed by the closed schema, nothing else. The answer carries the newest signed document. */
    async checkIn(compactJws: string, now = new Date()): Promise<FleetCheckInResponse> {
      const { signer, claims } = await signedSenderFor(compactJws, "check-in", now);
      const checkIn = claims.checkIn!;
      // A v1 check-in says nothing about lifecycle, so the stored one stays.
      const lifecycle = checkIn.schema === FLEET_CHECK_IN_SCHEMA_V1 ? null : checkIn.lifecycle;
      const reports = checkIn.schema === FLEET_CHECK_IN_SCHEMA_V3 || checkIn.schema === FLEET_CHECK_IN_SCHEMA_V4 ? checkIn.orders : [];
      const recorded: Array<{ id: string; seq: number; kind: string; result: string; code: string | null }> = [];
      await db.transaction(async (tx) => {
        const fields: PgUpdateSetSource<typeof fleetInstances> = { lastCheckInAt: now, lastAppHealth: checkIn.health.app };
        if (lifecycle) {
          fields.lifecycle = lifecycle;
          fields.lifecycleChangedAt = sql`case when ${fleetInstances.lifecycle} is distinct from ${lifecycle} then ${now.toISOString()}::timestamptz else ${fleetInstances.lifecycleChangedAt} end`;
        }
        if (!(await advanceSeq(tx, signer, claims.seq, now, fields))) reject("fleet_replay", 409);
        await tx.insert(fleetCheckIns).values({ fleetInstanceId: signer.id, seq: claims.seq, payload: checkIn, receivedAt: now });
        const cutoff = new Date(now.getTime() - CHECK_IN_RETENTION_DAYS * 24 * 60 * 60 * 1000);
        await tx.delete(fleetCheckIns).where(and(eq(fleetCheckIns.fleetInstanceId, signer.id), lt(fleetCheckIns.receivedAt, cutoff)));
        // P2: order results. The first report of a seq wins; a repeat changes nothing.
        for (const report of reports) {
          const [order] = await tx
            .update(fleetOrders)
            .set({ result: report.result, resultCode: report.code, resultAt: now })
            .where(and(eq(fleetOrders.fleetInstanceId, signer.id), eq(fleetOrders.seq, report.seq), isNull(fleetOrders.result)))
            .returning({ id: fleetOrders.id, seq: fleetOrders.seq, kind: fleetOrders.kind });
          if (order) recorded.push({ ...order, result: report.result, code: report.code });
        }
      });
      if (onOrderResult) for (const order of recorded) await onOrderResult(signer.id, order).catch(() => undefined);
      const entitlement = await db
        .select({ document: fleetInstances.entitlementDocument })
        .from(fleetInstances)
        .where(eq(fleetInstances.id, signer.id))
        .then((rows) => (rows[0]?.document as EntitlementEnvelope | null | undefined) ?? null);
      // Signed orders not yet reported on and still in date, oldest first: the install obeys them in seq order.
      const orders = await db
        .select({ message: fleetOrders.message })
        .from(fleetOrders)
        .where(and(eq(fleetOrders.fleetInstanceId, signer.id), isNull(fleetOrders.result), gt(fleetOrders.expiresAt, now)))
        .orderBy(asc(fleetOrders.seq))
        .then((rows) => rows.map((row) => row.message));
      return { receivedAt: now.toISOString(), entitlement, orders };
    },

    /**
     * Hub admin: a signed order for an active instance. `seq` is one above the
     * instance's last order. Null when the instance is not found.
     */
    async createOrder(
      id: string,
      input: { kind: FleetOrderKind; reason: string },
      issuedBy: { userId: string | null; label: string },
      key: HubSigningKey,
      now = new Date(),
    ) {
      if (!UUID_PATTERN.test(id)) return null;
      const row = await db.select().from(fleetInstances).where(eq(fleetInstances.id, id)).then((rows) => rows[0] ?? null);
      if (!row) return null;
      if (row.status !== "active") return reject("fleet_not_registered", 409);
      const [last] = await db
        .select({ seq: fleetOrders.seq })
        .from(fleetOrders)
        .where(eq(fleetOrders.fleetInstanceId, id))
        .orderBy(desc(fleetOrders.seq))
        .limit(1);
      const seq = (last?.seq ?? 0) + 1;
      const signed = signFleetOrder({ instanceId: row.id, code: row.code, seq, kind: input.kind }, key, now);
      // The unique (instance, seq) index refuses a second order made at the same moment.
      const [order] = await db
        .insert(fleetOrders)
        .values({
          fleetInstanceId: row.id,
          seq,
          kind: input.kind,
          reason: input.reason,
          issuedBy: issuedBy.label,
          issuedByUserId: issuedBy.userId,
          message: signed.message,
          expiresAt: signed.expiresAt,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (!order) return reject("fleet_replay", 409);
      return orderView(order, now);
    },

    /** Hub admin: remove the record and its check-ins (B9 delete, when the spoke cannot ask). Null when not found. */
    async remove(id: string) {
      if (!UUID_PATTERN.test(id)) return null;
      const [row] = await db.delete(fleetInstances).where(eq(fleetInstances.id, id)).returning({ id: fleetInstances.id, code: fleetInstances.code });
      return row ?? null;
    },

    /**
     * Spoke: remove its own record and check-ins (B9 `delete`, AT-4.8). Same
     * fence as advanceSeq: the row must be active, signed by the stored key,
     * with a new seq. Check-ins go with the row (on delete cascade).
     */
    async deleteFromSpoke(compactJws: string, now = new Date()) {
      const { signer, claims } = await signedSenderFor(compactJws, "delete", now);
      await db.transaction(async (tx) => {
        const rows = await tx
          .delete(fleetInstances)
          .where(
            and(
              eq(fleetInstances.id, signer.id),
              eq(fleetInstances.status, "active"),
              eq(fleetInstances.publicKeyX, signer.publicKeyX),
              or(isNull(fleetInstances.lastSeq), lt(fleetInstances.lastSeq, claims.seq)),
            ),
          )
          .returning({ id: fleetInstances.id });
        if (rows.length === 0) reject("fleet_replay", 409);
      });
      return { deletedAt: now.toISOString() };
    },

    /** Spoke: revoke its own key. After this the hub refuses every message signed by it. */
    async revokeFromSpoke(compactJws: string, now = new Date()) {
      const { signer, claims } = await signedSenderFor(compactJws, "revoke", now);
      await db.transaction(async (tx) => {
        if (!(await advanceSeq(tx, signer, claims.seq, now, { status: "revoked", revokedAt: now, revokedBy: "spoke" }))) reject("fleet_replay", 409);
      });
      return { revokedAt: now.toISOString() };
    },
  };
}
