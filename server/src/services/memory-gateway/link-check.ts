import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  memoryConflicts,
  memoryLinkLeads,
  memoryOperations,
  memoryRecords,
  memoryRelationships,
  memoryScopes,
  memorySettings,
} from "@greatstone/db";
import {
  MEMORY_LINK_LEAD_NOTE,
  type ConfirmMemoryLinkLead,
  type DismissMemoryLinkLead,
  type MemoryLinkBasis,
  type MemoryLinkCheckResult,
  type MemoryLinkLead,
  type MemoryLinkLeadList,
  type MemoryLinkLeadState,
} from "@greatstone/shared";
import { conflict, forbidden, notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { insertRelationship } from "./review-store.js";
import {
  grantCovers,
  isHardBoundary,
  toRecord,
  type MemoryCaller,
  type MemoryGatewayService,
  type RecordRow,
  type ScopeRow,
} from "./service.js";
import { statedValues } from "./text-conflict.js";

// Memory link check (memory linking, 6 Oct 2026).
//
// Proposes possible links between records that share names, topics, stated
// values (price, date, amount) or a source, using only what GSAM stores: the
// contributors' entity and topic tags, the record text and the source
// reference. It never invents a link: every lead names what both records
// share, and stays a lead until the owner or a memory reviewer confirms it
// (which writes a stated relationship with the reviewer as author) or
// dismisses it. A client or restricted-project record is only ever paired
// with a record in its own scope. Readers see a lead only when they may read
// both ends.

export const MEMORY_LINK_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Most recently changed records compared in one pass. */
export const MEMORY_LINK_CHECK_MAX_RECORDS = 2_000;
/** Open leads a record may have at once, so one busy subject does not become a hairball. */
export const MEMORY_LINK_CHECK_MAX_LEADS_PER_RECORD = 5;
/** A term carried by more records than this share (and at least COMMON_TERM_MIN) says nothing about a pair. */
const COMMON_TERM_SHARE = 0.25;
const COMMON_TERM_MIN = 6;
const MIN_SCORE = 3;

export const LINK_CHECK_NAME = "Link check";
export const LINK_LEAD_SOURCE_KIND = "memory_link_lead";
const LINK_CHECK_OPERATION = "link_check";
const SYSTEM_ACTOR_ID = "memory-link-check";

type ScoredBasis = { basis: MemoryLinkBasis; score: number };

export type LinkCheckRecord = {
  id: string;
  scopeId: string;
  scopeKind: string;
  title: string | null;
  content: string | null;
  entities: string[];
  topics: string[];
  sourceKind: string | null;
  sourceId: string | null;
};

type Prepared = {
  record: LinkCheckRecord;
  entities: Set<string>;
  topics: Set<string>;
  values: Map<string, string>;
  source: string | null;
};

function normalised(values: string[]) {
  return new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean));
}

export function pairKey(a: string, b: string) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** Same scope, or two scopes neither of which is a client or restricted-project scope. */
export function pairAllowed(a: Pick<LinkCheckRecord, "scopeId" | "scopeKind">, b: Pick<LinkCheckRecord, "scopeId" | "scopeKind">) {
  return a.scopeId === b.scopeId || (!isHardBoundary(a.scopeKind) && !isHardBoundary(b.scopeKind));
}

function prepare(record: LinkCheckRecord): Prepared {
  return {
    record,
    entities: normalised(record.entities),
    topics: normalised(record.topics),
    values: statedValues(record),
    source: record.sourceKind && record.sourceId ? `${record.sourceKind}:${record.sourceId}` : null,
  };
}

/**
 * What two records share, or null when it is not enough for a lead. A lead
 * needs a shared subject: a name, a source, or a topic with another match.
 * Stated values count only on top of a shared subject.
 */
function basisFor(a: Prepared, b: Prepared, common: { entities: Set<string>; topics: Set<string> }): ScoredBasis | null {
  const entities = [...a.entities].filter((term) => b.entities.has(term) && !common.entities.has(term)).sort();
  const topics = [...a.topics].filter((term) => b.topics.has(term) && !common.topics.has(term)).sort();
  const sameSource = a.source !== null && a.source === b.source;
  if (entities.length + topics.length === 0 && !sameSource) return null;
  const values = [...a.values.keys()].filter((key) => b.values.has(key)).map((key) => a.values.get(key)!).sort();
  const score = entities.length * 3 + topics.length * 2 + values.length + (sameSource ? 3 : 0);
  if (score < MIN_SCORE) return null;
  return { basis: { entities, topics, values, sameSource }, score };
}

/**
 * The pairs worth a lead among `records`, best first. Pure: the caller says
 * which pairs are already known and how many open leads each record has.
 */
