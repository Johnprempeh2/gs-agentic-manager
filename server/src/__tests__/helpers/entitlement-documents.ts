import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EntitlementDocument } from "@greatstone/shared";

export const HUB_KEYS = generateKeyPairSync("ed25519");

const DAY = 24 * 60 * 60 * 1000;

/**
 * The fixture's "now". Its dates hang off the real clock, so the document
 * never expires under tests that use the real clock (GRE-3510). Tests with a
 * fake clock start it here.
 */
export const FIXTURE_NOW = new Date();
export const FIXTURE_ISSUED_AT = new Date(FIXTURE_NOW.getTime() - 8 * DAY).toISOString();
export const FIXTURE_VALID_UNTIL = new Date(FIXTURE_NOW.getTime() + 23 * DAY).toISOString();

export function documentFor(overrides: Partial<EntitlementDocument> = {}): EntitlementDocument {
  return {
    v: 1,
    client: "acme",
    version: 1,
    issuedAt: FIXTURE_ISSUED_AT,
    validUntil: FIXTURE_VALID_UNTIL,
    issuedBy: "hub-admin@greatstone",
    reason: "CRM bundle",
    features: { enablePipelines: true, enableWebsiteView: true },
    limits: { maxAgents: 10 },
    ...overrides,
  };
}

/** A signed envelope as the hub writes it. */
export function signedFile(document: unknown, privateKey: KeyObject = HUB_KEYS.privateKey): string {
  const bytes = Buffer.from(JSON.stringify(document), "utf8");
  return JSON.stringify({
    v: 1,
    document: bytes.toString("base64url"),
    signature: sign(null, bytes, privateKey).toString("base64url"),
  });
}

export async function entitlementTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gsam-entitlements-"));
  return {
    dir,
    filePath: path.join(dir, "entitlement.json"),
    lastGoodPath: path.join(dir, "last-good.json"),
    remove: () => fs.rm(dir, { recursive: true, force: true }),
  };
}
