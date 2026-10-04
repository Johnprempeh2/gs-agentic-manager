import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { agentApiKeys, agents, authUsers, companies, companyMemberships } from "@greatstone/db";
import { createApp } from "../app.js";
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
const ALLOWED_CROSS_COMPANY: Record<string, string> = {
  // GRE-505 follow-up issue asks whether these should check the company too.
  "GET /api/companies/:companyId/environments":
    "Environments are instance-wide: the list ignores :companyId, returns the same redacted rows for any id, and holds no company data.",
  "GET /api/companies/:companyId/environments/capabilities":
    "Static adapter and sandbox driver capabilities for the instance; ignores :companyId and holds no company data.",
};

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
};

// Path params that must name something real before the company check runs.
const PARAM_VALUES: Record<string, string> = { type: "process" };

const REFUSED = new Set([403, 404]);
const COMPANY_PREFIX = /^\/api\/companies\/:companyId(?:\/|$)/;

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

  async function sweep(caller: Caller) {
    const leaks: string[] = [];
    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      if (ALLOWED_CROSS_COMPANY[key]) continue;
      let status: number | string;
      try {
        status = (await call(caller, route.method, fillPath(route.path, companyAId), REQUEST_BODIES[key])).status;
      } catch (error) {
        status = (error as { status?: number }).status ?? `error: ${(error as Error).message}`;
      }
      if (typeof status !== "number" || !REFUSED.has(status)) leaks.push(`${key} -> ${status}`);
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
    routes = listRoutes((app as unknown as { router: { stack: RouteLayer[] } }).router.stack)
      .filter((route) => COMPANY_PREFIX.test(route.path));

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
  }, 60_000);

  it("lists the company routes from the router", () => {
    // ~360 today. A sharp drop means discovery broke, not that routes left.
    expect(routes.length).toBeGreaterThan(200);
  });

  it.each([agentKeyB, boardOwnerB])("lets company B's $name into company B", async (caller) => {
    const res = await call(caller, "GET", `/api/companies/${companyBId}/agents`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it.each([agentKeyB, boardOwnerB])("refuses company B's $name on every company A route", async (caller) => {
    expect(await sweep(caller)).toEqual([]);
  }, 300_000);

  it("keeps every allow-list entry pointed at a live route with a reason", () => {
    const live = new Set(routes.map((route) => `${route.method} ${route.path}`));
    for (const [key, reason] of Object.entries(ALLOWED_CROSS_COMPANY)) {
      expect(live.has(key), `stale allow-list entry: ${key}`).toBe(true);
      expect(reason.trim().length, `allow-list entry needs a reason: ${key}`).toBeGreaterThan(10);
    }
  });
});
