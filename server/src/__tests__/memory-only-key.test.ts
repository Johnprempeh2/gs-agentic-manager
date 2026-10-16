import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agentApiKeys, agents, agentWakeupRequests, authUsers, companies, companyMemberships, heartbeatRuns, memorySettings,
  principalPermissionGrants, projects,
} from "@greatstone/db";
import { createApp } from "../app.js";
import { isMemoryPath } from "../middleware/memory-only-key-guard.js";
import { OWNER_OR_ADMIN_REQUIRED_CODE } from "../routes/authz.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { describeEmbeddedPostgres, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

/**
 * GRE-958: John's Claude and Codex hold a `memory_only` agent key. On the real
 * app it reaches the organization memory routes and is refused everywhere
 * else; the routes are listed from the router, so a new route is covered
 * without editing this file. Only a company owner or admin mints or revokes
 * such a key, and the key never wakes its paused agent.
 */

// Routes that never read an agent key: they run before the actor is resolved
// and take their own token, or the actor middleware skips them on purpose.
// The key is just an unknown bearer there, so the answer is still a refusal.
const ROUTES_WITHOUT_AGENT_KEY: Record<string, string> = {
  "/runtime-tools/": "Run-bound runtime capability token, mounted before the actor middleware.",
  "/mcp/runtime-tools": "Run-bound runtime capability token, mounted before the actor middleware.",
  "/connection-intents/": "Run-bound runtime capability token, mounted before the actor middleware.",
  "/api/routine-triggers/public/": "Public routine webhook; the trigger secret is the credential.",
  "/mcp/gateways/": "MCP gateway protocol; the gateway token is the credential.",
};

type RouteLayer = {
  route?: { path: unknown; methods: Record<string, boolean> };
  handle?: { stack?: RouteLayer[] };
  __mountPath?: string;
};

const routerProto = (express.Router as unknown as { prototype: { use: (...args: unknown[]) => unknown } }).prototype;
const originalUse = routerProto.use;

// Express 5 does not keep the mount path on a router layer; record it.
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
    .replace(/:([A-Za-z0-9_]+)/g, () => randomUUID());
}

describe("isMemoryPath", () => {
  it("allows the company memory routes and the memory MCP endpoint", () => {
    expect(isMemoryPath("/api/companies/c1/memory")).toBe(true);
    expect(isMemoryPath("/api/companies/c1/memory/records/r1/review")).toBe(true);
    expect(isMemoryPath("/api/mcp/memory-tools")).toBe(true);
  });

  it("refuses look-alike, dotted and encoded paths", () => {
    expect(isMemoryPath("/api/companies/c1/memoryx")).toBe(false);
    expect(isMemoryPath("/api/companies/c1/issues")).toBe(false);
    expect(isMemoryPath("/api/companies/c1/memory/../../agents/a1")).toBe(false);
    expect(isMemoryPath("/api/companies/c1/memory/%2e%2e/agents")).toBe(false);
    expect(isMemoryPath("/api/companies/c1%2Fx/memory")).toBe(false);
    expect(isMemoryPath("/api/mcp/memory-tools/extra")).toBe(false);
    expect(isMemoryPath("/memory/companies/c1/memory")).toBe(false);
  });
});

