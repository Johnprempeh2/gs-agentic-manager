import type { PermissionKey } from "./constants.js";

/**
 * Website access for an agent (GRE-2239). Three levels, all sites:
 * - none: no website grants.
 * - view: `website:view`.
 * - edit: `website:view` and `website:edit` (edit drafts, propose a Publish).
 *
 * There is no publish level: `website:publish` is for people only
 * (GRE-1914 ADR section 6) and the server refuses it for agents.
 */
export const AGENT_WEBSITE_ACCESS_LEVELS = ["none", "view", "edit"] as const;
export type AgentWebsiteAccessLevel = (typeof AGENT_WEBSITE_ACCESS_LEVELS)[number];

export const WEBSITE_VIEW_PERMISSION_KEY = "website:view" as const satisfies PermissionKey;
export const WEBSITE_EDIT_PERMISSION_KEY = "website:edit" as const satisfies PermissionKey;

/** Reads the level from an agent's grants. Only unscoped (all sites) grants count. */
export function agentWebsiteAccessLevel(
  grants: ReadonlyArray<{ permissionKey: string; scope?: Record<string, unknown> | null }>,
): AgentWebsiteAccessLevel {
  const has = (key: string) => grants.some((grant) => grant.permissionKey === key && !grant.scope);
  if (has(WEBSITE_EDIT_PERMISSION_KEY) && has(WEBSITE_VIEW_PERMISSION_KEY)) return "edit";
  if (has(WEBSITE_VIEW_PERMISSION_KEY)) return "view";
  return "none";
}
