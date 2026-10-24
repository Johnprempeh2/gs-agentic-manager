import {
  WEBSITE_EDIT_PERMISSION_KEY,
  WEBSITE_VIEW_PERMISSION_KEY,
  agentWebsiteAccessLevel,
  type AgentWebsiteAccessLevel,
} from "@greatstone/shared";
import type { accessService } from "./access.js";

type AccessService = Pick<ReturnType<typeof accessService>, "listPrincipalGrants" | "setPrincipalPermission">;

/**
 * Sets one agent's website access level (GRE-2239). Adds or removes only
 * website:view and website:edit, one key at a time, so the agent's other
 * grants stay as they are. website:publish is never written; the access
 * service refuses it for agents anyway.
 */
export async function setAgentWebsiteAccess(
  access: AccessService,
  input: { companyId: string; agentId: string; level: AgentWebsiteAccessLevel; grantedByUserId: string | null },
): Promise<{ before: AgentWebsiteAccessLevel; after: AgentWebsiteAccessLevel }> {
  const { companyId, agentId, level, grantedByUserId } = input;
  const before = agentWebsiteAccessLevel(await access.listPrincipalGrants(companyId, "agent", agentId));
  await access.setPrincipalPermission(
    companyId, "agent", agentId, WEBSITE_VIEW_PERMISSION_KEY, level !== "none", grantedByUserId,
  );
  await access.setPrincipalPermission(
    companyId, "agent", agentId, WEBSITE_EDIT_PERMISSION_KEY, level === "edit", grantedByUserId,
  );
  const after = agentWebsiteAccessLevel(await access.listPrincipalGrants(companyId, "agent", agentId));
  return { before, after };
}
