import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import express, { Router, type Request, type Response } from "express";
import type { Db } from "@greatstone/db";
import type { MemoryConnectionApp } from "@greatstone/shared";
import { z } from "zod";
import { badRequest, forbidden, notFound } from "../errors.js";
import { logActivity } from "../services/index.js";
import type { MemoryEngine } from "../services/memory-gateway/engine.js";
import { memoryGatewayService } from "../services/memory-gateway/service.js";
import { getActorInfo } from "./authz.js";
import { memoryCallerFromRequest } from "./memory.js";
import { memoryConnectionService } from "./memory-connections.js";

/**
 * OAuth 2.1 sign-in for the memory MCP endpoint, so ChatGPT and Claude.ai
 * (whose connectors need OAuth) can connect live. Only what those clients use:
 * dynamic client registration, the authorization code grant with PKCE (S256)
 * and public clients. The access token is an ordinary memory-only key of the
 * person's link agent, so it reaches memory and nothing else, and Disconnect
 * on the Memory page revokes it.
 *
 * Clients and codes are stateless: each is signed with a key derived from the
 * auth secret, so there is no table. Clients are instance-level registration
 * metadata (a name and redirect URIs) with no company or user data; the
 * company is chosen by the signed-in person on the consent screen and travels
 * inside the signed code. Codes last five minutes and are single-use within
 * this server process.
 *
 * Off by default twice over: the routes exist only in authenticated mode with
 * an auth secret, and a code is only issued, and only exchanged, while an
 * owner has turned on app sign-in in the company's memory settings.
 *
 * The public address (GSAM_MEMORY_PUBLIC_URL) only needs the MCP path, the
 * well-known documents, register, authorize and token. The consent screen
 * can stay on a private address (GSAM_MEMORY_CONSENT_URL), since the person
 * approving is on their own device.
 */

export const MEMORY_MCP_PATH = "/api/mcp/memory-tools";
const AUTHORIZE_PATH = "/oauth/memory/authorize";
const TOKEN_PATH = "/oauth/memory/token";
const REGISTER_PATH = "/oauth/memory/register";
const CONSENT_UI_PATH = "/memory/connect-app";
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_REDIRECT_URIS = 5;
export const MEMORY_APP_SIGN_IN_OFF_MESSAGE = "App sign-in is turned off for this company's memory";

export function memoryOAuthSigningKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const secret = env.BETTER_AUTH_SECRET?.trim() || env.GSAM_AGENT_JWT_SECRET?.trim();
  if (!secret) return null;
  return createHash("sha256").update(`gsam-memory-oauth:v1:${secret}`).digest();
}

const b64 = (value: Buffer | string) => Buffer.from(value).toString("base64url");
const trimBase = (value: string | undefined | null) => value?.trim().replace(/\/+$/, "") || null;

function sign(key: Buffer, payload: unknown): string {
  const body = b64(JSON.stringify(payload));
  return `${body}.${b64(createHmac("sha256", key).update(body).digest())}`;
}

function verify<T>(key: Buffer, token: string): T | null {
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra !== undefined) return null;
  const expected = createHmac("sha256", key).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** https anywhere, or http only on this machine, with no fragment. */