describeEmbeddedPostgres("memory_only agent keys (GRE-958)", () => {
  let app: express.Express | undefined;
  let root: string | undefined;
  // Registered before the database hooks so the app's loops stop first.
  afterAll(async () => {
    await (app?.locals.paperclipShutdown as (() => Promise<void>) | undefined)?.();
    if (root) await rm(root, { recursive: true, force: true });
  });
  const ctx = useEmbeddedPostgres("gsam-memory-only-key-");
  let routes: { method: string; path: string }[] = [];
  const companyId = randomUUID();
  const ownerId = `user-${randomUUID()}`;
  const operatorId = `user-${randomUUID()}`;
  const claudeId = randomUUID();
  const sharedId = randomUUID();
  const workerId = randomUUID();
  const memoryToken = `pcp_memonly_${randomBytes(24).toString("hex")}`;
  const sharedToken = `pcp_shared_${randomBytes(24).toString("hex")}`;
  const workerToken = `pcp_worker_${randomBytes(24).toString("hex")}`;
  const SESSION_HEADER = "x-test-session";

  const asMemoryKey = { Authorization: `Bearer ${memoryToken}` };
  const asSharedKey = { Authorization: `Bearer ${sharedToken}` };
  const asWorker = { Authorization: `Bearer ${workerToken}` };
  const asOwner = { [SESSION_HEADER]: ownerId, Origin: "http://127.0.0.1" };
  const asOperator = { [SESSION_HEADER]: operatorId, Origin: "http://127.0.0.1" };

  function call(headers: Record<string, string>, method: string, url: string, body?: unknown) {
    let req = request(app!)[method.toLowerCase() as "get"](url).set("Host", "127.0.0.1").timeout(10_000);
    for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
    if (!["GET", "HEAD", "DELETE"].includes(method)) req = req.send((body ?? {}) as object);
    return req;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "gsam-memory-only-key-"));
    recordMountPaths();
    try {
      app = await createApp(ctx.db, {
        uiMode: "none", serverPort: 0,
        storageService: createStorageService(createLocalDiskStorageProvider(join(root, "storage"))),
        deploymentMode: "authenticated", deploymentExposure: "private",
        allowedHostnames: ["127.0.0.1"], bindHost: "127.0.0.1", authReady: true,
        companyDeletionEnabled: true, instanceId: `memory-only-${randomUUID()}`,
        localPluginDir: join(root, "plugins"), managedPluginAutoInstall: [],
        decisionServiceOptions: { wakeOriginAgent: async () => undefined },
        resolveSession: async (req) => {
          const userId = req.header(SESSION_HEADER);
          return userId === ownerId || userId === operatorId
            ? { session: { id: `session-${userId}`, userId }, user: { id: userId, name: userId, email: null } }
            : null;
        },
      });
    } finally {
      routerProto.use = originalUse;
    }
    routes = listRoutes((app as unknown as { router: { stack: RouteLayer[] } }).router.stack);

    await ctx.db.insert(companies).values({
      id: companyId, name: "Memory key company", issuePrefix: `M${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    for (const [userId, role] of [[ownerId, "owner"], [operatorId, "operator"]] as const) {
      await ctx.db.insert(authUsers).values({
        id: userId, name: userId, email: `${userId}@memory-only.invalid`,
        emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
      });
      await ctx.db.insert(companyMemberships).values({
        companyId, principalType: "user", principalId: userId, status: "active", membershipRole: role, updatedAt: new Date(),
      });
      await ensureHumanRoleDefaultGrants(ctx.db, { companyId, principalId: userId, membershipRole: role, grantedByUserId: null });
    }
    // The operator may manage agents, so a refusal below comes from the
    // owner-only rule for memory keys and not from a missing permission.
    await ctx.db.insert(principalPermissionGrants).values({
      companyId, principalType: "user", principalId: operatorId, permissionKey: "agents:create", grantedByUserId: ownerId,
    }).onConflictDoNothing();
    await ctx.db.insert(agents).values([
      {
        id: claudeId, companyId, name: "John's Claude", role: "general", adapterType: "process",
        adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false } }, permissions: {}, status: "paused",
        // John's own app link (GRE-1081): a memory key belongs to one person.
        metadata: { memoryConnection: { app: "claude", createdByUserId: ownerId } },
      },
      {
        // The old shared memory key: a paused agent tied to nobody.
        id: sharedId, companyId, name: "Shared memory key", role: "general", adapterType: "process",
        adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false } }, permissions: {}, status: "paused",
      },
      {
        id: workerId, companyId, name: "Worker", role: "ceo", adapterType: "process",
        adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false } }, permissions: { canCreateAgents: true }, status: "active",
      },
    ]);
    await ctx.db.insert(agentApiKeys).values([
      {
        agentId: claudeId, companyId, name: "claude-memory", responsibleUserId: ownerId,
        keyHash: createHash("sha256").update(memoryToken).digest("hex"), scopeConfig: { kind: "memory_only" },
      },
      {
        agentId: sharedId, companyId, name: "shared-memory", responsibleUserId: ownerId,
        keyHash: createHash("sha256").update(sharedToken).digest("hex"), scopeConfig: { kind: "memory_only" },
      },
      {
        agentId: workerId, companyId, name: "worker", responsibleUserId: ownerId,
        keyHash: createHash("sha256").update(workerToken).digest("hex"),
      },
    ]);
    await ctx.db.insert(memorySettings).values({ companyId, enabled: true });
  }, 60_000);

  it("is refused on every route that is not organization memory", async () => {
    const leaks: string[] = [];
    let swept = 0;
    for (const route of routes) {
      const url = fillPath(route.path, companyId);
      if (isMemoryPath(url)) continue;
      const exempt = Object.keys(ROUTES_WITHOUT_AGENT_KEY).some((prefix) => route.path.startsWith(prefix));
      const key = `${route.method} ${route.path}`;
      let status: number | string;
      let code: unknown;
      try {
        const res = await call(asMemoryKey, route.method, url);
        status = res.status;
        code = res.body?.details?.code;
      } catch (error) {
        status = `error: ${(error as Error).message}`;
      }
      swept += 1;
      if (exempt) {
        if (typeof status !== "number" || status < 400) leaks.push(`${key} -> ${status} (no agent key here)`);
      } else if (status !== 403 || code !== "MEMORY_ONLY_KEY") {
        leaks.push(`${key} -> ${status} ${String(code ?? "")}`);
      }
    }
    expect(swept).toBeGreaterThan(200);
    expect(leaks).toEqual([]);
  }, 600_000);

  it("reaches the memory REST routes and the memory MCP endpoint", async () => {
    const settings = await call(asMemoryKey, "GET", `/api/companies/${companyId}/memory/settings`);
    expect(settings.status).toBe(200);
    expect(settings.body).toMatchObject({ enabled: true });

    const tools = await call(asMemoryKey, "POST", "/api/mcp/memory-tools", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(tools.status).toBe(200);
    expect(tools.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(
      expect.arrayContaining(["memory_recall", "memory_contribute", "memory_get"]),
    );

    // A run key without a run is still refused on the MCP endpoint.
    const worker = await call(asWorker, "POST", "/api/mcp/memory-tools", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(worker.status).toBe(403);
  });

  it("is refused on another company's memory routes", async () => {
    const res = await call(asMemoryKey, "GET", `/api/companies/${randomUUID()}/memory/settings`);
    expect(res.status).toBe(403);
  });

  it("never wakes or runs its paused agent", async () => {
    for (const path of [`/api/agents/${claudeId}/wakeup`, `/api/agents/${claudeId}/heartbeat/invoke`]) {
      const res = await call(asMemoryKey, "POST", path, { source: "on_demand", reason: "test" });
      expect(res.status).toBe(403);
      expect(res.body.details?.code).toBe("MEMORY_ONLY_KEY");
    }
    await call(asMemoryKey, "POST", "/api/mcp/memory-tools", { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(await ctx.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, claudeId))).toEqual([]);
    expect(await ctx.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, claudeId))).toEqual([]);
    const [agent] = await ctx.db.select().from(agents).where(eq(agents.id, claudeId));
    expect(agent?.status).toBe("paused");
  });

  it("only an owner or admin creates or revokes a memory_only key, and only for a paused agent", async () => {
    const body = { name: "codex-memory", scope: { kind: "memory_only" } };

    const byAgent = await call(asWorker, "POST", `/api/agents/${claudeId}/keys`, body);
    expect(byAgent.status).toBe(403);

    const byOperator = await call(asOperator, "POST", `/api/agents/${claudeId}/keys`, body);
    expect(byOperator.status).toBe(403);
    expect(byOperator.body.details?.code).toBe(OWNER_OR_ADMIN_REQUIRED_CODE);

    // The operator may still mint an ordinary key, so the refusal above is the
    // memory_only rule.
    const standard = await call(asOperator, "POST", `/api/agents/${workerId}/keys`, { name: "ordinary" });
    expect(standard.status).toBe(201);

    const forActiveAgent = await call(asOwner, "POST", `/api/agents/${workerId}/keys`, body);
    expect(forActiveAgent.status).toBe(409);
    // GRE-1081: no new shared key on an agent that is not one person's app link.
    const forSharedAgent = await call(asOwner, "POST", `/api/agents/${sharedId}/keys`, body);
    expect(forSharedAgent.status).toBe(409);

    const created = await call(asOwner, "POST", `/api/agents/${claudeId}/keys`, body);
    expect(created.status).toBe(201);
    expect(created.body.scope).toEqual({ kind: "memory_only" });
    expect(created.body.responsibleUserId).toBe(ownerId);

    const minted = await call({ Authorization: `Bearer ${created.body.token}` }, "GET", `/api/agents/${claudeId}`);
    expect(minted.status).toBe(403);
    expect(minted.body.details?.code).toBe("MEMORY_ONLY_KEY");

    const revokeByOperator = await call(asOperator, "DELETE", `/api/agents/${claudeId}/keys/${created.body.id}`);
    expect(revokeByOperator.status).toBe(403);
    const revokeByAgent = await call(asWorker, "DELETE", `/api/agents/${claudeId}/keys/${created.body.id}`);
    expect(revokeByAgent.status).toBe(403);

    const revoked = await call(asOwner, "DELETE", `/api/agents/${claudeId}/keys/${created.body.id}`);
    expect(revoked.status).toBe(200);
    const afterRevoke = await call({ Authorization: `Bearer ${created.body.token}` }, "GET", `/api/companies/${companyId}/memory/settings`);
    expect(afterRevoke.status).toBe(401);
  });

  // Shared memory M2 (GRE-1081, deck v7 slide 22).

  const mcp = (headers: Record<string, string>, method: string, params?: Record<string, unknown>) =>
    call(headers, "POST", "/api/mcp/memory-tools", { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) });
  const tool = (headers: Record<string, string>, name: string, args: Record<string, unknown>) =>
    mcp(headers, "tools/call", { name, arguments: args });

  it("refuses the old shared key: a memory key must belong to one person", async () => {
    for (const res of [
      await call(asSharedKey, "GET", `/api/companies/${companyId}/memory/settings`),
      await mcp(asSharedKey, "tools/list"),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.details?.code).toBe("MEMORY_KEY_NOT_LINKED");
    }
  });

  it("gives each person their own key; revoking one, or removing the person, cuts that app off on its next call", async () => {
    const connections = `/api/companies/${companyId}/memory/connections`;
    const owners = await call(asOwner, "POST", connections, { app: "claude_code" });
    const operators = await call(asOperator, "POST", connections, { app: "claude_code" });
    expect(owners.status).toBe(201);
    expect(operators.status).toBe(201);
    expect(operators.body.connection.agentId).not.toBe(owners.body.connection.agentId);
    const asOwnersApp = { Authorization: `Bearer ${owners.body.token}` };
    const asOperatorsApp = { Authorization: `Bearer ${operators.body.token}` };
    const settings = `/api/companies/${companyId}/memory/settings`;
    expect((await call(asOwnersApp, "GET", settings)).status).toBe(200);
    expect((await call(asOperatorsApp, "GET", settings)).status).toBe(200);

    // The operator cuts off their own app; the owner's app keeps working.
    expect((await call(asOperator, "DELETE", `${connections}/${operators.body.connection.agentId}`)).status).toBe(200);
    expect((await call(asOperatorsApp, "GET", settings)).status).toBe(401);
    expect((await call(asOwnersApp, "GET", settings)).status).toBe(200);

    // A person who leaves the company takes their apps with them.
    const codex = await call(asOperator, "POST", connections, { app: "codex" });
    const asCodex = { Authorization: `Bearer ${codex.body.token}` };
    expect((await call(asCodex, "GET", settings)).status).toBe(200);
    const operatorMembership = and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, operatorId));
    await ctx.db.update(companyMemberships).set({ status: "suspended" }).where(operatorMembership);
    try {
      const cut = await call(asCodex, "GET", settings);
      expect(cut.status).toBe(403);
      expect(cut.body.details?.code).toBe("MEMORY_KEY_NOT_LINKED");
    } finally {
      await ctx.db.update(companyMemberships).set({ status: "active" }).where(operatorMembership);
    }
  });

  it("an app reads and proposes only, and every versioned write at a stale version is refused", async () => {
    const tools = await mcp(asMemoryKey, "tools/list");
    const names = tools.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["memory_recall", "memory_contribute", "memory_get", "memory_history", "memory_revise"]));
    for (const reviewerTool of ["memory_confirm", "memory_dispute", "memory_retire"]) expect(names).not.toContain(reviewerTool);

    await ctx.db.insert(principalPermissionGrants).values({
      companyId, principalType: "agent", principalId: claudeId, permissionKey: "memory:contribute", grantedByUserId: ownerId,
    }).onConflictDoNothing();
    const proposed = await tool(asMemoryKey, "memory_contribute", { scope: "organization", content: "Invoices go out on the 1st." });
    expect(proposed.body.result.isError).toBeUndefined();
    const card = proposed.body.result.structuredContent.record as { id: string; version: number; status: string };
    expect(card).toMatchObject({ status: "unreviewed", version: 1 });

    // Calling the reviewer tools anyway is refused by the gateway, and nothing changes.
    for (const name of ["memory_confirm", "memory_dispute", "memory_retire"]) {
      const res = await tool(asMemoryKey, name, { recordId: card.id, expectedVersion: 1, reason: "From my app" });
      expect(res.body.result.isError).toBe(true);
      expect(res.body.result.content[0].text).toMatch(/read and propose only/);
    }
    const records = `/api/companies/${companyId}/memory/records/${card.id}`;
    expect((await call(asOwner, "GET", records)).body).toMatchObject({ status: "unreviewed", version: 1 });

    // The person confirms in GSAM; the confirmed card moves to version 2.
    const approved = await call(asOwner, "POST", `${records}/review`, { action: "approve", reason: "Checked", expectedVersion: 1 });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ status: "approved", version: 2 });

    // The app revises from what it read before the confirm: refused, nothing saved.
    const stale = await tool(asMemoryKey, "memory_revise", { recordId: card.id, expectedVersion: 1, content: "Invoices go out on the 2nd.", reason: "Moved" });
    expect(stale.body.result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/changed since you read it/) }] });

    // At the current version the revision is a proposal; the confirmed card stays in force.
    const revised = await tool(asMemoryKey, "memory_revise", { recordId: card.id, expectedVersion: 2, content: "Invoices go out on the 2nd.", reason: "Moved" });
    expect(revised.body.result.isError).toBeUndefined();
    expect(revised.body.result.structuredContent).toMatchObject({
      record: { id: card.id, status: "approved", version: 2 },
      newRecord: { status: "unreviewed", version: 3 },
    });

    // Retire and dispute in GSAM check the version too.
    expect((await call(asOwner, "POST", `${records}/retire`, { expectedVersion: 1, reason: "Old" })).status).toBe(409);
    expect((await call(asOwner, "POST", `${records}/review`, { action: "dispute", reason: "Old", expectedVersion: 1 })).status).toBe(409);

    // John confirms the revision his own app proposed; it replaces the card.
    const revision = `/api/companies/${companyId}/memory/records/${revised.body.result.structuredContent.newRecord.id}`;
    const confirmed = await call(asOwner, "POST", `${revision}/steward-action`, { action: "confirm", expectedVersion: 3, reason: "Checked" });
    expect(confirmed.status).toBe(200);
    const current = (await call(asOwner, "GET", revision)).body as { status: string; version: number };
    expect(current.status).toBe("approved");
    // The confirm moved the version on for good: a call made at the version seen before it is refused.
    expect(current.version).toBeGreaterThan(3);
    expect((await call(asOwner, "POST", `${revision}/review`, { action: "dispute", reason: "Stale", expectedVersion: 3 })).status).toBe(409);
    expect((await call(asOwner, "GET", records)).body).toMatchObject({ status: "superseded" });

    const retired = await call(asOwner, "POST", `${revision}/retire`, { expectedVersion: current.version, reason: "No longer true" });
    expect(retired.status).toBe(200);
    expect(retired.body).toMatchObject({ status: "retired", version: current.version + 1 });
  });

  it("keeps client and restricted scopes off for an app, even when its person can read them", async () => {
    const scopes = `/api/companies/${companyId}/memory/scopes`;
    const [project] = await ctx.db.insert(projects).values({ companyId, name: "Kestrel bid", leadAgentId: workerId }).returning();
    for (const kind of ["client", "restricted_project"] as const) {
      const scope = await call(asOwner, "POST", scopes, { kind, name: `Kestrel ${kind}`, ...(kind === "restricted_project" ? { projectId: project!.id } : {}) });
      expect(scope.status).toBe(201);
      const added = await call(asOwner, "POST", `/api/companies/${companyId}/memory/records`, { scopeId: scope.body.id, content: `Kestrel terms (${kind}).`, topics: ["kestrel terms"] });
      expect(added.status).toBe(201);
      const recordId = added.body.record.id as string;
      expect((await call(asOwner, "GET", `/api/companies/${companyId}/memory/records/${recordId}`)).status).toBe(200);

      const got = await tool(asMemoryKey, "memory_get", { recordId });
      expect(got.body.result.isError).toBe(true);
      const write = await tool(asMemoryKey, "memory_contribute", { scope: scope.body.id, content: "From my app.", topics: ["kestrel terms"] });
      expect(write.body.result.isError).toBe(true);
    }
  });
});
