import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  caseDocuments,
  cases,
  deepDiveFindingEvidence,
  deepDiveFindings,
  pipelineCaseEvidence,
} from "@greatstone/db";
import {
  DEEP_DIVE_CASE_TYPES,
  DEEP_DIVE_FINDING_NEVER_EDITED,
  DEEP_DIVE_GIF,
  type DeepDiveFinding,
  type DeepDiveFindingStatus,
  type DeepDiveGifKey,
  type DeepDiveVisibility,
  type ProposeDeepDiveFinding,
} from "@greatstone/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";

// Deep Dive findings (GRE-2367). Proposed by a person or an agent, validated
// or rejected by a person, never edited: a new finding supersedes a validated
// one, and the old one becomes Superseded when the new one is validated. The
// deep_dive_findings_guard trigger (migration 0397) enforces the same rules
// for any writer; these checks give the caller a clear answer first.

export type DeepDiveFindingActor =
  | { type: "user"; userId: string }
  | { type: "agent"; agentId: string | null };

type FindingRow = typeof deepDiveFindings.$inferSelect;

const GIF_KEY_BY_DOCUMENT_KEY = new Map<string, DeepDiveGifKey>(DEEP_DIVE_GIF.map((gif) => [gif.documentKey, gif.key]));

/** Postgres refusals from the unique index or the guard trigger, as answers the caller can act on. */
function asFindingError(error: unknown): unknown {
  const cause = ((error as { cause?: unknown })?.cause ?? error) as { code?: string; message?: string };
  if (cause?.code === "23505") return conflict("A finding that supersedes this one is already proposed");
  if (cause?.code === "23514" && cause.message) return unprocessable(cause.message);
  return error;
}

function requirePerson(actor: DeepDiveFindingActor, action: string): string {
  if (actor.type !== "user") throw forbidden(`Only a person can ${action} a finding`);
  return actor.userId;
}