export function findLinkLeads(
  records: LinkCheckRecord[],
  options: { known?: Set<string>; openLeadCounts?: Map<string, number>; maxLeadsPerRecord?: number } = {},
): Array<{ from: LinkCheckRecord; to: LinkCheckRecord } & ScoredBasis> {
  const known = options.known ?? new Set<string>();
  const counts = new Map(options.openLeadCounts ?? []);
  const max = options.maxLeadsPerRecord ?? MEMORY_LINK_CHECK_MAX_LEADS_PER_RECORD;
  const prepared = records.map(prepare);

  // Terms on a large share of records (the company's own name, say) match everything.
  const commonOf = (pick: (item: Prepared) => Set<string>) => {
    const frequency = new Map<string, number>();
    for (const item of prepared) for (const term of pick(item)) frequency.set(term, (frequency.get(term) ?? 0) + 1);
    const limit = Math.max(COMMON_TERM_MIN, prepared.length * COMMON_TERM_SHARE);
    return new Set([...frequency].filter(([, n]) => n > limit).map(([term]) => term));
  };
  const common = { entities: commonOf((item) => item.entities), topics: commonOf((item) => item.topics) };

  // Only records that share a term or a source are compared.
  const index = new Map<string, number[]>();
  const add = (key: string, position: number) => index.set(key, [...(index.get(key) ?? []), position]);
  prepared.forEach((item, position) => {
    for (const term of item.entities) if (!common.entities.has(term)) add(`e:${term}`, position);
    for (const term of item.topics) if (!common.topics.has(term)) add(`t:${term}`, position);
    if (item.source) add(`s:${item.source}`, position);
  });
  const seen = new Set<string>();
  const candidates: Array<{ from: LinkCheckRecord; to: LinkCheckRecord } & ScoredBasis> = [];
  for (const positions of index.values()) {
    for (let i = 0; i < positions.length; i += 1) {
      for (let j = i + 1; j < positions.length; j += 1) {
        const a = prepared[positions[i]!]!;
        const b = prepared[positions[j]!]!;
        if (a.record.id === b.record.id) continue;
        const key = pairKey(a.record.id, b.record.id);
        if (seen.has(key)) continue;
        seen.add(key);
        if (known.has(key) || !pairAllowed(a.record, b.record)) continue;
        const found = basisFor(a, b, common);
        if (!found) continue;
        const [from, to] = a.record.id < b.record.id ? [a.record, b.record] : [b.record, a.record];
        candidates.push({ from, to, ...found });
      }
    }
  }
  candidates.sort((x, y) => y.score - x.score || pairKey(x.from.id, x.to.id).localeCompare(pairKey(y.from.id, y.to.id)));
  const accepted: typeof candidates = [];
  for (const candidate of candidates) {
    if ((counts.get(candidate.from.id) ?? 0) >= max || (counts.get(candidate.to.id) ?? 0) >= max) continue;
    counts.set(candidate.from.id, (counts.get(candidate.from.id) ?? 0) + 1);
    counts.set(candidate.to.id, (counts.get(candidate.to.id) ?? 0) + 1);
    accepted.push(candidate);
  }
  return accepted;
}

type LinkCheckActor = { actorType: "agent" | "user" | "system"; actorId: string; agentId: string | null; runId: string | null };

/**
 * One pass over a company's live records. Safe to run again at any time: a
 * pair already stated, superseded, in a conflict or already a lead (open,
 * confirmed or dismissed) is never proposed again.
 */
