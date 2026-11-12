import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { cases, deepDiveDrafts, deepDiveFindings, organisations, pipelineCases, pipelineStages } from "@greatstone/db";
import {
  DEEP_DIVE_CASE_TYPES,
  deepDiveUnknownWorkstreams,
  readDeepDiveRecordFields,
  type DeepDiveDraft,
  type DeepDiveDraftKind,
  type DeepDiveDraftStatus,
  type DeepDiveInterviewLog,
  type DeepDiveRecordProposal,
  type DeepDiveRecordSummary,
  type DecideDeepDiveDraft,
  type DeepDiveStartableClient,
} from "@greatstone/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { inRecord, loadDeepDiveRecord, type DeepDiveScope } from "./deep-dive-scope.js";

// Deep Dive records and agent drafts (GRE-4430). The tiles list every
// client's Deep Dive. Agents write drafts only (an interview log from a Notion
// transcript, or a proposed register row); a person approves or rejects each
// one. The deep_dive_drafts_guard trigger (migration 0421) refuses deletes,
// changes to a decided draft and a decision without a person, for any writer.

export type DeepDiveDraftActor =
  | { type: "user"; userId: string }
  | { type: "agent"; agentId: string | null; runId: string | null };

type DraftRow = typeof deepDiveDrafts.$inferSelect;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toDraft(row: DraftRow): DeepDiveDraft {
  return {
    id: row.id,
    companyId: row.companyId,
    recordCaseId: row.recordCaseId,
    kind: row.kind as DeepDiveDraftKind,
    title: row.title,
    payload: row.payload as unknown as DeepDiveDraft["payload"],
    status: row.status as DeepDiveDraftStatus,
    version: row.version,
    createdByAgentId: row.createdByAgentId,
    createdByRunId: row.createdByRunId,
    createdByUserId: row.createdByUserId,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function asDraftError(error: unknown): unknown {
  const cause = ((error as { cause?: unknown })?.cause ?? error) as { code?: string; message?: string };
  if (cause?.code === "23514" && cause.message) return unprocessable(cause.message);
  return error;
}

export function deepDiveDraftsService(db: Db) {
  async function loadRow(draftId: string): Promise<DraftRow> {
    const row = await db.select().from(deepDiveDrafts).where(eq(deepDiveDrafts.id, draftId)).then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Draft not found");
    return row;
  }

  /** A draft read inside a scope: another Deep Dive's draft does not exist here. */
  async function loadInScope(scope: DeepDiveScope, draftId: string): Promise<DraftRow> {
    const row = await db.select().from(deepDiveDrafts)
      .where(and(eq(deepDiveDrafts.id, draftId), inRecord(deepDiveDrafts, scope)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Draft not found in this Deep Dive");
    return row;
  }

  async function save(
    scope: DeepDiveScope,
    kind: DeepDiveDraftKind,
    title: string,
    payload: DeepDiveInterviewLog | DeepDiveRecordProposal,
    revise: { draftId?: string; expectedVersion?: number },
    actor: DeepDiveDraftActor,
  ): Promise<DeepDiveDraft> {
    if (actor.type === "agent" && (!actor.runId || !UUID_RE.test(actor.runId))) {
      throw unprocessable("Write drafts from a run: the run id is recorded with every draft");
    }
    const record = await loadDeepDiveRecord(db, scope.companyId, scope.recordCaseId);
    const unknown = deepDiveUnknownWorkstreams(payload as Parameters<typeof deepDiveUnknownWorkstreams>[0], readDeepDiveRecordFields(record.fields).workstreams);
    if (unknown.length) throw unprocessable(`Not a workstream of this Deep Dive: ${unknown.join(", ")}`);

    if (revise.draftId) {
      const current = await loadInScope(scope, revise.draftId);
      if (current.kind !== kind) throw unprocessable("This draft is a different kind");
      if (current.status !== "draft") throw conflict(`This draft is ${current.status} already`);
      if (current.version !== revise.expectedVersion) throw conflict("The draft changed since you read it; read it again");
      const [row] = await db.update(deepDiveDrafts)
        .set({ title, payload: payload as unknown as Record<string, unknown>, version: current.version + 1, updatedAt: new Date() })
        .where(and(eq(deepDiveDrafts.id, current.id), eq(deepDiveDrafts.version, current.version), eq(deepDiveDrafts.status, "draft")))
        .returning()
        .catch((error) => { throw asDraftError(error); });
      if (!row) throw conflict("The draft changed since you read it; read it again");
      return toDraft(row);
    }

    const [row] = await db.insert(deepDiveDrafts).values({
      ...scope,
      kind,
      title,
      payload: payload as unknown as Record<string, unknown>,
      createdByAgentId: actor.type === "agent" ? actor.agentId : null,
      createdByRunId: actor.type === "agent" ? actor.runId : null,
      createdByUserId: actor.type === "user" ? actor.userId : null,
    }).returning().catch((error) => { throw asDraftError(error); });
    return toDraft(row!);
  }

  return {
    /** The Deep Dive a draft belongs to, for the route's access check. */
    scopeOf: async (draftId: string): Promise<DeepDiveScope> => {
      const row = await loadRow(draftId);
      return { companyId: row.companyId, recordCaseId: row.recordCaseId };
    },

    list: async (scope: DeepDiveScope, filter: { status?: DeepDiveDraftStatus } = {}) => {
      const rows = await db.select().from(deepDiveDrafts)
        .where(and(inRecord(deepDiveDrafts, scope), filter.status ? eq(deepDiveDrafts.status, filter.status) : undefined))
        .orderBy(desc(deepDiveDrafts.createdAt), desc(deepDiveDrafts.id));
      return rows.map(toDraft);
    },

    get: async (scope: DeepDiveScope, draftId: string) => toDraft(await loadInScope(scope, draftId)),

    logInterview: (scope: DeepDiveScope, interview: DeepDiveInterviewLog, revise: { draftId?: string; expectedVersion?: number }, actor: DeepDiveDraftActor) =>
      save(scope, "interview_log", `${interview.meetingTitle} (${interview.heldOn})`, interview, revise, actor),

    proposeRecord: (scope: DeepDiveScope, title: string, proposal: DeepDiveRecordProposal, revise: { draftId?: string; expectedVersion?: number }, actor: DeepDiveDraftActor) =>
      save(scope, "record_proposal", title, proposal, revise, actor),

    /** Only a person approves or rejects, once, against the version they read. */
    decide: async (scope: DeepDiveScope, draftId: string, input: DecideDeepDiveDraft, actor: DeepDiveDraftActor) => {
      if (actor.type !== "user") throw forbidden("Only a person approves or rejects a Deep Dive draft");
      const current = await loadInScope(scope, draftId);
      if (current.status !== "draft") throw conflict(`This draft is ${current.status} already`);
      if (current.version !== input.expectedVersion) throw conflict("The draft changed since you read it; read it again");
      const at = new Date();
      const [row] = await db.update(deepDiveDrafts)
        .set({ status: input.decision, decidedByUserId: actor.userId, decidedAt: at, decisionNote: input.note ?? null, updatedAt: at })
        .where(and(eq(deepDiveDrafts.id, draftId), eq(deepDiveDrafts.version, input.expectedVersion), eq(deepDiveDrafts.status, "draft")))
        .returning()
        .catch((error) => { throw asDraftError(error); });
      if (!row) throw conflict("The draft changed since you read it; read it again");
      return toDraft(row);
    },
  };
}

/** Clients a person can start a Deep Dive for: open journey cases, those at a Deep Dive stage first. */
export async function listDeepDiveStartableClients(db: Db, companyId: string): Promise<DeepDiveStartableClient[]> {
  const rows = await db
    .select({
      id: pipelineCases.id,
      title: pipelineCases.title,
      organisationName: organisations.name,
      stageName: pipelineStages.name,
      stageKey: pipelineStages.key,
      pipelineId: pipelineCases.pipelineId,
    })
    .from(pipelineCases)
    .innerJoin(pipelineStages, eq(pipelineStages.id, pipelineCases.stageId))
    .leftJoin(organisations, eq(organisations.id, pipelineCases.organisationId))
    .where(and(eq(pipelineCases.companyId, companyId), isNull(pipelineCases.retiredAt)))
    .orderBy(asc(pipelineCases.title));
  const atDeepDive = (row: { stageKey: string; stageName: string }) => /deep.?dive/i.test(`${row.stageKey} ${row.stageName}`);
  // Only client journeys: pipelines that have a Deep Dive stage, not every sales or hiring pipeline.
  const journeys = new Set(
    (await db.select({ pipelineId: pipelineStages.pipelineId, key: pipelineStages.key, name: pipelineStages.name }).from(pipelineStages))
      .filter((stage) => atDeepDive({ stageKey: stage.key, stageName: stage.name }))
      .map((stage) => stage.pipelineId),
  );
  return rows
    .filter((row) => journeys.has(row.pipelineId))
    .map((row) => ({ id: row.id, name: row.organisationName ?? row.title, stageName: row.stageName, atDeepDiveStage: atDeepDive(row) }))
    .sort((a, b) => Number(b.atDeepDiveStage) - Number(a.atDeepDiveStage));
}

/** Every client's Deep Dive, one tile each, with the work waiting for a person. */
export async function listDeepDiveRecords(db: Db, companyId: string): Promise<DeepDiveRecordSummary[]> {
  const rows = await db
    .select({
      id: cases.id,
      identifier: cases.identifier,
      title: cases.title,
      fields: cases.fields,
      clientCaseId: cases.clientCaseId,
      createdAt: cases.createdAt,
      clientTitle: pipelineCases.title,
      organisationId: pipelineCases.organisationId,
      organisationName: organisations.name,
    })
    .from(cases)
    .innerJoin(pipelineCases, eq(pipelineCases.id, cases.clientCaseId))
    .leftJoin(organisations, eq(organisations.id, pipelineCases.organisationId))
    .where(and(eq(cases.companyId, companyId), eq(cases.caseType, DEEP_DIVE_CASE_TYPES.record), isNotNull(cases.clientCaseId)))
    .orderBy(desc(cases.createdAt));
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [drafts, findings] = await Promise.all([
    db.select({ id: deepDiveDrafts.recordCaseId, count: sql<number>`count(*)::int` }).from(deepDiveDrafts)
      .where(and(eq(deepDiveDrafts.companyId, companyId), inArray(deepDiveDrafts.recordCaseId, ids), eq(deepDiveDrafts.status, "draft")))
      .groupBy(deepDiveDrafts.recordCaseId),
    db.select({ id: deepDiveFindings.recordCaseId, count: sql<number>`count(*)::int` }).from(deepDiveFindings)
      .where(and(eq(deepDiveFindings.companyId, companyId), inArray(deepDiveFindings.recordCaseId, ids), eq(deepDiveFindings.status, "proposed")))
      .groupBy(deepDiveFindings.recordCaseId),
  ]);
  const countOf = (list: { id: string | null; count: number }[], id: string) => list.find((r) => r.id === id)?.count ?? 0;
  return rows.map((row) => {
    const fields = readDeepDiveRecordFields(row.fields);
    return {
      id: row.id,
      identifier: row.identifier,
      title: row.title,
      clientCaseId: row.clientCaseId!,
      clientName: row.organisationName ?? row.clientTitle,
      organisationId: row.organisationId,
      workstreams: fields.workstreams,
      status: fields.status,
      draftsWaiting: countOf(drafts, row.id),
      findingsToValidate: countOf(findings, row.id),
      createdAt: row.createdAt.toISOString(),
    };
  });
}