export function deepDiveFindingsService(db: Db) {
  async function loadRow(findingId: string): Promise<FindingRow> {
    const row = await db
      .select()
      .from(deepDiveFindings)
      .where(eq(deepDiveFindings.id, findingId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Finding not found");
    return row;
  }

  async function present(rows: FindingRow[]): Promise<DeepDiveFinding[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const [documents, evidence, successors] = await Promise.all([
      db
        .select({ id: caseDocuments.id, key: caseDocuments.key })
        .from(caseDocuments)
        .where(inArray(caseDocuments.id, [...new Set(rows.map((row) => row.gifDocumentId))])),
      db
        .select({
          findingId: deepDiveFindingEvidence.findingId,
          id: pipelineCaseEvidence.id,
          title: pipelineCaseEvidence.title,
          kind: pipelineCaseEvidence.kind,
          clientCaseId: pipelineCaseEvidence.caseId,
        })
        .from(deepDiveFindingEvidence)
        .innerJoin(pipelineCaseEvidence, eq(pipelineCaseEvidence.id, deepDiveFindingEvidence.evidenceId))
        .where(inArray(deepDiveFindingEvidence.findingId, ids))
        .orderBy(asc(deepDiveFindingEvidence.createdAt), asc(deepDiveFindingEvidence.id)),
      db
        .select({ id: deepDiveFindings.id, supersedesFindingId: deepDiveFindings.supersedesFindingId })
        .from(deepDiveFindings)
        .where(and(inArray(deepDiveFindings.supersedesFindingId, ids), eq(deepDiveFindings.status, "validated"))),
    ]);
    const gifKeyByDocument = new Map(documents.map((doc) => [doc.id, GIF_KEY_BY_DOCUMENT_KEY.get(doc.key)]));
    const successorOf = new Map(successors.map((row) => [row.supersedesFindingId, row.id]));
    return rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      streamCaseId: row.streamCaseId,
      gifKey: gifKeyByDocument.get(row.gifDocumentId) ?? "current-state",
      gifDocumentId: row.gifDocumentId,
      statement: row.statement,
      status: row.status as DeepDiveFindingStatus,
      visibility: row.visibility as DeepDiveVisibility,
      supersedesFindingId: row.supersedesFindingId,
      supersededByFindingId: successorOf.get(row.id) ?? null,
      proposedByAgentId: row.proposedByAgentId,
      proposedByUserId: row.proposedByUserId,
      decidedByUserId: row.decidedByUserId,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      supersededAt: row.supersededAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      evidence: evidence
        .filter((item) => item.findingId === row.id)
        .map(({ findingId: _findingId, ...item }) => item),
    }));
  }

  async function getOne(findingId: string): Promise<DeepDiveFinding> {
    const [finding] = await present([await loadRow(findingId)]);
    return finding!;
  }

  return {
    /** The company id of a finding, for the route's access check. */
    companyOf: async (findingId: string) => (await loadRow(findingId)).companyId,

    get: getOne,

    list: async (companyId: string, filter: { streamCaseId?: string }) => {
      const rows = await db
        .select()
        .from(deepDiveFindings)
        .where(and(
          eq(deepDiveFindings.companyId, companyId),
          filter.streamCaseId ? eq(deepDiveFindings.streamCaseId, filter.streamCaseId) : undefined,
        ))
        .orderBy(asc(deepDiveFindings.createdAt), asc(deepDiveFindings.id));
      return present(rows);
    },

    propose: async (companyId: string, input: ProposeDeepDiveFinding, actor: DeepDiveFindingActor) => {
      const stream = await db
        .select({ id: cases.id, clientCaseId: cases.clientCaseId })
        .from(cases)
        .where(and(
          eq(cases.id, input.streamCaseId),
          eq(cases.companyId, companyId),
          eq(cases.caseType, DEEP_DIVE_CASE_TYPES.stream),
        ))
        .then((rows) => rows[0] ?? null);
      if (!stream) throw unprocessable("Investigation Stream not found in this company");

      const gif = DEEP_DIVE_GIF.find((entry) => entry.key === input.gifKey)!;
      const cell = await db
        .select({ id: caseDocuments.id })
        .from(caseDocuments)
        .where(and(
          eq(caseDocuments.companyId, companyId),
          eq(caseDocuments.caseId, stream.id),
          eq(caseDocuments.key, gif.documentKey),
        ))
        .then((rows) => rows[0] ?? null);
      if (!cell) throw unprocessable(`The ${gif.label} cell of this stream has no document yet; complete the record first`);

      const evidenceIds = [...new Set(input.evidenceIds ?? [])];
      if (evidenceIds.length > 0) {
        const found = await db
          .select({ id: pipelineCaseEvidence.id, caseId: pipelineCaseEvidence.caseId })
          .from(pipelineCaseEvidence)
          .where(and(eq(pipelineCaseEvidence.companyId, companyId), inArray(pipelineCaseEvidence.id, evidenceIds)));
        const allowed = found.filter((row) => !stream.clientCaseId || row.caseId === stream.clientCaseId);
        if (allowed.length !== evidenceIds.length) {
          throw unprocessable("Evidence not found for this stream's client");
        }
      }

      if (input.supersedesFindingId) {
        const previous = await db
          .select({ status: deepDiveFindings.status })
          .from(deepDiveFindings)
          .where(and(eq(deepDiveFindings.id, input.supersedesFindingId), eq(deepDiveFindings.companyId, companyId)))
          .then((rows) => rows[0] ?? null);
        if (!previous) throw unprocessable("The finding to supersede was not found in this company");
        if (previous.status !== "validated") throw conflict("Only a validated finding can be superseded");
        const pending = await db
          .select({ id: deepDiveFindings.id })
          .from(deepDiveFindings)
          .where(and(
            eq(deepDiveFindings.supersedesFindingId, input.supersedesFindingId),
            eq(deepDiveFindings.status, "proposed"),
          ))
          .then((rows) => rows[0] ?? null);
        if (pending) throw conflict("A finding that supersedes this one is already proposed");
      }

      const id = await db.transaction(async (tx) => {
        const [row] = await tx.insert(deepDiveFindings).values({
          companyId,
          streamCaseId: stream.id,
          gifDocumentId: cell.id,
          statement: input.statement,
          supersedesFindingId: input.supersedesFindingId ?? null,
          proposedByAgentId: actor.type === "agent" ? actor.agentId : null,
          proposedByUserId: actor.type === "user" ? actor.userId : null,
        }).returning({ id: deepDiveFindings.id });
        if (evidenceIds.length > 0) {
          await tx.insert(deepDiveFindingEvidence).values(
            evidenceIds.map((evidenceId) => ({ companyId, findingId: row!.id, evidenceId })),
          );
        }
        return row!.id;
      }).catch((error) => {
        throw asFindingError(error);
      });
      return getOne(id);
    },

    /** A person validates or rejects a proposed finding. Validating a successor supersedes its predecessor. */
    decide: async (findingId: string, decision: "validated" | "rejected", actor: DeepDiveFindingActor) => {
      const userId = requirePerson(actor, decision === "validated" ? "validate" : "reject");
      await db.transaction(async (tx) => {
        const row = await tx
          .select()
          .from(deepDiveFindings)
          .where(eq(deepDiveFindings.id, findingId))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!row) throw notFound("Finding not found");
        if (row.status !== "proposed") {
          throw conflict(`This finding is already ${row.status}. ${DEEP_DIVE_FINDING_NEVER_EDITED}`);
        }
        const now = new Date();
        if (decision === "validated" && row.supersedesFindingId) {
          const previous = await tx
            .select({ status: deepDiveFindings.status })
            .from(deepDiveFindings)
            .where(eq(deepDiveFindings.id, row.supersedesFindingId))
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (previous?.status !== "validated") {
            throw conflict("The finding this one supersedes is no longer validated");
          }
        }
        await tx
          .update(deepDiveFindings)
          .set({ status: decision, decidedByUserId: userId, decidedAt: now })
          .where(eq(deepDiveFindings.id, findingId));
        if (decision === "validated" && row.supersedesFindingId) {
          await tx
            .update(deepDiveFindings)
            .set({ status: "superseded", supersededAt: now })
            .where(eq(deepDiveFindings.id, row.supersedesFindingId));
        }
      });
      return getOne(findingId);
    },

    /** Internal or Shared: only a person shares a finding. */
    setVisibility: async (findingId: string, visibility: DeepDiveVisibility, actor: DeepDiveFindingActor) => {
      requirePerson(actor, "share or unshare");
      await db.update(deepDiveFindings).set({ visibility }).where(eq(deepDiveFindings.id, findingId));
      return getOne(findingId);
    },
  };
}
