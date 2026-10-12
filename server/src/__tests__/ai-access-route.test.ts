import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, createDb, issues } from "@greatstone/db";
import { AI_ACCESS_ROUTE_DEFINITIONS, type AiAccessRoute } from "@greatstone/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { applyAiAccessRoute } from "../services/ai-access-route.js";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";

// GRE-139: one instance setting switches the AI access route for every agent
// on the install, with no code change or rebuild. A route run uses only an
// account connected inside the install, never the host's own login.

const HOST_CLAUDE_TOKEN = "host-claude-oauth-token";
const HOST_ANTHROPIC_KEY = "host-anthropic-api-key";
const HOST_OPENAI_KEY = "host-openai-api-key";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-route-"));
  vi.stubEnv("GSAM_HOME", home);
  vi.stubEnv("GSAM_INSTANCE_ID", "ai-route");
  // The host's own logins. A route run must never reach them.
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", HOST_CLAUDE_TOKEN);
  vi.stubEnv("ANTHROPIC_API_KEY", HOST_ANTHROPIC_KEY);
  vi.stubEnv("OPENAI_API_KEY", HOST_OPENAI_KEY);
  database = await startEmbeddedPostgresTestDatabase("paperclip-ai-route-db-");
  db = createDb(database.connectionString);
}, 90_000);

afterEach(async () => {
  await instanceSettingsService(db).updateGeneral({ aiAccessRoute: null });
});

afterAll(async () => {
  await database?.cleanup();
  vi.unstubAllEnvs();
  if (home) await rm(home, { recursive: true, force: true });
});

/** An agent like the ones on an install today: Claude harness, host login, a Claude model. */
async function install() {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const userId = `owner-${companyId}`;
  await db.insert(companies).values({ id: companyId, name: "Route test", issuePrefix: `R${companyId.slice(0, 7)}`, defaultResponsibleUserId: userId });
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
  await db.insert(agents).values({
    id: agentId, companyId, name: "Engineer", role: "engineer", adapterType: "claude_local",
    adapterConfig: {
      cwd: home, engine: "cli", model: "claude-model-for-this-agent", dangerouslySkipPermissions: true,
      env: { ANTHROPIC_API_KEY: { type: "plain", value: HOST_ANTHROPIC_KEY } },
    },
    runtimeConfig: { heartbeat: { enabled: false } },
  });
  return { companyId, agentId, userId };
}

function credentialFor(route: AiAccessRoute) {
  const { provider, method } = AI_ACCESS_ROUTE_DEFINITIONS[route];
  if (method === "api_key") return `client-${route}-key`;
  return provider === "anthropic"
    ? "client-claude-seat-token"
    : JSON.stringify({ tokens: { access_token: "client-access", refresh_token: "client-refresh", id_token: "client-id", account_id: "client-account" } });
}

async function connect(f: Awaited<ReturnType<typeof install>>, route: AiAccessRoute, ownership: "personal" | "shared" = "personal") {
  const { provider, method } = AI_ACCESS_ROUTE_DEFINITIONS[route];
  const credential = credentialFor(route);
  const account = await aiConnectionService(db).save(f.companyId, f.userId, {
    provider, method, name: `Client ${route}`, ownership, agentIds: ownership === "personal" ? [f.agentId] : [], allAgents: ownership === "shared",
    ...(method === "api_key" ? { apiKey: credential } : { loginSessionId: "fixture" }),
  }, credential);
  return { ...account, credential };
}

type Seen = { adapterType: string; config: Record<string, unknown>; env: Record<string, string>; codexAuth: string | null };

