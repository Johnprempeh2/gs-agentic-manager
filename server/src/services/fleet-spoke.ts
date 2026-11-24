/**
 * The GSAM server as a fleet spoke (GSAM for Mac, P1). Runs only when the
 * Mac app's activation wrote `fleet/spoke.json` (fleet-spoke-config.ts).
 *
 * Two jobs:
 * - Set-up: while no owner exists, keep a one-time bootstrap invite link in
 *   `fleet/owner-invite.json` for the app to open. Once the owner has made
 *   their log-in, make the Greatstone operator log-in (instance admin) from
 *   `fleet/operator.json`, delete that file, and set backups to 30 days.
 *   The owner comes first because a bootstrap invite only makes the FIRST
 *   instance admin.
 * - Check-in: every 5 minutes, a signed check-in to the hub (the same closed
 *   schema the host scripts send). The answer carries the hub's newest signed
 *   entitlement document; a good one is written to the entitlement file and
 *   applied at once.
 */

import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID, type JsonWebKey } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { agents, authAccounts, authUsers, companies, heartbeatRuns, instanceUserRoles, invites, type Db } from "@greatstone/db";
import { FLEET_CHECK_IN_INTERVAL_SECONDS, type FleetCheckIn, type FleetCheckInResponse } from "@greatstone/shared/fleet";
import { buildCheckIn, nextSeq, signFleetMessage } from "@greatstone/shared/fleet-spoke";
import { hashInviteToken } from "../lib/invite-token-hash.js";
import { logger } from "../middleware/logger.js";
import { parseEntitlementPublicKey, readEntitlementConfig, verifyEntitlementEnvelope } from "./entitlement-document.js";
import { getEntitlementRuntime } from "./entitlement-runtime.js";
import { fleetSpokePaths, readFleetSpokeConfig, type FleetSpokeConfig } from "./fleet-spoke-config.js";
import { instanceSettingsService } from "./instance-settings.js";

const LOCAL_BOARD_USER_ID = "local-board";
const OWNER_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SETUP_POLL_MS = 10_000;
const FAILED_RUN_STATUSES = ["failed", "timed_out", "interrupted"];

type Paths = ReturnType<typeof fleetSpokePaths>;

