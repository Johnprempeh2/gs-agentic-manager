import { and, asc, eq, inArray, notInArray, or } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  cases,
  deepDiveBuilds,
  deepDiveFindings,
  deepDiveKpiProcesses,
  deepDiveKpis,
  deepDiveOpportunities,
  deepDiveOpportunityFindings,
  deepDivePeople,
  deepDiveProcesses,
} from "@greatstone/db";
import type {
  CreateDeepDiveBuild,
  CreateDeepDiveKpi,
  CreateDeepDiveOpportunity,
  DeepDiveBuildState,
  DeepDiveFindingStatus,
  DeepDiveKpiDirection,
  DeepDiveKpiScope,
  DeepDiveOpportunityBoard,
  DeepDiveOpportunityState,
  DeepDiveVisibility,
  UpdateDeepDiveBuild,
  UpdateDeepDiveKpi,
  UpdateDeepDiveOpportunity,
} from "@greatstone/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import type { DeepDiveFindingActor } from "./deep-dive-findings.js";
import { inRecord, scopeOfRow, type DeepDiveScope } from "./deep-dive-scope.js";

// Deep Dive opportunities and KPIs (GRE-2370): Screen 7 of the GRE-2327 plan.
// Every write returns the whole board, so the page shows exactly what was
// saved. The deep_dive_opportunity_guard trigger in migration 0400 keeps every
// link inside the company and links only validated findings, for any writer;
// this service turns its refusals into 422s. Links are replaced as a set: a
// link that stays is kept as it was, so a finding superseded after it was
// linked stays linked.

export type DeepDiveOpportunityActor = DeepDiveFindingActor;

export const DEEP_DIVE_OPPORTUNITY_KINDS = {
  opportunity: { table: deepDiveOpportunities, label: "Opportunity" },
  build: { table: deepDiveBuilds, label: "Build" },
  kpi: { table: deepDiveKpis, label: "KPI" },
} as const;
export type DeepDiveOpportunityKind = keyof typeof DEEP_DIVE_OPPORTUNITY_KINDS;

const CHECK_MESSAGES: Record<string, string> = {
  deep_dive_builds_why_check: "A build that is considered, deferred, tabled or cancelled needs a reason",
  deep_dive_kpis_baseline_check: "A baseline needs how it is calculated and the period it covers",
  deep_dive_opportunities_outcome_check: "An opportunity needs a desired outcome",
};

function asOpportunityError(error: unknown): unknown {
  const cause = ((error as { cause?: unknown })?.cause ?? error) as {
    code?: string;
    message?: string;
    constraint_name?: string;
    constraint?: string;
  };
  const constraint = cause?.constraint_name ?? cause?.constraint ?? "";
  if (cause?.code === "23505") return conflict("That link is already recorded");
  if (cause?.code === "23503") return unprocessable("That link points at something that is not in this Deep Dive");
  if (cause?.code === "23514") return unprocessable(CHECK_MESSAGES[constraint] ?? cause.message ?? "Refused");
  return error;
}

async function write<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((error) => {
    throw asOpportunityError(error);
  });
}

/** Drop keys the caller did not send, so a PATCH never blanks what it did not name. */
function sent<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}

