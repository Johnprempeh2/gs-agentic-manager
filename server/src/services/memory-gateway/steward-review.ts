/**
 * Memory steward daily incremental review (GRE-887, plan 8.5).
 *
 * A daily GSAM routine wakes the steward agent, which runs one review pass.
 * The pass reads new and changed memory records after a durable cursor and
 * writes findings to a decision queue for people to settle:
 * failed ingestion, duplicates, stale material and possible contradictions.
 *
 * Rules:
 * - The steward never approves, disputes, edits or deletes a record. Nothing
 *   here writes a record; it only reads records and writes queue items.
 * - Each page of records and its queue writes are committed together with the
 *   cursor, guarded by the run's lease token. A pass killed mid-run loses at
 *   most the page it had not committed; the next pass redoes that page, so
 *   every record is counted once.
 * - Every escalation has a dedupe key (finding, record, version). Writing the
 *   same key twice is a no-op, so a repeat pass never escalates twice.
 * - A run holds a lease. A dead run's lease expires; the next run marks it
 *   interrupted and carries on from the cursor. A missed day needs no special
 *   path: the cursor still points at the last committed record.
 * - The cursor stops `settleMs` before "now", so a record whose transaction
 *   commits late with an older `updatedAt` is not skipped.
 * - The steward sees a content hash, never the content (least access).
 * - Pricing, policy, legal and client-commitment items, and client or
 *   restricted scopes, go to John (G1 decision 6). Anything with no known
 *   owner also goes to John.
 */

import { randomUUID } from "node:crypto";
import type { MemoryRecordStatus, MemoryScopeKind } from "@greatstone/shared";

export type StewardFindingKind = "failed_ingestion" | "duplicate" | "stale" | "possible_contradiction";

/** What the steward may see of a record. No content: only its hash. */
export interface StewardEntry {
  id: string;
  companyId: string;
  scopeId: string;
  scopeKind: MemoryScopeKind;
  status: MemoryRecordStatus;
  /** GRE-886 decision class: `operational` | `pricing` | `policy` | `legal` | `client_commitment`. */
  decisionClass: string;
  version: number;
  title: string | null;
  contentHash: string | null;
  topics: string[];
  entities: string[];
  contributorAgentId: string | null;
  contributorUserId: string | null;
  sourceKind: string | null;
  sourceId: string | null;
  /** `pending` | `synced` | `failed` */
  syncState: string;
  /** Approved records the contribution check flagged this one against (GRE-886). */
  conflictsWith: string[];
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface StewardCursor {
  updatedAt: Date;
  id: string;
}

export type StewardOwner =
  | { kind: "john"; reason: string }
  | { kind: "agent"; agentId: string; label: string; reason: string }
  | { kind: "user"; userId: string; label: string; reason: string };

export interface StewardSource {
  recordId: string;
  version: number;
  status: MemoryRecordStatus;
  title: string | null;
  contributorAgentId: string | null;
  contributorUserId: string | null;
  sourceKind: string | null;
  sourceId: string | null;
}

export interface StewardApprovedPosition {
  recordId: string;
  title: string | null;
}

export interface StewardQueueItem {
  id: string;
  companyId: string;
  /** Related findings share a group: same kind, scope and anchor. */
  groupKey: string;
  kind: StewardFindingKind;
  scopeId: string;
  scopeKind: MemoryScopeKind;
  routeTo: StewardOwner;
  sources: StewardSource[];
  approvedPosition: StewardApprovedPosition[];
  proposedResolution: string;
  /** `resolved` is set by the owner through the review workflow, never by the steward. */
  state: "open" | "resolved";
  openedAt: Date;
  updatedAt: Date;
}

export interface StewardEscalation {
  /** `${kind}:${recordId}:v${version}`. Written once per company. */
  dedupeKey: string;
  groupKey: string;
  kind: StewardFindingKind;
  scopeId: string;
  scopeKind: MemoryScopeKind;
  routeTo: StewardOwner;
  source: StewardSource;
  approvedPosition: StewardApprovedPosition[];
  proposedResolution: string;
}

export type StewardRunState = "running" | "completed" | "interrupted" | "failed";

export interface StewardRun {
  id: string;
  companyId: string;
  agentId: string;
  grantId: string;
  state: StewardRunState;
  token: string;
  leaseUntil: Date;
  startedAt: Date;
  finishedAt: Date | null;
  /** Upper bound of this pass: records changed after it wait for the next pass. */
  until: Date;
  cursorFrom: StewardCursor | null;
  cursorTo: StewardCursor | null;
  entriesSeen: number;
  escalationsCreated: number;
  escalationsDeduped: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number | null;
  resumedFromRunId: string | null;
  error: string | null;
}

/**
 * Scoped, audited steward grant. Only sandbox grants exist until G4; the real
 * grant is a G4 decision.
 */
export interface StewardGrant {
  id: string;
  companyId: string;
  agentId: string;
  scopeIds: string[];
  environment: "sandbox";
  grantedBy: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export const MEMORY_STEWARD_REAL_GRANTS_ALLOWED = false;

export class StewardAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StewardAccessError";
  }
}

