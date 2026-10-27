import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  companies, companyMemberships, companySecrets, connectionGrants,
  createDb, issues, projectWorkspaces, projects, toolApplications,
  toolConnectionInstalls, toolConnections, userSecretDefinitions,
} from "@greatstone/db";
import { LOW_TRUST_REVIEW_PRESET } from "@greatstone/shared";
import { createGitRemoteAuthProvider } from "../services/git-credentials.js";
import { projectGitAuthorizationService } from "../services/project-git-authorization.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const access = vi.hoisted(() => ({ refreshManagedGitHubGrantAccess: vi.fn() }));
vi.mock("../services/tool-access.js", () => ({ toolAccessService: () => access }));

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("background project Git consent", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let fixture: Awaited<ReturnType<typeof seed>>;
  const secrets = {
    getByName: vi.fn(async () => ({ id: "legacy-secret" })),
    resolveSecretValue: vi.fn(async () => "legacy-token"),
    resolveUserSecretValue: vi.fn(async (_companyId: string, input: { responsibleUserId: string }) => ({ value: `token-${input.responsibleUserId}` })),
  };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("project-git-consent-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); }, 60_000);
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    secrets.getByName.mockClear();
    secrets.resolveSecretValue.mockClear();
    secrets.resolveUserSecretValue.mockClear();
    access.refreshManagedGitHubGrantAccess.mockReset().mockImplementation(async (_connection, grant) => {
      const [current] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id));
      return current;
    });
    fixture = await seed();
  });

  async function seed() {
    const companyId = randomUUID(), projectId = randomUUID(), workspaceId = randomUUID(), issueId = randomUUID();
    const grantId = randomUUID(), connectionId = randomUUID(), userId = `user-${randomUUID()}`;
    const repoUrl = "https://github.com/example/private.git";
    await db.insert(companies).values({ id: companyId, name: companyId, issuePrefix: companyId.slice(0, 8) });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "member" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Consent test" });
    await db.insert(projectWorkspaces).values({ id: workspaceId, companyId, projectId, name: "private", repoUrl });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Rebuild" });
    const [app] = await db.insert(toolApplications).values({ companyId, name: "GitHub", type: "mcp_http" }).returning();
    await db.insert(toolConnections).values({
      id: connectionId, companyId, applicationId: app.id, name: "GitHub", uid: connectionId,
      transport: "mcp_remote", status: "active", enabled: true, credentialPolicy: "per_user",
      config: { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } },
    });
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId, targetType: "company", targetId: companyId });
    const [definition] = await db.insert(userSecretDefinitions).values({ companyId, key: randomUUID(), name: "GitHub token" }).returning();
    const [secret] = await db.insert(companySecrets).values({
      companyId, key: randomUUID(), name: "GitHub token", scope: "user", ownerUserId: userId,
      userSecretDefinitionId: definition.id,
    }).returning();
    await db.insert(connectionGrants).values({
      id: grantId, companyId, connectionId, kind: "user", subjectUserId: userId, status: "active",
      credentialSecretRefs: [{ secretId: secret.id, configPath: "oauth.access_token", versionSelector: "latest" }],
      providerTenant: { github: {
        userId: userId, login: "alice", installationCount: 1, repositoryCount: 1,
        repositorySelection: "selected", installationIds: ["1"], installationOwnerLogins: ["example"],
        repositories: [{ id: "1", fullName: "example/private", installationId: "1", private: true }],
      } },
    });
    return { companyId, projectId, workspaceId, issueId, grantId, connectionId, userId, repoUrl };
  }

  const provider = (input: typeof fixture, scope: Partial<{ companyId: string; projectId: string; projectWorkspaceId: string; issueId: string; operation: "prepare" | "inspect" | "remove" }> = {}) =>
    createGitRemoteAuthProvider(db, scope.companyId ?? input.companyId, {
      projectId: scope.projectId ?? input.projectId,
      projectWorkspaceId: scope.projectWorkspaceId ?? input.workspaceId,
      issueId: scope.issueId ?? input.issueId,
      operation: scope.operation ?? "prepare",
    }, { secrets: secrets as never, env: { GITHUB_TOKEN: "legacy-env-token" } });

  async function consent() {
    await projectGitAuthorizationService(db).set(fixture.companyId, fixture.projectId, fixture.userId, fixture.grantId);
  }

  it("denies an unconsented private rebuild without consulting legacy credentials", async () => {
    await expect(provider(fixture)(fixture.repoUrl)).rejects.toThrow(/Authorize this project/);
    expect(secrets.getByName).not.toHaveBeenCalled();
    expect(secrets.resolveSecretValue).not.toHaveBeenCalled();
  });

  it("accepts consent only from an active writer for their own installed grant", async () => {
    const service = projectGitAuthorizationService(db);
    await expect(service.set(fixture.companyId, fixture.projectId, fixture.userId, randomUUID()))
      .rejects.toThrow(/your own active/i);
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(and(
      eq(companyMemberships.companyId, fixture.companyId), eq(companyMemberships.principalId, fixture.userId),
    ));
    await expect(service.set(fixture.companyId, fixture.projectId, fixture.userId, fixture.grantId))
      .rejects.toThrow(/project writer/i);
    const [project] = await db.select().from(projects).where(eq(projects.id, fixture.projectId));
    expect(project.gitAuthorizationGrantId).toBeNull();
  });

  it("uses only the selected personal grant, with no substitution", async () => {
    await consent();
    const authorized = await provider(fixture)(fixture.repoUrl);
    expect(authorized?.env.GSAM_GIT_TOKEN).toBe(`token-${fixture.userId}`);
    expect(authorized?.source).toBe("managed_connection");
    const [selected] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, fixture.grantId));
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, fixture.connectionId));
    const substituteConnectionId = randomUUID();
    await db.insert(toolConnections).values({
      ...connection, id: substituteConnectionId, uid: substituteConnectionId, name: "Second GitHub",
    });
    await db.insert(toolConnectionInstalls).values({
      companyId: fixture.companyId, connectionId: substituteConnectionId,
      targetType: "company", targetId: fixture.companyId,
    });
    await db.insert(connectionGrants).values({
      ...selected, id: randomUUID(), connectionId: substituteConnectionId,
      createdAt: new Date(), updatedAt: new Date(),
    });
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, fixture.grantId));
    await expect(provider(fixture)(fixture.repoUrl)).rejects.toThrow(/authorization is unavailable/i);
    expect(secrets.getByName).not.toHaveBeenCalled();
  });

  it("denies disabled connection, lost membership or writer access", async () => {
    await consent();
    await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, fixture.connectionId));
    await expect(provider(fixture)(fixture.repoUrl)).rejects.toThrow(/authorization is unavailable/i);
    await db.update(toolConnections).set({ enabled: true }).where(eq(toolConnections.id, fixture.connectionId));
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(and(
      eq(companyMemberships.companyId, fixture.companyId), eq(companyMemberships.principalId, fixture.userId),
    ));
    await expect(provider(fixture)(fixture.repoUrl)).rejects.toThrow(/project writer/i);
    await db.update(companyMemberships).set({ membershipRole: "member", status: "inactive" }).where(and(
      eq(companyMemberships.companyId, fixture.companyId), eq(companyMemberships.principalId, fixture.userId),
    ));
    await expect(provider(fixture)(fixture.repoUrl)).rejects.toThrow(/project writer/i);
  });

  it("denies repository permission removal even with saved consent", async () => {
    await consent();
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, fixture.grantId));
    await db.update(connectionGrants).set({ providerTenant: { ...grant.providerTenant,
      github: { ...grant.providerTenant!.github!, repositories: [], repositoryCount: 0 },
    } }).where(eq(connectionGrants.id, fixture.grantId));
    await expect(provider(fixture)(fixture.repoUrl)).rejects.toThrow(/cannot access this repository/i);
  });

  it("never emits a malformed Connector token into Git's credential helper", async () => {
    await consent();
    secrets.resolveUserSecretValue.mockResolvedValueOnce({ value: "token\npassword=wrong" });
    await expect(provider(fixture)(fixture.repoUrl)).rejects.toThrow(/credential is unavailable/i);
  });

  it("denies low trust, archive, cross-company and workspace substitution", async () => {
    await consent();
    await db.update(projects).set({ executionWorkspacePolicy: { authorizationPolicy: {
      trustPreset: LOW_TRUST_REVIEW_PRESET,
      trustBoundary: { mode: LOW_TRUST_REVIEW_PRESET, companyId: fixture.companyId, projectIds: [fixture.projectId] },
    } } }).where(eq(projects.id, fixture.projectId));
    await expect(provider(fixture)(fixture.repoUrl)).rejects.toThrow(/low-trust/i);
    await db.update(projects).set({ executionWorkspacePolicy: null }).where(eq(projects.id, fixture.projectId));
    await db.update(issues).set({ sourceTrust: {
      preset: LOW_TRUST_REVIEW_PRESET, disposition: "quarantined", sourceIssueId: fixture.issueId,
    } }).where(eq(issues.id, fixture.issueId));
    await expect(provider(fixture)(fixture.repoUrl)).rejects.toThrow(/low-trust/i);
    await db.update(issues).set({ sourceTrust: null }).where(eq(issues.id, fixture.issueId));
    await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, fixture.projectId));
    await expect(provider(fixture)(fixture.repoUrl)).rejects.toThrow(/Archived/i);
    await db.update(projects).set({ archivedAt: null }).where(eq(projects.id, fixture.projectId));
    await expect(provider(fixture, { companyId: randomUUID() })(fixture.repoUrl)).rejects.toThrow();
    await expect(provider(fixture, { projectWorkspaceId: randomUUID() })(fixture.repoUrl)).rejects.toThrow(/workspace/i);
  });

  it("keeps public clone anonymous and unknown visibility closed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ full_name: "example/private", private: false })));
    const anonymous = await provider(fixture)(fixture.repoUrl);
    expect(anonymous?.source).toBe("anonymous");
    expect(anonymous?.env.GSAM_GIT_TOKEN).toBe("");
    expect(anonymous?.env.GITHUB_TOKEN).toBe("");
    expect(secrets.resolveUserSecretValue).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    await expect(provider(fixture)(fixture.repoUrl)).rejects.toThrow(/visibility/i);
  });
});