export function isAllowedRedirectUri(value: string): boolean {
  if (value.length > 500) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/** Which app a registered client is, from the name it gave itself. */
export function memoryOAuthApp(clientName: string): MemoryConnectionApp {
  if (/chatgpt|openai/i.test(clientName)) return "chatgpt";
  if (/claude|anthropic/i.test(clientName)) return "claude_ai";
  return "other";
}

type ClientPayload = { v: 1; r: string[]; n: string };
type CodePayload = { v: 1; k: "code"; j: string; c: string; a: string; u: string | null; cl: string; r: string; ch: string; e: number };

const registerSchema = z
  .object({
    redirect_uris: z.array(z.string()).min(1).max(MAX_REDIRECT_URIS),
    client_name: z.string().trim().max(100).optional(),
  })
  .passthrough();

const approveSchema = z
  .object({
    companyId: z.string().uuid(),
    clientId: z.string().min(1).max(4_000),
    redirectUri: z.string().min(1).max(500),
    codeChallenge: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
    codeChallengeMethod: z.literal("S256"),
    state: z.string().max(1_000).optional(),
    canContribute: z.boolean().default(true),
  })
  .strict();

function clientIdHash(clientId: string) {
  return createHash("sha256").update(clientId).digest("base64url").slice(0, 22);
}

export interface MemoryOAuthOptions {
  engine?: MemoryEngine;
  /** Where ChatGPT and Claude.ai reach GSAM. Defaults to the request's own host. */
  publicBaseUrl?: string | null;
  /** Where the person approving opens the consent screen. Defaults to the public address. */
  consentBaseUrl?: string | null;
  signingKey?: Buffer | null;
  now?: () => number;
}

function readClient(signing: Buffer, clientId: string): ClientPayload | null {
  const client = verify<ClientPayload>(signing, clientId);
  return client?.v === 1 && Array.isArray(client.r) && typeof client.n === "string" ? client : null;
}

function sharedSetup(db: Db, options: MemoryOAuthOptions) {
  const gateway = memoryGatewayService(db, options);
  const key = options.signingKey === undefined ? memoryOAuthSigningKey() : options.signingKey;
  return { gateway, links: memoryConnectionService(db, gateway), key, now: options.now ?? Date.now };
}

/**
 * The handshake ChatGPT and Claude.ai call: discovery, registration,
 * authorize and token. Mounted on the app, outside /api.
 */
export function memoryOAuthRoutes(db: Db, options: MemoryOAuthOptions = {}) {
  const router = Router();
  const { gateway, links, key, now } = sharedSetup(db, options);
  const usedCodes = new Map<string, number>();

  function baseUrl(req: Request) {
    return trimBase(options.publicBaseUrl) ?? `${req.protocol}://${req.get("host")}`;
  }

  function requireKey(res: Response): Buffer | null {
    if (key) return key;
    res.status(404).json({ error: "OAuth sign-in for memory is not available on this server" });
    return null;
  }

  function protectedResource(req: Request, res: Response) {
    if (!requireKey(res)) return;
    const base = baseUrl(req);
    res.json({
      resource: `${base}${MEMORY_MCP_PATH}`,
      authorization_servers: [base],
      scopes_supported: ["memory"],
      bearer_methods_supported: ["header"],
      resource_name: "GSAM organisation memory",
    });
  }

  function authorizationServer(req: Request, res: Response) {
    if (!requireKey(res)) return;
    const base = baseUrl(req);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}${AUTHORIZE_PATH}`,
      token_endpoint: `${base}${TOKEN_PATH}`,
      registration_endpoint: `${base}${REGISTER_PATH}`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["memory"],
    });
  }

  router.get(["/.well-known/oauth-protected-resource", `/.well-known/oauth-protected-resource${MEMORY_MCP_PATH}`], protectedResource);
  router.get(
    ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration", `/.well-known/oauth-authorization-server${MEMORY_MCP_PATH}`],
    authorizationServer,
  );

  // Dynamic client registration (RFC 7591), public clients only.
  router.post(REGISTER_PATH, (req, res) => {
    const signing = requireKey(res);
    if (!signing) return;
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success || !parsed.data.redirect_uris.every(isAllowedRedirectUri)) {
      res.status(400).json({ error: "invalid_redirect_uri", error_description: "Redirect URIs must be https, or http on localhost" });
      return;
    }
    const name = parsed.data.client_name?.trim() || "An MCP app";
    const clientId = sign(signing, { v: 1, r: parsed.data.redirect_uris, n: name } satisfies ClientPayload);
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(now() / 1000),
      client_name: name,
      redirect_uris: parsed.data.redirect_uris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  // Checks the request, then hands it to the consent screen in the board UI,
  // where a signed-in person picks Allow. A bad client or redirect never redirects.
  router.get(AUTHORIZE_PATH, (req, res) => {
    const signing = requireKey(res);
    if (!signing) return;
    const query = req.query as Record<string, unknown>;
    const field = (name: string) => (typeof query[name] === "string" ? (query[name] as string) : "");
    const client = field("client_id") ? readClient(signing, field("client_id")) : null;
    const redirectUri = field("redirect_uri");
    if (!client || !redirectUri || !client.r.includes(redirectUri)) {
      res.status(400).type("text/plain").send("This sign-in link is not valid. Start the connection again from the app.");
      return;
    }
    const redirect = new URL(redirectUri);
    const fail = (error: string) => {
      redirect.searchParams.set("error", error);
      if (field("state")) redirect.searchParams.set("state", field("state"));
      res.redirect(302, redirect.toString());
    };
    if (field("response_type") !== "code") return fail("unsupported_response_type");
    if (!field("code_challenge") || field("code_challenge_method") !== "S256") return fail("invalid_request");
    const params = new URLSearchParams();
    for (const name of ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope"]) {
      if (field(name)) params.set(name, field(name));
    }
    const consentBase = trimBase(options.consentBaseUrl) ?? trimBase(options.publicBaseUrl) ?? "";
    res.redirect(302, `${consentBase}${CONSENT_UI_PATH}?${params.toString()}`);
  });

  router.post(TOKEN_PATH, express.urlencoded({ extended: false, limit: "16kb" }), async (req, res) => {
    const signing = requireKey(res);
    if (!signing) return;
    res.set("Cache-Control", "no-store");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const field = (name: string) => (typeof body[name] === "string" ? (body[name] as string) : "");
    const fail = (error: string, description: string) => res.status(400).json({ error, error_description: description });

    if (field("grant_type") !== "authorization_code") return fail("unsupported_grant_type", "Only authorization_code is supported");
    const code = verify<CodePayload>(signing, field("code"));
    if (!code || code.v !== 1 || code.k !== "code") return fail("invalid_grant", "The code is not valid");
    const at = now();
    for (const [id, expires] of usedCodes) if (expires < at) usedCodes.delete(id);
    if (code.e < at) return fail("invalid_grant", "The code has expired");
    if (usedCodes.has(code.j)) return fail("invalid_grant", "The code has already been used");
    if (clientIdHash(field("client_id")) !== code.cl) return fail("invalid_grant", "The code was issued to another app");
    if (field("redirect_uri") !== code.r) return fail("invalid_grant", "The redirect URI does not match");
    const verifier = field("code_verifier");
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || createHash("sha256").update(verifier).digest("base64url") !== code.ch) {
      return fail("invalid_grant", "The code verifier does not match");
    }
    usedCodes.set(code.j, code.e);

    const settings = await gateway.getSettings(code.c);
    if (!settings.enabled || !settings.appSignIn) return fail("access_denied", MEMORY_APP_SIGN_IN_OFF_MESSAGE);
    const client = readClient(signing, field("client_id"));
    const minted = await links.mintKey(code.c, code.a, `${(client?.n ?? "App").slice(0, 60)} (signed in)`, code.u);
    if (!minted) return fail("invalid_grant", "The connection was removed");
    await logActivity(db, {
      companyId: code.c,
      actorType: "user",
      actorId: code.u ?? "board",
      action: "memory.connection_created",
      entityType: "agent",
      entityId: code.a,
      details: { app: minted.connection.app, keyId: minted.keyId, via: "oauth" },
    });
    res.json({ access_token: minted.token, token_type: "Bearer", scope: "memory" });
  });

  return router;
}

/**
 * What the consent screen calls. Mounted inside /api so the board session and
 * the board mutation guard apply, like every other board write.
 */
export function memoryOAuthConsentRoutes(db: Db, options: MemoryOAuthOptions = {}) {
  const router = Router();
  const { gateway, links, key, now } = sharedSetup(db, options);

  function requireKey(): Buffer {
    if (!key) throw notFound("OAuth sign-in for memory is not available on this server");
    return key;
  }

  // The address to paste into ChatGPT or Claude.ai. Answers 404 where sign-in is not offered.
  router.get("/memory-oauth/status", (req, res) => {
    requireKey();
    const base = trimBase(options.publicBaseUrl) ?? `${req.protocol}://${req.get("host")}`;
    res.json({ mcpUrl: `${base}${MEMORY_MCP_PATH}`, publicAddressSet: !!trimBase(options.publicBaseUrl) });
  });

  // What the consent screen shows. The name is the app's own claim.
  router.get("/memory-oauth/client", (req, res) => {
    const signing = requireKey();
    const clientId = typeof req.query.client_id === "string" ? req.query.client_id : "";
    const redirectUri = typeof req.query.redirect_uri === "string" ? req.query.redirect_uri : "";
    const client = readClient(signing, clientId);
    if (!client || !client.r.includes(redirectUri)) throw notFound("This sign-in link is not valid");
    res.json({ name: client.n, app: memoryOAuthApp(client.n), redirectHost: new URL(redirectUri).host });
  });

  // The person pressed Allow: make or reuse their link agent for this app and
  // return the app's redirect with a signed, short-lived code.
  router.post("/memory-oauth/approve", async (req, res) => {
    const signing = requireKey();
    const parsed = approveSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest("Invalid sign-in request");
    const input = parsed.data;
    const caller = memoryCallerFromRequest(req, input.companyId);
    if (caller.actorType !== "user" || !caller.userId) throw forbidden("Only a person can allow an app");
    const settings = await gateway.assertEnabled(input.companyId);
    if (!settings.appSignIn) throw forbidden(MEMORY_APP_SIGN_IN_OFF_MESSAGE);
    const client = readClient(signing, input.clientId);
    if (!client || !client.r.includes(input.redirectUri)) throw notFound("This sign-in link is not valid");

    const app = memoryOAuthApp(client.n);
    // The token exchange mints the key the app uses.
    const link = await links.connect(caller, app, input.canContribute);

    const code = sign(signing, {
      v: 1,
      k: "code",
      j: randomBytes(12).toString("base64url"),
      c: input.companyId,
      a: link.agentId,
      u: caller.userId,
      cl: clientIdHash(input.clientId),
      r: input.redirectUri,
      ch: input.codeChallenge,
      e: now() + CODE_TTL_MS,
    } satisfies CodePayload);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: input.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "memory.connection_authorized",
      entityType: "agent",
      entityId: link.agentId,
      details: { app, clientName: client.n, redirectHost: new URL(input.redirectUri).host, canContribute: input.canContribute },
    });
    const redirect = new URL(input.redirectUri);
    redirect.searchParams.set("code", code);
    if (input.state) redirect.searchParams.set("state", input.state);
    res.json({ redirectTo: redirect.toString() });
  });

  return router;
}

/** Tells an MCP client where to sign in when it calls the memory endpoint without a key. */
export function memoryMcpAuthChallenge(req: Request, res: Response, publicBaseUrl?: string | null) {
  const base = trimBase(publicBaseUrl) ?? `${req.protocol}://${req.get("host")}`;
  res.set("WWW-Authenticate", `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource${MEMORY_MCP_PATH}"`);
  res.status(401).json({ error: "Sign in to use organisation memory" });
}