export async function runMemoryLinkCheck(
  db: Db,
  companyId: string,
  options: { now?: Date; actor?: LinkCheckActor; trigger?: "schedule" | "owner" } = {},
): Promise<MemoryLinkCheckResult> {
  const now = options.now ?? new Date();
  const actor: LinkCheckActor = options.actor ?? { actorType: "system", actorId: SYSTEM_ACTOR_ID, agentId: null, runId: null };
  const scopes = new Map(
    (await db.select().from(memoryScopes).where(eq(memoryScopes.companyId, companyId))).map((scope) => [scope.id, scope]),
  );
  const rows = await db
    .select({
      id: memoryRecords.id,
      scopeId: memoryRecords.scopeId,
      title: memoryRecords.title,
      content: memoryRecords.content,
      entities: memoryRecords.entities,
      topics: memoryRecords.topics,
      sourceKind: memoryRecords.sourceKind,
      sourceId: memoryRecords.sourceId,
      supersedesId: memoryRecords.supersedesId,
    })
    .from(memoryRecords)
    .where(and(eq(memoryRecords.companyId, companyId), notInArray(memoryRecords.status, ["deleted", "superseded"])))
    .orderBy(desc(memoryRecords.updatedAt), desc(memoryRecords.id))
    .limit(MEMORY_LINK_CHECK_MAX_RECORDS);
  const records: LinkCheckRecord[] = rows.flatMap((row) => {
    const scope = scopes.get(row.scopeId);
    return scope ? [{ ...row, scopeKind: scope.kind }] : [];
  });

  const known = new Set<string>();
  const openLeadCounts = new Map<string, number>();
  if (records.length > 1) {
    for (const rel of await db
      .select({ a: memoryRelationships.fromRecordId, b: memoryRelationships.toRecordId })
      .from(memoryRelationships)
      .where(eq(memoryRelationships.companyId, companyId))) {
      known.add(pairKey(rel.a, rel.b));
    }
    for (const row of await db
      .select({ a: memoryConflicts.recordId, b: memoryConflicts.approvedRecordId })
      .from(memoryConflicts)
      .where(eq(memoryConflicts.companyId, companyId))) {
      known.add(pairKey(row.a, row.b));
    }
    for (const row of rows) if (row.supersedesId) known.add(pairKey(row.id, row.supersedesId));
    for (const lead of await db
      .select({ a: memoryLinkLeads.fromRecordId, b: memoryLinkLeads.toRecordId, state: memoryLinkLeads.state })
      .from(memoryLinkLeads)
      .where(eq(memoryLinkLeads.companyId, companyId))) {
      known.add(pairKey(lead.a, lead.b));
      if (lead.state === "open") {
        openLeadCounts.set(lead.a, (openLeadCounts.get(lead.a) ?? 0) + 1);
        openLeadCounts.set(lead.b, (openLeadCounts.get(lead.b) ?? 0) + 1);
      }
    }
  }

  const found = records.length > 1 ? findLinkLeads(records, { known, openLeadCounts }) : [];
  let proposed = 0;
  for (let start = 0; start < found.length; start += 200) {
    const inserted = await db
      .insert(memoryLinkLeads)
      .values(
        found.slice(start, start + 200).map((lead) => ({
          companyId,
          fromRecordId: lead.from.id,
          toRecordId: lead.to.id,
          fromScopeId: lead.from.scopeId,
          toScopeId: lead.to.scopeId,
          basis: lead.basis,
          score: lead.score,
          detectedAt: now,
        })),
      )
      .onConflictDoNothing({ target: [memoryLinkLeads.fromRecordId, memoryLinkLeads.toRecordId] })
      .returning({ id: memoryLinkLeads.id });
    proposed += inserted.length;
  }
  const result: MemoryLinkCheckResult = {
    note: MEMORY_LINK_LEAD_NOTE,
    recordsChecked: records.length,
    proposed,
    alreadyKnown: known.size,
    ranAt: now,
  };
  // Counts only: the audit row names no record, term or scope.
  await db.insert(memoryOperations).values({
    companyId,
    operation: LINK_CHECK_OPERATION,
    outcome: "ok",
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    runId: actor.runId,
    detail: { trigger: options.trigger ?? "schedule", recordsChecked: result.recordsChecked, proposed, alreadyKnown: result.alreadyKnown },
    createdAt: now,
  });
  return result;
}

/** Last pass per company, so the scheduler reads the audit table once per company per boot. */
const lastPassAt = new Map<string, number>();

/**
 * Called on every scheduler sweep. Runs the link check for each company with
 * memory on, at most once per MEMORY_LINK_CHECK_INTERVAL_MS (an owner can run
 * it sooner from the memory routes). A failure is logged and retried on a
 * later sweep; it never stops other work.
 */
export async function runScheduledMemoryLinkChecks(db: Db, now = new Date()) {
  const enabled = await db.select({ companyId: memorySettings.companyId }).from(memorySettings).where(eq(memorySettings.enabled, true));
  let ran = 0;
  for (const { companyId } of enabled) {
    if (!lastPassAt.has(companyId)) {
      const [last] = await db
        .select({ at: memoryOperations.createdAt })
        .from(memoryOperations)
        .where(and(eq(memoryOperations.companyId, companyId), eq(memoryOperations.operation, LINK_CHECK_OPERATION)))
        .orderBy(desc(memoryOperations.createdAt))
        .limit(1);
      lastPassAt.set(companyId, last ? last.at.getTime() : 0);
    }
    if (now.getTime() - (lastPassAt.get(companyId) ?? 0) < MEMORY_LINK_CHECK_INTERVAL_MS) continue;
    lastPassAt.set(companyId, now.getTime());
    try {
      await runMemoryLinkCheck(db, companyId, { now, trigger: "schedule" });
      ran += 1;
    } catch (error) {
      logger.warn({ err: error, companyId }, "memory link check failed; it runs again on a later sweep");
    }
  }
  return { ran };
}