/** Throws unless `grant` lets `agentId` review in `companyId` now. */
export function assertStewardGrant(
  grant: StewardGrant | null,
  input: { companyId: string; agentId: string; now: Date },
): asserts grant is StewardGrant {
  if (!grant) throw new StewardAccessError("No steward grant for this agent");
  if (grant.companyId !== input.companyId || grant.agentId !== input.agentId) {
    throw new StewardAccessError("Steward grant belongs to another agent or company");
  }
  if (grant.revokedAt) throw new StewardAccessError("Steward grant is revoked");
  if (grant.expiresAt.getTime() <= input.now.getTime()) throw new StewardAccessError("Steward grant has expired");
  if (grant.environment !== "sandbox" && !MEMORY_STEWARD_REAL_GRANTS_ALLOWED) {
    throw new StewardAccessError("Only sandbox steward grants are allowed before G4");
  }
  if (grant.scopeIds.length === 0) throw new StewardAccessError("Steward grant covers no scope");
}

export type StewardBeginResult =
  | { run: StewardRun; interrupted: StewardRun | null }
  | { busy: StewardRun };

/**
 * Storage for the review. `beginRun` and `commitPage` must each be atomic.
 * Guarded writes return false when the run's token or lease no longer holds.
 */
export interface StewardStore {
  /** Refuses (busy) while another run holds a live lease; takes over an expired one. */
  beginRun(input: {
    companyId: string;
    agentId: string;
    grantId: string;
    now: Date;
    until: Date;
    leaseMs: number;
    token: string;
  }): Promise<StewardBeginResult>;
  getCursor(companyId: string): Promise<StewardCursor | null>;
  /** Records with `(updatedAt, id)` after the cursor and `updatedAt <= until`, in that order. */
  listChangedAfter(input: {
    companyId: string;
    scopeIds: string[];
    cursor: StewardCursor | null;
    until: Date;
    limit: number;
  }): Promise<StewardEntry[]>;
  /** Live records in the same scope with the same content hash, created before `entry`. */
  listEarlierDuplicates(entry: StewardEntry): Promise<StewardEntry[]>;
  getEntries(companyId: string, ids: string[]): Promise<StewardEntry[]>;
  /** Records a time-based check may now flag, whether or not they changed. */
  listSweepCandidates(input: {
    companyId: string;
    scopeIds: string[];
    unreviewedBefore: Date;
    supersededBefore: Date;
    pendingBefore: Date;
  }): Promise<StewardEntry[]>;
  /**
   * One atomic write: escalations (deduped), the cursor (when given), the
   * run's counters and a renewed lease. Returns null if the run lost its lease.
   */
  commitPage(input: {
    runId: string;
    token: string;
    now: Date;
    leaseMs: number;
    cursor: StewardCursor | null;
    /** Records this page covers (empty for the sweep). */
    entryIds: string[];
    escalations: StewardEscalation[];
    usage: StewardUsage | null;
  }): Promise<{ created: number; deduped: number } | null>;
  finishRun(input: {
    runId: string;
    token: string;
    now: Date;
    state: "completed" | "failed";
    error: string | null;
  }): Promise<boolean>;
  listOpenItems(companyId: string): Promise<StewardQueueItem[]>;
  listRunsSince(input: { companyId: string; since: Date }): Promise<StewardRun[]>;
  /** Append to the memory audit ledger (`memory_operations`). */
  audit(input: {
    companyId: string;
    agentId: string;
    runId: string | null;
    operation: string;
    outcome: string;
    scopeIds: string[];
    detail: Record<string, unknown>;
    now: Date;
  }): Promise<void>;
}

