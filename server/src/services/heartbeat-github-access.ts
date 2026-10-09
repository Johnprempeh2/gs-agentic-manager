import type { Db } from "@greatstone/db";
import { githubIdentityScopeForRun, resolveManagedGitHubIdentitySelection } from "./git-credentials.js";

/** Decide once for both adapter environment resolution and the GitHub launcher. */
export async function resolveHeartbeatGitHubAccess(db: Db, input: {
  companyId: string;
  agentId: string;
  cause: string;
  responsibleUserId: string | null;
  trustKind: string;
  environmentDriver: string;
}) {
  const githubSelection = await resolveManagedGitHubIdentitySelection(db, input.companyId, {
    agentId: input.agentId,
    ...githubIdentityScopeForRun(input),
    requireGitToken: true,
    requireGitHubDetails: true,
  });
  return {
    githubSelection,
    useHostGitHub: !githubSelection.configured && input.trustKind === "standard"
      && ["local", "ssh"].includes(input.environmentDriver),
  };
}
