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
  fleetCheckInV2Schema,
  type FleetAction,
  type FleetCheckIn,
  type FleetConnections,
  type FleetLifecycle,
  type FleetPublicKey,
} from "../../packages/shared/src/fleet.js";
import { aiConnectionNeedsAttention, type AiConnectionView, type WatchSignal } from "./watch.js";

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
  /** From client-instance.json; absent means active. */
  lifecycle?: FleetLifecycle;
  /** Null when the app is not up to ask. */
  connections: FleetConnections | null;
}

const checkView = (value: { ok: boolean; at: string } | null | undefined, now: number) => {
  const age = minutesSince(value?.at, now);
  return value && age !== null ? { ok: value.ok, ageMinutes: age } : null;
};

/**
 * One alert per check over the whole instance. The `:<company id>` suffix of a
 * per-company signal is cut off and the signals of one check fold together:
 * the check fails when any company fails. A key outside the pattern is sent as
 * "other", so a new watch check never stops the check-in.
 */
export function instanceAlerts(signals: WatchSignal[]): FleetCheckIn["alerts"] {
  const folded = new Map<string, boolean>();
  for (const signal of signals) {
    const base = signal.key.split(":", 1)[0]!;
    const key = FLEET_ALERT_KEY_PATTERN.test(base) ? base : "other";
    folded.set(key, (folded.get(key) ?? true) && signal.ok);
  }
  return [...folded].slice(0, 64).map(([key, ok]) => ({ key, ok }));
}

/**
 * The check-in from host facts. Signal details (free text) are dropped: only
 * each key and pass/fail leaves the host. Throws when a value does not fit the
 * closed schema, so nothing unexpected is ever signed.
 */
export function buildCheckIn(input: CheckInInput, now = Date.now()): FleetCheckIn {
  const upgradeAge = minutesSince(input.lastUpgrade?.at, now);
  return fleetCheckInV2Schema.parse({
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
    alerts: instanceAlerts(input.signals),
    lifecycle: input.lifecycle ?? "active",
    connections: input.connections,
  });
}

/** A tool connection as GET /api/companies/:id/tools/connections lists it. Only these fields are read. */
export interface ToolConnectionView {
  connectionPurpose?: string;
  status: string;
  enabled: boolean;
}

/**
 * Connection health as counts over every company (AT-3.3). Only the numbers
 * leave this function: no name, id, provider or company. AI log-ins listed
 * among the tool connections are counted once, as AI. A tool connection is
 * active when it is switched on; disabled when it is off or turned off.
 * Drafts and archived ones are not counted.
 */
export function connectionTotals(
  companies: Array<{ ai: AiConnectionView[]; tools: ToolConnectionView[] }>,
  now = Date.now(),
): FleetConnections {
  const totals: FleetConnections = { ai: { healthy: 0, needsAttention: 0 }, tools: { active: 0, disabled: 0 } };
  for (const company of companies) {
    for (const connection of company.ai) {
      if (aiConnectionNeedsAttention(connection, now)) totals.ai.needsAttention += 1;
      else totals.ai.healthy += 1;
    }
    for (const connection of company.tools) {
      if (connection.connectionPurpose === "ai") continue;
      if (connection.status === "active" && connection.enabled) totals.tools.active += 1;
      else if (connection.status === "active" || connection.status === "disabled") totals.tools.disabled += 1;
    }
  }
  return totals;
}

export interface UsageCompany {
  agents: Array<{ status: string }>;
  runsLast24h: number;
  runsFailedLast24h: number;
  spendCents: number;
  budgetCents: number;
}

/** Run statuses counted as failed: the same rule as the failure rate (server/src/services/run-failure-rate.ts). */
export const FAILED_RUN_STATUSES = ["failed", "timed_out", "interrupted"] as const;

/** The run list API returns at most this many rows per call. */
export const RUN_PAGE_LIMIT = 1000;

/**
 * Count every run created at or after `since`. The list API caps a page at
 * 1000 rows, newest first, with `before` exclusive. Each next page asks for
 * `before` = oldest `createdAt` + 1 ms, so rows that share the oldest
 * timestamp come back again; the id set counts each run once. When a full
 * page is all one millisecond, the next page starts below it so the count
 * still moves on (only runs past 1000 in that one millisecond are lost).
 */
export async function countRunsSince(
  fetchPage: (since: Date, before: Date | null) => Promise<Array<{ id: string; createdAt: string }>>,
  since: Date,
): Promise<number> {
  const seen = new Set<string>();
  let before: Date | null = null;
  for (;;) {
    const page = await fetchPage(since, before);
    let added = 0;
    let oldest = Number.POSITIVE_INFINITY;
    for (const run of page) {
      if (!seen.has(run.id)) {
        seen.add(run.id);
        added += 1;
      }
      oldest = Math.min(oldest, Date.parse(run.createdAt));
    }
    if (page.length < RUN_PAGE_LIMIT || !Number.isFinite(oldest)) return seen.size;
    // Every row is older than `before`, so `oldest` always moves the window back.
    const stuck: boolean = added === 0 || (before !== null && oldest + 1 >= before.getTime());
    before = new Date(stuck ? oldest : oldest + 1);
  }
}

/** Totals over every company. Never per company, agent or person. */
export function usageTotals(companies: UsageCompany[], storageBytes: number): FleetCheckIn["usage"] {
  let activeAgents = 0;
  let runsLast24h = 0;
  let runsFailedLast24h = 0;
  let spendCentsMonth = 0;
  let budgetCentsMonth = 0;
  for (const company of companies) {
    activeAgents += company.agents.filter((a) => a.status !== "terminated" && a.status !== "paused" && a.status !== "pending_approval").length;
    runsLast24h += Math.max(0, Math.round(company.runsLast24h));
    runsFailedLast24h += Math.max(0, Math.round(company.runsFailedLast24h));
    spendCentsMonth += Math.max(0, Math.round(company.spendCents));
    budgetCentsMonth += Math.max(0, Math.round(company.budgetCents));
  }
  return { companies: companies.length, activeAgents, runsLast24h, runsFailedLast24h, spendCentsMonth, budgetCentsMonth, storageBytes: Math.max(0, Math.round(storageBytes)) };
}

/** What the hub's answer means for the operator. */
export function hubAnswer(status: number, body: unknown): { ok: boolean; detail: string } {
  if (status >= 200 && status < 300) return { ok: true, detail: `hub answered ${status}` };
  const code = (body as { error?: unknown } | null)?.error;
  const reason = typeof code === "string" ? code : `HTTP ${status}`;
  if (reason === "fleet_key_revoked") return { ok: false, detail: "the hub revoked this instance; ask for a new code and run fleet-register again" };
  return { ok: false, detail: `hub refused: ${reason}` };
}
