/**
 * Memory ingest outbox (ADR-0001, GRE-673).
 *
 * The gateway never calls the engine on the write path. A contribution writes
 * its `memory_records` row and an outbox entry in one transaction; this drain
 * delivers the entry to the engine later.
 *
 * Rules:
 * - A Claude plan limit or an engine outage DEFERS the entry. It stays queued
 *   and is retried later. There is no `failed` state.
 * - There is exactly one engine route. Nothing here can switch to another
 *   (paid) model provider.
 * - Delivery is at-least-once. The engine call is idempotent because the
 *   Hindsight `document_id` is the GSAM record id, so a replay replaces the
 *   same document.
 * - A claim carries a lease. A worker that dies mid-call leaves a lease that
 *   expires, and the entry is claimed again.
 */

import { randomUUID } from "node:crypto";
import {
  MEMORY_ENGINE_TIMEOUT_MS,
  withEngineTimeout,
  type MemoryEngine,
  type MemoryEngineDocument,
} from "./engine.js";

export type MemoryIngestOp = "retain" | "delete" | "retag";

export type MemoryIngestState =
  | "pending"
  | "in_flight"
  | "synced"
  /** A permanent engine rejection (bad request). Kept, never dropped; a named owner must look. */
  | "needs_attention";

export type MemoryEngineErrorKind =
  | "plan_limit"
  | "engine_unavailable"
  | "transient"
  | "rejected";

export interface MemoryIngestUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface MemoryIngestEntry {
  id: string;
  companyId: string;
  recordId: string;
  op: MemoryIngestOp;
  payload: Record<string, unknown>;
  state: MemoryIngestState;
  attempts: number;
  nextAttemptAt: Date;
  leaseUntil: Date | null;
  claimToken: string | null;
  lastErrorKind: MemoryEngineErrorKind | null;
  lastError: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  syncedAt: Date | null;
  createdAt: Date;
}

/**
 * Storage for the outbox. Every write after a claim is guarded by the claim
 * token, so a worker whose lease expired cannot overwrite a newer outcome.
 * Guarded writes return false when the token no longer matches.
 */
export interface MemoryIngestStore {
  enqueue(input: {
    companyId: string;
    recordId: string;
    op: MemoryIngestOp;
    payload: Record<string, unknown>;
    now: Date;
  }): Promise<MemoryIngestEntry>;
  /** Claims due `pending` entries and `in_flight` entries whose lease has expired. */
  claimDue(input: {
    now: Date;
    limit: number;
    leaseMs: number;
    newToken: () => string;
  }): Promise<MemoryIngestEntry[]>;
  markSynced(
    id: string,
    claimToken: string,
    input: { now: Date; usage: MemoryIngestUsage | null },
  ): Promise<boolean>;
  defer(
    id: string,
    claimToken: string,
    input: {
      now: Date;
      nextAttemptAt: Date;
      kind: MemoryEngineErrorKind;
      error: string;
      /** False when the entry was never sent (the pass halted before it). */
      countAttempt: boolean;
    },
  ): Promise<boolean>;
  park(
    id: string,
    claimToken: string,
    input: { now: Date; kind: MemoryEngineErrorKind; error: string },
  ): Promise<boolean>;
  listSyncedSince(input: {
    companyId: string;
    since: Date;
  }): Promise<MemoryIngestEntry[]>;
}

/** The single engine route. Implemented by the gateway's Hindsight adapter. */
export interface MemoryIngestEngine {
  apply(entry: MemoryIngestEntry): Promise<{ usage?: MemoryIngestUsage | null }>;
}

/** Payload of a `delete` entry. */
export interface MemoryIngestDeletePayload {
  bankId: string;
  documentId: string;
}

/**
 * The drain's single engine route: the gateway's configured `MemoryEngine`.
 * A `retain` payload is the exact `MemoryEngineDocument` built in
 * `contribute()`. Every call is bounded so a stuck engine cannot hold a lease.
 */
