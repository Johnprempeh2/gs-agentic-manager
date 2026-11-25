// Spoke side of the fleet channel, shared by the host scripts
// (scripts/client-instance) and the GSAM server itself when it is a spoke
// (the Mac app, services/fleet-spoke.ts). Pure helpers: key, signed message,
// check-in. The check-in passes the closed schema in fleet.ts before it is
// signed, so nothing unexpected ever leaves the instance.

import { createHash, createPrivateKey, generateKeyPairSync, sign, type JsonWebKey } from "node:crypto";
import {
  FLEET_AUDIENCE,
  FLEET_CHECK_IN_SCHEMA,
  FLEET_CHECK_IN_SCHEMA_V4,
  FLEET_JWS_TYPE,
  FLEET_ALERT_KEY_PATTERN,
  FLEET_MAX_MESSAGE_LIFETIME_SECONDS,
  fleetCheckInV2Schema,
  fleetCheckInV4Schema,
  type FleetAction,
  type FleetCheckIn,
  type FleetCheckInV3,
  type FleetCheckInV4,
  type FleetConnections,
  type FleetLifecycle,
  type FleetPlatformOs,
  type FleetPublicKey,
} from "./fleet.js";
import type { FleetSupportAttachment, FleetSupportSync } from "./fleet-support.js";

/** A watch signal: one check and whether it passed. Detail text never leaves the host. */
export interface FleetSignal {
  key: string;
  ok: boolean;
}

export interface FleetKey {
  privateJwk: JsonWebKey;
  publicKey: FleetPublicKey;
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
  input: { act: FleetAction; sub: string; seq: number; checkIn?: FleetCheckIn | FleetCheckInV3; support?: FleetSupportSync; attachment?: FleetSupportAttachment },
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
    ...(input.support ? { support: input.support } : {}),
    ...(input.attachment ? { attachment: input.attachment } : {}),
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
  signals: FleetSignal[];
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
export function instanceAlerts(signals: FleetSignal[]): FleetCheckIn["alerts"] {
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

/** The operating system and CPU as the v4 check-in names them. */
export function fleetPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): FleetCheckInV4["platform"] {
  const os: FleetPlatformOs = platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux";
  return { os, arch: arch === "arm64" || arch === "x64" ? arch : "other" };
}

/** The app spoke's check-in (v4): the v2 facts plus order results, its lifecycle, its tailnet name and its platform. */
export function macCheckIn(
  base: FleetCheckIn,
  extras: {
    lifecycle: FleetCheckInV3["lifecycle"];
    orders: FleetCheckInV3["orders"];
    tailnetName: string | null;
    platform?: FleetCheckInV4["platform"];
  },
): FleetCheckInV4 {
  return fleetCheckInV4Schema.parse({
    ...base,
    schema: FLEET_CHECK_IN_SCHEMA_V4,
    lifecycle: extras.lifecycle,
    orders: extras.orders,
    remote: { tailnetName: extras.tailnetName },
    platform: extras.platform ?? fleetPlatform(),
  });
}
