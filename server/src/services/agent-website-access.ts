import {
  WEBSITE_EDIT_PERMISSION_KEY,
  WEBSITE_VIEW_PERMISSION_KEY,
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
