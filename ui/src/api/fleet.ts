import type { FleetInstanceView } from "@greatstone/shared/fleet";
import { api } from "./client";

export const fleetApi = {
  /** Hub only: 404 unless GSAM_FLEET_HUB=true, 403 unless the caller is an instance admin. Read-only. */
  listInstances: () => api.get<FleetInstanceView[]>("/fleet/instances"),
};
