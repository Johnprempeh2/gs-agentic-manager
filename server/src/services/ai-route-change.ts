import type { Db } from "@greatstone/db";
import { aiAccessRouteSchema, type AiAccessRoute } from "@greatstone/shared";
import { logActivity } from "./activity-log.js";
import { readAiAccessRoute } from "./ai-access-route.js";
import { instanceSettingsService } from "./instance-settings.js";

type RouteChangeActor = { actorType: "user" | "agent" | "system"; actorId: string; agentId?: string | null };

/** The route an `ai_route_change` approval asks for, or undefined when the payload is unusable. */
export function requestedAiRoute(payload: Record<string, unknown>): AiAccessRoute | null | undefined {
  const parsed = aiAccessRouteSchema.nullable().safeParse(payload.toRoute);
  return parsed.success ? parsed.data : undefined;
}

/**
 * One `ai_route.changed` row per company (the route is instance-wide), with
 * the old and new route, when, why and, for an approved request, which
 * approval (GRE-1363, AT-2.9).
 */
export async function logAiRouteChanged(
  db: Db,
  input: RouteChangeActor & {
    settingsId: string;
    oldRoute: AiAccessRoute | null;
    newRoute: AiAccessRoute | null;
    reason: string | null;
    approvalId?: string | null;
  },
) {
  const effectiveFrom = new Date().toISOString();
  const companyIds = await instanceSettingsService(db).listCompanyIds();
  await Promise.all(companyIds.map((companyId) => logActivity(db, {
    companyId,
    actorType: input.actorType,
    actorId: input.actorId,
    agentId: input.agentId ?? null,
    action: "ai_route.changed",
    entityType: "instance_settings",
    entityId: input.settingsId,
    details: {
      oldValue: input.oldRoute,
      newValue: input.newRoute,
      effectiveFrom,
      reason: input.reason,
      approvalId: input.approvalId ?? null,
    },
  })));
}

/** Set the route and log it. A no-op (and no row) when it already has that value. */
export async function applyAiRouteChange(
  db: Db,
  input: RouteChangeActor & { route: AiAccessRoute | null; reason: string | null; approvalId?: string | null },
) {
  const settings = instanceSettingsService(db);
  const oldRoute = readAiAccessRoute(await settings.getGeneral());
  if (oldRoute === input.route) return { changed: false, oldRoute, newRoute: oldRoute };
  const updated = await settings.updateGeneral({ aiAccessRoute: input.route });
  const newRoute = readAiAccessRoute(updated.general);
  await logAiRouteChanged(db, { ...input, settingsId: updated.id, oldRoute, newRoute });
  return { changed: true, oldRoute, newRoute };
}
