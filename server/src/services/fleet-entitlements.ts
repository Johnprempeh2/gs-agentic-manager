/**
 * The hub's entitlement signing key (GSAM for Mac, P1).
 *
 * `GSAM_ENTITLEMENT_SIGN_PRIVATE_KEY` holds the hub's Ed25519 private key:
 * PEM (PKCS#8) or the raw 32-byte seed in base64url. Unset: the hub issues no
 * licences or documents. Set but bad: the hub refuses to issue (fail closed).
 * Installs pin the matching public key at activation and check every document
 * with it (`entitlement-document.ts`).
 */

import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import {
  ENTITLEMENT_DOCUMENT_VERSION,
  entitlementDocumentSchema,
  type EntitlementDocument,
  type EntitlementEnvelope,
} from "@greatstone/shared";

export const ENTITLEMENT_SIGN_PRIVATE_KEY_ENV = "GSAM_ENTITLEMENT_SIGN_PRIVATE_KEY";

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface HubSigningKey {
  privateKey: KeyObject;
  /** Raw 32 bytes, base64url: what GSAM_ENTITLEMENT_PUBLIC_KEY and the install's pinned key take. */
  publicKey: string;
}

/** Null when unset. Throws when set but not an Ed25519 private key. */
export function readHubSigningKey(env: Record<string, string | undefined> = process.env): HubSigningKey | null {
  const raw = env[ENTITLEMENT_SIGN_PRIVATE_KEY_ENV]?.trim();
  if (!raw) return null;
  let privateKey: KeyObject;
  try {
    if (raw.startsWith("-----BEGIN")) {
      privateKey = createPrivateKey(raw);
    } else {
      const seed = Buffer.from(raw, "base64url");
      if (seed.length !== 32) throw new Error("expected 32 bytes");
      privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
    }
  } catch {
    throw new Error(`${ENTITLEMENT_SIGN_PRIVATE_KEY_ENV} is not a valid Ed25519 private key`);
  }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error(`${ENTITLEMENT_SIGN_PRIVATE_KEY_ENV} must be an Ed25519 key`);
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  return { privateKey, publicKey: jwk.x! };
}

/** Signs exactly the bytes it stores, so the install checks the same bytes. Throws when the document is malformed. */
export function signEntitlementDocument(document: EntitlementDocument, key: HubSigningKey): EntitlementEnvelope {
  const parsed = entitlementDocumentSchema.parse(document);
  const bytes = Buffer.from(JSON.stringify(parsed));
  return {
    v: ENTITLEMENT_DOCUMENT_VERSION,
    document: bytes.toString("base64url"),
    signature: sign(null, bytes, key.privateKey).toString("base64url"),
  };
}
