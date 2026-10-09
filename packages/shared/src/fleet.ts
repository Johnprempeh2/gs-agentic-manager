// Fleet channel between the Greatstone hub and each client instance (GRE-1082,
// GRE-1069 slides 24 and 26). App-layer only: every message is a compact JWS
// (EdDSA, Ed25519) signed by the spoke's own key; the hub keeps only the
// public key. No remote commands: the spoke reports, the hub listens.
//
// The check-in schema is closed. It carries facts about the instance (health,
// version, usage totals, watch alerts) and never business data: no names,
// emails, titles, free text or ids of client records. Every object is strict,
// every string is an enum or a narrow pattern, so a new field needs a change
// here and a review.

import { z } from "zod";

export const FLEET_JWS_TYPE = "gsam-fleet+jwt";
export const FLEET_AUDIENCE = "gsam-fleet/v1";
export const FLEET_CHECK_IN_SCHEMA = "gsam-fleet-check-in/v1";
/** The spoke sends one check-in per watch pass. */
export const FLEET_CHECK_IN_INTERVAL_SECONDS = 5 * 60;
/** A signed message is good for this long after it is made. */
export const FLEET_MAX_MESSAGE_LIFETIME_SECONDS = 5 * 60;
export const FLEET_MAX_CLOCK_SKEW_SECONDS = 60;
/** A one-time registration code is good for this long. */
export const FLEET_REGISTRATION_CODE_TTL_HOURS = 24;
export const FLEET_REGISTRATION_CODE_PREFIX = "gsamfr_";

export const FLEET_ACTIONS = ["register", "check-in", "revoke"] as const;
export type FleetAction = (typeof FLEET_ACTIONS)[number];

export const FLEET_INSTANCE_STATUSES = ["pending", "active", "revoked"] as const;
export type FleetInstanceStatus = (typeof FLEET_INSTANCE_STATUSES)[number];

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

export const fleetCheckInSchema = z
  .object({
    schema: z.literal(FLEET_CHECK_IN_SCHEMA),
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
    usage: z
      .object({
        companies: count,
        activeAgents: count,
        runsLast24h: count,
        spendCentsMonth: count,
        budgetCentsMonth: count,
        storageBytes: count,
      })
      .strict(),
    /**
     * The watch signals of the last pass, one per check over the whole
     * instance: key and pass/fail only. Detail text and company ids stay on the host.
     */
    alerts: z.array(z.object({ key: z.string().regex(FLEET_ALERT_KEY_PATTERN), ok: z.boolean() }).strict()).max(64),
  })
  .strict();

export type FleetCheckIn = z.infer<typeof fleetCheckInSchema>;

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

export const fleetSignedRequestSchema = z.object({ message: z.string().min(1).max(16_384) }).strict();
