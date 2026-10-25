/**
 * One-time browser login link for an agent's QA log-in (GRE-2387).
 *
 * A QA account has no password. During a run the agent asks the server for a
 * link (`POST /api/agents/me/qa-browser-login`); the link carries a signed
 * ticket that works once, for 90 seconds, and only while the agent's QA grant
 * is live. Opening it makes a normal Better Auth session cookie.
 *
 * Same shape as the workspace login handoff (`workspace-login-handoff.ts`):
 * HMAC-signed, short expiry, and the nonce is recorded on first use, so a
 * captured link cannot be used twice. The signing key is derived one-way from
 * this server's auth secret and is domain-separated from every other use of it,
 * so only the server that made a ticket can accept it.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const QA_BROWSER_LOGIN_TICKET_VERSION = "qa1";

/** A link works for this long after it is made. */
export const QA_BROWSER_LOGIN_TICKET_TTL_SECONDS = 90;

/** A QA browser session is refused after this long, even while the grant is live. */
export const QA_BROWSER_SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;

/** Path under the Better Auth mount (`/api/auth`). */
export const QA_BROWSER_LOGIN_EXCHANGE_PATH = "/qa-login/exchange";

/** Query parameter carrying the ticket. The request logger redacts `ticket=`. */
export const QA_BROWSER_LOGIN_TICKET_QUERY_PARAM = "ticket";

export type QaBrowserLoginTicketPayload = {
  v: typeof QA_BROWSER_LOGIN_TICKET_VERSION;
  /** Single-use nonce. */
  jti: string;
  /** QA user id the ticket signs in. */
  sub: string;
  /** The agent_qa_logins row the ticket is bound to. */
  lid: string;
  /** Company of that grant. */
  cid: string;
  /** Agent that asked for the link. */
  aid: string;
  /** Seconds since epoch. */
  iat: number;
  exp: number;
};

export type QaBrowserLoginVerificationFailure =
  | "not_configured"
  | "malformed"
  | "unsupported_version"
  | "bad_signature"
  | "expired"
  | "not_yet_valid";

export type QaBrowserLoginVerificationResult =
  | { ok: true; payload: QaBrowserLoginTicketPayload }
  | { ok: false; reason: QaBrowserLoginVerificationFailure };

const CLOCK_SKEW_SECONDS = 5;

/** Signing key for QA tickets, or null when the server has no auth secret. */
export function resolveQaBrowserLoginKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = env.BETTER_AUTH_SECRET?.trim() || env.GSAM_AGENT_JWT_SECRET?.trim();
  if (!root) return null;
  return createHmac("sha256", root)
    .update(`gsam.qa-browser-login.${QA_BROWSER_LOGIN_TICKET_VERSION}`)
    .digest("hex");
}

function sign(key: string, message: string): Buffer {
  return createHmac("sha256", key).update(message).digest();
}

function base64UrlDecode(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0) return null;
  return decoded.toString("base64url") === value ? decoded : null;
}

