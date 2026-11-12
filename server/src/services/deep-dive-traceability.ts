import { and, asc, eq, inArray, notInArray, or } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  caseDocuments,
  cases,
  deepDiveBuilds,
  deepDiveCommercials,
  deepDiveFindingEvidence,
  deepDiveFindings,
  deepDiveKpis,
  deepDiveOpportunities,
  deepDiveOpportunityFindings,
  deepDiveRoadmapItems,
  deepDiveRoadmapKpis,
  documents,
  pipelineCaseEvidence,
} from "@greatstone/db";
import {
  DEEP_DIVE_CASE_TYPES,
  DEEP_DIVE_RECORD_DOCUMENTS,
  deepDiveBrokenLinks,
  deepDiveNorthStarWords,
  type CreateDeepDiveCommercial,
  type CreateDeepDiveRoadmapItem,
  type DeepDiveBuildState,
  type DeepDiveFindingStatus,
  type DeepDiveTraceability,
  type DeepDiveVisibility,
  type UpdateDeepDiveCommercial,
  type UpdateDeepDiveRoadmapItem,
} from "@greatstone/shared";
import { inRecord, scopeOfRow, type DeepDiveScope } from "./deep-dive-scope.js";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import type { DeepDiveOpportunityActor } from "./deep-dive-opportunities.js";

// Deep Dive traceability (GRE-2371): Screen 8 of the GRE-2327 plan. Reads the
// whole chain North Star → Source → Finding → Opportunity → Design →
// Commercial → Roadmap → KPI from its real links and lists where it breaks.
// Commercial cases and roadmap items are written here; every other step is
// written on its own screen. Every write returns the whole chain. The
// deep_dive_traceability_guard trigger in migration 0401 keeps links inside
// the company for any writer; this service turns its refusals into 422s.

export const DEEP_DIVE_TRACE_KINDS = {
  commercial: { table: deepDiveCommercials, label: "Commercial case" },
  roadmap: { table: deepDiveRoadmapItems, label: "Roadmap item" },
} as const;
export type DeepDiveTraceKind = keyof typeof DEEP_DIVE_TRACE_KINDS;

const NORTH_STAR_KEY = DEEP_DIVE_RECORD_DOCUMENTS[0].key;

function asTraceError(error: unknown): unknown {
  const cause = ((error as { cause?: unknown })?.cause ?? error) as { code?: string; message?: string };
  if (cause?.code === "23505") return conflict("That link is already recorded");
  if (cause?.code === "23503") return unprocessable("That link points at something that is not in this Deep Dive");
  if (cause?.code === "23514") return unprocessable(cause.message ?? "Refused");
  return error;
}

async function write<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((error) => {
    throw asTraceError(error);
  });
}

/** Drop keys the caller did not send, so a PATCH never blanks what it did not name. */
function sent<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}