export interface StewardUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Who owns a scope's decisions. Null means no known owner; the item goes to John. */
export type StewardOwnerResolver = (entry: StewardEntry) => Promise<StewardOwner | null> | StewardOwner | null;

/** Topic or entity words that make an item John's (G1 decision 6). Detection is by tag and can miss. */
const JOHN_ONLY_TERMS = [
  "price",
  "pricing",
  "rate card",
  "fee",
  "discount",
  "policy",
  "legal",
  "contract",
  "client commitment",
  "client_commitment",
  "sla",
];

const JOHN_ONLY_CLASSES = ["pricing", "policy", "legal", "client_commitment"];

function isJohnOnlyTopic(entry: StewardEntry): string | null {
  if (JOHN_ONLY_CLASSES.includes(entry.decisionClass)) return entry.decisionClass;
  for (const raw of [...entry.topics, ...entry.entities]) {
    const tag = raw.toLowerCase();
    const hit = JOHN_ONLY_TERMS.find((term) => tag === term || tag.includes(term));
    if (hit) return hit;
  }
  return null;
}

export async function routeStewardFinding(
  entry: StewardEntry,
  resolveOwner: StewardOwnerResolver,
): Promise<StewardOwner> {
  const term = isJohnOnlyTopic(entry);
  if (term) return { kind: "john", reason: `"${term}" needs John (pricing, policy, legal or client commitment)` };
  if (entry.scopeKind === "client" || entry.scopeKind === "restricted_project") {
    return { kind: "john", reason: `${entry.scopeKind} scope needs John` };
  }
  const owner = await resolveOwner(entry);
  return owner ?? { kind: "john", reason: "no owner known for this scope" };
}

// Retention, G1 decision 7 (same values as MEMORY_RETENTION_DAYS, GRE-886).
export const STEWARD_AGENT_NOTES_STALE_DAYS = 90;
export const STEWARD_UNREVIEWED_STALE_DAYS = 180;
export const STEWARD_SUPERSEDED_EXPIRY_DAYS = 365;
export const STEWARD_PENDING_INGEST_GRACE_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function sourceOf(entry: StewardEntry): StewardSource {
  return {
    recordId: entry.id,
    version: entry.version,
    status: entry.status,
    title: entry.title,
    contributorAgentId: entry.contributorAgentId,
    contributorUserId: entry.contributorUserId,
    sourceKind: entry.sourceKind,
    sourceId: entry.sourceId,
  };
}

function label(entry: { id: string; title: string | null }) {
  return entry.title ? `"${entry.title}"` : entry.id;
}

function isUnreviewed(status: MemoryRecordStatus) {
  return status === "unreviewed";
}

function staleAfterDays(entry: StewardEntry) {
  return entry.scopeKind === "agent" ? STEWARD_AGENT_NOTES_STALE_DAYS : STEWARD_UNREVIEWED_STALE_DAYS;
}

interface FindingContext {
  store: StewardStore;
  resolveOwner: StewardOwnerResolver;
  now: Date;
}

async function escalation(
  ctx: FindingContext,
  entry: StewardEntry,
  kind: StewardFindingKind,
  groupKey: string,
  proposedResolution: string,
  approvedPosition: StewardApprovedPosition[] = [],
): Promise<StewardEscalation> {
  return {
    dedupeKey: `${kind}:${entry.id}:v${entry.version}`,
    groupKey,
    kind,
    scopeId: entry.scopeId,
    scopeKind: entry.scopeKind,
    routeTo: await routeStewardFinding(entry, ctx.resolveOwner),
    source: sourceOf(entry),
    approvedPosition,
    proposedResolution,
  };
}

