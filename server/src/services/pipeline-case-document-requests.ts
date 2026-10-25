import { and, asc, eq, max } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  pipelineCaseDocumentRequests,
  pipelineCaseEvidence,
  pipelineCases,
  pipelineStages,
} from "@greatstone/db";
import {
  pipelineStageRequestedDocumentSchema,
  type ClientDocumentRequest,
  type ClientJourneySuggestedRequest,
} from "@greatstone/shared";
import { notFound } from "../errors.js";

// Documents we ask a client for at one stage of their journey (Ben, 12 Oct:
// the deep dive's document request stage collects a set list). A request is
// received once an upload is linked to it; deleting that file reopens it.

export type DocumentRequestActor =
  | { type: "user"; userId: string }
  | { type: "agent"; agentId: string };

/** The stage config's standard list (`requestedDocuments`), ignoring bad entries. */
export function readRequestedDocuments(config: Record<string, unknown> | null | undefined): ClientJourneySuggestedRequest[] {
  const raw = config?.requestedDocuments;
  if (!Array.isArray(raw)) return [];
  const out: ClientJourneySuggestedRequest[] = [];
  for (const entry of raw) {
    const parsed = pipelineStageRequestedDocumentSchema.safeParse(entry);
    if (parsed.success) out.push({ title: parsed.data.title, note: parsed.data.note ?? null });
  }
  return out;
}

const titleKey = (title: string) => title.trim().toLowerCase();

export function pipelineCaseDocumentRequestsService(db: Db) {
  async function stageOnCase(companyId: string, caseId: string, stageId: string) {
    const row = await db
      .select({ id: pipelineStages.id, config: pipelineStages.config })
      .from(pipelineStages)
      .innerJoin(pipelineCases, eq(pipelineCases.pipelineId, pipelineStages.pipelineId))
      .where(and(
        eq(pipelineStages.id, stageId),
        eq(pipelineCases.id, caseId),
        eq(pipelineCases.companyId, companyId),
      ))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Stage not found on this client's pipeline");
    return row;
  }

  async function list(companyId: string, caseId: string): Promise<ClientDocumentRequest[]> {
    const rows = await db
      .select({
        request: pipelineCaseDocumentRequests,
        evidence: {
          id: pipelineCaseEvidence.id,
          title: pipelineCaseEvidence.title,
          kind: pipelineCaseEvidence.kind,
          createdAt: pipelineCaseEvidence.createdAt,
        },
      })
      .from(pipelineCaseDocumentRequests)
      .leftJoin(pipelineCaseEvidence, and(
        eq(pipelineCaseEvidence.id, pipelineCaseDocumentRequests.evidenceId),
        eq(pipelineCaseEvidence.companyId, pipelineCaseDocumentRequests.companyId),
      ))
      .where(and(
        eq(pipelineCaseDocumentRequests.companyId, companyId),
        eq(pipelineCaseDocumentRequests.caseId, caseId),
      ))
      .orderBy(asc(pipelineCaseDocumentRequests.position), asc(pipelineCaseDocumentRequests.createdAt));
    return rows.map(({ request, evidence }) => ({
      id: request.id,
      stageId: request.stageId,
      title: request.title,
      note: request.note,
      createdAt: request.createdAt.toISOString(),
      received: evidence?.id
        ? {
          evidenceId: evidence.id,
          title: evidence.title,
          contentPath: evidence.kind === "upload" ? `/api/cases/${caseId}/evidence/${evidence.id}/content` : null,
          receivedAt: evidence.createdAt.toISOString(),
        }
        : null,
      websiteAnswer: request.websiteAnsweredAt && request.websiteAnsweredBy
        ? {
          answeredAt: request.websiteAnsweredAt.toISOString(),
          answeredBy: request.websiteAnsweredBy,
          note: request.websiteAnswer?.note ?? null,
          fileName: request.websiteAnswer?.fileName ?? null,
        }
        : null,
    }));
  }

  /** Add titles to a stage's list. A title the stage already asks for is skipped, not an error. */
  async function create(
    companyId: string,
    caseId: string,
    input: { stageId: string; items: ClientJourneySuggestedRequest[] },
    actor: DocumentRequestActor,
  ) {
    await stageOnCase(companyId, caseId, input.stageId);
    const existing = await db
      .select({ title: pipelineCaseDocumentRequests.title })
      .from(pipelineCaseDocumentRequests)
      .where(and(
        eq(pipelineCaseDocumentRequests.companyId, companyId),
        eq(pipelineCaseDocumentRequests.caseId, caseId),
        eq(pipelineCaseDocumentRequests.stageId, input.stageId),
      ));
    const seen = new Set(existing.map((row) => titleKey(row.title)));
    const fresh: ClientJourneySuggestedRequest[] = [];
    for (const item of input.items) {
      const key = titleKey(item.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      fresh.push({ title: item.title.trim(), note: item.note?.trim() || null });
    }
    if (fresh.length === 0) return [];
    const [top] = await db
      .select({ value: max(pipelineCaseDocumentRequests.position) })
      .from(pipelineCaseDocumentRequests)
      .where(and(
        eq(pipelineCaseDocumentRequests.companyId, companyId),
        eq(pipelineCaseDocumentRequests.caseId, caseId),
      ));
    const start = (top?.value ?? -1) + 1;
    return db
      .insert(pipelineCaseDocumentRequests)
      .values(fresh.map((item, index) => ({
        companyId,
        caseId,
        stageId: input.stageId,
        title: item.title,
        note: item.note,
        position: start + index,
        createdByAgentId: actor.type === "agent" ? actor.agentId : null,
        createdByUserId: actor.type === "user" ? actor.userId : null,
      })))
      .onConflictDoNothing()
      .returning({ id: pipelineCaseDocumentRequests.id, title: pipelineCaseDocumentRequests.title });
  }

  return {
    list,
    create,

    /** Add the stage config's standard list, skipping titles already asked for. */
    addStandard: async (companyId: string, caseId: string, stageId: string, actor: DocumentRequestActor) => {
      const stage = await stageOnCase(companyId, caseId, stageId);
      const items = readRequestedDocuments(stage.config as Record<string, unknown> | null);
      if (items.length === 0) return [];
      return create(companyId, caseId, { stageId, items }, actor);
    },

    get: async (companyId: string, caseId: string, requestId: string) => {
      return db
        .select()
        .from(pipelineCaseDocumentRequests)
        .where(and(
          eq(pipelineCaseDocumentRequests.companyId, companyId),
          eq(pipelineCaseDocumentRequests.caseId, caseId),
          eq(pipelineCaseDocumentRequests.id, requestId),
        ))
        .then((rows) => rows[0] ?? null);
    },

    /** Mark the request received by this evidence row. */
    markReceived: async (companyId: string, caseId: string, requestId: string, evidenceId: string) => {
      await db
        .update(pipelineCaseDocumentRequests)
        .set({ evidenceId, updatedAt: new Date() })
        .where(and(
          eq(pipelineCaseDocumentRequests.companyId, companyId),
          eq(pipelineCaseDocumentRequests.caseId, caseId),
          eq(pipelineCaseDocumentRequests.id, requestId),
        ));
    },

    remove: async (companyId: string, caseId: string, requestId: string) => {
      const [row] = await db
        .delete(pipelineCaseDocumentRequests)
        .where(and(
          eq(pipelineCaseDocumentRequests.companyId, companyId),
          eq(pipelineCaseDocumentRequests.caseId, caseId),
          eq(pipelineCaseDocumentRequests.id, requestId),
        ))
        .returning();
      return row ?? null;
    },
  };
}
