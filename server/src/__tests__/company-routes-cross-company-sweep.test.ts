import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  agentApiKeys, agents, agentTeams, approvals, assets, authUsers, cases, chatEndpoints, companies,
  companyMemberships, companySecretProviderConfigs, companySecrets, decisions, decisionTrainingExamples,
  environmentLeases, environments, executionWorkspaces, feedbackExports, feedbackVotes, goals, heartbeatRuns,
  invites, issueAttachments, issues,
  issueThreadInteractions, issueWorkProducts, labels, pipelines, plugins, projects, routines, routineTriggers,
  statusCards, toolApplications, toolConnections, toolProfileEntries, toolProfiles, workspaceOperations,
} from "@greatstone/db";
import { createApp } from "../app.js";
import { environmentService } from "../services/environments.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { describeEmbeddedPostgres, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

/**
 * GRE-505: every `/api/companies/:companyId/...` route registered on the real
 * app must refuse another company's caller. The routes are listed from the
 * router itself, so a new route is covered without editing this file.
 *
 * Two callers from company B call every route with company A's id: B's agent
 * key, and B's owner signed in on the board. Many routes refuse every agent
 * ("Board access required"), so the agent pass alone says nothing about their
 * company check; the board pass covers them.
 *
 * GRE-694 adds a second sweep for routes that take a record id directly
 * (`/api/issues/:id`, `/api/agents/:id`, ...): one record per resource is
 * seeded in company A and the same two callers must be refused on every route.
 *
 * Express 5 does not keep the mount path on a router layer, so the sweep wraps
 * `Router.prototype.use` before the app is built and records it on each layer.
 */

// Many routes validate the body before they check the company, so an empty
// body stops at a 400 and never reaches the check this sweep is about. Body
// validation is turned off here so every request reaches the handler.
vi.mock("../middleware/validate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../middleware/validate.js")>();
  const passThrough = () => (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, validate: passThrough, validateIssueMutationBody: passThrough };
});

// Routes that are meant to answer another company's caller. Each entry needs a
// reason. Key is `METHOD /api/companies/:companyId/...` as listed by the sweep.
const ALLOWED_CROSS_COMPANY: Record<string, string> = {};

// A few handlers parse their own body before the company check, so they need a
// body that parses. Any other route gets `{}`.
const loginIntent = { provider: "anthropic", method: "subscription", name: "Sweep", ownership: "personal" };
const REQUEST_BODIES: Record<string, unknown> = {
  "PUT /api/companies/:companyId/skill-policy": { schemaVersion: 1, defaultEffect: "allow", rules: [], expectedRevision: 0 },
  "POST /api/companies/:companyId/skill-policy/evaluate": { action: "skills.create" },
  "POST /api/companies/:companyId/ai-connections": {
    provider: "anthropic", method: "api_key", apiKey: "not-a-real-key", name: "Sweep", ownership: "personal",
  },
  "POST /api/companies/:companyId/ai-connections/local": loginIntent,
  "POST /api/companies/:companyId/ai-connections/local/check": loginIntent,
  "POST /api/companies/:companyId/ai-connections/local/attempts": loginIntent,
  "POST /api/agents/:id/skills/sync": { mode: "add", desiredSkills: [] },
};

// Path params that must name something real before the company check runs.
const PARAM_VALUES: Record<string, string> = { type: "process" };

const REFUSED = new Set([403, 404]);
const COMPANY_PREFIX = /^\/api\/companies\/:companyId(?:\/|$)/;

// GRE-694: routes outside `/api/companies/:companyId` that take a record id in
// the path. Every one must start with a seeded prefix (below, filled with a
// real company A record) or an allow-listed prefix with a reason. A new id
// route that is neither fails "classifies every id route".
const ID_ROUTE = /^\/api\/(?!companies\/:companyId(?:\/|$))[^?]*\/:/;

