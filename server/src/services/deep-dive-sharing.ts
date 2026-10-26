import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@greatstone/db";
import {
  cases,
  deepDiveBuilds,
  deepDiveCommercials,
  deepDiveFindingEvidence,
  deepDiveFindings,
  deepDiveItemFiles,
  deepDiveKpis,
  deepDiveOpportunities,
  deepDiveOpportunityFindings,
  deepDiveRoadmapItems,
  deepDiveRoadmapKpis,
  pipelineCaseDocumentRequests,
  pipelineCaseEvidence,
  pipelineCases,
} from "@greatstone/db";
import { DEEP_DIVE_CASE_TYPES, type ClientEvidenceKind, type SharedDeepDiveFile } from "@greatstone/shared";
import { notFound } from "../errors.js";

// Deep Dive sharing (GRE-2366). Every Deep Dive item is Internal unless a
// person sets Shared. The only way client-facing code reads items is
// listSharedDeepDiveItemsForClient (and their files,
// listSharedDeepDiveFilesForClient; findings, opportunities and KPIs,
// listSharedDeepDiveRecordsForClient), and the only way it writes them is
// withDeepDiveClientWrite: inside it the cases_guard_writes trigger (migration
// 0394) lets the client change only the unlocked fields of its own Shared items.

type DeepDiveClientTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const DEEP_DIVE_TYPES = Object.values(DEEP_DIVE_CASE_TYPES);

export type DeepDiveClientScope = { companyId: string; clientCaseId: string };

/** What a client may see of a Shared item: no internal ids, authors or source rows. */
export interface SharedDeepDiveItem {
  id: string;
  caseType: string;
  key: string | null;
  title: string;
  summary: string | null;
  status: string;
  fields: Record<string, unknown>;
  parentCaseId: string | null;
  clientEditableFields: string[];
  updatedAt: string;
}

/** Shared Deep Dive items of one client in one company. Internal items never come back. */
export async function listSharedDeepDiveItemsForClient(
  db: Db,
  scope: DeepDiveClientScope,
): Promise<SharedDeepDiveItem[]> {
  const rows = await db
    .select({
      id: cases.id,
      caseType: cases.caseType,
      key: cases.key,
      title: cases.title,
      summary: cases.summary,
      status: cases.status,
      fields: cases.fields,
      parentCaseId: cases.parentCaseId,
      clientEditableFields: cases.clientEditableFields,
      updatedAt: cases.updatedAt,
    })
    .from(cases)
    .where(and(
      eq(cases.companyId, scope.companyId),
      eq(cases.clientCaseId, scope.clientCaseId),
      eq(cases.visibility, "shared"),
      inArray(cases.caseType, DEEP_DIVE_TYPES),
    ))
    .orderBy(asc(cases.caseNumber));
  return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }));
}

const requestFile = alias(pipelineCaseEvidence, "request_file");

/**
 * Files on Shared Deep Dive items of one client (GRE-2395): only Shared links,
 * only on Shared items of that client, only files and requests of that same
 * client. Everything else never comes back.
 */