export function memoryIngestEngineFor(
  engine: MemoryEngine,
  options: { timeoutMs?: number } = {},
): MemoryIngestEngine {
  const timeoutMs = options.timeoutMs ?? MEMORY_ENGINE_TIMEOUT_MS;
  return {
    async apply(entry) {
      if (entry.op === "retain") {
        const result = await withEngineTimeout(
          Promise.resolve().then(() => engine.retain(entry.payload as unknown as MemoryEngineDocument)),
          timeoutMs,
        );
        return { usage: result?.usage ?? null };
      }
      if (entry.op === "delete") {
        const payload = entry.payload as unknown as MemoryIngestDeletePayload;
        await withEngineTimeout(
          Promise.resolve().then(() => engine.deleteDocument(payload.bankId, payload.documentId)),
          timeoutMs,
        );
        return { usage: null };
      }
      // No engine call for this op yet: park it for a named owner, never drop it.
      throw Object.assign(new Error(`Memory ingest op "${entry.op}" is not supported yet`), { status: 422 });
    },
  };
}

export interface ClassifiedEngineError {
  kind: MemoryEngineErrorKind;
  /** When the engine said when to come back (for example a plan reset time). */
  retryAt: Date | null;
  message: string;
}

const PLAN_LIMIT_PATTERNS = [
  /hit your (?:\w+[ -])?limit/i,
  /usage limit/i,
  /(?:weekly|daily|session|5-hour|opus|sonnet) limit/i,
  /rate[ _-]?limit/i,
  /quota/i,
  /api_error_status["']?\s*[:=]\s*429/i,
];

const UNAVAILABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** The error and its `cause` chain. The gateway adapter wraps engine errors, so the detail is often in a cause. */
function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current != null; depth += 1) {
    chain.push(current);
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return chain;
}

function errorText(error: unknown): string {
  const parts: string[] = [];
  for (const link of errorChain(error)) {
    if (typeof link === "string") {
      parts.push(link);
      continue;
    }
    if (typeof link !== "object" || link === null) {
      parts.push(String(link));
      continue;
    }
    const e = link as { message?: unknown; detail?: unknown; body?: unknown };
    if (typeof e.message === "string" && e.message) parts.push(e.message);
    for (const extra of [e.detail, e.body]) {
      if (typeof extra === "string") parts.push(extra);
      else if (extra != null) parts.push(JSON.stringify(extra));
    }
  }
  return parts.join(" | ") || "unknown error";
}

function errorStatus(error: unknown): number | null {
  for (const link of errorChain(error)) {
    if (!link || typeof link !== "object") continue;
    const e = link as { status?: unknown; statusCode?: unknown };
    const status = typeof e.status === "number" ? e.status : e.statusCode;
    if (typeof status === "number") return status;
  }
  return null;
}

function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  for (const link of errorChain(error)) {
    if (!link || typeof link !== "object") continue;
    const e = link as { code?: unknown; name?: unknown };
    if (typeof e.code === "string") codes.push(e.code);
    if (typeof e.name === "string") codes.push(e.name);
  }
  return codes;
}

/**
 * Reads the reset time from a Claude plan limit message, for example
 * "You've hit your weekly limit · resets Jul 18, 12pm (UTC)" or
 * "resets 3:30pm (UTC)". Only UTC times are trusted; anything else returns null
 * and the caller falls back to backoff.
 */
export function parsePlanResetAt(message: string, now: Date): Date | null {
  const match = /resets\s+(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(UTC\)/i.exec(
    message,
  );
  if (!match) return null;
  const [, monthName, dayText, hourText, minuteText, meridiem] = match;
  let hour = Number(hourText) % 12;
  if (meridiem.toLowerCase() === "pm") hour += 12;
  const minute = minuteText ? Number(minuteText) : 0;
  if (monthName) {
    const month = MONTHS[monthName.toLowerCase()];
    if (month === undefined) return null;
    let candidate = new Date(Date.UTC(now.getUTCFullYear(), month, Number(dayText), hour, minute));
    // A reset date earlier than now means it is in the next year (Dec -> Jan).
    if (candidate.getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
      candidate = new Date(Date.UTC(now.getUTCFullYear() + 1, month, Number(dayText), hour, minute));
    }
    return candidate;
  }
  const candidate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute),
  );
  if (candidate.getTime() <= now.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate;
}

