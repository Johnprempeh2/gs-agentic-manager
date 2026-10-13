import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  authUsers,
  issueWorkProducts,
  pipelineCaseEvents,
  pipelineCases,
  pipelineCaseStageDeliverables,
  pipelineStages,
} from "@greatstone/db";
import {
  DELIVERABLES_MAX_LIMIT,
  isClientPortalVisible,
  ndaClears,
  journeyStageStates,
  pipelineStageExpectedDeliverableSchema,
  pipelineStageTemplateSchema,
  stageCompleteness,
  type ClientJourneyResponse,
  type ClientJourneyStage,
  type ClientJourneyStageState,
  type ClientJourneyStageTemplate,
  type ClientNda,
  type NdaStatus,
  type ClientPortalJourneyResponse,
  type Deliverable,
} from "@greatstone/shared";
import { isUniqueViolation } from "../db-errors.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import { deliverableService } from "./deliverables.js";
import { pipelineCaseFilesService } from "./pipeline-case-files.js";

// Client journey by stage (GRE-1473). Each stage of a client's journey lists
// its standard templates (from the stage config) and the deliverables filed
// under it. The portal view applies the visibility rule from @greatstone/shared:
// only client-facing, final deliverables of completed stages, with outcome
// fields only.

export type ClientJourneyActor =
  | { type: "agent"; agentId: string }
  | { type: "user"; userId: string };

function deliverableRef(deliverable: Pick<Deliverable, "issue" | "key">) {
  return `${deliverable.issue.id}:${deliverable.key}`;
}

function readTemplates(config: Record<string, unknown> | null | undefined): ClientJourneyStageTemplate[] {
  const raw = Array.isArray(config?.templates) ? config.templates : [];
  const templates: ClientJourneyStageTemplate[] = [];
  for (const item of raw) {
    const parsed = pipelineStageTemplateSchema.safeParse(item);
    if (!parsed.success) continue;
    templates.push({ title: parsed.data.title, url: parsed.data.url ?? null, note: parsed.data.note ?? null });
  }
  return templates;
}