// Id routes left out of the id sweep, by path prefix. Each prefix must still
// match a live route. "Not seeded yet" entries are company records this sweep
// does not create yet; the rest do not take a company record id.
const ID_ROUTES_NOT_SWEPT: Record<string, string> = {
  "/api/invites/:token": "Public invite link, the token is the credential.",
  "/api/board-claim/:token": "Public board-claim link, the token is the credential.",
  "/api/join-requests/:requestId": "Only POST .../claim-api-key, which a joining agent calls before it has a key; "
    + "the claim secret in the body is the credential, not a session. Company join-request routes are swept above.",
  "/api/board-api-keys/:keyId": "Board API keys belong to the signed-in user, not a company.",
  "/api/cli-auth/challenges/:id": "CLI login challenges belong to the signed-in user, not a company.",
  "/api/admin/users/:userId": "Instance-admin only; the id is a user, not a company record.",
  "/api/adapters/:type": "Adapter types are instance-wide code, not company records.",
  "/api/skills/:skillName": "Bundled skill docs, the same for every company.",
  "/api/skills/catalog/:catalogId": "Instance-wide skill catalog, the same for every company.",
  "/api/teams/catalog/:catalogId": "Instance-wide team catalog, the same for every company.",
  "/api/agent-avatars/:version": "Static avatar images, the same for every company.",
  "/api/llms/agent-configuration/": "Static adapter docs, the same for every company.",
  "/api/environments/:id": "Environments are instance-wide (no company column), not company records.",
  "/api/environments/:environmentId": "Environments are instance-wide (no company column), not company records.",
  "/api/announcements/:id": "Product announcements are instance-wide, not company records.",
  "/api/chat-webhooks/:publicId": "Inbound provider webhook; authenticated by provider signature, not a session.",
  "/api/chat-webhooks/agentmail/:publicId": "Inbound provider webhook; authenticated by provider signature, not a session.",
  "/api/routine-triggers/public/:publicId": "Public routine webhook; authenticated by the trigger secret, not a session.",
  "/api/companies/import/": "Import jobs and transfers belong to the user who started them, before a company exists.",
  "/api/agents/me/": "Acts on the calling agent's own company; there is no other company's id to pass.",
  "/api/environment-custom-image-setup-sessions/:sessionId": "Instance-admin only: every handler calls "
    + "assertCanAccessInstanceEnvironments before reading the session, so a company owner is refused before any company check.",
  "/api/tool-gateway/": "Not seeded yet: gateways, tokens, sessions and runtime slots need a gateway setup.",
  "/api/plugins/:pluginId": "Plugins are instance-wide (no company column). Company data sits under "
    + "/plugins/:pluginId/companies/:companyId, which is swept, or in the request body, which this sweep does not fill.",
};

// Id routes that answer 200 with an empty body for both "missing" and "another
// company's", so the answer says nothing about company A's record.
const ID_ROUTES_EMPTY_ANSWER: Record<string, string> = {
  "GET /api/heartbeat-runs/:runId/issues": "Returns 200 [] for a missing or cross-company run (activity.ts, legacy contract).",
  "GET /api/issues/:issueId/chat-binding": "Returns 200 null when the issue has no chat binding; a binding is checked against its endpoint's company.",
};

// Id routes that answer another company's caller today. Listed so the sweep
// passes while the fix is decided (GRE-694, register row 55); delete an entry
// once its route refuses, the sweep fails until you do.
const KNOWN_ID_ROUTE_LEAKS: Record<string, string> = {};

type RouteLayer = {
  route?: { path: unknown; methods: Record<string, boolean> };
  handle?: { stack?: RouteLayer[] };
  __mountPath?: string;
};

const routerProto = (express.Router as unknown as { prototype: { use: (...args: unknown[]) => unknown } }).prototype;
const originalUse = routerProto.use;

function recordMountPaths() {
  routerProto.use = function patchedUse(this: { stack: RouteLayer[] }, ...args: unknown[]) {
    const before = this.stack.length;
    const result = originalUse.apply(this, args);
    const mountPath = typeof args[0] === "string" ? args[0] : "";
    for (const layer of this.stack.slice(before)) layer.__mountPath = mountPath;
    return result;
  };
}

function joinPath(prefix: string, path: string) {
  const joined = `${prefix}/${path}`.replace(/\/+/g, "/");
  return joined.length > 1 ? joined.replace(/\/$/, "") : joined;
}

function listRoutes(stack: RouteLayer[], prefix = ""): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = [];
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      const methods = Object.keys(layer.route.methods).filter((m) => layer.route!.methods[m] && m !== "_all");
      if (layer.route.methods._all) methods.push("get");
      for (const path of paths) {
        if (typeof path !== "string") continue;
        for (const method of methods) out.push({ method: method.toUpperCase(), path: joinPath(prefix, path) });
      }
    } else if (layer.handle?.stack) {
      out.push(...listRoutes(layer.handle.stack, joinPath(prefix, layer.__mountPath ?? "")));
    }
  }
  return out;
}

