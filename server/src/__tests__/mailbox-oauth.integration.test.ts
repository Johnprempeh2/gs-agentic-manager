import express from "express";
import request from "supertest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companySecrets,
  companySecretVersions,
  createDb,
  heartbeatRuns,
  issues,
  toolConnections,
} from "@greatstone/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler, logger } from "../middleware/index.js";
import { isSecretSensitiveHttpRequest } from "../middleware/http-log-policy.js";
import { stripSecretBearingUrlParts } from "../middleware/redact-sensitive.js";
import { mailboxRoutes } from "../routes/mailboxes.js";
import { createStorageService } from "../storage/service.js";
import {
  MailboxAuthError,
  OAUTH_SIGN_IN_REFUSED,
  type MailboxAccount,
  type MailboxClientFactory,
} from "../services/mailbox-imap.js";
import { resetMailboxOAuthState, type OAuthFetch } from "../services/mailbox-oauth.js";
import { applyConnectorSkills, resolveConnectorAssignments } from "../services/connector-runtime.js";
import { executeMailboxTool } from "../services/connectors/mailbox.js";

const CLIENT_SECRET = "entra-client-secret-7c1e-never-leak";
const AUTH_CODE = "auth-code-51aa-never-leak";
const ADDRESS = "john@greatstone.example";

function idToken(claims: Record<string, unknown>) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

/**
 * A token endpoint double. Every grant hands out a new, unique access token;
 * refresh grants also rotate the refresh token, as Microsoft does.
 */