/** Run one task on the agent and record what the harness received. */
async function runTask(f: Awaited<ReturnType<typeof install>>, failWith?: { errorCode: string; errorMessage: string }) {
  const seen: Seen[] = [];
  const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Route task", status: "todo", assigneeAgentId: f.agentId, responsibleUserId: f.userId, createdByUserId: f.userId }).returning();
  for (const adapterType of ["claude_local", "codex_local"]) {
    registerServerAdapter({
      ...getServerAdapter(adapterType),
      execute: vi.fn(async (ctx) => {
        const config = ctx.config as Record<string, unknown>;
        const env = (config.env ?? {}) as Record<string, string>;
        const codexAuth = env.CODEX_HOME ? await readFile(path.join(env.CODEX_HOME, "auth.json"), "utf8").catch(() => null) : null;
        seen.push({ adapterType, config, env, codexAuth });
        if (failWith) return { exitCode: 1, signal: null, timedOut: false, ...failWith, resultJson: {} };
        await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, issue!.id));
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      }),
    });
  }
  const heartbeat = heartbeatService(db);
  try {
    const run = await heartbeat.invoke(f.agentId, "assignment", { issueId: issue!.id, wakeReason: "issue_assigned", responsibleUserId: f.userId }, "system");
    expect(run).not.toBeNull();
    await expect.poll(async () => (await heartbeat.getRun(run!.id))?.status, { timeout: 20_000 }).toMatch(/^(succeeded|failed)$/);
    return { run: (await heartbeat.getRun(run!.id))!, seen };
  } finally {
    await heartbeat.drainActiveRunExecutions();
    unregisterServerAdapter("claude_local");
    unregisterServerAdapter("codex_local");
  }
}

function expectNoHostCredential(env: Record<string, string>) {
  for (const value of Object.values(env)) {
    expect(value).not.toBe(HOST_CLAUDE_TOKEN);
    expect(value).not.toBe(HOST_ANTHROPIC_KEY);
    expect(value).not.toBe(HOST_OPENAI_KEY);
  }
}

