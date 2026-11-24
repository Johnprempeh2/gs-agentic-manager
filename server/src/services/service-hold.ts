/**
 * Service hold on a GSAM for Mac install (P2). Three reasons, strongest first:
 * - stopped: Greatstone sent a signed `stop` order. Full-page screen.
 * - ended:   the paid period is over (the signed document's `validUntil` plus
 *            its `grace`, 0 for customers, has passed). Full-page screen.
 * - paused:  Greatstone sent a signed `pause` order. A banner; the app works.
 * Under any hold no new agent run starts (heartbeat scheduling suppression,
 * reason `service_hold`); runs already going finish. Nothing is deleted and
 * the API keeps answering, so data can still be read and exported.
 *
 * Only a spoke (fleet/spoke.json present) can be held. The order hold is kept
 * in fleet/orders.json by fleet-spoke.ts, which sets it here at start and on
 * each order.
 */

import { getEntitlementRuntime } from "./entitlement-runtime.js";

export type ServiceHold = "paused" | "stopped" | "ended";

let spoke = false;
let orderHold: "paused" | "stopped" | null = null;

export function setServiceHoldSpoke(isSpoke: boolean, hold: "paused" | "stopped" | null) {
  spoke = isSpoke;
  orderHold = isSpoke ? hold : null;
}

export function currentServiceHold(): ServiceHold | null {
  if (!spoke) return null;
  if (orderHold === "stopped") return "stopped";
  if (getEntitlementRuntime()?.summary().state === "floor") return "ended";
  return orderHold;
}

/** Where the "Subscription ended" and "Service stopped" screens send the customer. */
export function serviceRenewUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.GSAM_RENEW_URL?.trim() || "https://greatstoneint.com";
}

/** What `/api/health` carries for the UI. Null when the service runs normally. */
export function serviceHoldHealth(): { state: ServiceHold; renewUrl: string; validUntil: string | null } | null {
  const state = currentServiceHold();
  if (!state) return null;
  return { state, renewUrl: serviceRenewUrl(), validUntil: getEntitlementRuntime()?.summary().document?.validUntil ?? null };
}
