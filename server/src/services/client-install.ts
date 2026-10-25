import type { RequestHandler } from "express";
import { GREATSTONE_ONLY_ERROR_CODE } from "@greatstone/shared";
import { forbidden, type HttpError } from "../errors.js";
import { getManagedInstanceConfig, type ManagedConfigEnv } from "./managed-config.js";

/**
 * Greatstone-only surfaces (GRE-2346). A client install is one started with
 * `GSAM_MANAGED_CONFIG` (`managed` and `managed-plus`); there each surface
 * below is refused whatever the other env values, hidden settings or signed
 * keys say. Greatstone's own admin install has no managed config and keeps
 * them. `client-install.test.ts` mounts the real routers in a client install
 * and fails when one probe is reachable.
 */

/** One call a client install must never reach (403, or 404 where the surface hides itself). */
export interface GreatstoneOnlyProbe {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
}

const ID = "00000000-0000-4000-8000-000000000001";
const COMPANY = `/api/companies/${ID}`;

export const GREATSTONE_ONLY_SURFACES = {
  /** The hub's list of client instances (the Fleet page). */
  fleet: {
    title: "Fleet",
    probes: [
      { method: "get", path: "/api/fleet/instances" },
      { method: "post", path: "/api/fleet/instances" },
      { method: "post", path: `/api/fleet/instances/${ID}/registration-code` },
    ],
  },
  /** The hub endpoints client instances call to register and check in. */
  fleetHub: {
    title: "Fleet hub",
    probes: [
      { method: "post", path: "/api/fleet/spoke/register" },
      { method: "post", path: "/api/fleet/spoke/check-in" },
      { method: "post", path: "/api/fleet/spoke/support-sync" },
    ],
  },
  /** GSAM's own Releases page and release queue. */
  releaseBoard: {
    title: "Releasing",
    probes: [
      { method: "get", path: `${COMPANY}/releases` },
      { method: "post", path: `${COMPANY}/releases/release` },
      { method: "post", path: `${COMPANY}/releases/rollback` },
      { method: "get", path: `${COMPANY}/releases/queue` },
    ],
  },
} as const satisfies Record<string, { title: string; probes: readonly GreatstoneOnlyProbe[] }>;

export type GreatstoneOnlySurface = keyof typeof GREATSTONE_ONLY_SURFACES;

export function isClientInstall(env: ManagedConfigEnv = process.env): boolean {
  return getManagedInstanceConfig(env) !== null;
}

export function greatstoneOnly(what: string): HttpError {
  return forbidden(`${what} is part of Greatstone's own install and is never part of a client install`, {
    code: GREATSTONE_ONLY_ERROR_CODE,
  });
}

/** Route middleware: every request (reads too) to `surface` is refused in a client install. */
export function refuseInClientInstall(surface: GreatstoneOnlySurface): RequestHandler {
  return (_req, _res, next) => {
    if (isClientInstall()) throw greatstoneOnly(GREATSTONE_ONLY_SURFACES[surface].title);
    next();
  };
}