function fillPath(path: string, companyId: string) {
  return path
    .replace(/\{\/?\*[A-Za-z0-9_]+\}|\*[A-Za-z0-9_]+/g, "x")
    .replace(/[{}]/g, "")
    .replace(/:companyId\b/g, companyId)
    .replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => PARAM_VALUES[name] ?? randomUUID());
}

// A prefix ending in "/" matches anything under it; otherwise it must end at a
// path segment, so "/api/invites/:token" does not match "/api/invites/:tokenX".
function matchesPrefix(path: string, prefix: string) {
  return prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix || path.startsWith(`${prefix}/`);
}

function fillIdPath(path: string, seeded: Record<string, string>, companyId: string) {
  const prefix = Object.keys(seeded).find((key) => matchesPrefix(path, key));
  const head = prefix ? seeded[prefix]! : "";
  const rest = prefix ? path.slice(prefix.length) : path;
  return head + rest
    .replace(/\{\/?\*[A-Za-z0-9_]+\}|\*[A-Za-z0-9_]+/g, "x")
    .replace(/[{}]/g, "")
    .replace(/:companyId\b/g, companyId)
    .replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => PARAM_VALUES[name] ?? randomUUID());
}

describeEmbeddedPostgres("company routes refuse another company's caller (GRE-505)", () => {
  let app: express.Express | undefined;
  let root: string | undefined;
  // Registered before the database hooks: this config runs afterAll in list
  // order, and the app's background loops must stop before the database does.
  afterAll(async () => {
    await (app?.locals.paperclipShutdown as (() => Promise<void>) | undefined)?.();
    if (root) await rm(root, { recursive: true, force: true });
  });
  const ctx = useEmbeddedPostgres("paperclip-cross-company-sweep-");
  let routes: { method: string; path: string }[] = [];
  let idRoutes: { method: string; path: string }[] = [];
  // Id route prefix -> the same path with company A's seeded record id.
  let seeded: Record<string, string> = {};
  const companyAId = randomUUID();
  const companyBId = randomUUID();
  const agentBId = randomUUID();
  const ownerBId = `user-${randomUUID()}`;
  const tokenB = `pcp_sweep_${randomBytes(24).toString("hex")}`;
  const SESSION_HEADER = "x-sweep-session";

  type Caller = { name: string; headers: Record<string, string> };
  const agentKeyB: Caller = { name: "agent key", headers: { Authorization: `Bearer ${tokenB}` } };
  const boardOwnerB: Caller = { name: "board session", headers: { [SESSION_HEADER]: "owner-b", Origin: "http://127.0.0.1" } };

  function call(caller: Caller, method: string, url: string, body?: unknown) {
    let req = request(app!)[method.toLowerCase() as "get"](url).set("Host", "127.0.0.1").timeout(10_000);
    for (const [name, value] of Object.entries(caller.headers)) req = req.set(name, value);
    if (!["GET", "HEAD", "DELETE"].includes(method)) req = req.send((body ?? {}) as object);
    return req;
  }

  async function sweep(caller: Caller, list: typeof routes, fill: (path: string) => string) {
    const leaks: string[] = [];
    for (const route of list) {
      const key = `${route.method} ${route.path}`;
      if (ALLOWED_CROSS_COMPANY[key]) continue;
      let status: number | string;
      let body: unknown;
      try {
        const res = await call(caller, route.method, fill(route.path), REQUEST_BODIES[key]);
        status = res.status;
        body = res.body;
      } catch (error) {
        status = (error as { status?: number }).status ?? `error: ${(error as Error).message}`;
      }
      const emptyAnswer = ID_ROUTES_EMPTY_ANSWER[key] && status === 200
        && (body === null || (Array.isArray(body) && body.length === 0));
      if (typeof status !== "number" || !(REFUSED.has(status) || emptyAnswer)) leaks.push(`${key} -> ${status}`);
    }
    return leaks;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperclip-cross-company-sweep-"));
    recordMountPaths();
    try {
      app = await createApp(ctx.db, {
        uiMode: "none", serverPort: 0,
        storageService: createStorageService(createLocalDiskStorageProvider(join(root, "storage"))),
        deploymentMode: "authenticated", deploymentExposure: "private",
        allowedHostnames: ["127.0.0.1"], bindHost: "127.0.0.1", authReady: true,
        companyDeletionEnabled: true, instanceId: `sweep-${randomUUID()}`,
        localPluginDir: join(root, "plugins"), managedPluginAutoInstall: [],
        decisionServiceOptions: { wakeOriginAgent: async () => undefined },
        resolveSession: async (req) => req.header(SESSION_HEADER) === "owner-b"
          ? { session: { id: "sweep-session", userId: ownerBId }, user: { id: ownerBId, name: "Company B owner", email: null } }
          : null,
      });
    } finally {
      routerProto.use = originalUse;
    }
    const allRoutes = listRoutes((app as unknown as { router: { stack: RouteLayer[] } }).router.stack);
    routes = allRoutes.filter((route) => COMPANY_PREFIX.test(route.path));
    idRoutes = allRoutes.filter((route) => ID_ROUTE.test(route.path));

    // Flagged features answer 404 while off, which would hide their company check.
    await instanceSettingsService(ctx.db).updateExperimental({
      enableEnvironments: true, enableChatConnectors: true, enableMemoryConnectors: true,
      enablePipelines: true, enableCases: true, enableDeepDive: true, enableAgentChat: true,
      enableConferenceRoomChat: true, enableIssuePlanDecompositions: true, enableExternalObjects: true,
      enableSmokeLab: true, enableBuiltInAgents: true, enableBetaSkills: true, enableSummaries: true,
      enableStatusCards: true,
    });

    await ctx.db.insert(companies).values([
      { id: companyAId, name: "Company A", issuePrefix: `A${companyAId.replaceAll("-", "").slice(0, 6).toUpperCase()}` },
      { id: companyBId, name: "Company B", issuePrefix: `B${companyBId.replaceAll("-", "").slice(0, 6).toUpperCase()}` },
    ]);
    // The strongest callers company B has (its owner, and a CEO agent acting
    // for the owner), so a refusal comes from the company boundary and not
    // from a missing permission.
    await ctx.db.insert(authUsers).values({
      id: ownerBId, name: "Company B owner", email: `${ownerBId}@sweep.invalid`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
    });
    await ctx.db.insert(companyMemberships).values({
      companyId: companyBId, principalType: "user", principalId: ownerBId,
      status: "active", membershipRole: "owner", updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(ctx.db, {
      companyId: companyBId, principalId: ownerBId, membershipRole: "owner", grantedByUserId: null,
    });
    await ctx.db.insert(agents).values({
      id: agentBId, companyId: companyBId, name: "Company B CEO", role: "ceo",
      adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false } },
      permissions: { canCreateAgents: true }, status: "active",
    });
    await ctx.db.insert(agentApiKeys).values({
      agentId: agentBId, companyId: companyBId, name: "sweep", responsibleUserId: ownerBId,
      keyHash: createHash("sha256").update(tokenB).digest("hex"),
    });
    seeded = await seedCompanyARecords();
  }, 60_000);

  // One record per id resource, all in company A. Keys are the id route
  // prefixes as the router lists them.
  async function seedCompanyARecords(): Promise<Record<string, string>> {
    const A = { companyId: companyAId };
    const id = () => randomUUID();
    const agentId = id(), issueId = id(), caseId = id(), pluginId = id(), applicationId = id();
    const connectionId = id(), endpointId = id(), profileId = id(), pipelineId = id(), runId = id();
    const routineId = id(), triggerId = id(), projectId = id(), goalId = id(), approvalId = id();
    const statusCardId = id(), teamId = id(), workspaceId = id(), secretId = id();
    const providerConfigId = id(), labelId = id(), assetId = id(), attachmentId = id(), workProductId = id();
    const operationId = id(), leaseId = id();
    const profileEntryId = id(), intentId = id(), voteId = id(), traceId = id(), trainingId = id();
    const inviteId = id(), decisionId = id();
    const ownerAId = `user-${id()}`;

    await ctx.db.insert(agents).values({
      ...A, id: agentId, name: "Company A agent", role: "engineer", adapterType: "process",
      adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false } }, status: "active",
    });
    await ctx.db.insert(projects).values({ ...A, id: projectId, name: "Company A project" });
    await ctx.db.insert(goals).values({ ...A, id: goalId, title: "Company A goal" });
    await ctx.db.insert(issues).values({ ...A, id: issueId, title: "Company A issue", projectId });
    await ctx.db.insert(cases).values({
      ...A, id: caseId, caseNumber: 1, identifier: "ACASE-1", caseType: "general", title: "Company A case",
    });
    await ctx.db.insert(plugins).values({
      id: pluginId, pluginKey: `sweep.plugin.${pluginId}`, packageName: "@sweep/plugin", version: "1.0.0",
      manifestJson: { id: `sweep.plugin.${pluginId}`, version: "1.0.0" },
    });
    await ctx.db.insert(toolApplications).values({ ...A, id: applicationId, name: "Company A app", type: "mcp" });
    await ctx.db.insert(toolConnections).values({
      ...A, id: connectionId, applicationId, name: "Company A connection", uid: `a-${connectionId}`, transport: "mcp_remote",
    });
    await ctx.db.insert(chatEndpoints).values({
      ...A, id: endpointId, connectionId, provider: "slack", publicId: `a-${endpointId}`, assignedAgentId: agentId,
    });
    await ctx.db.insert(toolProfiles).values({ ...A, id: profileId, profileKey: "a-profile", name: "Company A profile" });
    await ctx.db.insert(pipelines).values({ ...A, id: pipelineId, key: "a-pipeline", name: "Company A pipeline" });
    await ctx.db.insert(heartbeatRuns).values({ ...A, id: runId, agentId });
    await ctx.db.insert(routines).values({ ...A, id: routineId, title: "Company A routine" });
    await ctx.db.insert(routineTriggers).values({ ...A, id: triggerId, routineId, kind: "schedule" });
    await ctx.db.insert(approvals).values({ ...A, id: approvalId, type: "hire_agent", payload: {} });
    await ctx.db.insert(statusCards).values({
      ...A, id: statusCardId, interestPrompt: "Company A card", refreshPolicy: { kind: "manual" },
    });
    await ctx.db.insert(agentTeams).values({ ...A, id: teamId, name: "Company A team", color: "#000000" });
    await ctx.db.insert(executionWorkspaces).values({
      ...A, id: workspaceId, projectId, mode: "isolated_workspace", strategyType: "git_worktree", name: "Company A ws",
    });
    await ctx.db.insert(companySecrets).values({ ...A, id: secretId, key: "A_SECRET", name: "Company A secret" });
    await ctx.db.insert(companySecretProviderConfigs).values({
      ...A, id: providerConfigId, provider: "local_encrypted", displayName: "Company A vault",
    });
    await ctx.db.insert(labels).values({ ...A, id: labelId, name: "Company A label", color: "#000000" });
    await ctx.db.insert(assets).values({
      ...A, id: assetId, provider: "local_disk", objectKey: `a/${assetId}`, contentType: "text/plain",
      byteSize: 1, sha256: "0".repeat(64),
    });
    await ctx.db.insert(issueAttachments).values({ ...A, id: attachmentId, issueId, assetId });
    await ctx.db.insert(issueWorkProducts).values({
      ...A, id: workProductId, issueId, type: "pull_request", provider: "github", title: "Company A PR", status: "open",
    });
    await ctx.db.insert(workspaceOperations).values({ ...A, id: operationId, phase: "worktree_prepare" });
    await ctx.db.insert(environmentLeases).values({ ...A, id: leaseId });
    // GRE-822: the first four "Not seeded yet" groups.
    await ctx.db.insert(toolProfileEntries).values({
      ...A, id: profileEntryId, profileId, selectorType: "application", applicationId,
    });
    await ctx.db.insert(issueThreadInteractions).values({
      ...A, id: intentId, issueId, kind: "connection_intent", addresseeUserId: ownerAId,
      payload: {
        version: 1, serviceSlug: "github", serviceName: "GitHub", requestingAgentId: agentId,
        requestingAgentName: "Company A agent", phase: "requested",
      },
    });
    await ctx.db.insert(feedbackVotes).values({
      ...A, id: voteId, issueId, targetType: "issue_comment", targetId: id(), authorUserId: ownerAId, vote: "up",
    });
    await ctx.db.insert(feedbackExports).values({
      ...A, id: traceId, feedbackVoteId: voteId, issueId, projectId, authorUserId: ownerAId,
      targetType: "issue_comment", targetId: id(), vote: "up", targetSummary: {},
    });
    await ctx.db.insert(decisionTrainingExamples).values({
      ...A, id: trainingId, sourceKind: "approval", sourceId: approvalId, issueId, cutoffAt: new Date(),
      // The id routes check the company before they read the snapshot.
      snapshot: {} as never, createdByUserId: ownerAId,
    });
    // GRE-822 PR 2: invites by id and decisions.
    await ctx.db.insert(invites).values({
      ...A, id: inviteId, tokenHash: createHash("sha256").update(randomBytes(16)).digest("hex"),
      expiresAt: new Date(Date.now() + 86_400_000), invitedByUserId: ownerAId,
    });
    await ctx.db.insert(decisions).values({
      ...A, id: decisionId, originAgentId: agentId, originIssueId: issueId, originRunId: runId,
      title: "Company A decision", body: "Company A decision", options: [],
      // The id routes check the company before they read the spec or snapshots.
      expiresAt: new Date(Date.now() + 86_400_000), signedSpec: "sweep", targetSnapshots: {},
    });

    const byPrefix: Record<string, string> = {
      "/api/issues/:id": issueId, "/api/issues/:issueId": issueId,
      "/api/agents/:id": agentId, "/api/agents/:agentId": agentId,
      "/api/cases/:id": caseId, "/api/cases/:caseId": caseId,
      "/api/plugins/:pluginId/companies/:companyId": pluginId,
      "/api/chat-endpoints/:endpointId": endpointId, "/api/email/inboxes/:endpointId": endpointId,
      "/api/tool-connections/:connectionId": connectionId, "/api/tools/oauth/:connectionId": connectionId,
      "/api/tool-applications/:applicationId": applicationId,
      "/api/tool-profiles/:profileId": profileId,
      "/api/pipelines/:pipelineId": pipelineId,
      "/api/heartbeat-runs/:runId": runId,
      "/api/routines/:id": routineId, "/api/routine-triggers/:id": triggerId,
      "/api/projects/:id": projectId, "/api/goals/:id": goalId, "/api/approvals/:id": approvalId,
      "/api/status-cards/:id": statusCardId, "/api/agent-teams/:id": teamId,
      "/api/execution-workspaces/:id": workspaceId,
      "/api/secrets/:id": secretId, "/api/secret-provider-configs/:id": providerConfigId,
      "/api/labels/:labelId": labelId, "/api/assets/:assetId": assetId,
      "/api/attachments/:attachmentId": attachmentId, "/api/work-products/:id": workProductId,
      "/api/workspace-operations/:operationId": operationId, "/api/environment-leases/:leaseId": leaseId,
      "/api/tool-profile-entries/:entryId": profileEntryId, "/api/connection-intents/:interactionId": intentId,
      "/api/feedback-traces/:traceId": traceId, "/api/decision-training/:id": trainingId,
      "/api/invites/:inviteId": inviteId, "/api/decisions/:id": decisionId,
    };
    return Object.fromEntries(Object.entries(byPrefix).map(([prefix, recordId]) => [
      prefix, prefix.replace(/:[A-Za-z0-9_]+/, recordId).replace(/:companyId\b/, companyAId),
    ]));
  }

  it("lists the company routes from the router", () => {
    // ~360 today. A sharp drop means discovery broke, not that routes left.
    expect(routes.length).toBeGreaterThan(200);
  });

  it.each([agentKeyB, boardOwnerB])("lets company B's $name into company B", async (caller) => {
    const res = await call(caller, "GET", `/api/companies/${companyBId}/agents`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it.each([agentKeyB, boardOwnerB])("refuses company B's $name on every company A route", async (caller) => {
    expect(await sweep(caller, routes, (path) => fillPath(path, companyAId))).toEqual([]);
  }, 300_000);

  it("lists the id routes from the router", () => {
    // ~470 today. A sharp drop means discovery broke, not that routes left.
    expect(idRoutes.length).toBeGreaterThan(300);
  });

  it("classifies every id route as swept or allow-listed", () => {
    const prefixes = [...Object.keys(seeded), ...Object.keys(ID_ROUTES_NOT_SWEPT)];
    const unclassified = idRoutes
      .filter((route) => !prefixes.some((prefix) => matchesPrefix(route.path, prefix)))
      .map((route) => `${route.method} ${route.path}`);
    expect(unclassified, "seed the record in seedCompanyARecords or allow-list it with a reason").toEqual([]);
  });

  const sweptIdRoutes = () => idRoutes.filter((route) => Object.keys(seeded).some((prefix) => matchesPrefix(route.path, prefix)));

  it.each([agentKeyB, boardOwnerB])("refuses company B's $name on every company A id route", async (caller) => {
    const leaks = await sweep(caller, sweptIdRoutes(), (path) => fillIdPath(path, seeded, companyAId));
    expect(leaks.filter((leak) => !KNOWN_ID_ROUTE_LEAKS[leak.split(" -> ")[0]!])).toEqual([]);
  }, 300_000);

  it("still sees every known id route leak, so a fixed one is removed from the list", async () => {
    const leaks = (await sweep(boardOwnerB, sweptIdRoutes(), (path) => fillIdPath(path, seeded, companyAId)))
      .map((leak) => leak.split(" -> ")[0]);
    for (const key of Object.keys(KNOWN_ID_ROUTE_LEAKS)) {
      expect(leaks, `${key} now refuses; delete it from KNOWN_ID_ROUTE_LEAKS`).toContain(key);
    }
  }, 300_000);

  it("keeps every id allow-list entry pointed at a live route with a reason", () => {
    for (const [prefix, reason] of Object.entries(ID_ROUTES_NOT_SWEPT)) {
      expect(idRoutes.some((route) => matchesPrefix(route.path, prefix)), `stale allow-list entry: ${prefix}`).toBe(true);
      expect(reason.trim().length, `allow-list entry needs a reason: ${prefix}`).toBeGreaterThan(10);
    }
    const live = new Set(idRoutes.map((route) => `${route.method} ${route.path}`));
    for (const key of [...Object.keys(ID_ROUTES_EMPTY_ANSWER), ...Object.keys(KNOWN_ID_ROUTE_LEAKS)]) {
      expect(live.has(key), `stale entry: ${key}`).toBe(true);
    }
    for (const prefix of Object.keys(seeded)) {
      expect(idRoutes.some((route) => matchesPrefix(route.path, prefix)), `stale seeded prefix: ${prefix}`).toBe(true);
    }
  });

  // GRE-772: `/api/environments/:id/leases` takes an instance-wide environment
  // id, so the id sweep allow-lists it, and the list answers 200 with the
  // caller's own leases rather than refusing. This checks that answer instead.
  it("lists only company B's leases on a shared environment for company B's board session", async () => {
    const environmentId = randomUUID(), leaseAId = randomUUID(), leaseBId = randomUUID();
    await ctx.db.insert(environments).values({ id: environmentId, name: "Shared sandbox", driver: "ssh" });
    await ctx.db.insert(environmentLeases).values([
      { id: leaseAId, companyId: companyAId, environmentId },
      { id: leaseBId, companyId: companyBId, environmentId },
    ]);

    const res = await call(boardOwnerB, "GET", `/api/environments/${environmentId}/leases`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body as { id: string }[]).map((lease) => lease.id)).toEqual([leaseBId]);

    const asA = await call(boardOwnerB, "GET", `/api/environments/${environmentId}/leases?companyId=${companyAId}`);
    expect(REFUSED.has(asA.status), `company A leases by companyId -> ${asA.status}`).toBe(true);

    // Company A still gets its own lease from the same filter.
    const forA = await environmentService(ctx.db).listLeases(environmentId, { companyIds: [companyAId] });
    expect(forA.map((lease) => lease.id)).toEqual([leaseAId]);
  });

  it("keeps every allow-list entry pointed at a live route with a reason", () => {
    const live = new Set(routes.map((route) => `${route.method} ${route.path}`));
    for (const [key, reason] of Object.entries(ALLOWED_CROSS_COMPANY)) {
      expect(live.has(key), `stale allow-list entry: ${key}`).toBe(true);
      expect(reason.trim().length, `allow-list entry needs a reason: ${key}`).toBeGreaterThan(10);
    }
  });
});
