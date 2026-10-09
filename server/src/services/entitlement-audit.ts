// Writes entitlement audit events (GRE-1078) to the activity log of every
// company on the instance, the same fan-out the experimental settings route
// uses for instance-wide changes.

import { companies, type Db } from "@greatstone/db";
import { logActivity } from "./activity-log.js";
import type { EntitlementAuditEvent } from "./entitlement-runtime.js";

export const ENTITLEMENT_ACTIVITY_ENTITY_ID = "entitlements";

export function entitlementActivityAuditSink(db: Db) {
  return async (event: EntitlementAuditEvent) => {
    const companyIds = await db
      .select({ id: companies.id })
      .from(companies)
      .then((rows) => rows.map((row) => row.id));
    const { kind, ...details } = event;
    await Promise.all(
      companyIds.map((companyId) =>
        logActivity(db, {
          companyId,
          actorType: event.requestedBy ? "user" : "system",
          actorId: event.requestedBy ?? "entitlements",
          action: kind === "changed" ? "instance.entitlements.changed" : "instance.entitlements.rejected",
          entityType: "instance_settings",
          entityId: ENTITLEMENT_ACTIVITY_ENTITY_ID,
          details,
        }),
      ),
    );
  };
}