export async function listSharedDeepDiveFilesForClient(
  db: Db,
  scope: DeepDiveClientScope,
): Promise<SharedDeepDiveFile[]> {
  const rows = await db
    .select({
      linkId: deepDiveItemFiles.id,
      itemId: cases.id,
      evidenceTitle: pipelineCaseEvidence.title,
      evidenceKind: pipelineCaseEvidence.kind,
      evidenceAt: pipelineCaseEvidence.createdAt,
      requestTitle: pipelineCaseDocumentRequests.title,
      requestFileKind: requestFile.kind,
      requestFileAt: requestFile.createdAt,
    })
    .from(deepDiveItemFiles)
    .innerJoin(cases, and(eq(cases.id, deepDiveItemFiles.caseId), eq(cases.companyId, deepDiveItemFiles.companyId)))
    .leftJoin(pipelineCaseEvidence, and(
      eq(pipelineCaseEvidence.id, deepDiveItemFiles.evidenceId),
      eq(pipelineCaseEvidence.companyId, scope.companyId),
      eq(pipelineCaseEvidence.caseId, scope.clientCaseId),
    ))
    .leftJoin(pipelineCaseDocumentRequests, and(
      eq(pipelineCaseDocumentRequests.id, deepDiveItemFiles.documentRequestId),
      eq(pipelineCaseDocumentRequests.companyId, scope.companyId),
      eq(pipelineCaseDocumentRequests.caseId, scope.clientCaseId),
    ))
    .leftJoin(requestFile, and(
      eq(requestFile.id, pipelineCaseDocumentRequests.evidenceId),
      eq(requestFile.companyId, scope.companyId),
      eq(requestFile.caseId, scope.clientCaseId),
    ))
    .where(and(
      eq(deepDiveItemFiles.companyId, scope.companyId),
      eq(deepDiveItemFiles.visibility, "shared"),
      eq(cases.companyId, scope.companyId),
      eq(cases.clientCaseId, scope.clientCaseId),
      eq(cases.visibility, "shared"),
      inArray(cases.caseType, DEEP_DIVE_TYPES),
      // The target must be this client's own file or request.
      or(
        eq(pipelineCaseEvidence.caseId, scope.clientCaseId),
        eq(pipelineCaseDocumentRequests.caseId, scope.clientCaseId),
      ),
    ))
    .orderBy(asc(cases.caseNumber), asc(deepDiveItemFiles.createdAt), asc(deepDiveItemFiles.id));
  return rows.map((row) => {
    const heldAt = row.evidenceAt ?? row.requestFileAt;
    return {
      linkId: row.linkId,
      itemId: row.itemId,
      title: row.evidenceTitle ?? row.requestTitle ?? "",
      kind: (row.evidenceKind ?? row.requestFileKind ?? null) as ClientEvidenceKind | null,
      status: heldAt ? "held" : "missing",
      heldAt: heldAt ? heldAt.toISOString() : null,
    };
  });
}

/**
 * Shared findings, opportunities and KPIs of one client (GRE-2632). A finding
 * is the client's when its stream is. Opportunities and KPIs belong to the
 * company, not to a client, so their client is read from their links, and an
 * unclear one is never sent:
 * - an opportunity is the client's when it has linked findings and every one
 *   is on that client's streams;
 * - a KPI is the client's when it reaches at least one opportunity through
 *   roadmap → commercial → build, and every opportunity it reaches is the
 *   client's. A broken link in the chain reaches nothing.
 * Visibility of a record decides only whether it is sent, never whose it is.
 */