function fakeProvider() {
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  const issued = { access: [] as string[], refresh: [] as string[] };
  let revoked = false;
  let counter = 0;
  // Default below the 60 s safety margin, so every later call refreshes.
  let expiresIn = 30;
  const mint = () => {
    counter += 1;
    const access = `access-${counter}-${randomUUID()}`;
    const refresh = `refresh-${counter}-${randomUUID()}`;
    issued.access.push(access);
    issued.refresh.push(refresh);
    return { access, refresh };
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl: OAuthFetch = async (url, init) => {
    const body = new URLSearchParams(String(init.body));
    calls.push({ url, body });
    if (body.get("client_secret") !== CLIENT_SECRET) return json(401, { error: "invalid_client" });
    if (body.get("grant_type") === "authorization_code") {
      if (body.get("code") !== AUTH_CODE) return json(400, { error: "invalid_grant" });
      const tokens = mint();
      return json(200, {
        access_token: tokens.access,
        refresh_token: tokens.refresh,
        expires_in: expiresIn,
        id_token: idToken({ preferred_username: ADDRESS, name: "John" }),
      });
    }
    if (body.get("grant_type") === "refresh_token") {
      // Only the newest refresh token is valid.
      if (revoked || body.get("refresh_token") !== issued.refresh.at(-1))
        return json(400, { error: "invalid_grant", error_description: `AADSTS70008 for ${ADDRESS}` });
      const tokens = mint();
      return json(200, { access_token: tokens.access, refresh_token: tokens.refresh, expires_in: expiresIn });
    }
    return json(400, { error: "unsupported_grant_type" });
  };
  return {
    fetchImpl,
    calls,
    issued,
    revoke: () => {
      revoked = true;
    },
    restore: () => {
      revoked = false;
    },
    tokenLifetime: (seconds: number) => {
      expiresIn = seconds;
    },
  };
}

/** IMAP double that accepts only access tokens the provider issued and has not revoked. */
function fakeImap(provider: ReturnType<typeof fakeProvider>) {
  const seen: MailboxAccount[] = [];
  const refused = new Set<string>();
  let refuseAll = false;
  const factory: MailboxClientFactory = (account) => {
    seen.push(account);
    const signIn = () => {
      if (
        !account.accessToken ||
        !provider.issued.access.includes(account.accessToken) ||
        refused.has(account.accessToken) ||
        refuseAll
      )
        throw new MailboxAuthError(OAUTH_SIGN_IN_REFUSED);
    };
    return {
      async folders() {
        signIn();
        return ["INBOX"];
      },
      async search(query) {
        signIn();
        return [
          {
            uid: 7,
            folder: query.folder,
            messageId: null,
            subject: "Q3 contract draft",
            from: [{ name: null, address: "ama@client.example" }],
            to: [],
            date: "2026-10-07T10:00:00.000Z",
            size: 100,
          },
        ];
      },
      async source() {
        signIn();
        return Buffer.from("Subject: Q3 contract draft\r\n\r\nHi John\r\n");
      },
    };
  };
  return {
    factory,
    seen,
    refuse: (token: string) => refused.add(token),
    refuseEverything: () => {
      refuseAll = true;
    },
  };
}

describe("mailbox sign-in with Microsoft and Google (GRE-1349)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const folder = mkdtempSync(path.join(os.tmpdir(), "gsam-mailbox-oauth-"));
  const previousKey = process.env.GSAM_SECRETS_MASTER_KEY_FILE;
  const storage = createStorageService({
    id: "local_disk",
    async putObject() {},
    async getObject() {
      throw new Error("unused");
    },
    async headObject() {
      return { exists: false };
    },
    async deleteObject() {},
  });
  const logLines: unknown[] = [];

  beforeAll(async () => {
    process.env.GSAM_SECRETS_MASTER_KEY_FILE = path.join(folder, "master.key");
    database = await startEmbeddedPostgresTestDatabase("gsam-mailbox-oauth-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => {
    await database?.cleanup();
    if (previousKey === undefined) delete process.env.GSAM_SECRETS_MASTER_KEY_FILE;
    else process.env.GSAM_SECRETS_MASTER_KEY_FILE = previousKey;
    rmSync(folder, { recursive: true, force: true });
  });
  beforeEach(() => {
    resetMailboxOAuthState();
    logLines.length = 0;
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const)
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
        logLines.push(args);
      }) as never);
  });
  afterEach(() => vi.restoreAllMocks());

  async function fixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `O${companyId.slice(0, 7).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Mailbox OAuth test",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Mail reader",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Find the Q3 email",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId } });
    const provider = fakeProvider();
    const imap = fakeImap(provider);
    let actor: Record<string, unknown> = { type: "board", source: "local_implicit" };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use(
      "/api",
      mailboxRoutes(db, storage, { clientFactory: imap.factory, fetch: provider.fetchImpl }),
    );
    app.use(errorHandler);
    const as = (next: Record<string, unknown>) => {
      actor = next;
    };
    const asBoard = () => as({ type: "board", source: "local_implicit" });
    const asAgent = () => as({ type: "agent", agentId, companyId, runId });
    const saveApp = (providerName = "microsoft", body: Record<string, unknown> = {}) =>
      request(app)
        .put(`/api/companies/${companyId}/mailbox-oauth/apps/${providerName}`)
        .send({ clientId: "client-123", clientSecret: CLIENT_SECRET, tenant: "greatstone.example", ...body });
    const start = (body: Record<string, unknown> = {}) =>
      request(app)
        .post(`/api/companies/${companyId}/mailbox-oauth/start`)
        .send({ provider: "microsoft", agentIds: [agentId], ...body });
    const callback = (query: Record<string, string>) =>
      request(app).get(`/api/mailbox-oauth/callback?${new URLSearchParams(query)}`);
    /** Run the whole browser round trip and return the callback response. */
    const signIn = async (body: Record<string, unknown> = {}) => {
      const started = await start(body);
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      const state = new URL(started.body.authorizationUrl).searchParams.get("state")!;
      return { started, state, done: await callback({ state, code: AUTH_CODE }) };
    };
    return {
      companyId,
      agentId,
      issueId,
      runId,
      issuePrefix,
      app,
      provider,
      imap,
      as,
      asBoard,
      asAgent,
      saveApp,
      start,
      callback,
      signIn,
    };
  }

  const outcome = (res: { headers: Record<string, string> }) =>
  new URL(res.headers.location, "http://app.test").searchParams.get("mailboxError") ?? "";

const searchAs = (f: Awaited<ReturnType<typeof fixture>>, mailboxId: string) =>
    request(f.app).post(`/api/companies/${f.companyId}/mailboxes/${mailboxId}/search`).send({ subject: "Q3" });

  it("adds an Outlook mailbox with Microsoft sign-in and shows it as connected", async () => {
    const f = await fixture();
    const missing = await f.start();
    expect(missing.status).toBe(422);
    expect(missing.body.error).toMatch(/app settings/i);

    expect((await f.saveApp()).status).toBe(200);
    const apps = await request(f.app).get(`/api/companies/${f.companyId}/mailbox-oauth/apps`);
    expect(apps.body).toEqual([
      expect.objectContaining({ provider: "microsoft", configured: true, clientId: "client-123", tenant: "greatstone.example" }),
      expect.objectContaining({ provider: "google", configured: false, clientId: null }),
    ]);
    expect(apps.body[0].redirectUri).toMatch(/^http:\/\/(127\.0\.0\.1|\[::1\]|localhost):\d+\/api\/mailbox-oauth\/callback$/);

    const { started, done } = await f.signIn({ label: "Work" });
    const url = new URL(started.body.authorizationUrl);
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/greatstone.example/oauth2/v2.0/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("scope")).toContain("https://outlook.office.com/IMAP.AccessAsUser.All");
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    // supertest serves each request on a new port, so compare the path.
    expect(new URL(url.searchParams.get("redirect_uri")!).pathname).toBe("/api/mailbox-oauth/callback");

    expect(done.status).toBe(303);
    expect(done.headers.location).toBe(
      `/${f.issuePrefix}/apps/mailboxes?mailboxConnected=${encodeURIComponent(ADDRESS)}`,
    );
    // The code was redeemed with the PKCE verifier that matches the challenge.
    const exchange = f.provider.calls.find((c) => c.body.get("grant_type") === "authorization_code")!;
    const verifier = exchange.body.get("code_verifier")!;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(url.searchParams.get("code_challenge"));
    expect(exchange.url).toBe("https://login.microsoftonline.com/greatstone.example/oauth2/v2.0/token");

    const [mailbox] = (await request(f.app).get(`/api/companies/${f.companyId}/mailboxes`)).body;
    expect(mailbox).toMatchObject({
      label: "Work",
      address: ADDRESS,
      provider: "microsoft",
      host: "outlook.office365.com",
      port: 993,
      healthStatus: "ok",
      agentIds: [f.agentId],
    });
    // IMAP signed in with the access token as the mailbox address (XOAUTH2).
    expect(f.imap.seen.at(-1)).toMatchObject({ username: ADDRESS, accessToken: f.provider.issued.access[0] });
  });

  it("refreshes the access token on the server and keeps the rotated refresh token", async () => {
    const f = await fixture();
    await f.saveApp();
    await f.signIn();
    const [mailbox] = (await request(f.app).get(`/api/companies/${f.companyId}/mailboxes`)).body;
    f.asAgent();
    for (let i = 0; i < 2; i++) expect((await searchAs(f, mailbox.id)).status).toBe(200);
    const refreshes = f.provider.calls.filter((c) => c.body.get("grant_type") === "refresh_token");
    expect(refreshes).toHaveLength(2);
    // The second refresh used the token the first one rotated in.
    expect(refreshes[0].body.get("refresh_token")).toBe(f.provider.issued.refresh[0]);
    expect(refreshes[1].body.get("refresh_token")).toBe(f.provider.issued.refresh[1]);
    expect(f.imap.seen.at(-1)?.accessToken).toBe(f.provider.issued.access.at(-1));
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, mailbox.id));
    const [secret] = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, connection.credentialSecretRefs[0].secretId));
    expect(secret.latestVersion).toBe(3);
  });

  it("retries once with a fresh token when the mail server refuses a cached one", async () => {
    const f = await fixture();
    f.provider.tokenLifetime(3600);
    await f.saveApp();
    await f.signIn();
    const [mailbox] = (await request(f.app).get(`/api/companies/${f.companyId}/mailboxes`)).body;
    // The sign-in token is still cached, but the mail server now refuses it.
    f.imap.refuse(f.provider.issued.access[0]);
    f.provider.calls.length = 0;
    f.asAgent();
    const ok = await searchAs(f, mailbox.id);
    expect(ok.status).toBe(200);
    expect(f.provider.calls.map((c) => c.body.get("grant_type"))).toEqual(["refresh_token"]);
    expect(f.imap.seen.at(-1)?.accessToken).toBe(f.provider.issued.access[1]);
    // When the fresh token is refused too, that is final: no loop of refreshes.
    f.imap.refuseEverything();
    f.provider.calls.length = 0;
    const refused = await searchAs(f, mailbox.id);
    expect(refused.status).toBe(422);
    expect(f.provider.calls).toHaveLength(1);
    f.imap.seen.length = 0;
    f.asBoard();
    const [after] = (await request(f.app).get(`/api/companies/${f.companyId}/mailboxes`)).body;
    expect(after).toMatchObject({ healthStatus: "failed", healthMessage: OAUTH_SIGN_IN_REFUSED });
  });

  it("marks the mailbox for reconnecting when the refresh token is revoked, and Reconnect restores it", async () => {
    const f = await fixture();
    await f.saveApp();
    await f.signIn();
    const [mailbox] = (await request(f.app).get(`/api/companies/${f.companyId}/mailboxes`)).body;
    f.provider.revoke();
    f.asAgent();
    const failed = await searchAs(f, mailbox.id);
    expect(failed.status).toBe(422);
    expect(failed.body.error).toBe("Microsoft sign-in expired or was revoked. Reconnect this mailbox.");
    // The provider's own description (which names the account) is never repeated.
    expect(failed.text).not.toContain("AADSTS");
    const viaTool = executeMailboxTool(
      db,
      { companyId: f.companyId, agentId: f.agentId, runId: f.runId, issueId: f.issueId },
      "search",
      { mailboxId: mailbox.id },
      { clientFactory: f.imap.factory, fetch: f.provider.fetchImpl },
    );
    await expect(viaTool).rejects.toThrow(/Reconnect this mailbox/);
    f.asBoard();
    const [marked] = (await request(f.app).get(`/api/companies/${f.companyId}/mailboxes`)).body;
    expect(marked).toMatchObject({
      healthStatus: "failed",
      healthMessage: "Microsoft sign-in expired or was revoked. Reconnect this mailbox.",
    });

    // Signing in again to the same mailbox replaces its refresh token in place.
    f.provider.restore();
    const { done } = await f.signIn();
    expect(done.status).toBe(303);
    const listed = (await request(f.app).get(`/api/companies/${f.companyId}/mailboxes`)).body;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: mailbox.id, healthStatus: "ok", agentIds: [f.agentId] });
    f.asAgent();
    expect((await searchAs(f, mailbox.id)).status).toBe(200);
  });

  it("marks the mailbox failed with an app-settings message when the client secret is rejected", async () => {
    const f = await fixture();
    await f.saveApp();
    await f.signIn();
    const [mailbox] = (await request(f.app).get(`/api/companies/${f.companyId}/mailboxes`)).body;
    await f.saveApp("microsoft", { clientSecret: "expired-secret" });
    f.asAgent();
    const failed = await searchAs(f, mailbox.id);
    expect(failed.status).toBe(422);
    expect(failed.body.error).toMatch(/rejected the app settings/);
    f.asBoard();
    const [marked] = (await request(f.app).get(`/api/companies/${f.companyId}/mailboxes`)).body;
    expect(marked.healthStatus).toBe("failed");
  });

  it("accepts each sign-in once, only for the user who started it, and always answers with a redirect", async () => {
    const f = await fixture();
    await f.saveApp();
    f.as({ type: "board", userId: "user-a", source: "session", isInstanceAdmin: true, companyIds: [f.companyId] });
    const started = await f.start();
    const state = new URL(started.body.authorizationUrl).searchParams.get("state")!;
    f.as({ type: "board", userId: "user-b", source: "session", isInstanceAdmin: true, companyIds: [f.companyId] });
    const foreign = await f.callback({ state, code: AUTH_CODE });
    expect(foreign.status).toBe(303);
    expect(outcome(foreign)).toMatch(/Sign in to this app as the person/);
    // The state is spent even though the wrong user presented it.
    f.as({ type: "board", userId: "user-a", source: "session", isInstanceAdmin: true, companyIds: [f.companyId] });
    const replay = await f.callback({ state, code: AUTH_CODE });
    expect(replay.status).toBe(303);
    expect(outcome(replay)).toMatch(/expired or was already used/);
    expect(f.provider.calls).toHaveLength(0);

    const cancelled = await f.start();
    const cancelledState = new URL(cancelled.body.authorizationUrl).searchParams.get("state")!;
    const denied = await f.callback({ state: cancelledState, error: "access_denied", error_description: "user said no" });
    expect(denied.status).toBe(303);
    expect(outcome(denied)).toMatch(/cancelled/);
    expect(denied.headers.location).not.toContain("user said no");

    const badCodeStart = await f.start();
    const badCodeState = new URL(badCodeStart.body.authorizationUrl).searchParams.get("state")!;
    const badCode = await f.callback({ state: badCodeState, code: "not-the-code" });
    expect(badCode.status).toBe(303);
    expect(outcome(badCode)).toBe("Microsoft sign-in did not complete. Try again.");

    const bogus = await f.callback({ state: "made-up", code: AUTH_CODE });
    expect(bogus.status).toBe(303);
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId))).toHaveLength(0);
  });

  it("builds a Google sign-in that asks for offline access to Gmail IMAP", async () => {
    const f = await fixture();
    await f.saveApp("google", { tenant: undefined });
    const started = await f.start({ provider: "google" });
    const url = new URL(started.body.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toContain("https://mail.google.com/");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    const state = url.searchParams.get("state")!;
    const done = await f.callback({ state, code: AUTH_CODE });
    expect(done.status).toBe(303);
    const [mailbox] = (await request(f.app).get(`/api/companies/${f.companyId}/mailboxes`)).body;
    expect(mailbox).toMatchObject({ provider: "google", host: "imap.gmail.com", address: ADDRESS });
  });

  it("never exposes tokens or the client secret in responses, logs, activity, config or agent tool results", async () => {
    const f = await fixture();
    const texts: string[] = [];
    const saved = await f.saveApp();
    texts.push(saved.text);
    const { started, done } = await f.signIn();
    texts.push(started.text, JSON.stringify(done.headers), done.text);
    texts.push((await request(f.app).get(`/api/companies/${f.companyId}/mailbox-oauth/apps`)).text);
    const listed = await request(f.app).get(`/api/companies/${f.companyId}/mailboxes`);
    texts.push(listed.text);
    const mailboxId = listed.body[0].id;
    f.asAgent();
    texts.push((await request(f.app).get(`/api/companies/${f.companyId}/mailboxes`)).text);
    texts.push((await searchAs(f, mailboxId)).text);
    texts.push(
      (await request(f.app).post(`/api/companies/${f.companyId}/mailboxes/${mailboxId}/read`).send({ uid: 7 })).text,
    );
    const binding = { companyId: f.companyId, agentId: f.agentId, runId: f.runId, issueId: f.issueId };
    const assignments = await resolveConnectorAssignments(db, binding);
    texts.push(JSON.stringify(assignments));
    const configured = await applyConnectorSkills({}, [], assignments);
    texts.push(readFileSync(path.join(configured.paperclipRuntimeSkills[0].source, "SKILL.md"), "utf8"));
    for (const [action, args] of [
      ["list", {}],
      ["folders", { mailboxId }],
      ["search", { mailboxId }],
      ["read", { mailboxId, uid: 7 }],
    ] as const)
      texts.push(
        JSON.stringify(
          await executeMailboxTool(db, binding, action, args, {
            clientFactory: f.imap.factory,
            fetch: f.provider.fetchImpl,
          }),
        ),
      );
    // A revoked token produces an error path, too.
    f.provider.revoke();
    texts.push((await searchAs(f, mailboxId)).text);

    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, mailboxId));
    texts.push(JSON.stringify(connection));
    texts.push(JSON.stringify(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))));
    const secretRows = await db.select().from(companySecrets).where(eq(companySecrets.companyId, f.companyId));
    texts.push(JSON.stringify(secretRows));
    for (const secret of secretRows)
      texts.push(
        JSON.stringify(
          await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, secret.id)),
        ),
      );
    texts.push(JSON.stringify(logLines));

    const forbidden = [CLIENT_SECRET, AUTH_CODE, ...f.provider.issued.access, ...f.provider.issued.refresh];
    expect(f.provider.issued.access.length).toBeGreaterThan(2);
    for (const text of texts) for (const value of forbidden) expect(text).not.toContain(value);

    // HTTP logs: the app-settings body is treated as secret, and the callback
    // URL (which carries the code) is logged without its query string.
    expect(isSecretSensitiveHttpRequest("PUT", `/api/companies/${f.companyId}/mailbox-oauth/apps/microsoft`)).toBe(true);
    expect(stripSecretBearingUrlParts(`/api/mailbox-oauth/callback?state=s&code=${AUTH_CODE}`)).toBe(
      "/api/mailbox-oauth/callback",
    );
  });
});
