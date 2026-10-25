// The hub key and the signed entitlement file of one client instance
// (GRE-2396). In a client install the Website screens (Site Studio) are on
// only while a valid signed document grants `enableWebsiteView` (GRE-2346).
// The script keeps the hub PUBLIC key, the file path and the optional client
// code in client-instance.json and passes them to the server at every start.
// No private key is ever read or written here.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { EffectiveEntitlements } from "../../packages/shared/src/entitlement-document.js";
import { parseEntitlementPublicKey } from "../../server/src/services/entitlement-document.js";

export interface EntitlementSetup {
  /** Hub Ed25519 public key: PEM (SPKI) or the raw 32 bytes in base64url. */
  publicKey: string;
  /** The signed file the server reads; always inside the instance folder. */
  file: string;
  /** When set, a document issued for another client is refused. */
  client?: string;
}

export const ENTITLEMENT_FLAGS = ["entitlement-public-key", "entitlement-file", "entitlement-client"] as const;

export const defaultEntitlementFile = (instanceDir: string) => path.join(instanceDir, "entitlements", "entitlement.json");

/** A key value, or the path of a file that holds it (a PEM file from the hub). */
function readKey(raw: string): string {
  const value = existsSync(raw) ? readFileSync(raw, "utf8") : raw;
  if (/PRIVATE KEY/.test(value)) throw new Error("--entitlement-public-key is a private key; give the hub's public key only");
  const trimmed = value.trim();
  parseEntitlementPublicKey(trimmed); // throws on a bad key, before anything is saved
  return trimmed;
}

/**
 * Build the setup from the flags, on top of `current` (null when none). Null
 * when no flag is given and there is no current setup. The file must be inside
 * the instance root, so no two instances share one.
 */
export function parseEntitlementFlags(
  opts: Record<string, string | undefined>,
  root: string,
  instanceDir: string,
  current: EntitlementSetup | null,
): EntitlementSetup | null {
  const rawKey = opts["entitlement-public-key"];
  const rawFile = opts["entitlement-file"];
  const rawClient = opts["entitlement-client"];
  if (rawKey === undefined && rawFile === undefined && rawClient === undefined) return current;
  const publicKey = rawKey !== undefined ? readKey(rawKey) : current?.publicKey;
  if (!publicKey) throw new Error("--entitlement-file and --entitlement-client need --entitlement-public-key (the hub key)");

  const file = path.resolve(rawFile ?? current?.file ?? defaultEntitlementFile(instanceDir));
  const realRoot = path.resolve(root);
  if (!file.startsWith(`${realRoot}${path.sep}`)) throw new Error(`--entitlement-file must be inside the instance folder ${realRoot}`);

  const client = rawClient !== undefined ? rawClient.trim() : current?.client;
  if (client !== undefined && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(client)) {
    throw new Error("--entitlement-client must be the client code (lowercase letters, digits and dashes), not a name");
  }
  return { publicKey, file, ...(client ? { client } : {}) };
}

/** The env values the server reads (server/src/services/entitlement-document.ts). */
export function entitlementEnv(setup: EntitlementSetup | null | undefined): Record<string, string> {
  if (!setup) return {};
  return {
    GSAM_ENTITLEMENT_PUBLIC_KEY: setup.publicKey,
    GSAM_ENTITLEMENT_FILE: setup.file,
    ...(setup.client ? { GSAM_ENTITLEMENT_CLIENT: setup.client } : {}),
  };
}

export function describeEntitlement(setup: EntitlementSetup | null | undefined): string {
  if (!setup) return "off (no hub key; Website screens off in a client edition)";
  return `hub key set, file ${setup.file}${setup.client ? `, client code ${setup.client}` : ""}`;
}

export interface EntitlementCheck {
  ok: boolean;
  line: string;
}

/** Website screens are on exactly when a valid document (active or in grace) grants the key. */
export function websiteExpected(view: Pick<EffectiveEntitlements, "state" | "features">): boolean {
  return (view.state === "active" || view.state === "grace") && view.features.enableWebsiteView?.entitled === true;
}

/**
 * verify, client editions only: the server's entitlement state matches the
 * setup, the Website switch matches the signed key, and the Website API
 * answers 200 or 403 to match.
 */
export function entitlementChecks(
  setup: EntitlementSetup | null | undefined,
  view: Pick<EffectiveEntitlements, "state" | "features" | "document" | "lastError">,
  websiteSwitch: unknown,
  websiteStatus: number,
): EntitlementCheck[] {
  const doc = view.document;
  const docText = doc ? `, document v${doc.version} valid until ${doc.validUntil}` : "";
  const errText = view.lastError ? `; last file refused: ${view.lastError}` : "";
  const stateOk = setup ? view.state !== "disabled" : view.state === "disabled";
  const results: EntitlementCheck[] = [
    {
      ok: stateOk,
      line: `entitlements: state ${view.state}${docText} (${setup ? "hub key set" : "no hub key"})${errText}`,
    },
  ];
  if (view.state === "grace" && doc) {
    results.push({ ok: true, line: `entitlements: in grace; renew before ${doc.graceEndsAt} or the base floor applies` });
  }
  const want = websiteExpected(view);
  results.push({
    ok: websiteSwitch === want,
    line: `enableWebsiteView is ${want ? "on" : "off"} to match the signed key (server reads ${String(websiteSwitch)})`,
  });
  results.push({
    ok: websiteStatus === (want ? 200 : 403),
    line: `Website API: GET /api/companies/:id/website -> ${websiteStatus} (want ${want ? 200 : 403})`,
  });
  return results;
}
