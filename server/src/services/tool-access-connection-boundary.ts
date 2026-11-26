import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  toolConnectionInstalls,
  toolConnections,
  toolProfileBindings,
  toolProfiles,
} from "@greatstone/db";
import { isConnectionAccessProfile } from "./tool-profile-binding-precedence.js";

// Ported from upstream paperclip 263c6f6c0 (#22967): a connection installed for
// some agents must not be callable by other agents through a broad grant,
// profile, trust rule or approval policy.

export type ConnectionAccessBoundary = {
  installedForAgent: boolean;
  hasManagedProfile: boolean;
  requiresInstall: boolean;
};

export function agentAccessConfiguredSql() {
  return sql<boolean>`coalesce((${toolConnections.config} ->> 'agentAccessConfigured') = 'true' or (${toolConnections.config} ->> 'mcpAgentAccessConfigured') = 'true', false)`;
}

export async function readConnectionAccessBoundary(
  db: Pick<Db, "select">,
  input: { companyId: string; agentId: string | null; connectionId: string },
): Promise<ConnectionAccessBoundary> {
  const [connectionRows, installs, managedProfiles] = await Promise.all([
    db
      .select({ agentAccessConfigured: agentAccessConfiguredSql() })
      .from(toolConnections)
      .where(and(eq(toolConnections.companyId, input.companyId), eq(toolConnections.id, input.connectionId))),
    db
      .select({ targetType: toolConnectionInstalls.targetType, targetId: toolConnectionInstalls.targetId })
      .from(toolConnectionInstalls)
      .where(and(
        eq(toolConnectionInstalls.companyId, input.companyId),
        eq(toolConnectionInstalls.connectionId, input.connectionId),
      )),
    db
      .select({ id: toolProfiles.id, profileKey: toolProfiles.profileKey, metadata: toolProfiles.metadata })
      .from(toolProfiles)
      .where(and(
        eq(toolProfiles.companyId, input.companyId),
        eq(toolProfiles.status, "active"),
        eq(toolProfiles.profileKey, `app:${input.connectionId}`),
      ))
      .then((rows) => rows.filter((row) => isConnectionAccessProfile(row, input.connectionId))),
  ]);

  const boundProfileIds = managedProfiles.length > 0
    ? new Set((await db
        .select({ profileId: toolProfileBindings.profileId })
        .from(toolProfileBindings)
        .where(and(
          eq(toolProfileBindings.companyId, input.companyId),
          inArray(toolProfileBindings.profileId, managedProfiles.map((profile) => profile.id)),
        ))).map((row) => row.profileId))
    : new Set<string>();

  const installedForAgent = Boolean(input.agentId && installs.some((install) =>
    (install.targetType === "company" && install.targetId === input.companyId)
    || (install.targetType === "agent" && install.targetId === input.agentId)));
  const hasManagedProfile = managedProfiles.length > 0;
  const hasUnboundManagedProfile = hasManagedProfile && managedProfiles.every((profile) => !boundProfileIds.has(profile.id));
  const requiresInstall = installs.length > 0
    || Boolean(connectionRows[0]?.agentAccessConfigured)
    || hasUnboundManagedProfile;
  return { installedForAgent, hasManagedProfile, requiresInstall };
}