function writePrivate(file: string, value: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- set-up

/** Instance admins other than the local board and the operator log-in: the owner, once they have signed up. */
async function ownerExists(db: Db, operatorEmail: string) {
  const rows = await db
    .select({ userId: instanceUserRoles.userId, email: authUsers.email })
    .from(instanceUserRoles)
    .leftJoin(authUsers, eq(authUsers.id, instanceUserRoles.userId))
    .where(eq(instanceUserRoles.role, "instance_admin"));
  return rows.some((row) => row.userId !== LOCAL_BOARD_USER_ID && row.email?.toLowerCase() !== operatorEmail.toLowerCase());
}

/** A pending bootstrap invite whose link is in the file, or a new one (older pending ones are revoked). */
async function ensureOwnerInvite(db: Db, paths: Paths, baseUrl: string, now = new Date()) {
  const saved = readJson<{ token?: string }>(paths.ownerInvite);
  if (saved?.token) {
    const live = await db
      .select({ id: invites.id })
      .from(invites)
      .where(and(eq(invites.tokenHash, hashInviteToken(saved.token)), isNull(invites.acceptedAt), isNull(invites.revokedAt), gt(invites.expiresAt, now)))
      .then((rows) => rows[0] ?? null);
    if (live) return;
  }
  await db
    .update(invites)
    .set({ revokedAt: now, updatedAt: now })
    .where(and(eq(invites.inviteType, "bootstrap_ceo"), isNull(invites.revokedAt), isNull(invites.acceptedAt)));
  const token = `pcp_bootstrap_${randomBytes(24).toString("hex")}`;
  const expiresAt = new Date(now.getTime() + OWNER_INVITE_TTL_MS);
  await db.insert(invites).values({
    inviteType: "bootstrap_ceo",
    tokenHash: hashInviteToken(token),
    allowedJoinTypes: "human",
    expiresAt,
    invitedByUserId: "system",
  });
  writePrivate(paths.ownerInvite, { token, url: `${baseUrl}/invite/${token}`, expiresAt: expiresAt.toISOString() });
  logger.info("fleet spoke: owner set-up link ready");
}

/** The Greatstone operator log-in as an instance admin. Run again, it sets the same password and keeps one role. */
export async function ensureOperatorLogin(db: Db, input: { email: string; password: string }) {
  const email = input.email.trim().toLowerCase();
  const passwordHash = await hashPassword(input.password);
  await db.transaction(async (tx) => {
    const now = new Date();
    let userId = await tx
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(sql`lower(${authUsers.email}) = ${email}`)
      .then((rows) => rows[0]?.id ?? null);
    if (!userId) {
      userId = randomUUID();
      await tx.insert(authUsers).values({ id: userId, name: "Greatstone operator", email, emailVerified: false, createdAt: now, updatedAt: now });
      await tx.insert(authAccounts).values({
        id: randomUUID(),
        issuer: "local:credential",
        accountId: userId,
        providerId: "credential",
        userId,
        password: passwordHash,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      await tx
        .update(authAccounts)
        .set({ password: passwordHash, updatedAt: now })
        .where(and(eq(authAccounts.userId, userId), eq(authAccounts.providerId, "credential")));
    }
    const hasRole = await tx
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows.length > 0);
    if (!hasRole) await tx.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
  });
}

/** One set-up step. True when set-up is finished (no operator file left). */
export async function advanceSpokeSetup(db: Db, config: FleetSpokeConfig, paths: Paths, baseUrl: string): Promise<boolean> {
  if (!existsSync(paths.operator)) return true;
  if (!(await ownerExists(db, config.operatorEmail))) {
    await ensureOwnerInvite(db, paths, baseUrl);
    return false;
  }
  rmSync(paths.ownerInvite, { force: true });
  const operator = readJson<{ email?: string; password?: string }>(paths.operator);
  if (!operator?.email || !operator.password) throw new Error("fleet/operator.json is not readable");
  await ensureOperatorLogin(db, { email: operator.email, password: operator.password });
  // Hourly backups (the config's interval), every one kept 30 days.
  await instanceSettingsService(db).updateGeneral({ backupRetention: { dailyDays: 30, weeklyWeeks: 4, monthlyMonths: 1 } });
  rmSync(paths.operator, { force: true });
  logger.info("fleet spoke: owner found, operator log-in made, set-up finished");
  return true;
}

// ---------------------------------------------------------------- check-in

function newestFileMtime(dir: string): string | null {
  try {
    let newest = 0;
    for (const name of readdirSync(dir)) newest = Math.max(newest, statSync(path.join(dir, name)).mtimeMs);
    return newest > 0 ? new Date(newest).toISOString() : null;
  } catch {
    return null;
  }
}

function releaseTag(): string | null {
  try {
    const tag = execFileSync("git", ["describe", "--tags", "--exact-match", "HEAD"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^[A-Za-z0-9._-]{1,80}$/.test(tag) ? tag : null;
  } catch {
    return null;
  }
}

async function usage(db: Db): Promise<FleetCheckIn["usage"]> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const n = (rows: Array<{ n: number | string | null }>) => Number(rows[0]?.n ?? 0);
  const [companyTotals] = await db
    .select({ n: sql<number>`count(*)`, spend: sql<number>`coalesce(sum(${companies.spentMonthlyCents}), 0)`, budget: sql<number>`coalesce(sum(${companies.budgetMonthlyCents}), 0)` })
    .from(companies);
  const activeAgents = n(await db.select({ n: sql<number>`count(*)` }).from(agents).where(sql`${agents.status} not in ('terminated', 'paused', 'pending_approval')`));
  const runs = n(await db.select({ n: sql<number>`count(*)` }).from(heartbeatRuns).where(gt(heartbeatRuns.createdAt, since)));
  const failed = n(
    await db.select({ n: sql<number>`count(*)` }).from(heartbeatRuns).where(and(gt(heartbeatRuns.createdAt, since), inArray(heartbeatRuns.status, FAILED_RUN_STATUSES))),
  );
  return {
    companies: Number(companyTotals?.n ?? 0),
    activeAgents,
    runsLast24h: runs,
    runsFailedLast24h: failed,
    spendCentsMonth: Math.max(0, Number(companyTotals?.spend ?? 0)),
    budgetCentsMonth: Math.max(0, Number(companyTotals?.budget ?? 0)),
    // ponytail: storage size is not measured on the Mac yet; add a folder walk if the hub needs it.
    storageBytes: 0,
  };
}

interface SpokeState {
  lastSeq: number;
  lastCheckIn?: { at: string; ok: boolean; detail: string };
}

/**
 * Write a document from the hub when it is signed by the pinned key, is for
 * this instance, and differs from the file. Returns its version, or null when
 * nothing changed.
 */
export async function applyHubEntitlement(envelope: unknown, config: FleetSpokeConfig, filePath: string): Promise<number | null> {
  const text = `${JSON.stringify(envelope)}\n`;
  const document = verifyEntitlementEnvelope(text, parseEntitlementPublicKey(config.entitlementPublicKey), config.code);
  const current = readJson<{ document?: string; signature?: string }>(filePath);
  const next = envelope as { document: string; signature: string };
  if (current?.document === next.document && current.signature === next.signature) return null;
  writePrivate(filePath, envelope);
  await getEntitlementRuntime()?.sync({ trigger: "file_reload" });
  return document.version;
}

export async function sendSpokeCheckIn(
  db: Db,
  input: { config: FleetSpokeConfig; paths: Paths; backupDir: string; appVersion: string | null; releaseTag: string | null; entitlementFile: string | null },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; detail: string }> {
  const { config, paths } = input;
  const key = readJson<{ privateJwk: JsonWebKey }>(paths.key);
  if (!key?.privateJwk) return { ok: false, detail: "fleet/key.json is missing" };
  const state = readJson<SpokeState>(paths.state) ?? { lastSeq: 0 };
  const seq = nextSeq(state.lastSeq);
  // Kept before sending, so a crash never sends the same seq twice.
  writePrivate(paths.state, { ...state, lastSeq: seq });
  let outcome: { ok: boolean; detail: string };
  try {
    const checkIn = buildCheckIn({
      edition: "managed",
      appUp: true,
      newestBackupAt: newestFileMtime(input.backupDir),
      // The Mac has no restore check or off-site copy.
      lastRestoreCheck: null,
      lastOffsiteBackup: null,
      releaseTag: input.releaseTag,
      appVersion: input.appVersion && /^[0-9A-Za-z.+-]{1,40}$/.test(input.appVersion) ? input.appVersion : null,
      usage: await usage(db),
      signals: [],
      connections: null,
    });
    const message = signFleetMessage(key.privateJwk, { act: "check-in", sub: config.instanceId, seq, checkIn });
    const res = await fetchImpl(`${config.hubUrl}/api/fleet/spoke/check-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => null)) as (FleetCheckInResponse & { error?: string }) | null;
    if (!res.ok) {
      outcome = { ok: false, detail: `hub refused: ${body?.error ?? `HTTP ${res.status}`}` };
    } else {
      let detail = `hub answered ${res.status}`;
      if (body?.entitlement && input.entitlementFile) {
        try {
          const version = await applyHubEntitlement(body.entitlement, config, input.entitlementFile);
          if (version !== null) detail += `, entitlement document v${version} applied`;
        } catch (err) {
          detail += `, entitlement document refused: ${(err as Error).message}`;
        }
      }
      outcome = { ok: true, detail };
    }
  } catch (err) {
    outcome = { ok: false, detail: `check-in failed: ${(err as Error).message}` };
  }
  writePrivate(paths.state, { lastSeq: seq, lastCheckIn: { at: new Date().toISOString(), ...outcome } });
  return outcome;
}

// ---------------------------------------------------------------- start

/** Starts both jobs when this instance is a spoke. Returns a stop function, or null when it is not a spoke. */
export function startFleetSpoke(opts: { db: Db; instanceRoot: string; port: number; backupDir: string; appVersion: string | null }) {
  const config = readFleetSpokeConfig(opts.instanceRoot);
  if (!config) return null;
  const paths = fleetSpokePaths(opts.instanceRoot);
  // The operator log-in has no phone; compulsory two-step sign-in leaves it out.
  const exempt = process.env.GSAM_TWO_STEP_EXEMPT_EMAILS?.trim();
  process.env.GSAM_TWO_STEP_EXEMPT_EMAILS = exempt ? `${exempt},${config.operatorEmail}` : config.operatorEmail;
  const baseUrl = `http://localhost:${opts.port}`;
  const tag = releaseTag();
  let stopped = false;
  const timers = new Map<() => void, NodeJS.Timeout>();
  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    timers.set(fn, timer);
  };

  const setup = () => {
    if (stopped) return;
    advanceSpokeSetup(opts.db, config, paths, baseUrl)
      .then((done) => {
        if (!done) later(setup, SETUP_POLL_MS);
      })
      .catch((err) => {
        logger.error({ err }, "fleet spoke: set-up step failed");
        later(setup, SETUP_POLL_MS);
      });
  };
  const checkIn = () => {
    if (stopped) return;
    const entitlementFile = (() => {
      try {
        return readEntitlementConfig()?.filePath ?? null;
      } catch {
        return null;
      }
    })();
    sendSpokeCheckIn(opts.db, { config, paths, backupDir: opts.backupDir, appVersion: opts.appVersion, releaseTag: tag, entitlementFile })
      .then((outcome) => (outcome.ok ? logger.info(outcome, "fleet spoke: check-in") : logger.warn(outcome, "fleet spoke: check-in")))
      .finally(() => later(checkIn, FLEET_CHECK_IN_INTERVAL_SECONDS * 1000));
  };
  setup();
  later(checkIn, 15_000);
  logger.info({ hubUrl: config.hubUrl, instanceId: config.instanceId }, "fleet spoke: on");
  return () => {
    stopped = true;
    for (const timer of timers.values()) clearTimeout(timer);
  };
}
