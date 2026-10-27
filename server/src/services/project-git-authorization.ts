import { and, eq } from "drizzle-orm";
import {
  companyMemberships,
  connectionGrants,
  issues,
  projectWorkspaces,
  projects,
  toolConnectionInstalls,
  toolConnections,
  type Db,
} from "@greatstone/db";
import { forbidden, notFound } from "../errors.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import { ghFetch } from "./github-fetch.js";
import { isManagedGitHubIdentityConnection, resolveManagedGitHubCredential, type GitCredential } from "./git-credentials.js";
import { normalizeProjectRepositoryUrl } from "./project-repositories.js";
import { authorizationService } from "./authorization.js";
import { resolveCoreTrustPreset } from "./trust-preset-resolver.js";
import { isLowTrustQuarantined } from "./source-trust.js";

type Secrets = Parameters<typeof resolveManagedGitHubCredential>[1];
type Grant = typeof connectionGrants.$inferSelect;

function canonicalRepoUrl(value: string) {
  const https = value.replace(/^git@(?:www\.)?github\.com:/i, "https://github.com/")
    .replace(/^ssh:\/\/git@(?:www\.)?github\.com\//i, "https://github.com/")
    .replace(/^https:\/\/www\.github\.com\//i, "https://github.com/");
  return normalizeProjectRepositoryUrl(https);
}

async function assertProjectWriter(db: Db, companyId: string, projectId: string, userId: string) {
  const [membership] = await db.select({ role: companyMemberships.membershipRole })
    .from(companyMemberships).where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId),
      eq(companyMemberships.status, "active"),
    ));
  if (!membership || membership.role === "viewer") throw forbidden("An active project writer is required");
  const access = await authorizationService(db).decide({
    actor: { type: "board", source: "session", userId },
    action: "project:read",
    resource: { type: "project", companyId, projectId },
  });
  if (!access.allowed) throw forbidden("Project access is required");
}

async function eligibleGrants(db: Db, companyId: string, userId: string) {
  const rows = await db.select({ grant: connectionGrants, connection: toolConnections })
    .from(connectionGrants)
    .innerJoin(toolConnections, and(
      eq(toolConnections.id, connectionGrants.connectionId),
      eq(toolConnections.companyId, companyId),
    ))
    .innerJoin(toolConnectionInstalls, and(
      eq(toolConnectionInstalls.connectionId, toolConnections.id),
      eq(toolConnectionInstalls.companyId, companyId),
      eq(toolConnectionInstalls.targetType, "company"),
      eq(toolConnectionInstalls.targetId, companyId),
    ))
    .where(and(
      eq(connectionGrants.companyId, companyId),
      eq(connectionGrants.kind, "user"),
      eq(connectionGrants.subjectUserId, userId),
      eq(connectionGrants.status, "active"),
      eq(toolConnections.status, "active"),
      eq(toolConnections.enabled, true),
    ));
  return rows.filter(({ grant, connection }) =>
    isManagedGitHubIdentityConnection(connection)
    && grant.credentialSecretRefs.some((ref) => ref.configPath === "oauth.access_token"));
}