export function classifyEngineError(error: unknown, now: Date): ClassifiedEngineError {
  const message = errorText(error).slice(0, 2000);
  const status = errorStatus(error);
  const codes = errorCodes(error);

  if (status === 429 || PLAN_LIMIT_PATTERNS.some((pattern) => pattern.test(message))) {
    return { kind: "plan_limit", retryAt: parsePlanResetAt(message, now), message };
  }
  if (
    codes.some((code) => UNAVAILABLE_CODES.has(code)) ||
    codes.includes("AbortError") ||
    codes.includes("TimeoutError") ||
    /fetch failed|socket hang up|connect ECONNREFUSED/i.test(message) ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    // A wrong or missing gateway key is not the entry's fault. Hold the queue.
    status === 401 ||
    status === 403
  ) {
    return { kind: "engine_unavailable", retryAt: null, message };
  }
  if (status === 400 || status === 409 || status === 413 || status === 422) {
    return { kind: "rejected", retryAt: null, message };
  }
  // The gateway adapter's own "unavailable" error with no more specific cause.
  if (codes.includes("MemoryEngineUnavailableError")) {
    return { kind: "engine_unavailable", retryAt: null, message };
  }
  return { kind: "transient", retryAt: null, message };
}

export interface MemoryIngestBackoff {
  baseMs: number;
  maxMs: number;
  /** Minimum wait after a plan limit when the message gives no reset time. */
  planLimitMinMs: number;
  /** Slack added after a parsed plan reset time. */
  planResetSlackMs: number;
}

export const DEFAULT_MEMORY_INGEST_BACKOFF: MemoryIngestBackoff = {
  baseMs: 30_000,
  maxMs: 60 * 60_000,
  planLimitMinMs: 15 * 60_000,
  planResetSlackMs: 60_000,
};

/** `attempts` is the count of failed attempts so far, including this one. */
export function nextAttemptAt(input: {
  now: Date;
  attempts: number;
  classified: ClassifiedEngineError;
  backoff?: MemoryIngestBackoff;
  random?: () => number;
}): Date {
  const backoff = input.backoff ?? DEFAULT_MEMORY_INGEST_BACKOFF;
  const random = input.random ?? Math.random;
  const exponent = Math.max(0, Math.min(input.attempts - 1, 20));
  const exponential = Math.min(backoff.maxMs, backoff.baseMs * 2 ** exponent);
  // Up to 20% jitter so a recovered engine is not hit by every entry at once.
  let delayMs = exponential + Math.floor(exponential * 0.2 * random());
  if (input.classified.kind === "plan_limit") {
    if (input.classified.retryAt) {
      const untilReset =
        input.classified.retryAt.getTime() - input.now.getTime() + backoff.planResetSlackMs;
      delayMs = Math.max(delayMs, untilReset);
    } else {
      delayMs = Math.max(delayMs, backoff.planLimitMinMs);
    }
  }
  return new Date(input.now.getTime() + delayMs);
}

export interface DrainMemoryIngestResult {
  claimed: number;
  synced: number;
  deferred: number;
  parked: number;
  /** Writes refused because another worker took the entry over. */
  lostClaims: number;
  /** True when the drain stopped early because the engine or the plan is down. */
  haltedOn: MemoryEngineErrorKind | null;
  /** Entries deferred this pass whose attempts reached the attention threshold. */
  overdue: Array<{ id: string; recordId: string; attempts: number; kind: MemoryEngineErrorKind }>;
}

export interface DrainMemoryIngestOptions {
  store: MemoryIngestStore;
  engine: MemoryIngestEngine;
  now?: () => Date;
  limit?: number;
  leaseMs?: number;
  backoff?: MemoryIngestBackoff;
  random?: () => number;
  newToken?: () => string;
  /** Deferred entries at or above this many attempts are reported as overdue. */
  overdueAfterAttempts?: number;
}

/**
 * One drain pass. Safe to run concurrently and to repeat: claims are leased and
 * every outcome write is guarded by the claim token.
 *
 * A plan limit or an engine outage stops the pass. The current entry and every
 * entry claimed after it are deferred to the same time, so one outage costs one
 * engine call, not one per queued entry.
 */