describe("install-wide AI access route (GRE-139)", () => {
  it.each(["claude_subscription", "claude_api_key", "codex_subscription", "codex_api_key"] as const)(
    "switching the setting to %s runs every agent on that route with the client's own account",
    async (route) => {
      const f = await install();
      const account = await connect(f, route);
      await instanceSettingsService(db).updateGeneral({ aiAccessRoute: route });

      const { run, seen } = await runTask(f);
      expect(run.status, run.error ?? "").toBe("succeeded");
      const definition = AI_ACCESS_ROUTE_DEFINITIONS[route];
      expect(seen.map((s) => s.adapterType)).toEqual([definition.adapterType]);
      expect(run.contextSnapshot?.aiConnection).toMatchObject({ connectionId: account.connectionId, method: definition.method, responsibleUserId: f.userId });

      const [{ env, config, codexAuth }] = seen;
      if (route === "claude_subscription") expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(account.credential);
      if (route === "claude_api_key") expect(env.ANTHROPIC_API_KEY).toBe(account.credential);
      if (route === "codex_subscription") expect(codexAuth).toBe(account.credential);
      if (route === "codex_api_key") expect(env.OPENAI_API_KEY).toBe(account.credential);
      expectNoHostCredential(env);
      // A Claude model or flag would break a Codex run; the shared settings stay.
      if (definition.adapterType === "codex_local") {
        expect(config.model).toBeUndefined();
        expect(config.dangerouslySkipPermissions).toBeUndefined();
      } else {
        expect(config.model).toBe("claude-model-for-this-agent");
      }
      expect(config.cwd).toBe(home);

      // The stored agent is untouched, so clearing the setting restores it.
      const [stored] = await db.select().from(agents).where(eq(agents.id, f.agentId));
      expect(stored!.adapterType).toBe("claude_local");
      expect(stored!.runtimeConfig.aiConnection).toBeUndefined();
    },
    60_000,
  );

  it.each(["claude_subscription", "claude_api_key", "codex_subscription"] as const)(
    "fails clearly on %s when no account is connected, and never falls back to the host login",
    async (route) => {
      const f = await install();
      await instanceSettingsService(db).updateGeneral({ aiAccessRoute: route });

      const { run, seen } = await runTask(f);
      expect(seen).toEqual([]);
      expect(run.status).toBe("failed");
      expect(run.errorCode).toBe("configuration_incomplete");
      expect(run.error).toContain(`This install uses ${AI_ACCESS_ROUTE_DEFINITIONS[route].label} for AI access.`);
    },
    60_000,
  );

  it("uses a company-shared account when the member has no personal one", async () => {
    const f = await install();
    const shared = await connect(f, "claude_api_key", "shared");
    await instanceSettingsService(db).updateGeneral({ aiAccessRoute: "claude_api_key" });

    const { run, seen } = await runTask(f);
    expect(run.status, run.error ?? "").toBe("succeeded");
    expect(run.contextSnapshot?.aiConnection).toMatchObject({ connectionId: shared.connectionId, mode: "shared" });
    expect(seen[0]!.env.ANTHROPIC_API_KEY).toBe(shared.credential);
  }, 60_000);

  it("does not run a key route on a seat login, or the reverse", async () => {
    const f = await install();
    await connect(f, "claude_subscription");
    await instanceSettingsService(db).updateGeneral({ aiAccessRoute: "claude_api_key" });

    const { run, seen } = await runTask(f);
    expect(seen).toEqual([]);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("This install uses Claude API key for AI access.");
  }, 60_000);

  // GRE-15 warnings: a login the provider rejects marks the connection as
  // needing attention, which the Inbox and connection page show, on every route.
  it.each([
    ["claude_subscription", "claude_auth_required"],
    ["claude_api_key", "claude_auth_required"],
    ["codex_subscription", "refresh_token_expired"],
    ["codex_subscription", "refresh_token_invalidated"],
    ["codex_api_key", "codex_auth_required"],
  ] as const)("flags the %s account when a run fails with %s", async (route, errorCode) => {
    const f = await install();
    const account = await connect(f, route);
    await instanceSettingsService(db).updateGeneral({ aiAccessRoute: route });

    const { run } = await runTask(f, { errorCode, errorMessage: "The provider rejected the login." });
    expect(run.status).toBe("failed");
    const [summary] = (await aiConnectionService(db).list(f.companyId, f.userId)).filter((a) => a.id === account.connectionId);
    expect(summary?.status).toBe("needs_attention");
  }, 60_000);

  it("leaves agents on their own harness and login when the setting is cleared", async () => {
    const f = await install();
    await connect(f, "codex_subscription");
    await instanceSettingsService(db).updateGeneral({ aiAccessRoute: "codex_subscription" });
    await instanceSettingsService(db).updateGeneral({ aiAccessRoute: null });

    const { run, seen } = await runTask(f);
    expect(run.status, run.error ?? "").toBe("succeeded");
    expect(seen.map((s) => s.adapterType)).toEqual(["claude_local"]);
    expect(seen[0]!.config.model).toBe("claude-model-for-this-agent");
    expect(run.contextSnapshot?.aiConnection).toBeUndefined();
  }, 60_000);
});

describe("applyAiAccessRoute", () => {
  const agent = { adapterType: "claude_local", adapterConfig: { cwd: "/w", model: "m", command: "claude", instructionsFilePath: "/i.md" }, runtimeConfig: { heartbeat: { enabled: true } } };

  it("is a no-op without a route and for other harnesses", () => {
    expect(applyAiAccessRoute(agent, null)).toBe(agent);
    const other = { ...agent, adapterType: "opencode_local" };
    expect(applyAiAccessRoute(other, "codex_subscription")).toBe(other);
  });

  it("switches harness, drops harness-only keys, and binds the route's account type", () => {
    const routed = applyAiAccessRoute(agent, "codex_subscription");
    expect(routed.adapterType).toBe("codex_local");
    expect(routed.adapterConfig).toEqual({ cwd: "/w", instructionsFilePath: "/i.md" });
    expect(routed.runtimeConfig).toEqual({
      heartbeat: { enabled: true },
      aiConnection: { provider: "openai", method: "subscription", mode: "responsible_user" },
      aiAccessRoute: "codex_subscription",
    });
    expect(agent.adapterType).toBe("claude_local");
  });

  it("keeps the agent's own model on its own harness", () => {
    expect(applyAiAccessRoute(agent, "claude_api_key").adapterConfig).toBe(agent.adapterConfig);
  });
});
