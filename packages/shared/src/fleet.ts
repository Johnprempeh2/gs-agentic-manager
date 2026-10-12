// Fleet channel between the Greatstone hub and each client instance (GRE-1082,
// GRE-1069 slides 24 and 26). App-layer only: every message is a compact JWS
// (EdDSA, Ed25519) signed by the spoke's own key; the hub keeps only the
// public key. No remote commands: the spoke reports, the hub listens.
//
// The check-in schema is closed. It carries facts about the instance (health,
// version, usage totals, watch alerts, lifecycle, connection counts) and
// never business data: no names,
// emails, titles, free text or ids of client records. Every object is strict,
// every string is an enum or a narrow pattern, so a new field needs a change
// here and a review.

import { z } from "zod";
import { fleetSupportAttachmentSchema, fleetSupportSyncSchema } from "./fleet-support.js";

export const FLEET_JWS_TYPE = "gsam-fleet+jwt";
export const FLEET_AUDIENCE = "gsam-fleet/v1";
/** v2 (GRE-1366) adds `lifecycle`, `connections` and `usage.runsFailedLast24h`. The hub still takes v1 until every spoke runs a v2 release. */
export const FLEET_CHECK_IN_SCHEMA = "gsam-fleet-check-in/v2";
export const FLEET_CHECK_IN_SCHEMA_V1 = "gsam-fleet-check-in/v1";
/** The spoke sends one check-in per watch pass. */
export const FLEET_CHECK_IN_INTERVAL_SECONDS = 5 * 60;
/** A signed message is good for this long after it is made. */
export const FLEET_MAX_MESSAGE_LIFETIME_SECONDS = 5 * 60;
export const FLEET_MAX_CLOCK_SKEW_SECONDS = 60;
/** A one-time registration code is good for this long. */
export const FLEET_REGISTRATION_CODE_TTL_HOURS = 24;
export const FLEET_REGISTRATION_CODE_PREFIX = "gsamfr_";

/**
 * `delete` (B9): the spoke asks the hub to remove its record and check-ins, as the last step of `client-instance.sh delete`.
 * `support-sync` and `support-attachment` (GRE-1084): the spoke sends its support tickets and client-picked files (fleet-support.ts).
 */
export const FLEET_ACTIONS = ["register", "check-in", "revoke", "delete", "support-sync", "support-attachment"] as const;
export type FleetAction = (typeof FLEET_ACTIONS)[number];

export const FLEET_INSTANCE_STATUSES = ["pending", "active", "revoked"] as const;
export type FleetInstanceStatus = (typeof FLEET_INSTANCE_STATUSES)[number];

/** What the operator did to the instance on the host (B9: `pause`, `resume`, `archive`). Not the same as up or down. */
export const FLEET_LIFECYCLES = ["active", "paused", "archived"] as const;
export type FleetLifecycle = (typeof FLEET_LIFECYCLES)[number];

/** The instance code (the `<root>` folder name), never a client name. */
export const fleetInstanceCodeSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/, "code: a-z, 0-9 and -, 3 to 32 characters");

/**
 * Watch signal key (scripts/client-instance/watch.ts) without any suffix. The
 * spoke folds per-company signals (`ai-connections:<id>`) into one key per
 * check, so no company id ever leaves the host.
 */
export const FLEET_ALERT_KEY_PATTERN = /^[a-z][a-z-]{0,39}$/;

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ageMinutes = z.number().int().min(0).max(100_000_000);
const releaseTag = z.string().regex(/^[A-Za-z0-9._-]{1,80}$/);
const check = z.object({ ok: z.boolean(), ageMinutes }).strict();

const usageV1Fields = {
  companies: count,
  activeAgents: count,
  runsLast24h: count,
  spendCentsMonth: count,
  budgetCentsMonth: count,
  storageBytes: count,
};
const usageV1Schema = z.object(usageV1Fields).strict();
/** v2 adds failed runs (GRE-144): runs made in the last 24 hours that ended failed, timed out or interrupted. */
const usageV2Schema = z.object({ ...usageV1Fields, runsFailedLast24h: count }).strict();

const checkInV1Fields = {
  edition: z.enum(["managed", "managed-plus", "internal"]),
  health: z
    .object({
      app: z.enum(["ok", "down"]),
      backupAgeMinutes: ageMinutes.nullable(),
      restoreCheck: check.nullable(),
      offsiteBackup: check.nullable(),
    })
    .strict(),
  version: z
    .object({
      releaseTag: releaseTag.nullable(),
      appVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,40}$/).nullable(),
      lastUpgrade: z.object({ toTag: releaseTag.nullable(), ageMinutes }).strict().nullable(),
    })
    .strict(),
  /** Totals over the whole instance. Never per company, agent or person. */
  usage: usageV1Schema,
  /**
   * The watch signals of the last pass, one per check over the whole
   * instance: key and pass/fail only. Detail text and company ids stay on the host.
   */
  alerts: z.array(z.object({ key: z.string().regex(FLEET_ALERT_KEY_PATTERN), ok: z.boolean() }).strict()).max(64),
};

