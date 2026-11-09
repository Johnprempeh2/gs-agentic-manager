import type { PermissionKey } from "./constants.js";

/**
 * Website access for an agent (GRE-2239). Three levels, all sites:
 * - none: no website grants.
 * - view: `website:view`.
 * - edit: `website:view` and `website:edit` (edit drafts, propose a Publish).
 *
 * There is no publish level: `website:publish` is for people only
 * (GRE-1914 ADR section 6) and the server refuses it for agents.
 *
 * A level can be limited to chosen sites (GRE-3992): the grants then carry
 * the scope `{ siteIds: [...] }`. With no scope the level covers every site.
 */
export const AGENT_WEBSITE_ACCESS_LEVELS = ["none", "view", "edit"] as const;
export type AgentWebsiteAccessLevel = (typeof AGENT_WEBSITE_ACCESS_LEVELS)[number];

export const WEBSITE_VIEW_PERMISSION_KEY = "website:view" as const satisfies PermissionKey;
export const WEBSITE_EDIT_PERMISSION_KEY = "website:edit" as const satisfies PermissionKey;
/**
 * Commerce for an agent (GRE-4814): catalogue, prices and invoices as drafts,
 * and asks to publish or refund. A person approves each ask. It needs website
 * access view or higher and carries the same site scope.
 */
export const WEBSITE_COMMERCE_PERMISSION_KEY = "website:commerce" as const satisfies PermissionKey;

/** True when the agent holds website:commerce, scoped or not. */
export function agentHasCommerce(grants: ReadonlyArray<{ permissionKey: string }>): boolean {
  return grants.some((grant) => grant.permissionKey === WEBSITE_COMMERCE_PERMISSION_KEY);
}

/** Reads the level from an agent's grants. Only unscoped (all sites) grants count. */
export function agentWebsiteAccessLevel(
  grants: ReadonlyArray<{ permissionKey: string; scope?: Record<string, unknown> | null }>,
): AgentWebsiteAccessLevel {
  const has = (key: string) => grants.some((grant) => grant.permissionKey === key && !grant.scope);
  if (has(WEBSITE_EDIT_PERMISSION_KEY) && has(WEBSITE_VIEW_PERMISSION_KEY)) return "edit";
  if (has(WEBSITE_VIEW_PERMISSION_KEY)) return "view";
  return "none";
}

/** The site IDs a website grant is limited to, or null when it covers every site. */
function grantSiteIds(scope: Record<string, unknown> | null | undefined): string[] | null {
  if (!scope) return null;
  const ids = [scope.siteId, ...(Array.isArray(scope.siteIds) ? scope.siteIds : [])]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return ids.length > 0 ? ids : null;
}

/**
 * Reads the level and its sites from an agent's grants, scoped or not
 * (GRE-3992). `siteIds` is null when the level covers every site.
 */
export function agentWebsiteAccess(
  grants: ReadonlyArray<{ permissionKey: string; scope?: Record<string, unknown> | null }>,
): { level: AgentWebsiteAccessLevel; siteIds: string[] | null } {
  const view = grants.find((grant) => grant.permissionKey === WEBSITE_VIEW_PERMISSION_KEY);
  if (!view) return { level: "none", siteIds: null };
  const edit = grants.some((grant) => grant.permissionKey === WEBSITE_EDIT_PERMISSION_KEY);
  return { level: edit ? "edit" : "view", siteIds: grantSiteIds(view.scope) };
}