/** Findings for one changed record. Pure apart from read-only store lookups. */
async function findingsForChanged(ctx: FindingContext, entry: StewardEntry): Promise<StewardEscalation[]> {
  if (entry.deletedAt || entry.status === "deleted") return [];
  const out: StewardEscalation[] = [];

  if (entry.syncState === "failed") {
    out.push(await failedIngestion(ctx, entry));
  }

  if (entry.contentHash) {
    const earlier = await ctx.store.listEarlierDuplicates(entry);
    if (earlier.length > 0) {
      const first = earlier[0]!;
      out.push(
        await escalation(
          ctx,
          entry,
          "duplicate",
          `duplicate:${entry.scopeId}:${entry.contentHash}`,
          `Same content as ${label(first)}. Keep ${label(first)} and delete or supersede ${label(entry)}.`,
        ),
      );
    }
  }

  const anchors = [...new Set(entry.conflictsWith)].sort();
  if (anchors.length > 0 || entry.status === "disputed") {
    const approved = (await ctx.store.getEntries(entry.companyId, anchors))
      .filter((anchor) => anchor.status === "approved" && !anchor.deletedAt)
      .map((anchor) => ({ recordId: anchor.id, title: anchor.title }));
    const position = approved.map((p) => label({ id: p.recordId, title: p.title })).join(", ");
    out.push(
      await escalation(
        ctx,
        entry,
        "possible_contradiction",
        `possible_contradiction:${entry.scopeId}:${anchors.length > 0 ? anchors.join(",") : entry.id}`,
        approved.length > 0
          ? `Keep the approved position ${position} unless the owner accepts the new evidence in ${label(entry)}. ` +
            `If accepted, supersede ${position} with a dated decision that cites it. This flag is a possible conflict, not proof.`
          : `${label(entry)} is disputed with no approved position on record. The owner decides which statement holds.`,
        approved,
      ),
    );
  }

  return out;
}

async function failedIngestion(ctx: FindingContext, entry: StewardEntry) {
  return escalation(
    ctx,
    entry,
    "failed_ingestion",
    `failed_ingestion:${entry.scopeId}`,
    `${label(entry)} is not in the engine (sync ${entry.syncState}). Check the ingest outbox; ` +
      "retry it or delete the record. Recall cannot find it until then.",
  );
}

async function findingsForSweep(ctx: FindingContext, entry: StewardEntry): Promise<StewardEscalation[]> {
  if (entry.deletedAt || entry.status === "deleted") return [];
  const ageDays = Math.floor((ctx.now.getTime() - entry.updatedAt.getTime()) / DAY_MS);
  const out: StewardEscalation[] = [];
  if (entry.syncState !== "synced" && ctx.now.getTime() - entry.updatedAt.getTime() >= STEWARD_PENDING_INGEST_GRACE_MS) {
    out.push(await failedIngestion(ctx, entry));
  }
  if (isUnreviewed(entry.status) && ageDays >= staleAfterDays(entry)) {
    out.push(
      await escalation(
        ctx,
        entry,
        "stale",
        `stale:${entry.scopeId}`,
        `${label(entry)} has been unreviewed for ${ageDays} days. Approve it, or it is deleted under the ` +
          `${staleAfterDays(entry)}-day rule unless it is cited.`,
      ),
    );
  }
  if (entry.status === "superseded" && ageDays >= STEWARD_SUPERSEDED_EXPIRY_DAYS) {
    out.push(
      await escalation(
        ctx,
        entry,
        "stale",
        `stale:${entry.scopeId}`,
        `${label(entry)} was superseded ${ageDays} days ago. Its ${STEWARD_SUPERSEDED_EXPIRY_DAYS}-day retention has ended; delete it.`,
      ),
    );
  }
  return out;
}

export interface StewardReviewOptions {
  store: StewardStore;
  companyId: string;
  agentId: string;
  grant: StewardGrant | null;
  resolveOwner: StewardOwnerResolver;
  now?: () => Date;
  pageSize?: number;
  leaseMs?: number;
  settleMs?: number;
  /** Attempts per page before the run stops as failed. The next run retries from the cursor. */
  pageAttempts?: number;
  newToken?: () => string;
  /** Test hook: runs after each committed page. Throwing here simulates a kill between pages. */
  afterPage?: (page: number) => void | Promise<void>;
}

export interface StewardReviewResult {
  outcome: "completed" | "busy" | "failed" | "lost_lease";
  runId: string | null;
  interruptedRunId: string | null;
  entriesSeen: number;
  escalationsCreated: number;
  escalationsDeduped: number;
  durationMs: number;
  error: string | null;
}

/**
 * One review pass. Safe to repeat and to run concurrently: a second pass
 * while one is live returns `busy`; a pass that lost its lease stops without
 * writing.
 */
