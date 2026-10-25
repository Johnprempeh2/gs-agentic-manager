// What a client install may and may not turn on (GRE-2346, Site Studio).
//
// A client install is one started with `GSAM_MANAGED_CONFIG` (both editions,
// `managed` and `managed-plus`). Greatstone's own admin install has no managed
// config, so none of these rules apply to it. The server applies them on every
// read, after the managed config and the signed entitlement document, so no
// stored value, managed value or signed key can widen them.

import type { EntitlementFeatureKey } from "./entitlement-document.js";
import type { InstanceFeatureKey } from "./feature-catalog.js";

/**
 * Switches a client install has on only while a valid signed entitlement
 * document grants them. The stored value and the managed config do not count,
 * and with no hub key (no document can be valid) they read off. Off hides the
 * screens and refuses the API; stored data is kept.
 */
export const SIGNED_KEY_ONLY_FEATURE_KEYS = [
  // The Website screens (Site Studio): Releases, rollback, preview, data bridge.
  "enableWebsiteView",
] as const satisfies readonly EntitlementFeatureKey[];

/** Switches that are Greatstone's own and read off in every client install, whatever any layer says. */
export const GREATSTONE_ONLY_FEATURE_KEYS = [
  // Where Greatstone designs a client's team (GRE-1090).
  "enableDeepDive",
  // The Intelligence page: Daily Pulse and the AI Intelligence Hub.
  "enableIntelligence",
] as const satisfies readonly InstanceFeatureKey[];

/**
 * Website feature keys that are Greatstone's own site (seeded on Greatstone's
 * site only, migration 0392). A client install cannot add or switch on a
 * feature with one of these keys. `client-install.test.ts` fails when a
 * migration seeds a website feature key that is in neither this list nor
 * `CLIENT_WEBSITE_FEATURE_KEYS`, so a new Greatstone feature is covered by default.
 */
export const GREATSTONE_ONLY_WEBSITE_FEATURE_KEYS = [
  "shop",
  "client-portal",
  "deep-dive",
  "front-door",
  "intelligence-hub",
] as const;

/** Seeded website feature keys a client site may also use. */
export const CLIENT_WEBSITE_FEATURE_KEYS = ["public-site"] as const;

export const GREATSTONE_ONLY_ERROR_CODE = "greatstone_only";

export function isGreatstoneOnlyWebsiteFeatureKey(key: string): boolean {
  return (GREATSTONE_ONLY_WEBSITE_FEATURE_KEYS as readonly string[]).includes(key);
}