async function publicRepository(fullName: string): Promise<boolean> {
  let response: Response;
  try {
    response = await ghFetch(`https://api.github.com/repos/${fullName}`, {
      headers: { Accept: "application/vnd.github+json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw forbidden("Repository visibility is unavailable");
  }
  if (response.status === 404) return false;
  if (!response.ok) throw forbidden("Repository visibility is unavailable");
  const metadata = await response.json().catch(() => null) as { full_name?: unknown; private?: unknown } | null;
  if (metadata?.full_name?.toString().toLowerCase() !== fullName.toLowerCase()
    || typeof metadata.private !== "boolean") throw forbidden("Repository visibility is unavailable");
  return metadata.private === false;
}

function repositoryAllowed(grant: Grant, fullName: string) {
  return grant.providerTenant?.github?.repositories?.some((repo) =>
    repo.fullName.toLowerCase() === fullName.toLowerCase()) === true;
}

/** The selected personal grant is project consent. It never follows a past task identity. */
export function projectGitAuthorizationService(db: Db) {
  async function getProject(companyId: string, projectId: string) {
    const [project] = await db.select().from(projects).where(and(
      eq(projects.companyId, companyId), eq(projects.id, projectId),
    ));
    if (!project) throw notFound("Project not found");
    return project;
  }

  async function read(companyId: string, projectId: string, userId: string) {
    const project = await getProject(companyId, projectId);
    const options = await eligibleGrants(db, companyId, userId);
    return {
      grantId: project.gitAuthorizationGrantId,
      authorizedByUserId: project.gitAuthorizedByUserId,
      options: options.map(({ grant, connection }) => ({
        grantId: grant.id,
        connectionName: connection.name,
        login: grant.providerTenant?.github?.login ?? connection.name,
      })),
    };
  }

  return {
    read,

    async set(companyId: string, projectId: string, userId: string, grantId: string | null) {
      const publication = await db.transaction(async (tx) => {
        const transactionalDb = tx as unknown as Db;
        const [project] = await tx.select().from(projects).where(and(
          eq(projects.companyId, companyId), eq(projects.id, projectId),
        )).for("update");
        if (!project || (project.archivedAt && grantId)) throw notFound("Active project not found");
        await assertProjectWriter(transactionalDb, companyId, projectId, userId);
        if (grantId && !(await eligibleGrants(transactionalDb, companyId, userId))
          .some(({ grant }) => grant.id === grantId)) {
          throw forbidden("Select your own active company-installed GitHub Connector grant");
        }
        await tx.update(projects).set({
          gitAuthorizationGrantId: grantId,
          gitAuthorizedByUserId: grantId ? userId : null,
          updatedAt: new Date(),
        }).where(and(eq(projects.companyId, companyId), eq(projects.id, projectId)));
        const result = await persistActivity(transactionalDb, {
          companyId, actorType: "user", actorId: userId,
          action: grantId ? "project.git_authorized" : "project.git_authorization_revoked",
          entityType: "project", entityId: projectId, details: { grantId },
        });
        return result.publication;
      });
      publishActivity(publication);
      return read(companyId, projectId, userId);
    },

    async resolve(input: {
      companyId: string;
      projectId: string | null;
      projectWorkspaceId: string | null;
      issueId: string | null;
      operation: "prepare" | "inspect" | "remove" | null;
      remoteUrl: string;
    }, secrets: Secrets): Promise<GitCredential | null> {
      if (!input.operation) throw forbidden("Background Git requires a host project operation");
      const repo = canonicalRepoUrl(input.remoteUrl);
      const [issue] = input.issueId ? await db.select({
        companyId: issues.companyId,
        projectId: issues.projectId,
        executionPolicy: issues.executionPolicy,
        sourceTrust: issues.sourceTrust,
      }).from(issues).where(and(
        eq(issues.companyId, input.companyId), eq(issues.id, input.issueId),
      )) : [];
      if (input.issueId && !issue) throw forbidden("Background Git task is unavailable");
      const projectId = input.projectId ?? issue?.projectId;
      if (!projectId || (issue && issue.projectId !== projectId)) {
        throw forbidden("Background Git project does not match its task");
      }
      const project = await getProject(input.companyId, projectId);
      if (project.archivedAt) throw forbidden("Archived projects cannot acquire Git credentials");
      const workspaceRows = await db.select().from(projectWorkspaces).where(and(
        eq(projectWorkspaces.companyId, input.companyId),
        eq(projectWorkspaces.projectId, projectId),
      ));
      const matching = workspaceRows.filter((row) => row.repoUrl
        && (!input.projectWorkspaceId || row.id === input.projectWorkspaceId)
        && canonicalRepoUrl(row.repoUrl).url.toLowerCase() === repo.url.toLowerCase());
      if (matching.length !== 1) throw forbidden("Background Git workspace does not match this repository");
      if (isLowTrustQuarantined(issue?.sourceTrust)
        || resolveCoreTrustPreset({ companyId: input.companyId, project, issue }).kind !== "standard") {
        throw forbidden("Git credentials are unavailable to low-trust projects or tasks");
      }
      // Public repositories need no credential, including when a project has a grant.
      if (await publicRepository(repo.fullName)) return null;
      if (!project.gitAuthorizationGrantId || !project.gitAuthorizedByUserId) {
        throw forbidden("Authorize this project's GitHub Connector before private background Git work");
      }
      await assertProjectWriter(db, input.companyId, projectId, project.gitAuthorizedByUserId);
      const selected = (await eligibleGrants(db, input.companyId, project.gitAuthorizedByUserId))
        .find(({ grant }) => grant.id === project.gitAuthorizationGrantId);
      if (!selected) throw forbidden("Project GitHub authorization is unavailable");
      let freshGrant: Grant;
      try {
        freshGrant = await (await import("./tool-access.js")).toolAccessService(db)
          .refreshManagedGitHubGrantAccess(selected.connection, selected.grant, {
            actorType: "system", actorId: "project-git-credential",
          });
      } catch {
        throw forbidden("Current GitHub repository access is unavailable");
      }
      if (freshGrant.id !== selected.grant.id || !repositoryAllowed(freshGrant, repo.fullName)) {
        throw forbidden("The selected GitHub grant cannot access this repository");
      }
      const resolved = await resolveManagedGitHubCredential(db, secrets, input.companyId, {
        responsibleUserId: project.gitAuthorizedByUserId,
        explicitGrantId: project.gitAuthorizationGrantId,
        allowStandingDelegation: false,
      });
      if (!resolved.credential || resolved.credential.grantId !== project.gitAuthorizationGrantId) {
        throw forbidden("The selected GitHub credential is unavailable");
      }
      const current = await getProject(input.companyId, projectId);
      if (current.archivedAt || current.gitAuthorizationGrantId !== project.gitAuthorizationGrantId
        || current.gitAuthorizedByUserId !== project.gitAuthorizedByUserId) {
        throw forbidden("Project GitHub authorization changed during credential acquisition");
      }
      await assertProjectWriter(db, input.companyId, projectId, project.gitAuthorizedByUserId);
      const [currentWorkspace] = await db.select({ repoUrl: projectWorkspaces.repoUrl })
        .from(projectWorkspaces).where(and(
          eq(projectWorkspaces.companyId, input.companyId),
          eq(projectWorkspaces.projectId, projectId),
          eq(projectWorkspaces.id, matching[0]!.id),
        ));
      if (!currentWorkspace?.repoUrl || canonicalRepoUrl(currentWorkspace.repoUrl).url.toLowerCase() !== repo.url.toLowerCase()) {
        throw forbidden("Project repository changed during credential acquisition");
      }
      const [currentIssue] = input.issueId ? await db.select({
        projectId: issues.projectId, executionPolicy: issues.executionPolicy, sourceTrust: issues.sourceTrust,
      }).from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))) : [];
      if ((input.issueId && (!currentIssue || currentIssue.projectId !== projectId))
        || isLowTrustQuarantined(currentIssue?.sourceTrust)
        || resolveCoreTrustPreset({ companyId: input.companyId, project: current, issue: currentIssue }).kind !== "standard") {
        throw forbidden("Project trust or task scope changed during credential acquisition");
      }
      const latest = (await eligibleGrants(db, input.companyId, project.gitAuthorizedByUserId))
        .find(({ grant }) => grant.id === project.gitAuthorizationGrantId);
      if (!latest || !repositoryAllowed(latest.grant, repo.fullName)) {
        throw forbidden("Project GitHub authorization changed during credential acquisition");
      }
      const token = resolved.credential.token;
      if (!token || token.length > 4096 || /[\0\r\n]/.test(token) || token.startsWith("secret://")) {
        throw forbidden("Project GitHub credential is unavailable");
      }
      return resolved.credential;
    },
  };
}
