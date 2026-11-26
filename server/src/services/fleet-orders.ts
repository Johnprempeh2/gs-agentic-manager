/**
 * Signed operator orders (GSAM for Mac P2): pause, resume, stop, update.
 *
 * The hub signs each order with its entitlement key (the key every install
 * pinned at activation), as a compact JWS of type `gsam-fleet-order+jwt`.
 * The install checks the signature with the pinned key, the audience, its own
 * instance id and code, the expiry, and that `seq` is above every order it
 * already obeyed. The hub keeps who and why; only kind, seq and expiry travel.
 *
 * Also here: the hub activity log for fleet admin actions, and the one-use
 * Tailscale auth key handed out at activation.
 */

import { createPublicKey, sign, verify } from "node:crypto";
import { companies, type Db } from "@greatstone/db";
import {
  FLEET_MAX_CLOCK_SKEW_SECONDS,
  FLEET_ORDER_AUDIENCE,
  FLEET_ORDER_JWS_TYPE,
  FLEET_ORDER_LIFETIME_HOURS,
  fleetOrderClaimsSchema,
  type FleetOrderClaims,
  type FleetOrderKind,
} from "@greatstone/shared/fleet";
import { logActivity } from "./activity-log.js";
import type { HubSigningKey } from "./fleet-entitlements.js";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

export function signFleetOrder(
  input: { instanceId: string; code: string; seq: number; kind: FleetOrderKind },
  key: HubSigningKey,
  now = new Date(),
): { message: string; expiresAt: Date } {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + FLEET_ORDER_LIFETIME_HOURS * 60 * 60;
  const claims: FleetOrderClaims = fleetOrderClaimsSchema.parse({
    v: 1,
    aud: FLEET_ORDER_AUDIENCE,
    sub: input.instanceId,
    client: input.code,
    seq: input.seq,
    kind: input.kind,
    iat,
    exp,
  });
  const signingInput = `${encode({ alg: "EdDSA", typ: FLEET_ORDER_JWS_TYPE })}.${encode(claims)}`;
  const signature = sign(null, Buffer.from(signingInput), key.privateKey).toString("base64url");
  return { message: `${signingInput}.${signature}`, expiresAt: new Date(exp * 1000) };
}

export type FleetOrderCheck =
  | { ok: true; claims: FleetOrderClaims }
  /** `expired` is reported to the hub; the rest cannot be trusted enough to report. */
  | { ok: false; reason: "malformed" | "bad_signature" | "wrong_instance" | "expired"; seq: number | null };

/** Install side: is this order from the pinned hub key, for this install, and still in date? */
export function verifyFleetOrder(
  message: string,
  pinnedPublicKey: string,
  expected: { instanceId: string; code: string },
  now = new Date(),
): FleetOrderCheck {
  const parts = message.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed", seq: null };
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let payload: unknown;
  try {
    header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed", seq: null };
  }
  if (header?.alg !== "EdDSA" || header?.typ !== FLEET_ORDER_JWS_TYPE) return { ok: false, reason: "malformed", seq: null };
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pinnedPublicKey }, format: "jwk" });
  if (!verify(null, Buffer.from(`${headerPart}.${payloadPart}`), key, Buffer.from(signaturePart, "base64url"))) {
    return { ok: false, reason: "bad_signature", seq: null };
  }
  const parsed = fleetOrderClaimsSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, reason: "malformed", seq: null };
  const claims = parsed.data;
  if (claims.sub !== expected.instanceId || claims.client !== expected.code) return { ok: false, reason: "wrong_instance", seq: claims.seq };
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (claims.exp <= claims.iat || claims.iat > nowSeconds + FLEET_MAX_CLOCK_SKEW_SECONDS || claims.exp < nowSeconds) {
    return { ok: false, reason: "expired", seq: claims.seq };
  }
  return { ok: true, claims };
}

/**
 * The hub activity log for fleet admin actions: every company on the hub,
 * the same fan-out the entitlement audit uses for instance-wide events.
 * Never a password or key in `details`.
 */
export async function logFleetActivity(
  db: Db,
  input: { actorUserId: string | null; action: string; instanceId: string; details: Record<string, unknown> },
) {
  const companyIds = await db.select({ id: companies.id }).from(companies).then((rows) => rows.map((row) => row.id));
  await Promise.all(
    companyIds.map((companyId) =>
      logActivity(db, {
        companyId,
        actorType: input.actorUserId ? "user" : "system",
        actorId: input.actorUserId ?? "fleet",
        action: input.action,
        entityType: "fleet_instance",
        entityId: input.instanceId,
        details: input.details,
      }),
    ),
  );
}

export const FLEET_TAILSCALE_TAG = "tag:gsam-customer";

/**
 * A Tailscale auth key for a new install, or null when the hub has none set up.
 * - `GSAM_FLEET_TAILSCALE_OAUTH_CLIENT_ID` and `..._SECRET`: an OAuth client
 *   with the `auth_keys` scope that owns `tag:gsam-customer`. Each install gets
 *   its own one-use, pre-approved key, good for one hour.
 * - else `GSAM_FLEET_TAILSCALE_AUTH_KEY`: a pre-made key tagged
 *   `tag:gsam-customer` (reusable, so it can serve many installs).
 * A failure to mint is logged by the caller and the install goes without.
 */
export async function fleetTailscaleAuthKey(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const clientId = env.GSAM_FLEET_TAILSCALE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GSAM_FLEET_TAILSCALE_OAUTH_CLIENT_SECRET?.trim();
  if (clientId && clientSecret) {
    const tokenRes = await fetchImpl("https://api.tailscale.com/api/v2/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!tokenRes.ok) throw new Error(`Tailscale OAuth token: HTTP ${tokenRes.status}`);
    const { access_token: accessToken } = (await tokenRes.json()) as { access_token?: string };
    if (!accessToken) throw new Error("Tailscale OAuth token: no access token");
    const keyRes = await fetchImpl("https://api.tailscale.com/api/v2/tailnet/-/keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        capabilities: { devices: { create: { reusable: false, ephemeral: false, preauthorized: true, tags: [FLEET_TAILSCALE_TAG] } } },
        expirySeconds: 3600,
        description: "GSAM for Mac install",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!keyRes.ok) throw new Error(`Tailscale auth key: HTTP ${keyRes.status}`);
    const { key } = (await keyRes.json()) as { key?: string };
    if (!key) throw new Error("Tailscale auth key: no key in the answer");
    return key;
  }
  return env.GSAM_FLEET_TAILSCALE_AUTH_KEY?.trim() || null;
}
