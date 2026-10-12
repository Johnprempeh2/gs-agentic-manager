import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentApiKeys, agents, agentWakeupRequests, authUsers, companies, companyMemberships, heartbeatRuns, memorySettings,
  principalPermissionGrants,
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
  const workerId = randomUUID();
  const memoryToken = `pcp_memonly_${randomBytes(24).toString("hex")}`;
  const workerToken = `pcp_worker_${randomBytes(24).toString("hex")}`;
  const SESSION_HEADER = "x-test-session";

  const asMemoryKey = { Authorization: `Bearer ${memoryToken}` };
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
});
