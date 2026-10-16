import { authUsers, type Db } from "@greatstone/db";
import { inArray } from "drizzle-orm";
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
  const scope = githubIdentityScopeForRun(input);
  const githubSelection = await resolveManagedGitHubIdentitySelection(db, input.companyId, {
    agentId: input.agentId,
    ...scope,
    requireGitToken: true,
    requireGitHubDetails: true,
  });
  // A person caused this run but the selected grant is someone else's personal
  // grant: it can only have come from Share with agents, so say so in the run log.
  const grant = githubSelection.grant;
  let githubAccessNote: { message: string; grantOwnerUserId: string; responsibleUserId: string; grantId: string } | null = null;
  if (grant?.kind === "user" && grant.subjectUserId && scope.responsibleUserId && grant.subjectUserId !== scope.responsibleUserId) {
    const ids = [grant.subjectUserId, scope.responsibleUserId];
    const users = await db.select({ id: authUsers.id, name: authUsers.name }).from(authUsers).where(inArray(authUsers.id, ids))
      .catch(() => [] as { id: string; name: string }[]);
    const nameOf = (id: string) => users.find((user) => user.id === id)?.name?.trim() || id;
    githubAccessNote = {
      message: `GitHub: using shared access delegated by ${nameOf(grant.subjectUserId)} because ${nameOf(scope.responsibleUserId)} has no GitHub connection`,
      grantOwnerUserId: grant.subjectUserId,
      responsibleUserId: scope.responsibleUserId,
      grantId: grant.id,
    };
  }
  return {
    githubSelection,
    githubAccessNote,
    useHostGitHub: !githubSelection.configured && input.trustKind === "standard"
      && ["local", "ssh"].includes(input.environmentDriver),
  };
}
