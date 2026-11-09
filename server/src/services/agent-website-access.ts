import {
  WEBSITE_COMMERCE_PERMISSION_KEY,
  WEBSITE_EDIT_PERMISSION_KEY,
  WEBSITE_VIEW_PERMISSION_KEY,
  agentHasCommerce,
  agentWebsiteAccess,
  type AgentWebsiteAccessLevel,
} from "@greatstone/shared";
import type { accessService } from "./access.js";

type AccessService = Pick<ReturnType<typeof accessService>, "listPrincipalGrants" | "setPrincipalPermission">;

/**
 * Sets one agent's website access level (GRE-2239). Adds or removes only
 * website:view and website:edit, one key at a time, so the agent's other
 * grants stay as they are. website:publish is never written; the access
 * service refuses it for agents anyway.
 *
 * With a siteId both grants are limited to that one site (GRE-3992); the
 * caller checks the site belongs to the company first.
 */
type WebsiteAccessState = ReturnType<typeof agentWebsiteAccess>;

export async function setAgentWebsiteAccess(
  access: AccessService,
  input: {
    companyId: string;
    agentId: string;
    level: AgentWebsiteAccessLevel;
    siteId?: string | null;
    grantedByUserId: string | null;
  },
): Promise<{ before: WebsiteAccessState; after: WebsiteAccessState }> {
  const { companyId, agentId, level, grantedByUserId } = input;
  const scope = input.siteId ? { siteIds: [input.siteId] } : null;
  const before = agentWebsiteAccess(await access.listPrincipalGrants(companyId, "agent", agentId));
  await access.setPrincipalPermission(
    companyId, "agent", agentId, WEBSITE_VIEW_PERMISSION_KEY, level !== "none", grantedByUserId, scope,
  );
  await access.setPrincipalPermission(
    companyId, "agent", agentId, WEBSITE_EDIT_PERMISSION_KEY, level === "edit", grantedByUserId, scope,
  );
  const after = agentWebsiteAccess(await access.listPrincipalGrants(companyId, "agent", agentId));
  return { before, after };
}

/**
 * Keeps one agent's website:commerce grant in step with its website access
 * (GRE-4814). `enabled` true or false sets or clears it; undefined keeps it as
 * it is. A held grant always carries the scope of the agent's website:view
 * grant, and is cleared when the agent has no website access. The caller
 * refuses `enabled: true` without website access before anything is written.
 * Returns null when nothing changed.
 */
export async function syncAgentCommerceAccess(
  access: AccessService,
  input: { companyId: string; agentId: string; enabled?: boolean; grantedByUserId: string | null },
): Promise<{ before: boolean; after: boolean } | null> {
  const { companyId, agentId, grantedByUserId } = input;
  const grants = await access.listPrincipalGrants(companyId, "agent", agentId);
  const before = agentHasCommerce(grants);
  const view = grants.find((grant) => grant.permissionKey === WEBSITE_VIEW_PERMISSION_KEY);
  const after = Boolean(view) && (input.enabled ?? before);
  if (!before && !after) return null;
  await access.setPrincipalPermission(
    companyId, "agent", agentId, WEBSITE_COMMERCE_PERMISSION_KEY, after, grantedByUserId,
    (view?.scope as Record<string, unknown> | null | undefined) ?? null,
  );
  return before === after ? null : { before, after };
}