function readExpected(config: Record<string, unknown> | null | undefined) {
  const raw = Array.isArray(config?.expectedDeliverables) ? config.expectedDeliverables : [];
  return raw.flatMap((item) => {
    const parsed = pipelineStageExpectedDeliverableSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

/** The NDA a case row records, as the journey shows it. */
function ndaOf(row: {
  ndaStatus: string;
  ndaAcceptedAt: Date | null;
  ndaSuspendedReason: string | null;
  ndaStatusChangedAt: Date | null;
  ndaChangedBy: string | null;
}): ClientNda {
  const status: NdaStatus = row.ndaStatus === "accepted" || row.ndaStatus === "suspended" ? row.ndaStatus : "required";
  return {
    status,
    acceptedAt: status === "accepted" ? row.ndaAcceptedAt?.toISOString() ?? null : null,
    suspendedReason: status === "suspended" ? row.ndaSuspendedReason : null,
    changedBy: row.ndaChangedBy,
    changedAt: row.ndaStatusChangedAt?.toISOString() ?? null,
  };
}

export function pipelineCaseJourneyService(db: Db) {
  const files = pipelineCaseFilesService(db);

  async function loadCase(companyId: string, caseId: string) {
    const row = await db
      .select({
        id: pipelineCases.id,
        title: pipelineCases.title,
        pipelineId: pipelineCases.pipelineId,
        stageId: pipelineCases.stageId,
        ndaAcceptedAt: pipelineCases.ndaAcceptedAt,
        ndaStatus: pipelineCases.ndaStatus,
        ndaSuspendedReason: pipelineCases.ndaSuspendedReason,
        ndaStatusChangedAt: pipelineCases.ndaStatusChangedAt,
        ndaChangedBy: authUsers.name,
      })
      .from(pipelineCases)
      .leftJoin(authUsers, eq(authUsers.id, pipelineCases.ndaStatusChangedByUserId))
      .where(and(eq(pipelineCases.companyId, companyId), eq(pipelineCases.id, caseId), isNull(pipelineCases.retiredAt)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Pipeline case not found");
    return row;
  }

  /** The stages the case entered, newest first; the first journey stage among them is where it paused. */
  async function lastJourneyStageId(companyId: string, caseId: string, stageIds: Set<string>) {
    const rows = await db
      .select({ toStageId: pipelineCaseEvents.toStageId })
      .from(pipelineCaseEvents)
      .where(and(
        eq(pipelineCaseEvents.companyId, companyId),
        eq(pipelineCaseEvents.caseId, caseId),
        isNotNull(pipelineCaseEvents.toStageId),
        inArray(pipelineCaseEvents.type, ["ingested", "transitioned", "transition_forced"]),
      ))
      .orderBy(desc(pipelineCaseEvents.createdAt), desc(pipelineCaseEvents.id));
    return rows.find((row) => row.toStageId && stageIds.has(row.toStageId))?.toStageId ?? null;
  }

  /** Deliverables on the client's linked tasks and projects (the GRE-1311 scope). */
  async function scopedDeliverables(companyId: string, caseId: string) {
    const scope = await files.scopeFor(companyId, [caseId]);
    const result = await deliverableService(db).list(companyId, { limit: DELIVERABLES_MAX_LIMIT }, { scope });
    return result.deliverables;
  }

  async function getJourney(companyId: string, caseId: string): Promise<ClientJourneyResponse & {
    title: string;
    stateById: Map<string, ClientJourneyStageState>;
  }> {
    const caseRow = await loadCase(companyId, caseId);
    const stages = await db
      .select()
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, caseRow.pipelineId));
    const journeyStageIds = new Set(stages.filter((stage) => stage.kind !== "cancelled").map((stage) => stage.id));
    const currentIsJourney = journeyStageIds.has(caseRow.stageId);
    const pausedFrom = currentIsJourney ? null : await lastJourneyStageId(companyId, caseId, journeyStageIds);
    const states = journeyStageStates(stages, caseRow.stageId, pausedFrom);
    const stateById = new Map(states.map((entry) => [entry.id, entry.state]));

    const [deliverables, links] = await Promise.all([
      scopedDeliverables(companyId, caseId),
      db
        .select()
        .from(pipelineCaseStageDeliverables)
        .where(and(
          eq(pipelineCaseStageDeliverables.companyId, companyId),
          eq(pipelineCaseStageDeliverables.caseId, caseId),
        )),
    ]);
    const deliverableByRef = new Map(deliverables.map((item) => [deliverableRef(item), item]));
    const filed = new Set<string>();
    const stageById = new Map(stages.map((stage) => [stage.id, stage]));
    const sections = new Map<string, ClientJourneyStage>();
    for (const entry of states) {
      const stage = stageById.get(entry.id)!;
      sections.set(stage.id, {
        id: stage.id,
        key: stage.key,
        name: stage.name,
        kind: stage.kind,
        position: stage.position,
        state: entry.state,
        templates: readTemplates(stage.config),
        deliverables: [],
        expected: [],
      });
    }
    for (const link of links) {
      const ref = `${link.deliverableIssueId}:${link.deliverableKey}`;
      // A deliverable that left the client's scope (its task was unlinked) is not shown.
      const deliverable = deliverableByRef.get(ref);
      const section = sections.get(link.stageId);
      if (!deliverable || !section) continue;
      filed.add(ref);
      section.deliverables.push({ linkId: link.id, stageId: link.stageId, clientFacing: link.clientFacing, deliverable });
    }
    for (const section of sections.values()) {
      section.expected = stageCompleteness(
        readExpected(stageById.get(section.id)?.config),
        section.deliverables.map(({ deliverable }) => deliverable),
      );
    }

    return {
      caseId,
      title: caseRow.title,
      ndaAcceptedAt: caseRow.ndaStatus === "accepted" ? caseRow.ndaAcceptedAt?.toISOString() ?? null : null,
      nda: ndaOf(caseRow),
      stages: [...sections.values()],
      unfiled: deliverables.filter((item) => !filed.has(deliverableRef(item))),
      stateById,
    };
  }

  async function assertStageOfCase(companyId: string, caseId: string, stageId: string) {
    const caseRow = await loadCase(companyId, caseId);
    const stage = await db
      .select({ id: pipelineStages.id })
      .from(pipelineStages)
      .where(and(eq(pipelineStages.id, stageId), eq(pipelineStages.pipelineId, caseRow.pipelineId)))
      .then((rows) => rows[0] ?? null);
    if (!stage) throw unprocessable("Stage is not on this client's pipeline");
  }

  return {
    journey: async (companyId: string, caseId: string): Promise<ClientJourneyResponse> => {
      const { caseId: id, ndaAcceptedAt, nda, stages, unfiled } = await getJourney(companyId, caseId);
      return { caseId: id, ndaAcceptedAt, nda, stages, unfiled };
    },

    /** What the client sees on its portal: the visibility rule applied, outcome fields only. */
    portal: async (companyId: string, caseId: string): Promise<ClientPortalJourneyResponse> => {
      const journey = await getJourney(companyId, caseId);
      const stages = journey.stages
        .map((stage) => ({
          key: stage.key,
          name: stage.name,
          deliverables: stage.deliverables
            .filter((item) => isClientPortalVisible({
              clientFacing: item.clientFacing,
              status: item.deliverable.status,
              stageState: stage.state,
              confidentiality: item.deliverable.confidentiality,
              ndaCleared: ndaClears(journey.nda.status),
            }))
            .map(({ deliverable }) => ({
              title: deliverable.title,
              summary: deliverable.summary,
              kind: deliverable.kind,
              version: deliverable.version,
              contentType: deliverable.contentType,
              updatedAt: deliverable.updatedAt,
              // The rule above lets only client and public items through.
              confidentiality: deliverable.confidentiality as "client" | "public",
              contentPath: deliverable.external ? null : deliverable.contentPath,
              url: deliverable.url,
            })),
          state: stage.state,
        }))
        .filter((stage) => stage.state === "done")
        .map(({ state: _state, ...stage }) => stage);
      return { caseId, title: journey.title, stages };
    },

    /**
     * Set the client's NDA status. Board only; the route checks. Accepted
     * keeps its first date while it stays accepted; a suspension needs its
     * reason (the validator checks) and clears the accepted date.
     */
    setNda: async (
      companyId: string,
      caseId: string,
      input: { status: NdaStatus; reason: string | null },
      userId: string | null,
    ): Promise<{ ndaAcceptedAt: string | null; nda: ClientNda }> => {
      const current = await loadCase(companyId, caseId);
      if (input.status === "suspended" && !input.reason?.trim()) throw unprocessable("A suspended NDA needs a reason");
      const now = new Date();
      await db
        .update(pipelineCases)
        .set({
          ndaStatus: input.status,
          ndaAcceptedAt: input.status === "accepted"
            ? (current.ndaStatus === "accepted" && current.ndaAcceptedAt ? current.ndaAcceptedAt : now)
            : null,
          ndaSuspendedReason: input.status === "suspended" ? input.reason!.trim() : null,
          ndaStatusChangedAt: now,
          ndaStatusChangedByUserId: userId,
          updatedAt: now,
        })
        .where(and(eq(pipelineCases.companyId, companyId), eq(pipelineCases.id, caseId)));
      const nda = ndaOf(await loadCase(companyId, caseId));
      return { ndaAcceptedAt: nda.acceptedAt, nda };
    },

    /** File a deliverable in the client's scope under one of its stages. */
    fileDeliverable: async (
      companyId: string,
      caseId: string,
      input: { stageId: string; deliverableId: string; clientFacing: boolean },
      actor: ClientJourneyActor,
    ) => {
      await assertStageOfCase(companyId, caseId, input.stageId);
      const row = await db
        .select({ issueId: issueWorkProducts.issueId, key: issueWorkProducts.externalId })
        .from(issueWorkProducts)
        .where(and(
          eq(issueWorkProducts.companyId, companyId),
          eq(issueWorkProducts.id, input.deliverableId),
          eq(issueWorkProducts.type, "deliverable"),
        ))
        .then((rows) => rows[0] ?? null);
      if (!row?.key) throw notFound("Deliverable not found");
      const inScope = (await scopedDeliverables(companyId, caseId))
        .some((item) => item.issue.id === row.issueId && item.key === row.key);
      if (!inScope) throw unprocessable("This deliverable is not on this client's tasks or projects");
      try {
        const [link] = await db
          .insert(pipelineCaseStageDeliverables)
          .values({
            companyId,
            caseId,
            stageId: input.stageId,
            deliverableIssueId: row.issueId,
            deliverableKey: row.key,
            clientFacing: input.clientFacing,
            createdByAgentId: actor.type === "agent" ? actor.agentId : null,
            createdByUserId: actor.type === "user" ? actor.userId : null,
          })
          .returning();
        return link!;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict("This deliverable is already filed under a stage", { code: "duplicate_stage_deliverable" });
        }
        throw error;
      }
    },

    updateLink: async (
      companyId: string,
      caseId: string,
      linkId: string,
      patch: { stageId?: string; clientFacing?: boolean },
    ) => {
      if (patch.stageId) await assertStageOfCase(companyId, caseId, patch.stageId);
      const [link] = await db
        .update(pipelineCaseStageDeliverables)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(
          eq(pipelineCaseStageDeliverables.companyId, companyId),
          eq(pipelineCaseStageDeliverables.caseId, caseId),
          eq(pipelineCaseStageDeliverables.id, linkId),
        ))
        .returning();
      return link ?? null;
    },

    removeLink: async (companyId: string, caseId: string, linkId: string) => {
      const [link] = await db
        .delete(pipelineCaseStageDeliverables)
        .where(and(
          eq(pipelineCaseStageDeliverables.companyId, companyId),
          eq(pipelineCaseStageDeliverables.caseId, caseId),
          eq(pipelineCaseStageDeliverables.id, linkId),
        ))
        .returning();
      return link ?? null;
    },
  };
}