export function deepDiveOpportunitiesService(db: Db) {
  type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

  async function scopeOf(kind: DeepDiveOpportunityKind, id: string): Promise<DeepDiveScope> {
    const { label } = DEEP_DIVE_OPPORTUNITY_KINDS[kind];
    const table = DEEP_DIVE_OPPORTUNITY_KINDS[kind].table as typeof deepDiveOpportunities;
    const row = await db
      .select({ companyId: table.companyId, recordCaseId: table.recordCaseId })
      .from(table)
      .where(eq(table.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound(`${label} not found`);
    return scopeOfRow(row, label);
  }

  /** Links may only point inside this Deep Dive. */
  async function assertInRecord(table: typeof deepDiveFindings | typeof deepDiveProcesses, ids: string[] | undefined, scope: DeepDiveScope) {
    const wanted = [...new Set(ids ?? [])];
    if (!wanted.length) return;
    const found = await db.select({ id: table.id }).from(table).where(and(inRecord(table, scope), inArray(table.id, wanted)));
    if (found.length !== wanted.length) throw unprocessable("That link points at something that is not in this Deep Dive");
  }

  async function board(scope: DeepDiveScope): Promise<DeepDiveOpportunityBoard> {
    const companyId = scope.companyId;
    const [opportunities, allFindingLinks, builds, kpis, allProcessLinks, processes, people] = await Promise.all([
      db.select().from(deepDiveOpportunities).where(inRecord(deepDiveOpportunities, scope))
        .orderBy(asc(deepDiveOpportunities.createdAt)),
      db.select().from(deepDiveOpportunityFindings).where(eq(deepDiveOpportunityFindings.companyId, companyId))
        .orderBy(asc(deepDiveOpportunityFindings.createdAt)),
      db.select().from(deepDiveBuilds).where(inRecord(deepDiveBuilds, scope))
        .orderBy(asc(deepDiveBuilds.createdAt)),
      db.select().from(deepDiveKpis).where(inRecord(deepDiveKpis, scope))
        .orderBy(asc(deepDiveKpis.createdAt)),
      db.select().from(deepDiveKpiProcesses).where(eq(deepDiveKpiProcesses.companyId, companyId))
        .orderBy(asc(deepDiveKpiProcesses.createdAt)),
      db.select({ id: deepDiveProcesses.id, name: deepDiveProcesses.name }).from(deepDiveProcesses)
        .where(inRecord(deepDiveProcesses, scope)).orderBy(asc(deepDiveProcesses.name)),
      db.select({ id: deepDivePeople.id, name: deepDivePeople.name }).from(deepDivePeople)
        .where(inRecord(deepDivePeople, scope)).orderBy(asc(deepDivePeople.name)),
    ]);
    const opportunityIds = new Set(opportunities.map((o) => o.id));
    const kpiIds = new Set(kpis.map((k) => k.id));
    const findingLinks = allFindingLinks.filter((l) => opportunityIds.has(l.opportunityId));
    const processLinks = allProcessLinks.filter((l) => kpiIds.has(l.kpiId));
    const linkedFindingIds = [...new Set(findingLinks.map((l) => l.findingId))];
    const findings = await db
      .select({
        id: deepDiveFindings.id,
        statement: deepDiveFindings.statement,
        status: deepDiveFindings.status,
        streamTitle: cases.title,
      })
      .from(deepDiveFindings)
      .innerJoin(cases, eq(cases.id, deepDiveFindings.streamCaseId))
      .where(and(
        inRecord(deepDiveFindings, scope),
        linkedFindingIds.length
          ? or(eq(deepDiveFindings.status, "validated"), inArray(deepDiveFindings.id, linkedFindingIds))
          : eq(deepDiveFindings.status, "validated"),
      ))
      .orderBy(asc(cases.title), asc(deepDiveFindings.createdAt));

    const findingsOf = new Map<string, string[]>();
    for (const l of findingLinks) findingsOf.set(l.opportunityId, [...(findingsOf.get(l.opportunityId) ?? []), l.findingId]);
    const processesOf = new Map<string, string[]>();
    for (const l of processLinks) processesOf.set(l.kpiId, [...(processesOf.get(l.kpiId) ?? []), l.processId]);

    return {
      companyId,
      opportunities: opportunities.map((o) => ({
        id: o.id,
        ref: o.ref,
        name: o.name,
        statement: o.statement,
        rootCause: o.rootCause,
        desiredOutcome: o.desiredOutcome,
        potentialValue: o.potentialValue,
        state: o.state as DeepDiveOpportunityState,
        findingIds: findingsOf.get(o.id) ?? [],
        visibility: o.visibility as DeepDiveVisibility,
      })),
      builds: builds.map((b) => ({
        id: b.id,
        ref: b.ref,
        name: b.name,
        what: b.what,
        opportunityId: b.opportunityId,
        state: b.state as DeepDiveBuildState,
        stateWhy: b.stateWhy,
        visibility: b.visibility as DeepDiveVisibility,
      })),
      kpis: kpis.map((k) => ({
        id: k.id,
        name: k.name,
        scope: k.scope as DeepDiveKpiScope,
        ownerPersonId: k.ownerPersonId,
        unit: k.unit,
        direction: k.direction as DeepDiveKpiDirection,
        baseline: Number(k.baseline),
        definition: k.definition,
        baselinePeriod: k.baselinePeriod,
        target: Number(k.target),
        processIds: processesOf.get(k.id) ?? [],
        visibility: k.visibility as DeepDiveVisibility,
      })),
      findings: findings.map((f) => ({ ...f, status: f.status as DeepDiveFindingStatus })),
      processes,
      people,
    };
  }

  /**
   * Makes the opportunity's findings exactly `findingIds`. Links that stay are not rewritten, so a
   * finding superseded after it was linked stays linked; only new links must be validated.
   */
  async function setFindings(tx: Tx, companyId: string, opportunityId: string, findingIds: string[]) {
    const wanted = [...new Set(findingIds)];
    await tx.delete(deepDiveOpportunityFindings).where(and(
      eq(deepDiveOpportunityFindings.opportunityId, opportunityId),
      wanted.length ? notInArray(deepDiveOpportunityFindings.findingId, wanted) : undefined,
    ));
    const kept = new Set((await tx.select({ findingId: deepDiveOpportunityFindings.findingId })
      .from(deepDiveOpportunityFindings).where(eq(deepDiveOpportunityFindings.opportunityId, opportunityId))).map((l) => l.findingId));
    const added = wanted.filter((findingId) => !kept.has(findingId));
    if (added.length) {
      await tx.insert(deepDiveOpportunityFindings).values(added.map((findingId) => ({ companyId, opportunityId, findingId })));
    }
  }

  async function setProcesses(tx: Tx, companyId: string, kpiId: string, processIds: string[]) {
    const wanted = [...new Set(processIds)];
    await tx.delete(deepDiveKpiProcesses).where(and(
      eq(deepDiveKpiProcesses.kpiId, kpiId),
      wanted.length ? notInArray(deepDiveKpiProcesses.processId, wanted) : undefined,
    ));
    const kept = new Set((await tx.select({ processId: deepDiveKpiProcesses.processId })
      .from(deepDiveKpiProcesses).where(eq(deepDiveKpiProcesses.kpiId, kpiId))).map((l) => l.processId));
    const added = wanted.filter((processId) => !kept.has(processId));
    if (added.length) {
      await tx.insert(deepDiveKpiProcesses).values(added.map((processId) => ({ companyId, kpiId, processId })));
    }
  }

  function onlyPersonDecides(input: { visibility?: DeepDiveVisibility; state?: string }, actor: DeepDiveOpportunityActor) {
    if (actor.type === "user") return;
    if (input.visibility !== undefined) throw forbidden("Only a person can share or unshare a Deep Dive item");
    if (input.state === "validated") throw forbidden("Only a person can validate an opportunity");
  }

  return {
    scopeOf,
    companyOf: async (kind: DeepDiveOpportunityKind, id: string) => (await scopeOf(kind, id)).companyId,
    board,

    // Opportunities ---------------------------------------------------------

    createOpportunity: async (scope: DeepDiveScope, input: CreateDeepDiveOpportunity, actor: DeepDiveOpportunityActor) => {
      onlyPersonDecides(input, actor);
      const { findingIds, ...fields } = input;
      await assertInRecord(deepDiveFindings, findingIds, scope);
      await write(db.transaction(async (tx) => {
        const [row] = await tx.insert(deepDiveOpportunities).values({
          ...scope,
          ...fields,
          createdByAgentId: actor.type === "agent" ? actor.agentId : null,
          createdByUserId: actor.type === "user" ? actor.userId : null,
        }).returning({ id: deepDiveOpportunities.id });
        if (findingIds) await setFindings(tx, scope.companyId, row!.id, findingIds);
      }));
      return board(scope);
    },

    updateOpportunity: async (opportunityId: string, input: UpdateDeepDiveOpportunity, actor: DeepDiveOpportunityActor) => {
      onlyPersonDecides(input, actor);
      const scope = await scopeOf("opportunity", opportunityId);
      const { findingIds, ...fields } = input;
      await assertInRecord(deepDiveFindings, findingIds, scope);
      await write(db.transaction(async (tx) => {
        await tx.update(deepDiveOpportunities).set({ ...sent(fields), updatedAt: new Date() })
          .where(eq(deepDiveOpportunities.id, opportunityId));
        if (findingIds) await setFindings(tx, scope.companyId, opportunityId, findingIds);
      }));
      return board(scope);
    },

    /** Its finding links go with it; its builds stay and serve no opportunity. */
    deleteOpportunity: async (opportunityId: string) => {
      const scope = await scopeOf("opportunity", opportunityId);
      await write(db.delete(deepDiveOpportunities).where(eq(deepDiveOpportunities.id, opportunityId)));
      return board(scope);
    },

    // Builds ----------------------------------------------------------------

    createBuild: async (scope: DeepDiveScope, input: CreateDeepDiveBuild) => {
      await write(db.insert(deepDiveBuilds).values({ ...scope, ...input }));
      return board(scope);
    },

    updateBuild: async (buildId: string, input: UpdateDeepDiveBuild, actor: DeepDiveOpportunityActor) => {
      onlyPersonDecides({ visibility: input.visibility }, actor);
      const scope = await scopeOf("build", buildId);
      await write(db.update(deepDiveBuilds).set({ ...sent(input), updatedAt: new Date() }).where(eq(deepDiveBuilds.id, buildId)));
      return board(scope);
    },

    deleteBuild: async (buildId: string) => {
      const scope = await scopeOf("build", buildId);
      await write(db.delete(deepDiveBuilds).where(eq(deepDiveBuilds.id, buildId)));
      return board(scope);
    },

    // KPIs ------------------------------------------------------------------

    createKpi: async (scope: DeepDiveScope, input: CreateDeepDiveKpi) => {
      const { processIds, baseline, target, ...fields } = input;
      await assertInRecord(deepDiveProcesses, processIds, scope);
      await write(db.transaction(async (tx) => {
        const [row] = await tx.insert(deepDiveKpis).values({
          ...scope,
          ...fields,
          baseline: String(baseline),
          target: String(target),
        }).returning({ id: deepDiveKpis.id });
        if (processIds) await setProcesses(tx, scope.companyId, row!.id, processIds);
      }));
      return board(scope);
    },

    updateKpi: async (kpiId: string, input: UpdateDeepDiveKpi, actor: DeepDiveOpportunityActor) => {
      onlyPersonDecides({ visibility: input.visibility }, actor);
      const scope = await scopeOf("kpi", kpiId);
      const { processIds, baseline, target, ...fields } = input;
      await assertInRecord(deepDiveProcesses, processIds, scope);
      await write(db.transaction(async (tx) => {
        await tx.update(deepDiveKpis).set({
          ...sent(fields),
          ...(baseline !== undefined ? { baseline: String(baseline) } : {}),
          ...(target !== undefined ? { target: String(target) } : {}),
          updatedAt: new Date(),
        }).where(eq(deepDiveKpis.id, kpiId));
        if (processIds) await setProcesses(tx, scope.companyId, kpiId, processIds);
      }));
      return board(scope);
    },

    deleteKpi: async (kpiId: string) => {
      const scope = await scopeOf("kpi", kpiId);
      await write(db.delete(deepDiveKpis).where(eq(deepDiveKpis.id, kpiId)));
      return board(scope);
    },
  };
}