export function deepDiveTraceabilityService(db: Db) {
  type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

  async function scopeOf(kind: DeepDiveTraceKind, id: string): Promise<DeepDiveScope> {
    const { label } = DEEP_DIVE_TRACE_KINDS[kind];
    const table = DEEP_DIVE_TRACE_KINDS[kind].table as typeof deepDiveCommercials;
    const row = await db
      .select({ companyId: table.companyId, recordCaseId: table.recordCaseId })
      .from(table)
      .where(eq(table.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound(`${label} not found`);
    return scopeOfRow(row, label);
  }

  async function chain(scope: DeepDiveScope): Promise<DeepDiveTraceability> {
    const companyId = scope.companyId;
    const [northStar, opportunities, allFindingLinks, builds, commercials, roadmap, allKpiLinks, kpis] = await Promise.all([
      db.select({ documentId: documents.id, body: documents.latestBody })
        .from(cases)
        .innerJoin(caseDocuments, and(eq(caseDocuments.caseId, cases.id), eq(caseDocuments.key, NORTH_STAR_KEY)))
        .innerJoin(documents, eq(documents.id, caseDocuments.documentId))
        .where(and(
          eq(cases.companyId, companyId),
          eq(cases.caseType, DEEP_DIVE_CASE_TYPES.record),
          eq(cases.id, scope.recordCaseId),
        ))
        .then((rows) => rows[0] ?? null),
      db.select({ id: deepDiveOpportunities.id, name: deepDiveOpportunities.name }).from(deepDiveOpportunities)
        .where(inRecord(deepDiveOpportunities, scope)).orderBy(asc(deepDiveOpportunities.createdAt)),
      db.select().from(deepDiveOpportunityFindings).where(eq(deepDiveOpportunityFindings.companyId, companyId))
        .orderBy(asc(deepDiveOpportunityFindings.createdAt)),
      db.select({
        id: deepDiveBuilds.id,
        name: deepDiveBuilds.name,
        state: deepDiveBuilds.state,
        opportunityId: deepDiveBuilds.opportunityId,
      }).from(deepDiveBuilds).where(inRecord(deepDiveBuilds, scope)).orderBy(asc(deepDiveBuilds.createdAt)),
      db.select().from(deepDiveCommercials).where(inRecord(deepDiveCommercials, scope))
        .orderBy(asc(deepDiveCommercials.createdAt)),
      db.select().from(deepDiveRoadmapItems).where(inRecord(deepDiveRoadmapItems, scope))
        .orderBy(asc(deepDiveRoadmapItems.createdAt)),
      db.select().from(deepDiveRoadmapKpis).where(eq(deepDiveRoadmapKpis.companyId, companyId))
        .orderBy(asc(deepDiveRoadmapKpis.createdAt)),
      db.select({ id: deepDiveKpis.id, name: deepDiveKpis.name }).from(deepDiveKpis)
        .where(inRecord(deepDiveKpis, scope)).orderBy(asc(deepDiveKpis.createdAt)),
    ]);
    const opportunityIds = new Set(opportunities.map((o) => o.id));
    const roadmapIds = new Set(roadmap.map((r) => r.id));
    const findingLinks = allFindingLinks.filter((l) => opportunityIds.has(l.opportunityId));
    const kpiLinks = allKpiLinks.filter((l) => roadmapIds.has(l.roadmapItemId));

    const linkedFindingIds = [...new Set(findingLinks.map((l) => l.findingId))];
    const findings = await db
      .select({ id: deepDiveFindings.id, statement: deepDiveFindings.statement, status: deepDiveFindings.status })
      .from(deepDiveFindings)
      .where(and(
        inRecord(deepDiveFindings, scope),
        linkedFindingIds.length
          ? or(eq(deepDiveFindings.status, "validated"), inArray(deepDiveFindings.id, linkedFindingIds))
          : eq(deepDiveFindings.status, "validated"),
      ))
      .orderBy(asc(deepDiveFindings.createdAt));
    const sourceLinks = findings.length
      ? await db
        .select({ findingId: deepDiveFindingEvidence.findingId, id: pipelineCaseEvidence.id, title: pipelineCaseEvidence.title })
        .from(deepDiveFindingEvidence)
        .innerJoin(pipelineCaseEvidence, eq(pipelineCaseEvidence.id, deepDiveFindingEvidence.evidenceId))
        .where(and(
          eq(deepDiveFindingEvidence.companyId, companyId),
          inArray(deepDiveFindingEvidence.findingId, findings.map((f) => f.id)),
        ))
        .orderBy(asc(pipelineCaseEvidence.title))
      : [];

    const group = <T,>(rows: T[], key: (row: T) => string, value: (row: T) => string) => {
      const out = new Map<string, string[]>();
      for (const row of rows) out.set(key(row), [...(out.get(key(row)) ?? []), value(row)]);
      return out;
    };
    const findingsOf = group(findingLinks, (l) => l.opportunityId, (l) => l.findingId);
    const sourcesOf = group(sourceLinks, (l) => l.findingId, (l) => l.id);
    const kpisOf = group(kpiLinks, (l) => l.roadmapItemId, (l) => l.kpiId);
    const sources = [...new Map(sourceLinks.map((s) => [s.id, { id: s.id, title: s.title }])).values()];

    const links: Omit<DeepDiveTraceability, "companyId" | "broken"> = {
      northStar: northStar ? { documentId: northStar.documentId, words: deepDiveNorthStarWords(northStar.body) } : null,
      sources,
      findings: findings.map((f) => ({
        ...f,
        status: f.status as DeepDiveFindingStatus,
        sourceIds: sourcesOf.get(f.id) ?? [],
      })),
      opportunities: opportunities.map((o) => ({ ...o, findingIds: findingsOf.get(o.id) ?? [] })),
      designs: builds.map((b) => ({ ...b, state: b.state as DeepDiveBuildState })),
      commercials: commercials.map((c) => ({
        id: c.id,
        name: c.name,
        terms: c.terms,
        value: c.value,
        buildId: c.buildId,
        visibility: c.visibility as DeepDiveVisibility,
      })),
      roadmap: roadmap.map((r) => ({
        id: r.id,
        name: r.name,
        phase: r.phase,
        commercialId: r.commercialId,
        kpiIds: kpisOf.get(r.id) ?? [],
        visibility: r.visibility as DeepDiveVisibility,
      })),
      kpis,
    };
    return { companyId, ...links, broken: deepDiveBrokenLinks(links) };
  }

  async function setKpis(tx: Tx, companyId: string, roadmapItemId: string, kpiIds: string[]) {
    const wanted = [...new Set(kpiIds)];
    await tx.delete(deepDiveRoadmapKpis).where(and(
      eq(deepDiveRoadmapKpis.roadmapItemId, roadmapItemId),
      wanted.length ? notInArray(deepDiveRoadmapKpis.kpiId, wanted) : undefined,
    ));
    const kept = new Set((await tx.select({ kpiId: deepDiveRoadmapKpis.kpiId })
      .from(deepDiveRoadmapKpis).where(eq(deepDiveRoadmapKpis.roadmapItemId, roadmapItemId))).map((l) => l.kpiId));
    const added = wanted.filter((kpiId) => !kept.has(kpiId));
    if (added.length) {
      await tx.insert(deepDiveRoadmapKpis).values(added.map((kpiId) => ({ companyId, roadmapItemId, kpiId })));
    }
  }

  async function assertKpisInRecord(ids: string[] | undefined, scope: DeepDiveScope) {
    const wanted = [...new Set(ids ?? [])];
    if (!wanted.length) return;
    const found = await db.select({ id: deepDiveKpis.id }).from(deepDiveKpis).where(and(inRecord(deepDiveKpis, scope), inArray(deepDiveKpis.id, wanted)));
    if (found.length !== wanted.length) throw unprocessable("That link points at something that is not in this Deep Dive");
  }

  function onlyPersonShares(visibility: DeepDiveVisibility | undefined, actor: DeepDiveOpportunityActor) {
    if (actor.type !== "user" && visibility !== undefined) throw forbidden("Only a person can share or unshare a Deep Dive item");
  }

  return {
    scopeOf,
    companyOf: async (kind: DeepDiveTraceKind, id: string) => (await scopeOf(kind, id)).companyId,
    chain,

    createCommercial: async (scope: DeepDiveScope, input: CreateDeepDiveCommercial) => {
      await write(db.insert(deepDiveCommercials).values({ ...scope, ...input }));
      return chain(scope);
    },

    updateCommercial: async (commercialId: string, input: UpdateDeepDiveCommercial, actor: DeepDiveOpportunityActor) => {
      onlyPersonShares(input.visibility, actor);
      const scope = await scopeOf("commercial", commercialId);
      await write(db.update(deepDiveCommercials).set({ ...sent(input), updatedAt: new Date() })
        .where(eq(deepDiveCommercials.id, commercialId)));
      return chain(scope);
    },

    /** Roadmap items that delivered it stay, and the check shows them as broken. */
    deleteCommercial: async (commercialId: string) => {
      const scope = await scopeOf("commercial", commercialId);
      await write(db.delete(deepDiveCommercials).where(eq(deepDiveCommercials.id, commercialId)));
      return chain(scope);
    },

    createRoadmapItem: async (scope: DeepDiveScope, input: CreateDeepDiveRoadmapItem) => {
      const { kpiIds, ...fields } = input;
      await assertKpisInRecord(kpiIds, scope);
      await write(db.transaction(async (tx) => {
        const [row] = await tx.insert(deepDiveRoadmapItems).values({ ...scope, ...fields })
          .returning({ id: deepDiveRoadmapItems.id });
        if (kpiIds) await setKpis(tx, scope.companyId, row!.id, kpiIds);
      }));
      return chain(scope);
    },

    updateRoadmapItem: async (roadmapItemId: string, input: UpdateDeepDiveRoadmapItem, actor: DeepDiveOpportunityActor) => {
      onlyPersonShares(input.visibility, actor);
      const scope = await scopeOf("roadmap", roadmapItemId);
      const { kpiIds, ...fields } = input;
      await assertKpisInRecord(kpiIds, scope);
      await write(db.transaction(async (tx) => {
        await tx.update(deepDiveRoadmapItems).set({ ...sent(fields), updatedAt: new Date() })
          .where(eq(deepDiveRoadmapItems.id, roadmapItemId));
        if (kpiIds) await setKpis(tx, scope.companyId, roadmapItemId, kpiIds);
      }));
      return chain(scope);
    },

    deleteRoadmapItem: async (roadmapItemId: string) => {
      const scope = await scopeOf("roadmap", roadmapItemId);
      await write(db.delete(deepDiveRoadmapItems).where(eq(deepDiveRoadmapItems.id, roadmapItemId)));
      return chain(scope);
    },
  };
}