export async function listSharedDeepDiveRecordsForClient(db: Db, scope: DeepDiveClientScope) {
  const [findingRows, evidenceRows, opportunityLinks, kpiLinks] = await Promise.all([
    db
      .select({ finding: deepDiveFindings, streamClientCaseId: cases.clientCaseId })
      .from(deepDiveFindings)
      .innerJoin(cases, and(eq(cases.id, deepDiveFindings.streamCaseId), eq(cases.companyId, deepDiveFindings.companyId)))
      .where(eq(deepDiveFindings.companyId, scope.companyId))
      .orderBy(asc(deepDiveFindings.createdAt), asc(deepDiveFindings.id)),
    db
      .select({ findingId: deepDiveFindingEvidence.findingId, count: sql<number>`count(*)::int` })
      .from(deepDiveFindingEvidence)
      .where(eq(deepDiveFindingEvidence.companyId, scope.companyId))
      .groupBy(deepDiveFindingEvidence.findingId),
    db
      .select({ opportunityId: deepDiveOpportunityFindings.opportunityId, findingId: deepDiveOpportunityFindings.findingId })
      .from(deepDiveOpportunityFindings)
      .where(eq(deepDiveOpportunityFindings.companyId, scope.companyId)),
    db
      .select({ kpiId: deepDiveRoadmapKpis.kpiId, opportunityId: deepDiveBuilds.opportunityId })
      .from(deepDiveRoadmapKpis)
      .innerJoin(deepDiveRoadmapItems, and(
        eq(deepDiveRoadmapItems.id, deepDiveRoadmapKpis.roadmapItemId),
        eq(deepDiveRoadmapItems.companyId, scope.companyId),
      ))
      .leftJoin(deepDiveCommercials, and(
        eq(deepDiveCommercials.id, deepDiveRoadmapItems.commercialId),
        eq(deepDiveCommercials.companyId, scope.companyId),
      ))
      .leftJoin(deepDiveBuilds, and(eq(deepDiveBuilds.id, deepDiveCommercials.buildId), eq(deepDiveBuilds.companyId, scope.companyId)))
      .where(eq(deepDiveRoadmapKpis.companyId, scope.companyId)),
  ]);

  const findingClient = new Map(findingRows.map((row) => [row.finding.id, row.streamClientCaseId]));
  const evidenceCount = new Map(evidenceRows.map((row) => [row.findingId, row.count]));
  /** The ids whose every link points at this client, and that have at least one link. */
  const ownedBy = (links: { owner: string; target: string | null }[], isMine: (target: string) => boolean) => {
    const verdict = new Map<string, boolean>();
    for (const { owner, target } of links) {
      if (target === null) continue;
      verdict.set(owner, (verdict.get(owner) ?? true) && isMine(target));
    }
    return new Set([...verdict].filter(([, mine]) => mine).map(([id]) => id));
  };
  const myOpportunityIds = ownedBy(
    opportunityLinks.map((l) => ({ owner: l.opportunityId, target: l.findingId })),
    (findingId) => findingClient.get(findingId) === scope.clientCaseId,
  );
  const myKpiIds = ownedBy(
    kpiLinks.map((l) => ({ owner: l.kpiId, target: l.opportunityId })),
    (opportunityId) => myOpportunityIds.has(opportunityId),
  );

  const [opportunities, kpis] = await Promise.all([
    myOpportunityIds.size === 0 ? [] : db
      .select()
      .from(deepDiveOpportunities)
      .where(and(
        eq(deepDiveOpportunities.companyId, scope.companyId),
        eq(deepDiveOpportunities.visibility, "shared"),
        inArray(deepDiveOpportunities.id, [...myOpportunityIds]),
      ))
      .orderBy(asc(deepDiveOpportunities.createdAt), asc(deepDiveOpportunities.id)),
    myKpiIds.size === 0 ? [] : db
      .select()
      .from(deepDiveKpis)
      .where(and(
        eq(deepDiveKpis.companyId, scope.companyId),
        eq(deepDiveKpis.visibility, "shared"),
        inArray(deepDiveKpis.id, [...myKpiIds]),
      ))
      .orderBy(asc(deepDiveKpis.createdAt), asc(deepDiveKpis.id)),
  ]);

  return {
    findings: findingRows
      .filter((row) => row.streamClientCaseId === scope.clientCaseId && row.finding.visibility === "shared")
      .map(({ finding }) => ({ ...finding, evidenceCount: evidenceCount.get(finding.id) ?? 0 })),
    opportunities: opportunities.map((row) => ({
      ...row,
      findingIds: opportunityLinks.filter((l) => l.opportunityId === row.id).map((l) => l.findingId),
    })),
    kpis: kpis.map((row) => ({
      ...row,
      opportunityIds: [...new Set(kpiLinks.filter((l) => l.kpiId === row.id && l.opportunityId).map((l) => l.opportunityId!))],
    })),
  };
}

/**
 * Run `fn` as the client: a transaction in which the database refuses any
 * write to cases except the unlocked fields of this client's Shared items.
 * The setting is transaction-local, so it never leaks to a pooled connection.
 */
export async function withDeepDiveClientWrite<T>(
  db: Db,
  scope: DeepDiveClientScope,
  fn: (tx: DeepDiveClientTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const client = await tx
      .select({ id: pipelineCases.id })
      .from(pipelineCases)
      .where(and(eq(pipelineCases.id, scope.clientCaseId), eq(pipelineCases.companyId, scope.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!client) throw notFound("Client not found");
    await tx.execute(sql`select
      set_config('gsam.actor_role', 'client', true),
      set_config('gsam.client_case_id', ${scope.clientCaseId}, true)`);
    return fn(tx);
  });
}
