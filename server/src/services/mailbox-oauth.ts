import { createHash, randomBytes } from "node:crypto";
import type { MailboxOAuthProvider } from "@greatstone/shared";
import { HttpError, unprocessable } from "../errors.js";
import { MailboxAuthError, MailboxUnavailableError } from "./mailbox-imap.js";

// OAuth sign-in for Microsoft 365 / Outlook and Gmail mailboxes (GRE-1349).
// The endpoints are fixed per provider, so this stays a small authorization
// code + PKCE client rather than the generic tool OAuth flow, which assumes an
// MCP catalog. Access tokens live only in this process; the refresh token is
// the stored credential.

export type MailboxOAuthApp = { clientId: string; clientSecret: string; tenant?: string };

type ProviderSpec = {
  label: string;
  imapHost: string;
  scopes: string[];
  authorizeUrl: (tenant: string) => string;
  tokenUrl: (tenant: string) => string;
  authorizeParams: Record<string, string>;
};

export const MAILBOX_OAUTH_PROVIDERS: Record<MailboxOAuthProvider, ProviderSpec> = {
  microsoft: {
    label: "Microsoft",
    imapHost: "outlook.office365.com",
    // openid + email return an id_token naming the mailbox to sign in as.
    scopes: ["openid", "email", "offline_access", "https://outlook.office.com/IMAP.AccessAsUser.All"],
    authorizeUrl: (tenant) =>
      `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`,
    tokenUrl: (tenant) =>
      `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
    authorizeParams: { prompt: "select_account" },
  },
  google: {
    label: "Google",
    imapHost: "imap.gmail.com",
    // Gmail IMAP accepts only the full mail scope; gmail.readonly does not
    // work over IMAP. The IMAP client still opens every folder read-only.
    scopes: ["openid", "email", "https://mail.google.com/"],
    authorizeUrl: () => "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: () => "https://oauth2.googleapis.com/token",
    // Without consent Google returns a refresh token only on the first grant.
    authorizeParams: { access_type: "offline", prompt: "consent" },
  },
};

export const DEFAULT_MICROSOFT_TENANT = "organizations";

export function tenantFor(provider: MailboxOAuthProvider, app: MailboxOAuthApp) {
  return provider === "microsoft" ? app.tenant || DEFAULT_MICROSOFT_TENANT : "";
}

export function reconnectMessage(provider: MailboxOAuthProvider) {
  return `${MAILBOX_OAUTH_PROVIDERS[provider].label} sign-in expired or was revoked. Reconnect this mailbox.`;
}

export function appRejectedMessage(provider: MailboxOAuthProvider) {
  return `${MAILBOX_OAUTH_PROVIDERS[provider].label} rejected the app settings (client id or secret). Update them on the Mailboxes page, then reconnect.`;
}

const base64url = (buffer: Buffer) => buffer.toString("base64url");

export function pkcePair() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function authorizationUrl(input: {
  provider: MailboxOAuthProvider;
  app: MailboxOAuthApp;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}) {
  const spec = MAILBOX_OAUTH_PROVIDERS[input.provider];
  const url = new URL(spec.authorizeUrl(tenantFor(input.provider, input.app)));
  url.searchParams.set("client_id", input.app.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", spec.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  for (const [key, value] of Object.entries(spec.authorizeParams)) url.searchParams.set(key, value);
  return url.toString();
}

export type TokenSet = {
  accessToken: string;
  /** Present on the first grant; Microsoft may also rotate it on refresh. */
  refreshToken: string | null;
  expiresAt: number;
  idToken: string | null;
};

export type OAuthFetch = (url: string, init: RequestInit) => Promise<Response>;

const RECONNECT_ERRORS = new Set(["invalid_grant", "interaction_required", "consent_required", "login_required"]);
const APP_ERRORS = new Set(["invalid_client", "unauthorized_client"]);

/**
 * One token endpoint call. Errors never repeat the provider's text, which can
 * name the account or tenant and reaches agents and logs.
 */
export async function requestToken(
  fetchImpl: OAuthFetch,
  provider: MailboxOAuthProvider,
  app: MailboxOAuthApp,
  params: Record<string, string>,
  now = Date.now(),
): Promise<TokenSet> {
  const spec = MAILBOX_OAUTH_PROVIDERS[provider];
  const body = new URLSearchParams({
    ...params,
    client_id: app.clientId,
    client_secret: app.clientSecret,
  });
  if (provider === "microsoft") body.set("scope", spec.scopes.join(" "));
  let response: Response;
  try {
    response = await fetchImpl(spec.tokenUrl(tenantFor(provider, app)), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new MailboxUnavailableError(`could not reach ${spec.label} sign-in`);
  }
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const error = typeof payload?.error === "string" ? payload.error : "";
    if (RECONNECT_ERRORS.has(error)) throw new MailboxAuthError(reconnectMessage(provider));
    if (APP_ERRORS.has(error)) throw new MailboxAuthError(appRejectedMessage(provider));
    if (response.status >= 500 || response.status === 429)
      throw new MailboxUnavailableError(`${spec.label} sign-in is unavailable`);
    throw new MailboxAuthError(reconnectMessage(provider));
  }
  const accessToken = typeof payload?.access_token === "string" ? payload.access_token : "";
  if (!accessToken) throw new MailboxUnavailableError(`${spec.label} sign-in returned no access token`);
  const expiresIn = Number(payload?.expires_in);
  return {
    accessToken,
    refreshToken: typeof payload?.refresh_token === "string" ? payload.refresh_token : null,
    expiresAt: now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
    idToken: typeof payload?.id_token === "string" ? payload.id_token : null,
  };
}

/**
 * The mailbox address from an id_token received straight from the token
 * endpoint over TLS (OIDC Core 3.1.3.7 lets the client skip the signature
 * check in that case). Never trust an id_token from anywhere else.
 */
export function addressFromIdToken(idToken: string | null): string | null {
  if (!idToken) return null;
  try {
    const claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"));
    for (const claim of [claims.email, claims.preferred_username, claims.upn]) {
      if (typeof claim === "string" && /^[^@\s]+@[^@\s]+$/.test(claim)) return claim.toLowerCase();
    }
  } catch {
    // Fall through: a malformed token names no mailbox.
  }
  return null;
}

// Pending sign-ins. They live in memory for ten minutes and are used once; a
// restart only means the user clicks the sign-in button again.
export type PendingSignIn = {
  companyId: string;
  provider: MailboxOAuthProvider;
  userId: string;
  codeVerifier: string;
  redirectUri: string;
  label?: string;
  allAgents: boolean;
  agentIds: string[];
  expiresAt: number;
};

const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 200;
const pending = new Map<string, PendingSignIn>();

function prune(now: number) {
  for (const [state, entry] of pending) if (entry.expiresAt <= now) pending.delete(state);
}

export function rememberSignIn(entry: Omit<PendingSignIn, "expiresAt">, now = Date.now()) {
  prune(now);
  if (pending.size >= MAX_PENDING)
    throw new HttpError(429, "Too many mailbox sign-ins in progress. Try again in a few minutes.", {
      code: "mailbox_oauth_busy",
    });
  const state = base64url(randomBytes(32));
  pending.set(state, { ...entry, expiresAt: now + PENDING_TTL_MS });
  return state;
}

/** Take a pending sign-in once. A replayed or expired state returns null. */
export function takeSignIn(state: string, now = Date.now()): PendingSignIn | null {
  const entry = pending.get(state);
  pending.delete(state);
  if (!entry || entry.expiresAt <= now) return null;
  return entry;
}

// Access tokens, per mailbox. In memory only: never stored, logged or returned.
const EXPIRY_MARGIN_MS = 60_000;
const accessTokens = new Map<string, { token: string; expiresAt: number }>();
const refreshing = new Map<string, Promise<string>>();

export function forgetAccessToken(connectionId: string) {
  accessTokens.delete(connectionId);
}

/** Keep the token from a fresh sign-in, so the first search needs no refresh. */
export function primeAccessToken(connectionId: string, tokens: TokenSet) {
  accessTokens.set(connectionId, { token: tokens.accessToken, expiresAt: tokens.expiresAt });
}

/**
 * A live access token for one mailbox. Concurrent callers share one refresh,
 * so a rotating refresh token is redeemed once.
 */
export async function accessTokenFor(
  connectionId: string,
  refresh: () => Promise<TokenSet>,
  now = Date.now(),
): Promise<string> {
  const cached = accessTokens.get(connectionId);
  if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > now) return cached.token;
  const inFlight = refreshing.get(connectionId);
  if (inFlight) return inFlight;
  const run = (async () => {
    try {
      const tokens = await refresh();
      accessTokens.set(connectionId, { token: tokens.accessToken, expiresAt: tokens.expiresAt });
      return tokens.accessToken;
    } finally {
      refreshing.delete(connectionId);
    }
  })();
  refreshing.set(connectionId, run);
  return run;
}

export function parseApp(raw: string): MailboxOAuthApp {
  try {
    const value = JSON.parse(raw);
    if (typeof value?.clientId === "string" && typeof value?.clientSecret === "string")
      return {
        clientId: value.clientId,
        clientSecret: value.clientSecret,
        ...(typeof value.tenant === "string" && value.tenant ? { tenant: value.tenant } : {}),
      };
  } catch {
    // Fall through.
  }
  throw unprocessable("The saved mailbox sign-in app settings are unreadable. Save them again.");
}

/** Test-only: forget every pending sign-in and cached token. */
export function resetMailboxOAuthState() {
  pending.clear();
  accessTokens.clear();
  refreshing.clear();
}
