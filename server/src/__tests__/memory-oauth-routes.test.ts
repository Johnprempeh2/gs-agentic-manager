import { createHash } from "node:crypto";
import express from "express";
import request from "supertest";
import { expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agentApiKeys,
  agents,
  approvals,
  heartbeatRuns,
  memoryOperations,
  memoryScopes,
  memorySettings,
  principalPermissionGrants,
} from "@greatstone/db";
import { normalizeAgentApiKeyScope } from "@greatstone/shared";
import { errorHandler } from "../middleware/index.js";
import { memoryConnectionRoutes } from "../routes/memory-connections.js";
import {
  isAllowedRedirectUri,
  memoryMcpAuthChallenge,
  memoryOAuthApp,
  memoryOAuthConsentRoutes,
  memoryOAuthRoutes,
} from "../routes/memory-oauth.js";
import type { MemoryEngine } from "../services/memory-gateway/engine.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

const engine: MemoryEngine = {
  async retain() {},
  async recall() {
    return [];
  },
  async deleteDocument() {},
};

const signingKey = createHash("sha256").update("memory-oauth-test").digest();
const PUBLIC = "https://memory.example.com";
const CONSENT = "https://gsam.tailnet.example";
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const verifier = "a".repeat(43) + "-verifier";
const challenge = createHash("sha256").update(verifier).digest("base64url");