export async function runStewardReview(options: StewardReviewOptions): Promise<StewardReviewResult> {
  const now = options.now ?? (() => new Date());
  const leaseMs = options.leaseMs ?? 10 * 60_000;
  const pageSize = options.pageSize ?? 100;
  const pageAttempts = Math.max(1, options.pageAttempts ?? 3);
  const started = now();
  const { store, companyId, agentId } = options;

  try {
    assertStewardGrant(options.grant, { companyId, agentId, now: started });
  } catch (error) {
    await store.audit({
      companyId,
      agentId,
      runId: null,
      operation: "steward_review",
      outcome: "denied",
      scopeIds: options.grant?.scopeIds ?? [],
      detail: { reason: (error as Error).message },
      now: started,
    });
    throw error;
  }
  const grant = options.grant;

  const result: StewardReviewResult = {
    outcome: "completed",
    runId: null,
    interruptedRunId: null,
    entriesSeen: 0,
    escalationsCreated: 0,
    escalationsDeduped: 0,
    durationMs: 0,
    error: null,
  };

  const token = (options.newToken ?? randomUUID)();
  const begun = await store.beginRun({
    companyId,
    agentId,
    grantId: grant.id,
    now: started,
    until: new Date(started.getTime() - (options.settleMs ?? 5 * 60_000)),
    leaseMs,
    token,
  });
  if ("busy" in begun) {
    return { ...result, outcome: "busy", runId: begun.busy.id };
  }
  const run = begun.run;
  result.runId = run.id;
  result.interruptedRunId = begun.interrupted?.id ?? null;
  await store.audit({
    companyId,
    agentId,
    runId: run.id,
    operation: "steward_review",
    outcome: "started",
    scopeIds: grant.scopeIds,
    detail: { grantId: grant.id, resumedFromRunId: result.interruptedRunId, cursorFrom: run.cursorFrom },
    now: started,
  });

  const ctx: FindingContext = { store, resolveOwner: options.resolveOwner, now: started };

  // Commits one batch, retrying on a thrown store error. Null means the lease was lost.
  const commit = async (
    build: () => Promise<{ cursor: StewardCursor | null; entryIds: string[]; escalations: StewardEscalation[] }>,
  ) => {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= pageAttempts; attempt += 1) {
      try {
        const batch = await build();
        const written = await store.commitPage({
          runId: run.id,
          token,
          now: now(),
          leaseMs,
          cursor: batch.cursor,
          entryIds: batch.entryIds,
          escalations: dedupeBatch(batch.escalations),
          usage: null,
        });
        if (!written) return null;
        result.entriesSeen += batch.entryIds.length;
        result.escalationsCreated += written.created;
        result.escalationsDeduped += written.deduped;
        return written;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };

  try {
    let cursor = await store.getCursor(companyId);
    let page = 0;
    for (;;) {
      const entries = await store.listChangedAfter({
        companyId,
        scopeIds: grant.scopeIds,
        cursor,
        until: run.until,
        limit: pageSize,
      });
      if (entries.length === 0) break;
      const last = entries[entries.length - 1]!;
      const next = { updatedAt: last.updatedAt, id: last.id };
      const written = await commit(async () => ({
        cursor: next,
        entryIds: entries.map((entry) => entry.id),
        escalations: (await Promise.all(entries.map((entry) => findingsForChanged(ctx, entry)))).flat(),
      }));
      if (!written) return finishLost();
      cursor = next;
      page += 1;
      await options.afterPage?.(page);
      if (entries.length < pageSize) break;
    }

    // Time-based checks: a record can go stale or stay unsynced without changing.
    const swept = await commit(async () => {
      const candidates = await store.listSweepCandidates({
        companyId,
        scopeIds: grant.scopeIds,
        // The shorter (agent notes) bound; findingsForSweep applies the right rule per scope.
        unreviewedBefore: new Date(started.getTime() - STEWARD_AGENT_NOTES_STALE_DAYS * DAY_MS),
        supersededBefore: new Date(started.getTime() - STEWARD_SUPERSEDED_EXPIRY_DAYS * DAY_MS),
        pendingBefore: new Date(started.getTime() - STEWARD_PENDING_INGEST_GRACE_MS),
      });
      return {
        cursor: null,
        entryIds: [],
        escalations: (await Promise.all(candidates.map((entry) => findingsForSweep(ctx, entry)))).flat(),
      };
    });
    if (!swept) return finishLost();
  } catch (error) {
    result.outcome = "failed";
    result.error = error instanceof Error ? error.message : String(error);
  }

  const ended = now();
  result.durationMs = ended.getTime() - started.getTime();
  const state = result.outcome === "failed" ? "failed" : "completed";
  const finished = await store.finishRun({ runId: run.id, token, now: ended, state, error: result.error });
  if (!finished) return finishLost();
  await store.audit({
    companyId,
    agentId,
    runId: run.id,
    operation: "steward_review",
    outcome: state,
    scopeIds: grant.scopeIds,
    detail: {
      entriesSeen: result.entriesSeen,
      escalationsCreated: result.escalationsCreated,
      escalationsDeduped: result.escalationsDeduped,
      durationMs: result.durationMs,
      error: result.error,
    },
    now: ended,
  });
  return result;

  function finishLost(): StewardReviewResult {
    result.outcome = "lost_lease";
    result.durationMs = now().getTime() - started.getTime();
    return result;
  }
}

/** A record can yield the same key twice in one batch (changed and swept); keep one. */
function dedupeBatch(escalations: StewardEscalation[]) {
  const seen = new Map<string, StewardEscalation>();
  for (const item of escalations) if (!seen.has(item.dedupeKey)) seen.set(item.dedupeKey, item);
  return [...seen.values()];
}

// ---------------------------------------------------------------------------------------------
// Daily report: audit cost and queue age.

const LONDON_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export interface StewardDailyReport {
  /** Europe/London calendar days, oldest first. */
  days: Array<{
    date: string;
    runs: number;
    completed: number;
    interrupted: number;
    failed: number;
    entriesSeen: number;
    escalationsCreated: number;
    escalationsDeduped: number;
    reviewMs: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  /** Days in the window with no completed run. The next run catches them up from the cursor. */
  missedDays: string[];
  queue: {
    open: number;
    oldestAgeHours: number | null;
    medianAgeHours: number | null;
    toJohn: number;
    byKind: Record<StewardFindingKind, number>;
  };
}

export function buildStewardDailyReport(input: {
  runs: StewardRun[];
  openItems: StewardQueueItem[];
  now: Date;
  days: number;
}): StewardDailyReport {
  const dates: string[] = [];
  for (let i = input.days - 1; i >= 0; i -= 1) {
    dates.push(LONDON_DAY.format(new Date(input.now.getTime() - i * DAY_MS)));
  }
  const byDay = new Map(
    dates.map((date) => [
      date,
      {
        date,
        runs: 0,
        completed: 0,
        interrupted: 0,
        failed: 0,
        entriesSeen: 0,
        escalationsCreated: 0,
        escalationsDeduped: 0,
        reviewMs: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    ]),
  );
  for (const run of input.runs) {
    const day = byDay.get(LONDON_DAY.format(run.startedAt));
    if (!day) continue;
    day.runs += 1;
    if (run.state === "completed") day.completed += 1;
    if (run.state === "interrupted") day.interrupted += 1;
    if (run.state === "failed") day.failed += 1;
    day.entriesSeen += run.entriesSeen;
    day.escalationsCreated += run.escalationsCreated;
    day.escalationsDeduped += run.escalationsDeduped;
    day.reviewMs += run.durationMs ?? 0;
    day.inputTokens += run.inputTokens;
    day.outputTokens += run.outputTokens;
  }

  const ages = input.openItems
    .map((item) => (input.now.getTime() - item.openedAt.getTime()) / 3_600_000)
    .sort((a, b) => a - b);
  const byKind: Record<StewardFindingKind, number> = {
    failed_ingestion: 0,
    duplicate: 0,
    stale: 0,
    possible_contradiction: 0,
  };
  for (const item of input.openItems) byKind[item.kind] += 1;
  const round = (n: number) => Math.round(n * 10) / 10;

  const days = [...byDay.values()];
  return {
    days,
    missedDays: days.filter((day) => day.completed === 0).map((day) => day.date),
    queue: {
      open: input.openItems.length,
      oldestAgeHours: ages.length ? round(ages[ages.length - 1]!) : null,
      medianAgeHours: ages.length ? round(ages[Math.floor((ages.length - 1) / 2)]!) : null,
      toJohn: input.openItems.filter((item) => item.routeTo.kind === "john").length,
      byKind,
    },
  };
}

export async function getStewardDailyReport(input: {
  store: StewardStore;
  companyId: string;
  days: number;
  now?: Date;
}): Promise<StewardDailyReport> {
  const now = input.now ?? new Date();
  const days = Math.max(1, input.days);
  const [runs, openItems] = await Promise.all([
    input.store.listRunsSince({ companyId: input.companyId, since: new Date(now.getTime() - days * DAY_MS) }),
    input.store.listOpenItems(input.companyId),
  ]);
  return buildStewardDailyReport({ runs, openItems, now, days });
}

// ---------------------------------------------------------------------------------------------
// In-memory store with the same guarded, atomic semantics as the database store.

function afterCursor(entry: StewardEntry, cursor: StewardCursor | null) {
  if (!cursor) return true;
  const a = entry.updatedAt.getTime();
  const b = cursor.updatedAt.getTime();
  return a > b || (a === b && entry.id > cursor.id);
}

function compareEntries(a: StewardEntry, b: StewardEntry) {
  return a.updatedAt.getTime() - b.updatedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function createInMemoryStewardStore(): StewardStore & {
  entries: Map<string, StewardEntry>;
  runs: Map<string, StewardRun>;
  items: Map<string, StewardQueueItem>;
  escalatedKeys: Set<string>;
  /** Every record id each committed page counted, in order. */
  seenLog: string[];
  auditLog: Array<{ operation: string; outcome: string; runId: string | null; detail: Record<string, unknown> }>;
  /** Test hook: throw from the next N `commitPage` calls before anything is written. */
  failNextCommits: number;
} {
  const entries = new Map<string, StewardEntry>();
  const runs = new Map<string, StewardRun>();
  const items = new Map<string, StewardQueueItem>();
  const escalatedKeys = new Set<string>();
  const cursors = new Map<string, StewardCursor>();
  const seenLog: string[] = [];
  const auditLog: Array<{ operation: string; outcome: string; runId: string | null; detail: Record<string, unknown> }> = [];
  let sequence = 0;
  const live = (run: StewardRun | undefined, token: string, now: Date): run is StewardRun =>
    Boolean(run && run.state === "running" && run.token === token && run.leaseUntil.getTime() > now.getTime());

  const store = {
    entries,
    runs,
    items,
    escalatedKeys,
    seenLog,
    auditLog,
    failNextCommits: 0,
    async beginRun({ companyId, agentId, grantId, now, until, leaseMs, token }) {
      let interrupted: StewardRun | null = null;
      for (const run of runs.values()) {
        if (run.companyId !== companyId || run.state !== "running") continue;
        if (run.leaseUntil.getTime() > now.getTime()) return { busy: { ...run } };
        run.state = "interrupted";
        run.finishedAt = now;
        run.error = "lease expired before the run finished";
        interrupted = { ...run };
      }
      sequence += 1;
      const run: StewardRun = {
        id: `steward-run-${sequence}`,
        companyId,
        agentId,
        grantId,
        state: "running",
        token,
        leaseUntil: new Date(now.getTime() + leaseMs),
        startedAt: now,
        finishedAt: null,
        until,
        cursorFrom: cursors.get(companyId) ?? null,
        cursorTo: cursors.get(companyId) ?? null,
        entriesSeen: 0,
        escalationsCreated: 0,
        escalationsDeduped: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: null,
        resumedFromRunId: interrupted?.id ?? null,
        error: null,
      };
      runs.set(run.id, run);
      return { run: { ...run }, interrupted };
    },
    async getCursor(companyId) {
      return cursors.get(companyId) ?? null;
    },
    async listChangedAfter({ companyId, scopeIds, cursor, until, limit }) {
      return [...entries.values()]
        .filter(
          (entry) =>
            entry.companyId === companyId &&
            scopeIds.includes(entry.scopeId) &&
            entry.updatedAt.getTime() <= until.getTime() &&
            afterCursor(entry, cursor),
        )
        .sort(compareEntries)
        .slice(0, limit)
        .map((entry) => ({ ...entry }));
    },
    async listEarlierDuplicates(entry) {
      return [...entries.values()]
        .filter(
          (other) =>
            other.id !== entry.id &&
            other.companyId === entry.companyId &&
            other.scopeId === entry.scopeId &&
            other.contentHash === entry.contentHash &&
            !other.deletedAt &&
            other.status !== "deleted" &&
            other.createdAt.getTime() < entry.createdAt.getTime(),
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((other) => ({ ...other }));
    },
    async getEntries(companyId, ids) {
      return ids
        .map((id) => entries.get(id))
        .filter((entry): entry is StewardEntry => Boolean(entry && entry.companyId === companyId))
        .map((entry) => ({ ...entry }));
    },
    async listSweepCandidates({ companyId, scopeIds, unreviewedBefore, supersededBefore, pendingBefore }) {
      return [...entries.values()]
        .filter((entry) => {
          if (entry.companyId !== companyId || !scopeIds.includes(entry.scopeId) || entry.deletedAt) return false;
          const at = entry.updatedAt.getTime();
          return (
            (entry.syncState !== "synced" && at <= pendingBefore.getTime()) ||
            (isUnreviewed(entry.status) && at <= unreviewedBefore.getTime()) ||
            (entry.status === "superseded" && at <= supersededBefore.getTime())
          );
        })
        .map((entry) => ({ ...entry }));
    },
    async commitPage({ runId, token, now, leaseMs, cursor, entryIds, escalations, usage }) {
      if (store.failNextCommits > 0) {
        store.failNextCommits -= 1;
        throw new Error("synthetic store failure");
      }
      const run = runs.get(runId);
      if (!live(run, token, now)) return null;
      let created = 0;
      let deduped = 0;
      for (const item of escalations) {
        const key = `${run.companyId}:${item.dedupeKey}`;
        if (escalatedKeys.has(key)) {
          deduped += 1;
          continue;
        }
        escalatedKeys.add(key);
        created += 1;
        const open = [...items.values()].find(
          (existing) =>
            existing.companyId === run.companyId && existing.groupKey === item.groupKey && existing.state === "open",
        );
        if (open) {
          open.sources = [...open.sources.filter((s) => s.recordId !== item.source.recordId), item.source];
          const known = new Set(open.approvedPosition.map((p) => p.recordId));
          open.approvedPosition.push(...item.approvedPosition.filter((p) => !known.has(p.recordId)));
          open.proposedResolution = item.proposedResolution;
          open.updatedAt = now;
        } else {
          sequence += 1;
          const id = `steward-item-${sequence}`;
          items.set(id, {
            id,
            companyId: run.companyId,
            groupKey: item.groupKey,
            kind: item.kind,
            scopeId: item.scopeId,
            scopeKind: item.scopeKind,
            routeTo: item.routeTo,
            sources: [item.source],
            approvedPosition: [...item.approvedPosition],
            proposedResolution: item.proposedResolution,
            state: "open",
            openedAt: now,
            updatedAt: now,
          });
        }
      }
      if (cursor) {
        cursors.set(run.companyId, cursor);
        run.cursorTo = cursor;
      }
      seenLog.push(...entryIds);
      run.entriesSeen += entryIds.length;
      run.escalationsCreated += created;
      run.escalationsDeduped += deduped;
      run.inputTokens += usage?.inputTokens ?? 0;
      run.outputTokens += usage?.outputTokens ?? 0;
      run.leaseUntil = new Date(now.getTime() + leaseMs);
      return { created, deduped };
    },
    async finishRun({ runId, token, now, state, error }) {
      const run = runs.get(runId);
      if (!live(run, token, now)) return false;
      run.state = state;
      run.finishedAt = now;
      run.durationMs = now.getTime() - run.startedAt.getTime();
      run.error = error;
      return true;
    },
    async listOpenItems(companyId) {
      return [...items.values()]
        .filter((item) => item.companyId === companyId && item.state === "open")
        .map((item) => ({ ...item }));
    },
    async listRunsSince({ companyId, since }) {
      return [...runs.values()]
        .filter((run) => run.companyId === companyId && run.startedAt.getTime() >= since.getTime())
        .map((run) => ({ ...run }));
    },
    async audit({ operation, outcome, runId, detail }) {
      auditLog.push({ operation, outcome, runId, detail });
    },
  } satisfies StewardStore & Record<string, unknown>;
  return store;
}
