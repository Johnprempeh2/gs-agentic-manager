/**
 * Signed entitlement document: config, signature check, and state (GRE-1078).
 *
 * Pure functions only; `entitlement-runtime.ts` holds the last good copy and
 * reloads the file. Entitlements apply only when the hub public key is set
 * (`GSAM_ENTITLEMENT_PUBLIC_KEY`). With no key the instance behaves as before.
 * A key that is set but malformed refuses start-up (fail closed), the same as
 * GSAM_MANAGED_CONFIG.
 */

import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import path from "node:path";
import {
  ENTITLEMENT_BASE_FLOOR,
  ENTITLEMENT_FEATURE_KEYS,
  ENTITLEMENT_GRACE_DAYS,
  entitlementDocumentSchema,
  entitlementEnvelopeSchema,
  isEntitlementFeatureKey,
  type EntitlementDocument,
  type EntitlementFeatureKey,
  type EntitlementState,
} from "@greatstone/shared";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

export const ENTITLEMENT_PUBLIC_KEY_ENV = "GSAM_ENTITLEMENT_PUBLIC_KEY";
export const ENTITLEMENT_FILE_ENV = "GSAM_ENTITLEMENT_FILE";
/** Optional: when set, a document issued for another client is refused. */
export const ENTITLEMENT_CLIENT_ENV = "GSAM_ENTITLEMENT_CLIENT";

/** Larger files are refused before parsing. */
export const MAX_ENTITLEMENT_FILE_BYTES = 256 * 1024;

const GRACE_MS = ENTITLEMENT_GRACE_DAYS * 24 * 60 * 60 * 1000;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface EntitlementConfig {
  publicKey: KeyObject;
  filePath: string;
  lastGoodPath: string;
  expectedClient: string | null;
}

export class EntitlementDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntitlementDocumentError";
  }
}

/** Accepts an Ed25519 public key as PEM (SPKI) or as the raw 32 bytes in base64 or base64url. */
export function parseEntitlementPublicKey(raw: string): KeyObject {
  const value = raw.trim();
  let key: KeyObject;
  try {
    if (value.startsWith("-----BEGIN")) {
      key = createPublicKey(value);
    } else {
      const bytes = Buffer.from(value, "base64url");
      if (bytes.length !== 32) throw new Error("expected 32 bytes");
      key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, bytes]), format: "der", type: "spki" });
    }
  } catch {
    throw new Error(`${ENTITLEMENT_PUBLIC_KEY_ENV} is not a valid Ed25519 public key`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`${ENTITLEMENT_PUBLIC_KEY_ENV} must be an Ed25519 public key`);
  }
  return key;
}

/** Null when no hub key is configured (entitlements off). Throws on a malformed key. */
export function readEntitlementConfig(
  env: Record<string, string | undefined> = process.env,
  instanceRoot: string = resolvePaperclipInstanceRoot(),
): EntitlementConfig | null {
  const rawKey = env[ENTITLEMENT_PUBLIC_KEY_ENV];
  if (rawKey === undefined) return null;
  if (rawKey.trim().length === 0) {
    throw new Error(`${ENTITLEMENT_PUBLIC_KEY_ENV} is set but blank; unset it to turn entitlements off`);
  }
  const dir = path.resolve(instanceRoot, "entitlements");
  const filePath = env[ENTITLEMENT_FILE_ENV]?.trim() || path.join(dir, "entitlement.json");
  return {
    publicKey: parseEntitlementPublicKey(rawKey),
    filePath: path.resolve(filePath),
    lastGoodPath: path.join(path.dirname(path.resolve(filePath)), "last-good.json"),
    expectedClient: env[ENTITLEMENT_CLIENT_ENV]?.trim() || null,
  };
}

export function hashEntitlementFile(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Parse the envelope, check the signature, then parse the signed document. */
export function verifyEntitlementEnvelope(
  text: string,
  publicKey: KeyObject,
  expectedClient: string | null = null,
): EntitlementDocument {
  if (Buffer.byteLength(text) > MAX_ENTITLEMENT_FILE_BYTES) {
    throw new EntitlementDocumentError("entitlement file is too large");
  }
  let envelopeJson: unknown;
  try {
    envelopeJson = JSON.parse(text);
  } catch {
    throw new EntitlementDocumentError("entitlement file is not valid JSON");
  }
  const envelope = entitlementEnvelopeSchema.safeParse(envelopeJson);
  if (!envelope.success) throw new EntitlementDocumentError("entitlement file is not a v1 signed envelope");

  const documentBytes = Buffer.from(envelope.data.document, "base64url");
  const signature = Buffer.from(envelope.data.signature, "base64url");
  if (documentBytes.length === 0 || !verify(null, documentBytes, publicKey, signature)) {
    throw new EntitlementDocumentError("entitlement signature is invalid");
  }

  let documentJson: unknown;
  try {
    documentJson = JSON.parse(documentBytes.toString("utf8"));
  } catch {
    throw new EntitlementDocumentError("signed entitlement document is not valid JSON");
  }
  const parsed = entitlementDocumentSchema.safeParse(documentJson);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new EntitlementDocumentError(
      `signed entitlement document is malformed${issue ? ` at ${issue.path.join(".") || "root"}: ${issue.message}` : ""}`,
    );
  }
  if (Date.parse(parsed.data.validUntil) <= Date.parse(parsed.data.issuedAt)) {
    throw new EntitlementDocumentError("signed entitlement document ends before it was issued");
  }
  if (expectedClient && parsed.data.client !== expectedClient) {
    throw new EntitlementDocumentError(
      `entitlement document is for client "${parsed.data.client}", not "${expectedClient}"`,
    );
  }
  return parsed.data;
}

export function entitlementGraceEndsAt(document: EntitlementDocument): Date {
  return new Date(Date.parse(document.validUntil) + GRACE_MS);
}

export function resolveEntitlementState(document: EntitlementDocument | null, now: Date): EntitlementState {
  if (!document) return "floor";
  const nowMs = now.getTime();
  if (nowMs <= Date.parse(document.validUntil)) return "active";
  if (nowMs <= entitlementGraceEndsAt(document).getTime()) return "grace";
  return "floor";
}

/** What the document allows. A governed key the document leaves out is not entitled. */
export function entitledFeatures(
  document: EntitlementDocument | null,
  state: EntitlementState,
): Record<EntitlementFeatureKey, boolean> {
  if (!document || state === "floor" || state === "disabled") return { ...ENTITLEMENT_BASE_FLOOR };
  return Object.fromEntries(
    ENTITLEMENT_FEATURE_KEYS.map((key) => [key, document.features[key] === true]),
  ) as Record<EntitlementFeatureKey, boolean>;
}

export function ignoredEntitlementFeatureKeys(document: EntitlementDocument | null): string[] {
  if (!document) return [];
  return Object.keys(document.features).filter((key) => !isEntitlementFeatureKey(key)).sort();
}