export async function drainMemoryIngestOutbox(
  options: DrainMemoryIngestOptions,
): Promise<DrainMemoryIngestResult> {
  const now = options.now ?? (() => new Date());
  const newToken = options.newToken ?? (() => randomUUID());
  const overdueAfter = options.overdueAfterAttempts ?? 12;
  const result: DrainMemoryIngestResult = {
    claimed: 0,
    synced: 0,
    deferred: 0,
    parked: 0,
    lostClaims: 0,
    haltedOn: null,
    overdue: [],
  };

  const claimed = await options.store.claimDue({
    now: now(),
    limit: options.limit ?? 25,
    leaseMs: options.leaseMs ?? 5 * 60_000,
    newToken,
  });
  result.claimed = claimed.length;

  let halt: { classified: ClassifiedEngineError; until: Date } | null = null;

  for (const entry of claimed) {
    const token = entry.claimToken;
    if (!token) {
      result.lostClaims += 1;
      continue;
    }

    if (halt) {
      // The engine or plan is down: do not spend a call. Defer without
      // counting an attempt against this entry.
      const ok = await options.store.defer(entry.id, token, {
        now: now(),
        nextAttemptAt: halt.until,
        kind: halt.classified.kind,
        error: halt.classified.message,
        countAttempt: false,
      });
      if (ok) result.deferred += 1;
      else result.lostClaims += 1;
      continue;
    }

    let usage: MemoryIngestUsage | null = null;
    try {
      const response = await options.engine.apply(entry);
      usage = response.usage ?? null;
    } catch (error) {
      const at = now();
      const classified = classifyEngineError(error, at);
      const attempts = entry.attempts + 1;

      if (classified.kind === "rejected") {
        const ok = await options.store.park(entry.id, token, {
          now: at,
          kind: classified.kind,
          error: classified.message,
        });
        if (ok) result.parked += 1;
        else result.lostClaims += 1;
        continue;
      }

      const until = nextAttemptAt({
        now: at,
        attempts,
        classified,
        backoff: options.backoff,
        random: options.random,
      });
      const ok = await options.store.defer(entry.id, token, {
        now: at,
        nextAttemptAt: until,
        kind: classified.kind,
        error: classified.message,
        countAttempt: true,
      });
      if (ok) {
        result.deferred += 1;
        if (attempts >= overdueAfter) {
          result.overdue.push({ id: entry.id, recordId: entry.recordId, attempts, kind: classified.kind });
        }
      } else {
        result.lostClaims += 1;
      }
      if (classified.kind === "plan_limit" || classified.kind === "engine_unavailable") {
        halt = { classified, until };
        result.haltedOn = classified.kind;
      }
      continue;
    }

    const ok = await options.store.markSynced(entry.id, token, { now: now(), usage });
    if (ok) result.synced += 1;
    else result.lostClaims += 1;
  }

  return result;
}

export const MEMORY_INGEST_DRAIN_INTERVAL_MS = 30_000;

export interface MemoryIngestDrainScheduler {
  /** Runs one pass now unless one is already running. Resolves to null when skipped. */
  tick(): Promise<DrainMemoryIngestResult | null>;
  stop(): void;
}

/**
 * Drains the outbox on a fixed interval. Off unless the caller passes a
 * configured engine: with no engine there is nothing to deliver to, and the
 * entries stay queued. Passes never overlap, and a failed pass is logged and
 * the next tick retries, so the timer itself can never strand the queue.
 */