/**
 * Connection health as counts over the whole instance. Never a name, id,
 * provider or company: only how many. Null when the app is not up to ask.
 */
export const fleetConnectionsSchema = z
  .object({
    /** AI log-ins: connected with no expiry under 7 days, or anything else. */
    ai: z.object({ healthy: count, needsAttention: count }).strict(),
    /** Tool connections that are switched on, or switched off. Drafts and archived ones are not counted. */
    tools: z.object({ active: count, disabled: count }).strict(),
  })
  .strict();
export type FleetConnections = z.infer<typeof fleetConnectionsSchema>;

export const fleetCheckInV1Schema = z.object({ schema: z.literal(FLEET_CHECK_IN_SCHEMA_V1), ...checkInV1Fields }).strict();

export const fleetCheckInV2Schema = z
  .object({
    schema: z.literal(FLEET_CHECK_IN_SCHEMA),
    ...checkInV1Fields,
    usage: usageV2Schema,
    lifecycle: z.enum(FLEET_LIFECYCLES),
    connections: fleetConnectionsSchema.nullable(),
  })
  .strict();

/** What a spoke signs and sends: always the newest version. */
export type FleetCheckIn = z.infer<typeof fleetCheckInV2Schema>;

/** What the hub takes: the newest version, or v1 from a spoke not yet upgraded. Any other field is refused. */
export const fleetCheckInSchema = z.discriminatedUnion("schema", [fleetCheckInV2Schema, fleetCheckInV1Schema]);
export type FleetReceivedCheckIn = z.infer<typeof fleetCheckInSchema>;

/** Ed25519 public key as a JWK; the hub stores `x` only. */
export const fleetPublicKeySchema = z
  .object({ kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
export type FleetPublicKey = z.infer<typeof fleetPublicKeySchema>;

/**
 * Claims of every signed fleet message. `seq` (milliseconds) must grow with
 * each message an instance sends; the hub refuses any `seq` it has seen, so a
 * captured message cannot be sent again.
 */
export const fleetClaimsSchema = z
  .object({
    v: z.literal(1),
    aud: z.literal(FLEET_AUDIENCE),
    act: z.enum(FLEET_ACTIONS),
    /** The hub's instance id; for `register`, the SHA-256 (base64url) of the registration code. */
    sub: z.string().min(1).max(64),
    iat: z.number().int(),
    exp: z.number().int(),
    seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    checkIn: fleetCheckInSchema.optional(),
    support: fleetSupportSyncSchema.optional(),
    attachment: fleetSupportAttachmentSchema.optional(),
  })
  .strict();
export type FleetClaims = z.infer<typeof fleetClaimsSchema>;

export const fleetRegisterRequestSchema = z
  .object({
    registrationCode: z.string().startsWith(FLEET_REGISTRATION_CODE_PREFIX).max(128),
    publicKey: fleetPublicKeySchema,
    /** A fleet message with act `register`, signed by the new key: proof the spoke holds it. */
    proof: z.string().min(1).max(4096),
  })
  .strict();

/**
 * What the hub shows for an instance. A paused or archived instance is
 * stopped on purpose, so it is never "stale" or "down" (AT-3.8). The two
 * limits are hub settings, not constants.
 */
export const FLEET_INSTANCE_STATES = ["pending", "revoked", "paused", "archived", "waiting", "ok", "stale", "down"] as const;
export type FleetInstanceState = (typeof FLEET_INSTANCE_STATES)[number];

export function fleetInstanceState(
  input: { status: FleetInstanceStatus; lifecycle: FleetLifecycle | null; lastCheckInAt: Date | null; lastAppHealth: "ok" | "down" | null },
  limits: { staleAfterMinutes: number; downAfterMinutes: number },
  now = new Date(),
): FleetInstanceState {
  if (input.status !== "active") return input.status;
  if (input.lifecycle === "paused" || input.lifecycle === "archived") return input.lifecycle;
  if (!input.lastCheckInAt) return "waiting";
  const ageMinutes = (now.getTime() - input.lastCheckInAt.getTime()) / 60_000;
  if (ageMinutes >= limits.downAfterMinutes || input.lastAppHealth === "down") return "down";
  return ageMinutes >= limits.staleAfterMinutes ? "stale" : "ok";
}

/** One row of `GET /api/fleet/instances` (F2 fleet page, GRE-1083). Read-only; dates are ISO strings on the wire. */
export interface FleetInstanceView {
  id: string;
  code: string;
  status: FleetInstanceStatus;
  state: FleetInstanceState;
  lifecycle: FleetLifecycle | null;
  lifecycleChangedAt: string | null;
  registeredAt: string | null;
  lastCheckInAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  registrationCodeExpiresAt: string | null;
  createdAt: string;
  latestCheckIn: { receivedAt: string; checkIn: FleetReceivedCheckIn } | null;
}

export const fleetSignedRequestSchema = z.object({ message: z.string().min(1).max(16_384) }).strict();