it("allows https redirects and http only on this machine", () => {
  expect(isAllowedRedirectUri(REDIRECT)).toBe(true);
  expect(isAllowedRedirectUri("http://localhost:6274/oauth/callback")).toBe(true);
  expect(isAllowedRedirectUri("http://evil.example/callback")).toBe(false);
  expect(isAllowedRedirectUri("https://chatgpt.com/cb#frag")).toBe(false);
  expect(isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
});

it("names the app from where it sends the browser back, never from its name", () => {
  expect(memoryOAuthApp([REDIRECT])).toBe("chatgpt");
  expect(memoryOAuthApp(["https://claude.ai/api/mcp/auth_callback"])).toBe("claude_ai");
  expect(memoryOAuthApp(["https://evil.example/cb"])).toBe("other");
  expect(memoryOAuthApp([REDIRECT, "https://evil.example/cb"])).toBe("other");
  expect(memoryOAuthApp(["https://chatgpt.com.evil.example/cb"])).toBe("other");
});

it("points a call without a key at the sign-in", async () => {
  const app = express();
  app.post("/api/mcp/memory-tools", (req, res) => memoryMcpAuthChallenge(req, res, PUBLIC));
  const res = await request(app).post("/api/mcp/memory-tools").send({});
  expect(res.status).toBe(401);
  expect(res.headers["www-authenticate"]).toBe(
    `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/api/mcp/memory-tools"`,
  );
});

describeEmbeddedPostgres("memory sign-in for ChatGPT and Claude.ai", () => {
  const ctx = useEmbeddedPostgres("gsam-memory-oauth-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(approvals);
      await db.delete(memoryOperations);
      await db.delete(memoryScopes);
      await db.delete(memorySettings);
      await db.delete(principalPermissionGrants);
      await db.delete(agentApiKeys);
      await db.delete(heartbeatRuns);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
    },
  });

  async function setup(name: string, settings: { enabled: boolean; appSignIn: boolean }, now = () => Date.now()) {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, name);
    await ctx.db.insert(memorySettings).values({ companyId: seeded.companyId, ...settings });
    const options = { engine, publicBaseUrl: PUBLIC, consentBaseUrl: CONSENT, signingKey, now };
    const publicApp = express();
    publicApp.use(express.json());
    publicApp.use(memoryOAuthRoutes(ctx.db, options));
    publicApp.use(errorHandler);
    const board = routeApp(ctx.db, seeded.actor, (db) => memoryOAuthConsentRoutes(db, options), (db) => memoryConnectionRoutes(db, { engine }));
    return { ...seeded, publicApp, board };
  }

  async function register(publicApp: express.Express, clientName = "ChatGPT") {
    const res = await request(publicApp).post("/oauth/memory/register").send({ client_name: clientName, redirect_uris: [REDIRECT] });
    expect(res.status).toBe(201);
    return res.body.client_id as string;
  }

  function approveBody(companyId: string, clientId: string, redirectUri = REDIRECT) {
    return { companyId, clientId, redirectUri, codeChallenge: challenge, codeChallengeMethod: "S256", state: "s1" };
  }

  function exchange(publicApp: express.Express, clientId: string, code: string) {
    return request(publicApp)
      .post("/oauth/memory/token")
      .type("form")
      .send({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
  }

  it("signs ChatGPT in end to end and hands it a memory-only key the Memory page can cut off", async () => {
    const { publicApp, board, companyId } = await setup("Sign in", { enabled: true, appSignIn: true });

    const resource = await request(publicApp).get("/.well-known/oauth-protected-resource/api/mcp/memory-tools");
    expect(resource.body).toMatchObject({ resource: `${PUBLIC}/api/mcp/memory-tools`, authorization_servers: [PUBLIC] });
    const server = await request(publicApp).get("/.well-known/oauth-authorization-server");
    expect(server.body).toMatchObject({
      token_endpoint: `${PUBLIC}/oauth/memory/token`,
      registration_endpoint: `${PUBLIC}/oauth/memory/register`,
      code_challenge_methods_supported: ["S256"],
    });

    const status = await request(board).get("/api/memory-oauth/status");
    expect(status.body).toEqual({ mcpUrl: `${PUBLIC}/api/mcp/memory-tools` });

    const clientId = await register(publicApp);
    const authorize = await request(publicApp).get("/oauth/memory/authorize").query({
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s1",
    });
    expect(authorize.status).toBe(302);
    // The consent screen can stay on the private address.
    expect(authorize.headers.location.startsWith(`${CONSENT}/memory/connect-app?`)).toBe(true);

    const shown = await request(board).get("/api/memory-oauth/client").query({ client_id: clientId, redirect_uri: REDIRECT });
    expect(shown.body).toEqual({ name: "ChatGPT", app: "chatgpt", redirectHost: "chatgpt.com" });

    const approved = await request(board).post("/api/memory-oauth/approve").send(approveBody(companyId, clientId));
    expect(approved.status).toBe(200);
    const back = new URL(approved.body.redirectTo);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("s1");
    const code = back.searchParams.get("code")!;

    const token = await exchange(publicApp, clientId, code);
    expect(token.status).toBe(200);
    expect(token.body).toMatchObject({ token_type: "Bearer", scope: "memory" });
    expect(token.headers["cache-control"]).toBe("no-store");

    const [agent] = await ctx.db.select().from(agents);
    expect(agent).toMatchObject({ companyId, status: "paused" });
    const [key] = await ctx.db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, agent.id));
    expect(normalizeAgentApiKeyScope(key.scopeConfig).kind).toBe("memory_only");

    // A code works once.
    expect((await exchange(publicApp, clientId, code)).body.error).toBe("invalid_grant");

    const listed = await request(board).get(`/api/companies/${companyId}/memory/connections`);
    expect(listed.body).toEqual([expect.objectContaining({ app: "chatgpt", agentId: agent.id })]);
    const actions = (await ctx.db.select().from(activityLog)).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["memory.connection_authorized", "memory.connection_created"]));
  });

  it("treats an app that only calls itself ChatGPT as an unknown app, read only unless allowed more", async () => {
    const { publicApp, board, companyId } = await setup("Impostor", { enabled: true, appSignIn: true });
    const res = await request(publicApp)
      .post("/oauth/memory/register")
      .send({ client_name: "ChatGPT", redirect_uris: ["https://evil.example/cb"] });
    const clientId = res.body.client_id as string;
    const shown = await request(board).get("/api/memory-oauth/client").query({ client_id: clientId, redirect_uri: "https://evil.example/cb" });
    expect(shown.body).toEqual({ name: "ChatGPT", app: "other", redirectHost: "evil.example" });
    const approved = await request(board).post("/api/memory-oauth/approve").send(approveBody(companyId, clientId, "https://evil.example/cb"));
    expect(approved.status).toBe(200);
    const [agent] = await ctx.db.select().from(agents);
    expect((agent.metadata as { memoryConnection: { app: string } }).memoryConnection.app).toBe("other");
    expect(await ctx.db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, agent.id))).toEqual([]);
  });

  it("offers no sign-in at all without a public address", async () => {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "No address");
    const app = express();
    app.use(memoryOAuthRoutes(ctx.db, { engine, signingKey }));
    expect((await request(app).get("/.well-known/oauth-authorization-server")).status).toBe(404);
    const board = routeApp(ctx.db, seeded.actor, (db) => memoryOAuthConsentRoutes(db, { engine, signingKey }));
    expect((await request(board).get("/api/memory-oauth/status")).status).toBe(404);
  });

  it("issues nothing while an owner has not turned on app sign-in", async () => {
    const { publicApp, board, companyId } = await setup("Off", { enabled: true, appSignIn: false });
    const clientId = await register(publicApp, "claudeai");
    const refused = await request(board).post("/api/memory-oauth/approve").send(approveBody(companyId, clientId));
    expect(refused.status).toBe(403);
    expect(await ctx.db.select().from(agents)).toEqual([]);
  });

  it("refuses a code once the switch is turned off, a wrong verifier and a forged client", async () => {
    let now = Date.now();
    const { publicApp, board, companyId } = await setup("Checks", { enabled: true, appSignIn: true }, () => now);
    const clientId = await register(publicApp, "claudeai");
    const approved = await request(board).post("/api/memory-oauth/approve").send(approveBody(companyId, clientId));
    const code = new URL(approved.body.redirectTo).searchParams.get("code")!;

    const wrongVerifier = await request(publicApp)
      .post("/oauth/memory/token")
      .type("form")
      .send({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: "b".repeat(43) });
    expect(wrongVerifier.body.error).toBe("invalid_grant");

    const otherClient = await register(publicApp, "Another app");
    expect((await exchange(publicApp, otherClient, code)).body.error).toBe("invalid_grant");

    await ctx.db.update(memorySettings).set({ appSignIn: false }).where(eq(memorySettings.companyId, companyId));
    expect((await exchange(publicApp, clientId, code)).body.error).toBe("access_denied");

    await ctx.db.update(memorySettings).set({ appSignIn: true }).where(eq(memorySettings.companyId, companyId));
    const later = await request(board).post("/api/memory-oauth/approve").send(approveBody(companyId, clientId));
    now += 6 * 60 * 1000;
    const expired = await exchange(publicApp, clientId, new URL(later.body.redirectTo).searchParams.get("code")!);
    expect(expired.body.error_description).toBe("The code has expired");

    const forged = await request(publicApp).get("/oauth/memory/authorize").query({ client_id: "abc.def", redirect_uri: REDIRECT });
    expect(forged.status).toBe(400);
    const badRedirect = await request(publicApp).post("/oauth/memory/register").send({ redirect_uris: ["http://evil.example/cb"] });
    expect(badRedirect.status).toBe(400);
    expect(await ctx.db.select().from(agentApiKeys)).toEqual([]);
  });
});