export function issueQaBrowserLoginTicket(input: {
  key: string;
  userId: string;
  loginId: string;
  companyId: string;
  agentId: string;
  now?: Date;
  nonce?: string;
}): { ticket: string; payload: QaBrowserLoginTicketPayload } {
  const iat = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const payload: QaBrowserLoginTicketPayload = {
    v: QA_BROWSER_LOGIN_TICKET_VERSION,
    jti: input.nonce ?? randomBytes(18).toString("base64url"),
    sub: input.userId,
    lid: input.loginId,
    cid: input.companyId,
    aid: input.agentId,
    iat,
    exp: iat + QA_BROWSER_LOGIN_TICKET_TTL_SECONDS,
  };
  const message = `${QA_BROWSER_LOGIN_TICKET_VERSION}.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
  return { ticket: `${message}.${sign(input.key, message).toString("base64url")}`, payload };
}

export function buildQaBrowserLoginUrl(input: { origin: string; ticket: string }): string {
  const url = new URL(`/api/auth${QA_BROWSER_LOGIN_EXCHANGE_PATH}`, input.origin);
  url.searchParams.set(QA_BROWSER_LOGIN_TICKET_QUERY_PARAM, input.ticket);
  return url.toString();
}

function isPayloadShape(value: unknown): value is QaBrowserLoginTicketPayload {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    ["jti", "sub", "lid", "cid", "aid"].every((k) => typeof c[k] === "string" && (c[k] as string).length > 0)
    && Number.isFinite(c.iat)
    && Number.isFinite(c.exp)
  );
}

/** Checks the signature and the 90-second window. The grant is checked by the caller. */
export function verifyQaBrowserLoginTicket(input: {
  ticket: string | null | undefined;
  key: string | null | undefined;
  now?: Date;
}): QaBrowserLoginVerificationResult {
  const key = input.key?.trim();
  if (!key) return { ok: false, reason: "not_configured" };
  const segments = input.ticket?.trim().split(".") ?? [];
  if (segments.length !== 3) return { ok: false, reason: "malformed" };
  const [version, encodedPayload, encodedSignature] = segments as [string, string, string];
  if (version !== QA_BROWSER_LOGIN_TICKET_VERSION) return { ok: false, reason: "unsupported_version" };

  const provided = base64UrlDecode(encodedSignature);
  if (!provided) return { ok: false, reason: "malformed" };
  const expected = sign(key, `${version}.${encodedPayload}`);
  // Signature first: never parse JSON we have not authenticated.
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, reason: "bad_signature" };
  }

  const decoded = base64UrlDecode(encodedPayload);
  if (!decoded) return { ok: false, reason: "malformed" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isPayloadShape(parsed)) return { ok: false, reason: "malformed" };
  if (parsed.v !== QA_BROWSER_LOGIN_TICKET_VERSION) return { ok: false, reason: "unsupported_version" };

  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (parsed.exp <= parsed.iat || parsed.exp - parsed.iat > QA_BROWSER_LOGIN_TICKET_TTL_SECONDS) {
    return { ok: false, reason: "malformed" };
  }
  if (parsed.exp + CLOCK_SKEW_SECONDS < now) return { ok: false, reason: "expired" };
  if (parsed.iat - CLOCK_SKEW_SECONDS > now) return { ok: false, reason: "not_yet_valid" };
  return { ok: true, payload: parsed };
}

/** Exchange, with every dependency injected so the security cases are unit-testable. */
export type QaBrowserLoginExchangeDeps = {
  /** True only when the grant row is active, not past expiry, and belongs to sub/cid/aid. */
  isGrantLive: (payload: QaBrowserLoginTicketPayload) => Promise<boolean>;
  /** Record the nonce; false when it was already used. Must be atomic. */
  reserveNonce: (input: { nonce: string; expiresAt: Date }) => Promise<boolean>;
  createSession: (userId: string) => Promise<void>;
};

export type QaBrowserLoginExchangeFailure =
  | QaBrowserLoginVerificationFailure
  | "grant_not_live"
  | "replayed"
  | "session_failed";

export type QaBrowserLoginExchangeResult =
  | { ok: true; payload: QaBrowserLoginTicketPayload }
  | { ok: false; reason: QaBrowserLoginExchangeFailure; payload: QaBrowserLoginTicketPayload | null };

export async function exchangeQaBrowserLoginTicket(input: {
  ticket: string | null | undefined;
  key: string | null | undefined;
  deps: QaBrowserLoginExchangeDeps;
  now?: Date;
}): Promise<QaBrowserLoginExchangeResult> {
  const verification = verifyQaBrowserLoginTicket(input);
  if (!verification.ok) return { ok: false, reason: verification.reason, payload: null };
  const payload = verification.payload;
  if (!(await input.deps.isGrantLive(payload))) return { ok: false, reason: "grant_not_live", payload };
  const reserved = await input.deps.reserveNonce({
    nonce: payload.jti,
    expiresAt: new Date((payload.exp + 60) * 1000),
  });
  if (!reserved) return { ok: false, reason: "replayed", payload };
  try {
    await input.deps.createSession(payload.sub);
  } catch {
    return { ok: false, reason: "session_failed", payload };
  }
  return { ok: true, payload };
}