export function startMemoryIngestDrain(
  options: Omit<DrainMemoryIngestOptions, "engine"> & {
    engine: MemoryIngestEngine | null;
    intervalMs?: number;
    onResult?: (result: DrainMemoryIngestResult) => void;
    onError?: (error: unknown) => void;
  },
): MemoryIngestDrainScheduler | null {
  const { engine, intervalMs, onResult, onError, ...drainOptions } = options;
  if (!engine) return null;
  let running = false;
  const tick = async () => {
    if (running) return null;
    running = true;
    try {
      const result = await drainMemoryIngestOutbox({ ...drainOptions, engine });
      onResult?.(result);
      return result;
    } catch (error) {
      onError?.(error);
      return null;
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs ?? MEMORY_INGEST_DRAIN_INTERVAL_MS);
  timer.unref?.();
  return { tick, stop: () => clearInterval(timer) };
}

export interface DailyPlanUsage {
  /** Calendar day in Europe/London, YYYY-MM-DD. */
  date: string;
  /** Engine deliveries that reported model use. Chunks-mode entries report none. */
  modelCalls: number;
  deliveries: number;
  inputTokens: number;
  outputTokens: number;
}

const LONDON_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Daily Claude plan use by memory extraction, from the token counts the engine
 * returns on each synchronous retain. Days are Europe/London.
 */
export function summarizeDailyPlanUsage(entries: MemoryIngestEntry[]): DailyPlanUsage[] {
  const byDay = new Map<string, DailyPlanUsage>();
  for (const entry of entries) {
    if (entry.state !== "synced" || !entry.syncedAt) continue;
    const date = LONDON_DAY.format(entry.syncedAt);
    const day = byDay.get(date) ?? {
      date,
      modelCalls: 0,
      deliveries: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    const input = entry.inputTokens ?? 0;
    const output = entry.outputTokens ?? 0;
    day.deliveries += 1;
    if (input + output > 0) day.modelCalls += 1;
    day.inputTokens += input;
    day.outputTokens += output;
    byDay.set(date, day);
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function getDailyPlanUsage(input: {
  store: MemoryIngestStore;
  companyId: string;
  days: number;
  now?: Date;
}): Promise<DailyPlanUsage[]> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - Math.max(1, input.days) * 24 * 60 * 60 * 1000);
  const entries = await input.store.listSyncedSince({ companyId: input.companyId, since });
  return summarizeDailyPlanUsage(entries);
}

/** In-memory store with the same guarded semantics as the database store. Tests and the test double use it. */
export function createInMemoryMemoryIngestStore(): MemoryIngestStore & {
  entries: Map<string, MemoryIngestEntry>;
} {
  const entries = new Map<string, MemoryIngestEntry>();
  let sequence = 0;
  const holds = (entry: MemoryIngestEntry | undefined, token: string): entry is MemoryIngestEntry =>
    Boolean(entry && entry.state === "in_flight" && entry.claimToken === token);

  return {
    entries,
    async enqueue(input) {
      const key = JSON.stringify(input.payload);
      for (const existing of entries.values()) {
        if (
          existing.recordId === input.recordId &&
          existing.op === input.op &&
          JSON.stringify(existing.payload) === key
        ) {
          return existing;
        }
      }
      sequence += 1;
      const entry: MemoryIngestEntry = {
        id: `outbox-${sequence}`,
        companyId: input.companyId,
        recordId: input.recordId,
        op: input.op,
        payload: input.payload,
        state: "pending",
        attempts: 0,
        nextAttemptAt: input.now,
        leaseUntil: null,
        claimToken: null,
        lastErrorKind: null,
        lastError: null,
        inputTokens: null,
        outputTokens: null,
        syncedAt: null,
        createdAt: input.now,
      };
      entries.set(entry.id, entry);
      return entry;
    },
    async claimDue({ now, limit, leaseMs, newToken }) {
      const due = [...entries.values()]
        .filter(
          (entry) =>
            (entry.state === "pending" && entry.nextAttemptAt.getTime() <= now.getTime()) ||
            (entry.state === "in_flight" &&
              entry.leaseUntil !== null &&
              entry.leaseUntil.getTime() <= now.getTime()),
        )
        .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
        .slice(0, limit);
      for (const entry of due) {
        entry.state = "in_flight";
        entry.claimToken = newToken();
        entry.leaseUntil = new Date(now.getTime() + leaseMs);
      }
      return due.map((entry) => ({ ...entry }));
    },
    async markSynced(id, token, { now, usage }) {
      const entry = entries.get(id);
      if (!holds(entry, token)) return false;
      entry.state = "synced";
      entry.syncedAt = now;
      entry.leaseUntil = null;
      entry.claimToken = null;
      entry.inputTokens = usage?.inputTokens ?? 0;
      entry.outputTokens = usage?.outputTokens ?? 0;
      return true;
    },
    async defer(id, token, { nextAttemptAt: at, kind, error, countAttempt }) {
      const entry = entries.get(id);
      if (!holds(entry, token)) return false;
      entry.state = "pending";
      if (countAttempt) entry.attempts += 1;
      entry.nextAttemptAt = at;
      entry.leaseUntil = null;
      entry.claimToken = null;
      entry.lastErrorKind = kind;
      entry.lastError = error;
      return true;
    },
    async park(id, token, { kind, error }) {
      const entry = entries.get(id);
      if (!holds(entry, token)) return false;
      entry.state = "needs_attention";
      entry.attempts += 1;
      entry.leaseUntil = null;
      entry.claimToken = null;
      entry.lastErrorKind = kind;
      entry.lastError = error;
      return true;
    },
    async listSyncedSince({ companyId, since }) {
      return [...entries.values()]
        .filter(
          (entry) =>
            entry.companyId === companyId &&
            entry.state === "synced" &&
            entry.syncedAt !== null &&
            entry.syncedAt.getTime() >= since.getTime(),
        )
        .map((entry) => ({ ...entry }));
    },
  };
}
