// Signed entitlement document contract (GRE-1078). The hub signs one document
// per client instance; the instance reads it from a file, verifies it with the
// hub public key, and applies it without a restart. Shared by server and UI.
//
// File shape (the envelope): { "v": 1, "document": "<base64url JSON>",
// "signature": "<base64url ed25519 signature over the decoded bytes>" }.
// The signature covers the exact document bytes, so no JSON canonical form is
// needed.

import { z } from "zod";
import type { InstanceFeatureKey } from "./feature-catalog.js";

export const ENTITLEMENT_DOCUMENT_VERSION = 1;

/** A last good document keeps applying for this long after `validUntil`; then the base floor. */
export const ENTITLEMENT_GRACE_DAYS = 14;

/** The file is re-read at least this often, so a new document applies within 5 minutes. */
export const ENTITLEMENT_RELOAD_INTERVAL_MS = 60_000;

/**
 * The switches a signed document governs: managed product features with
 * their own API or behavior (the `api` and `pending` gates in the server
 * registry). Runtime infrastructure switches (runner, sandbox, workspace
 * policy) stay with the operator, so an expired document never changes how
 * runs execute. `entitlements-document.test.ts` keeps this list equal to the
 * server gate registry.
 */
export const ENTITLEMENT_FEATURE_KEYS = [
  "enableAgentChat",
  "enableBuiltInAgents",
  "enableCases",
  "enableChatConnectors",
  "enableConferenceRoomChat",
  "enableDeepDive",
  "enableEnvironments",
  "enableExternalObjects",
  "enableIssuePlanDecompositions",
  "enableMemoryConnectors",
  "enablePipelines",
  "enableStatusCards",
  "enableSummaries",
] as const satisfies readonly InstanceFeatureKey[];

export type EntitlementFeatureKey = (typeof ENTITLEMENT_FEATURE_KEYS)[number];

export function isEntitlementFeatureKey(key: string): key is EntitlementFeatureKey {
  return (ENTITLEMENT_FEATURE_KEYS as readonly string[]).includes(key);
}

/**
 * The base floor: what an instance is entitled to with no valid document
 * (none yet, or past `validUntil` + grace). Every governed feature is off.
 * Off means "not entitled", never "deleted": stored data is kept.
 */
export const ENTITLEMENT_BASE_FLOOR: Readonly<Record<EntitlementFeatureKey, boolean>> = Object.freeze(
  Object.fromEntries(ENTITLEMENT_FEATURE_KEYS.map((key) => [key, false])) as Record<EntitlementFeatureKey, boolean>,
);

/**
 * Governed switches that change start-up wiring. A new document changes them
 * only after a restart; until then they report `pendingRestart`. None of the
 * governed switches is read once at start-up today; add a key here when one is.
 */
export const RESTART_WIRED_ENTITLEMENT_KEYS: readonly EntitlementFeatureKey[] = [];

export const entitlementEnvelopeSchema = z
  .object({
    v: z.literal(ENTITLEMENT_DOCUMENT_VERSION),
    document: z.string().min(1),
    signature: z.string().min(1),
  })
  .strict();

export type EntitlementEnvelope = z.infer<typeof entitlementEnvelopeSchema>;

export const entitlementDocumentSchema = z
  .object({
    v: z.literal(ENTITLEMENT_DOCUMENT_VERSION),
    /** Client the document was issued for. */
    client: z.string().trim().min(1).max(200),
    /** Increases with every new document for the client; an older version is refused. */
    version: z.number().int().positive(),
    issuedAt: z.string().datetime({ offset: true }),
    validUntil: z.string().datetime({ offset: true }),
    /** Hub admin who issued it (the "who" in the change log). */
    issuedBy: z.string().trim().min(1).max(200),
    /** Why it was issued (the "why" in the change log). */
    reason: z.string().trim().max(1000).optional(),
    /** Missing governed keys are not entitled. Unknown keys are ignored and reported. */
    features: z.record(z.string().min(1), z.boolean()),
    /** Named limits (for example `maxAgents`). Reported now; enforced by later work. */
    limits: z.record(z.string().min(1), z.number().int().nonnegative()).default({}),
  })
  .strict();

export type EntitlementDocument = z.infer<typeof entitlementDocumentSchema>;

/**
 * - `disabled`: no hub public key configured; entitlements do not apply (self-hosted as today).
 * - `active`: a valid document applies.
 * - `grace`: past `validUntil`, within the grace days; the last good document still applies.
 * - `floor`: no valid document, or past grace; the base floor applies.
 */
export const ENTITLEMENT_STATES = ["disabled", "active", "grace", "floor"] as const;
export type EntitlementState = (typeof ENTITLEMENT_STATES)[number];

export interface EffectiveEntitlementFeature {
  /** The signed document (or base floor) allows it. */
  entitled: boolean;
  /** The value the server uses now: stored setting AND entitled. */
  effective: boolean;
  /** The current document changes this switch, but only after a restart. */
  pendingRestart: boolean;
}

export interface EffectiveEntitlements {
  state: EntitlementState;
  document: {
    client: string;
    version: number;
    issuedAt: string;
    issuedBy: string;
    validUntil: string;
    graceEndsAt: string;
  } | null;
  features: Record<EntitlementFeatureKey, EffectiveEntitlementFeature>;
  limits: Record<string, number>;
  /** Keys in the document this build does not govern. */
  ignoredFeatureKeys: string[];
  lastCheckedAt: string | null;
  /** Why the newest file was refused; the last good copy stays in force. */
  lastError: string | null;
}
