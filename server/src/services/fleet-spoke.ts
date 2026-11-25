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
 * - Check-in: every 5 minutes, a signed check-in to the hub (the closed
 *   schema, v3). The answer carries the hub's newest signed entitlement
 *   document; a good one is written to the entitlement file and applied at
 *   once. It also carries signed operator orders (P2): pause, resume, stop,
 *   update. Each is checked against the pinned hub key, obeyed once in seq
 *   order, and its result goes in the next check-in.
 */

import { execFile, execFileSync } from "node:child_process";
import { randomBytes, randomUUID, type JsonWebKey } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { agents, authAccounts, authUsers, companies, heartbeatRuns, instanceUserRoles, invites, type Db } from "@greatstone/db";
import {
  FLEET_CHECK_IN_INTERVAL_SECONDS,
  FLEET_TAILNET_NAME_PATTERN,
  type FleetCheckIn,
  type FleetCheckInResponse,
  type FleetOrderReport,
} from "@greatstone/shared/fleet";
import { buildCheckIn, macCheckIn, nextSeq, signFleetMessage } from "@greatstone/shared/fleet-spoke";
import { hashInviteToken } from "../lib/invite-token-hash.js";
import { logger } from "../middleware/logger.js";
import { parseEntitlementPublicKey, readEntitlementConfig, verifyEntitlementEnvelope } from "./entitlement-document.js";
import { getEntitlementRuntime } from "./entitlement-runtime.js";
import { fleetSpokePaths, readFleetSpokeConfig, type FleetSpokeConfig } from "./fleet-spoke-config.js";
import { instanceSettingsService } from "./instance-settings.js";
import { verifyFleetOrder } from "./fleet-orders.js";
import { setServiceHoldSpoke } from "./service-hold.js";

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

// ---------------------------------------------------------------- orders

const ORDER_RESULTS_KEPT = 50;

export interface SpokeOrders {
  /** The highest order seq obeyed or refused. An order at or below it is never obeyed again. */
  lastSeq: number;
  hold: "paused" | "stopped" | null;
  results: Array<FleetOrderReport & { reported: boolean }>;
}

export function readSpokeOrders(paths: Paths): SpokeOrders {
  const saved = readJson<Partial<SpokeOrders>>(paths.orders);
  return {
    lastSeq: typeof saved?.lastSeq === "number" ? saved.lastSeq : 0,
    hold: saved?.hold === "paused" || saved?.hold === "stopped" ? saved.hold : null,
    results: Array.isArray(saved?.results) ? saved.results : [],
  };
}

function record(orders: SpokeOrders, report: FleetOrderReport) {
  orders.results = [...orders.results.filter((r) => r.seq !== report.seq), { ...report, reported: false }].slice(-ORDER_RESULTS_KEPT);
}

/**
 * The command that runs this install's updater now: the `<label>.update`
 * LaunchAgent gsam.sh made on a Mac, the `<label>.update` scheduled task
 * gsam.ps1 made on Windows. Null where there is none.
 */
export function updaterCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  uid: number = process.getuid?.() ?? 0,
): { file: string; args: string[] } | null {
  const valid = (label: string | undefined) => (label && /^[A-Za-z0-9.-]{1,120}$/.test(label.trim()) ? label.trim() : null);
  if (platform === "darwin") {
    const label = valid(env.GSAM_LAUNCHD_LABEL);
    return label ? { file: "launchctl", args: ["kickstart", `gui/${uid}/${label}.update`] } : null;
  }
  if (platform === "win32") {
    const label = valid(env.GSAM_SCHEDULED_TASK);
    return label ? { file: "schtasks.exe", args: ["/Run", "/TN", `${label}.update`] } : null;
  }
  return null;
}

/** Start this install's updater now (an "update now" order). */
export function kickUpdater(env: NodeJS.ProcessEnv = process.env): Promise<FleetOrderReport["code"]> {
  const command = updaterCommand(env);
  if (!command) return Promise.resolve("update_unavailable");
  return new Promise((resolve) => {
    execFile(command.file, command.args, { timeout: 10_000, windowsHide: true }, (err) => resolve(err ? "update_failed" : null));
  });
}

/**
 * Obey signed orders from a check-in answer, oldest first. Each verified order
 * above `lastSeq` is obeyed once; an older one is reported again, never
 * obeyed again. An expired one is refused. A badly signed one, or one for
 * another install, is dropped and logged: nothing about it can be trusted.
 * The file is written before an update is started, so a restart never
 * loses the result.
 */
