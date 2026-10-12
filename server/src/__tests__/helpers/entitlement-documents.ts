import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EntitlementDocument } from "@greatstone/shared";

export const HUB_KEYS = generateKeyPairSync("ed25519");

export function documentFor(overrides: Partial<EntitlementDocument> = {}): EntitlementDocument {
  return {
    v: 1,
    client: "acme",
    version: 1,
    issuedAt: "2026-10-01T00:00:00.000Z",
    validUntil: "2026-11-01T00:00:00.000Z",
    issuedBy: "hub-admin@greatstone",
    reason: "CRM bundle",
    features: { enablePipelines: true, enableCases: true },
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
