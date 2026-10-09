// Spoke side of the fleet channel (GRE-1082). Pure helpers, tested without a
// server; client-instance.ts reads the inputs and calls the hub.
//
// The instance makes its own Ed25519 key pair. The private key stays in
// <root>/fleet/key.json (mode 600) and is never sent; the hub gets the public
// key once, with the one-time code. Each message is a compact JWS the hub
// checks with that key. The check-in is built only from facts already on the
// host (client-instance.json, the watch signals, usage totals) and passes the
// closed schema in packages/shared/src/fleet.ts before it is signed.

import { createHash, createPrivateKey, generateKeyPairSync, sign, type JsonWebKey } from "node:crypto";
import {
  FLEET_AUDIENCE,
  FLEET_CHECK_IN_SCHEMA,
  FLEET_JWS_TYPE,
  FLEET_ALERT_KEY_PATTERN,
  FLEET_MAX_MESSAGE_LIFETIME_SECONDS,
  fleetCheckInSchema,
  type FleetAction,
  type FleetCheckIn,
  type FleetPublicKey,
} from "../../packages/shared/src/fleet.js";
import type { WatchSignal } from "./watch.js";

export interface FleetKey {
  privateJwk: JsonWebKey;
  publicKey: FleetPublicKey;
}

/** Kept in <root>/fleet/hub.json. No secret in it. */
export interface FleetRegistration {
  hubUrl: string;
  instanceId: string;
  code: string;
  registeredAt: string;
  /** The last `seq` sent; the next message must be higher. */
  lastSeq: number;
  lastCheckIn?: { at: string; ok: boolean; detail: string };
}

export function generateFleetKey(): FleetKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateJwk = privateKey.export({ format: "jwk" });
  return { privateJwk, publicKey: { kty: "OKP", crv: "Ed25519", x: privateJwk.x! } };
}

/** The hub's base URL: https, or http on loopback only (sandbox tests). */
export function fleetHubUrl(raw: string): string | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `hub URL ${raw} is not a URL` };
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return { error: "hub URL must be https://<host>" };
  if (url.search || url.hash || url.username || url.password) return { error: "hub URL takes no query, fragment or log-in" };
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** Milliseconds, and always above the last one sent, so the hub's replay fence never refuses an honest message. */
export function nextSeq(lastSeq: number, now = Date.now()): number {
  return Math.max(now, lastSeq + 1);
}

export function registrationSubject(registrationCode: string): string {
  return createHash("sha256").update(registrationCode, "utf8").digest("base64url");
}

export function signFleetMessage(
  privateJwk: JsonWebKey,
  input: { act: FleetAction; sub: string; seq: number; checkIn?: FleetCheckIn },
  now = Date.now(),
): string {
  const iat = Math.floor(now / 1000);
  const header = { alg: "EdDSA", typ: FLEET_JWS_TYPE, ...(input.act === "register" ? {} : { kid: input.sub }) };
  const claims = {
    v: 1,
    aud: FLEET_AUDIENCE,
    act: input.act,
    sub: input.sub,
    iat,
    exp: iat + FLEET_MAX_MESSAGE_LIFETIME_SECONDS,
    seq: input.seq,
    ...(input.checkIn ? { checkIn: input.checkIn } : {}),
  };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode(header)}.${encode(claims)}`;
  const signature = sign(null, Buffer.from(signingInput), createPrivateKey({ key: privateJwk, format: "jwk" }));
  return `${signingInput}.${signature.toString("base64url")}`;
}

const minutesSince = (iso: string | null | undefined, now: number): number | null => {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 60_000)) : null;
};

export interface CheckInInput {
  edition: FleetCheckIn["edition"];
  appUp: boolean;
  /** Modified time of the newest backup file, or null. */
  newestBackupAt: string | null;
  lastRestoreCheck?: { ok: boolean; at: string } | null;
  lastOffsiteBackup?: { ok: boolean; at: string } | null;
  releaseTag: string | null;
  appVersion: string | null;
  lastUpgrade?: { to: { tag: string | null }; at: string } | null;
  usage: FleetCheckIn["usage"];
  signals: WatchSignal[];
}

const checkView = (value: { ok: boolean; at: string } | null | undefined, now: number) => {
  const age = minutesSince(value?.at, now);
  return value && age !== null ? { ok: value.ok, ageMinutes: age } : null;
};

/**
 * The check-in from host facts. Signal details (free text) are dropped: only
 * each key and pass/fail leaves the host. Throws when a value does not fit the
 * closed schema, so nothing unexpected is ever signed.
 */
export function buildCheckIn(input: CheckInInput, now = Date.now()): FleetCheckIn {
  const upgradeAge = minutesSince(input.lastUpgrade?.at, now);
  return fleetCheckInSchema.parse({
    schema: FLEET_CHECK_IN_SCHEMA,
    edition: input.edition,
    health: {
      app: input.appUp ? "ok" : "down",
      backupAgeMinutes: minutesSince(input.newestBackupAt, now),
      restoreCheck: checkView(input.lastRestoreCheck, now),
      offsiteBackup: checkView(input.lastOffsiteBackup, now),
    },
    version: {
      releaseTag: input.releaseTag,
      appVersion: input.appVersion,
      lastUpgrade: input.lastUpgrade && upgradeAge !== null ? { toTag: input.lastUpgrade.to.tag, ageMinutes: upgradeAge } : null,
    },
    usage: input.usage,
    // A key outside the pattern is sent as "other", so a new watch check never stops the check-in.
    alerts: input.signals.slice(0, 64).map((s) => ({ key: FLEET_ALERT_KEY_PATTERN.test(s.key) ? s.key : "other", ok: s.ok })),
  });
}

export interface UsageCompany {
  agents: Array<{ status: string }>;
  runs: Array<{ createdAt?: string | null }>;
  spendCents: number;
  budgetCents: number;
}

/** Totals over every company. Never per company, agent or person. */
export function usageTotals(companies: UsageCompany[], storageBytes: number, now = Date.now()): FleetCheckIn["usage"] {
  const dayAgo = now - 24 * 60 * 60 * 1000;
  let activeAgents = 0;
  let runsLast24h = 0;
  let spendCentsMonth = 0;
  let budgetCentsMonth = 0;
  for (const company of companies) {
    activeAgents += company.agents.filter((a) => a.status !== "terminated" && a.status !== "paused" && a.status !== "pending_approval").length;
    runsLast24h += company.runs.filter((r) => Date.parse(r.createdAt ?? "") >= dayAgo).length;
    spendCentsMonth += Math.max(0, Math.round(company.spendCents));
    budgetCentsMonth += Math.max(0, Math.round(company.budgetCents));
  }
  return { companies: companies.length, activeAgents, runsLast24h, spendCentsMonth, budgetCentsMonth, storageBytes: Math.max(0, Math.round(storageBytes)) };
}

/** What the hub's answer means for the operator. */
export function hubAnswer(status: number, body: unknown): { ok: boolean; detail: string } {
  if (status >= 200 && status < 300) return { ok: true, detail: `hub answered ${status}` };
  const code = (body as { error?: unknown } | null)?.error;
  const reason = typeof code === "string" ? code : `HTTP ${status}`;
  if (reason === "fleet_key_revoked") return { ok: false, detail: "the hub revoked this instance; ask for a new code and run fleet-register again" };
  return { ok: false, detail: `hub refused: ${reason}` };
}