/** For tests: forget the in-process schedule. */
export function resetMemoryLinkCheckSchedule() {
  lastPassAt.clear();
}

type LeadRow = typeof memoryLinkLeads.$inferSelect;

function toLead(row: LeadRow, from: RecordRow, to: RecordRow, scopes: Map<string, ScopeRow>): MemoryLinkLead {
  return {
    id: row.id,
    fromRecordId: row.fromRecordId,
    toRecordId: row.toRecordId,
    basis: row.basis,
    state: row.state as MemoryLinkLeadState,
    resolution: row.resolution,
    resolutionNote: row.resolutionNote,
    relationshipId: row.relationshipId,
    detectedAt: row.detectedAt,
    resolvedAt: row.resolvedAt,
    from: toRecord(from, scopes.get(from.scopeId)!),
    to: toRecord(to, scopes.get(to.scopeId)!),
  };
}

/** Lead review for the owner and memory reviewers, and the owner's "run now". */
export function memoryLinkService(db: Db, gateway: MemoryGatewayService) {
  const { accessFor, logOperation } = gateway.internals;

  async function readableScopes(caller: MemoryCaller) {
    await gateway.assertEnabled(caller.companyId);
    const access = await accessFor(caller);
    const scopes = (await db.select().from(memoryScopes).where(eq(memoryScopes.companyId, caller.companyId))).filter((scope) =>
      access.canRead(scope),
    );
    return { access, byId: new Map(scopes.map((scope) => [scope.id, scope])) };
  }

  async function list(caller: MemoryCaller, state: MemoryLinkLeadState | "all"): Promise<MemoryLinkLeadList> {
    const { byId } = await readableScopes(caller);
    const scopeIds = [...byId.keys()];
    const rows =
      scopeIds.length === 0
        ? []
        : await db
            .select()
            .from(memoryLinkLeads)
            .where(
              and(
                eq(memoryLinkLeads.companyId, caller.companyId),
                inArray(memoryLinkLeads.fromScopeId, scopeIds),
                inArray(memoryLinkLeads.toScopeId, scopeIds),
                ...(state === "all" ? [] : [eq(memoryLinkLeads.state, state)]),
              ),
            )
            .orderBy(desc(memoryLinkLeads.score), desc(memoryLinkLeads.detectedAt))
            .limit(200);
    const ids = [...new Set(rows.flatMap((row) => [row.fromRecordId, row.toRecordId]))];
    const records = new Map(
      (ids.length === 0
        ? []
        : await db
            .select()
            .from(memoryRecords)
            .where(and(eq(memoryRecords.companyId, caller.companyId), inArray(memoryRecords.id, ids)))
      ).map((row) => [row.id, row]),
    );
    const leads = rows.flatMap((row) => {
      const from = records.get(row.fromRecordId);
      const to = records.get(row.toRecordId);
      // Both ends checked against the reader, never the scope ids on the lead alone.
      if (!from || !to || !byId.has(from.scopeId) || !byId.has(to.scopeId)) return [];
      return [toLead(row, from, to, byId)];
    });
    await logOperation(caller, "link_leads_list", "ok", { detail: { state, returned: leads.length } });
    return { note: MEMORY_LINK_LEAD_NOTE, leads };
  }

  /** The owner, or a reviewer for both ends: `memory:approve` on the scope, or the agent's own working notes. */
  function mayReview(access: Awaited<ReturnType<typeof accessFor>>, scopes: ScopeRow[]) {
    if (access.isOwner) return true;
    return scopes.every((scope) => access.ownsAgentScope(scope) || grantCovers(access.grants, "memory:approve", scope));
  }

  async function loadOpenLead(caller: MemoryCaller, leadId: string, operation: string) {
    const { access, byId } = await readableScopes(caller);
    const lead = await db
      .select()
      .from(memoryLinkLeads)
      .where(and(eq(memoryLinkLeads.id, leadId), eq(memoryLinkLeads.companyId, caller.companyId)))
      .then((rows) => rows[0] ?? null);
    const ends = lead
      ? await db
          .select()
          .from(memoryRecords)
          .where(and(eq(memoryRecords.companyId, caller.companyId), inArray(memoryRecords.id, [lead.fromRecordId, lead.toRecordId])))
      : [];
    const from = ends.find((row) => row.id === lead?.fromRecordId);
    const to = ends.find((row) => row.id === lead?.toRecordId);
    if (!lead || !from || !to || !byId.has(from.scopeId) || !byId.has(to.scopeId)) {
      await logOperation(caller, operation, "denied", { detail: { requestedId: leadId.slice(0, 100) } });
      throw notFound("Memory link lead not found");
    }
    const audit = { scopeIds: [...new Set([from.scopeId, to.scopeId])], recordId: from.id };
    if (lead.state !== "open") throw conflict(`The lead is already ${lead.state}`);
    if (!mayReview(access, [byId.get(from.scopeId)!, byId.get(to.scopeId)!])) {
      await logOperation(caller, operation, "denied", { ...audit, detail: { reason: "no_review_right", leadId } });
      throw forbidden("Only the company owner or a memory reviewer for both entries can confirm or dismiss a lead");
    }
    if (from.status === "deleted" || to.status === "deleted") throw conflict("A deleted record cannot be related");
    return { lead, from, to, scopes: byId, audit };
  }

  async function confirm(caller: MemoryCaller, leadId: string, input: ConfirmMemoryLinkLead): Promise<MemoryLinkLead> {
    const operation = "link_lead_confirm";
    const { lead, from, to, scopes, audit } = await loadOpenLead(caller, leadId, operation);
    const [linkFrom, linkTo] = input.reverse ? [to, from] : [from, to];
    const now = new Date();
    const next = await db.transaction(async (tx) => {
      const created = await insertRelationship(tx, caller, linkFrom, linkTo, {
        type: input.type,
        note: input.reason,
        sourceKind: LINK_LEAD_SOURCE_KIND,
        sourceId: lead.id,
        now,
      });
      const relationshipId =
        created?.id ??
        (await tx
          .select({ id: memoryRelationships.id })
          .from(memoryRelationships)
          .where(
            and(
              eq(memoryRelationships.fromRecordId, linkFrom.id),
              eq(memoryRelationships.toRecordId, linkTo.id),
              eq(memoryRelationships.type, input.type),
            ),
          )
          .then((rows) => rows[0]?.id ?? null));
      const [updated] = await tx
        .update(memoryLinkLeads)
        .set({
          state: "confirmed",
          resolution: "confirmed",
          resolutionNote: input.reason,
          resolvedByActorType: caller.actorType,
          resolvedByActorId: caller.actorId,
          resolvedAt: now,
          relationshipId,
        })
        .where(and(eq(memoryLinkLeads.id, lead.id), eq(memoryLinkLeads.state, "open")))
        .returning();
      if (!updated) throw conflict("The lead changed while it was reviewed; read it again");
      return updated;
    });
    await logOperation(caller, operation, "ok", {
      ...audit,
      detail: { leadId: lead.id, relationshipId: next.relationshipId, type: input.type, reverse: input.reverse },
    });
    return toLead(next, from, to, scopes);
  }

  async function dismiss(caller: MemoryCaller, leadId: string, input: DismissMemoryLinkLead): Promise<MemoryLinkLead> {
    const operation = "link_lead_dismiss";
    const { lead, from, to, scopes, audit } = await loadOpenLead(caller, leadId, operation);
    const now = new Date();
    const [next] = await db
      .update(memoryLinkLeads)
      .set({
        state: "dismissed",
        resolution: "dismissed",
        resolutionNote: input.reason,
        resolvedByActorType: caller.actorType,
        resolvedByActorId: caller.actorId,
        resolvedAt: now,
      })
      .where(and(eq(memoryLinkLeads.id, lead.id), eq(memoryLinkLeads.state, "open")))
      .returning();
    if (!next) throw conflict("The lead changed while it was reviewed; read it again");
    await logOperation(caller, operation, "ok", { ...audit, detail: { leadId: lead.id } });
    return toLead(next, from, to, scopes);
  }

  /** The owner's "run now". The check itself reads every scope; what it writes is shown only to readers of both ends. */
  async function runNow(caller: MemoryCaller): Promise<MemoryLinkCheckResult> {
    await gateway.assertEnabled(caller.companyId);
    const access = await accessFor(caller);
    if (!access.isOwner && !access.grants.has("memory:admin")) {
      await logOperation(caller, LINK_CHECK_OPERATION, "denied", { detail: { reason: "not_owner" } });
      throw forbidden("Only the company owner or a memory admin can run the link check");
    }
    return runMemoryLinkCheck(db, caller.companyId, {
      actor: { actorType: caller.actorType, actorId: caller.actorId, agentId: caller.agentId, runId: caller.runId },
      trigger: "owner",
    });
  }

  return { list, confirm, dismiss, runNow };
}

export type MemoryLinkService = ReturnType<typeof memoryLinkService>;