export async function obeySpokeOrders(
  messages: string[],
  config: FleetSpokeConfig,
  paths: Paths,
  deps: { runUpdate?: () => Promise<FleetOrderReport["code"]>; now?: Date } = {},
): Promise<string[]> {
  const orders = readSpokeOrders(paths);
  const done: string[] = [];
  const checked = messages
    .map((message) => verifyFleetOrder(message, config.entitlementPublicKey, { instanceId: config.instanceId, code: config.code }, deps.now))
    .sort((a, b) => (a.ok ? a.claims.seq : (a.seq ?? 0)) - (b.ok ? b.claims.seq : (b.seq ?? 0)));
  for (const check of checked) {
    if (!check.ok) {
      if (check.reason === "expired" && check.seq !== null && check.seq > orders.lastSeq) {
        record(orders, { seq: check.seq, result: "refused", code: "expired" });
        orders.lastSeq = check.seq;
        writePrivate(paths.orders, orders);
      }
      logger.warn({ reason: check.reason, seq: check.seq }, "fleet spoke: order refused");
      continue;
    }
    const { seq, kind } = check.claims;
    if (seq <= orders.lastSeq) {
      const previous = orders.results.find((r) => r.seq === seq);
      record(orders, previous ? { seq, result: previous.result, code: previous.code } : { seq, result: "refused", code: "already_handled" });
      writePrivate(paths.orders, orders);
      continue;
    }
    orders.lastSeq = seq;
    if (kind === "update") {
      record(orders, { seq, result: "done", code: null });
      writePrivate(paths.orders, orders);
      const code = await (deps.runUpdate ?? kickUpdater)();
      if (code) {
        record(orders, { seq, result: "failed", code });
        writePrivate(paths.orders, orders);
      }
    } else {
      orders.hold = kind === "pause" ? "paused" : kind === "stop" ? "stopped" : null;
      record(orders, { seq, result: "done", code: null });
      writePrivate(paths.orders, orders);
      setServiceHoldSpoke(true, orders.hold);
    }
    done.push(`${kind} #${seq}`);
    logger.info({ kind, seq }, "fleet spoke: order obeyed");
  }
  return done;
}

function tailnetName(paths: Paths): string | null {
  const name = readJson<{ name?: string }>(paths.tailnet)?.name?.replace(/\.$/, "").toLowerCase() ?? null;
  return name && FLEET_TAILNET_NAME_PATTERN.test(name) ? name : null;
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
  input: {
    config: FleetSpokeConfig;
    paths: Paths;
    backupDir: string;
    appVersion: string | null;
    releaseTag: string | null;
    entitlementFile: string | null;
    runUpdate?: () => Promise<FleetOrderReport["code"]>;
  },
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
    const orders = readSpokeOrders(paths);
    const reports = orders.results.filter((r) => !r.reported).map(({ seq, result, code }) => ({ seq, result, code }));
    const base = buildCheckIn({
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
    const checkIn = macCheckIn(base, {
      lifecycle: orders.hold ?? "active",
      orders: reports,
      tailnetName: tailnetName(paths),
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
      // The hub recorded these results in the same step that answered; never send them again.
      if (reports.length > 0) {
        const sent = new Set(reports.map((r) => r.seq));
        const latest = readSpokeOrders(paths);
        latest.results = latest.results.map((r) => (sent.has(r.seq) ? { ...r, reported: true } : r));
        writePrivate(paths.orders, latest);
      }
      if (body?.entitlement && input.entitlementFile) {
        try {
          const version = await applyHubEntitlement(body.entitlement, config, input.entitlementFile);
          if (version !== null) detail += `, entitlement document v${version} applied`;
        } catch (err) {
          detail += `, entitlement document refused: ${(err as Error).message}`;
        }
      }
      if (Array.isArray(body?.orders) && body.orders.length > 0) {
        const obeyed = await obeySpokeOrders(body.orders.filter((m): m is string => typeof m === "string"), config, paths, { runUpdate: input.runUpdate });
        if (obeyed.length > 0) detail += `, orders obeyed: ${obeyed.join(", ")}`;
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
  setServiceHoldSpoke(true, readSpokeOrders(paths).hold);
  // The operator log-in has no phone; compulsory two-step sign-in leaves it out.
  const exempt = process.env.GSAM_TWO_STEP_EXEMPT_EMAILS?.trim();
  process.env.GSAM_TWO_STEP_EXEMPT_EMAILS = exempt ? `${exempt},${config.operatorEmail}` : config.operatorEmail;
  const baseUrl = `http://localhost:${opts.port}`;
  const tag = releaseTag();
  // Sandbox tests may check in more often (GSAM_FLEET_CHECK_IN_SECONDS, 15 or more); installs use 5 minutes.
  const checkInSeconds = Math.max(15, Number.parseInt(process.env.GSAM_FLEET_CHECK_IN_SECONDS ?? "", 10) || FLEET_CHECK_IN_INTERVAL_SECONDS);
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
      .finally(() => later(checkIn, checkInSeconds * 1000));
  };
  setup();
  later(checkIn, 15_000);
  logger.info({ hubUrl: config.hubUrl, instanceId: config.instanceId }, "fleet spoke: on");
  return () => {
    stopped = true;
    for (const timer of timers.values()) clearTimeout(timer);
  };
}
