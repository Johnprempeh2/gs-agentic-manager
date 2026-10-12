import { and, asc, desc, eq, inArray, isNull, max } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@greatstone/db";
import {
  agents,
  issues,
  organisations,
  pipelineCaseEvents,
  pipelineCaseIssueLinks,
  pipelineCaseProjectLinks,
  pipelineCases,
  pipelineStages,
  pipelines,
  projects,
} from "@greatstone/db";
import type { OrganisationHistory, OrganisationHistoryCase } from "@greatstone/shared";

const STAGE_CHANGE_TYPES = ["transitioned", "transition_forced"];

function iso(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function latest(values: Array<string | null>) {
  let best: string | null = null;
  for (const value of values) {
    if (value && (!best || value > best)) best = value;
  }
  return best;
}

/**
 * Engagement history of one organisation (GRE-1480): its live pipeline cases
 * with their stage changes, linked projects and linked tasks. Every query
 * carries the company id, so another company's records never appear.
 */
export function organisationHistoryService(db: Db) {
  return {
    async get(companyId: string, organisationId: string): Promise<OrganisationHistory | null> {
      const organisation = await db
        .select({ id: organisations.id })
        .from(organisations)
        .where(and(eq(organisations.companyId, companyId), eq(organisations.id, organisationId)))
        .then((rows) => rows[0] ?? null);
      if (!organisation) return null;

      const caseRows = await db
        .select({
          id: pipelineCases.id,
          caseKey: pipelineCases.caseKey,
          title: pipelineCases.title,
          pipelineId: pipelineCases.pipelineId,
          pipelineName: pipelines.name,
          stageName: pipelineStages.name,
          stageKind: pipelineStages.kind,
          terminalKind: pipelineCases.terminalKind,
          createdAt: pipelineCases.createdAt,
          updatedAt: pipelineCases.updatedAt,
        })
        .from(pipelineCases)
        .innerJoin(pipelines, eq(pipelines.id, pipelineCases.pipelineId))
        .innerJoin(pipelineStages, eq(pipelineStages.id, pipelineCases.stageId))
        .where(
          and(
            eq(pipelineCases.companyId, companyId),
            eq(pipelineCases.organisationId, organisationId),
            isNull(pipelineCases.retiredAt),
          ),
        )
        .orderBy(desc(pipelineCases.updatedAt));

      if (caseRows.length === 0) return { organisationId, lastContactAt: null, cases: [] };
      const caseIds = caseRows.map((row) => row.id);

      const fromStage = alias(pipelineStages, "from_stage");
      const toStage = alias(pipelineStages, "to_stage");
      const [stageChanges, lastEvents, projectRows, taskRows] = await Promise.all([
        db
          .select({
            id: pipelineCaseEvents.id,
            caseId: pipelineCaseEvents.caseId,
            type: pipelineCaseEvents.type,
            at: pipelineCaseEvents.createdAt,
            actorType: pipelineCaseEvents.actorType,
            actorAgentName: agents.name,
            fromStageName: fromStage.name,
            toStageName: toStage.name,
          })
          .from(pipelineCaseEvents)
          .leftJoin(fromStage, eq(fromStage.id, pipelineCaseEvents.fromStageId))
          .leftJoin(toStage, eq(toStage.id, pipelineCaseEvents.toStageId))
          .leftJoin(agents, eq(agents.id, pipelineCaseEvents.actorAgentId))
          .where(
            and(
              eq(pipelineCaseEvents.companyId, companyId),
              inArray(pipelineCaseEvents.caseId, caseIds),
              inArray(pipelineCaseEvents.type, STAGE_CHANGE_TYPES),
            ),
          )
          .orderBy(asc(pipelineCaseEvents.createdAt)),
        db
          .select({ caseId: pipelineCaseEvents.caseId, at: max(pipelineCaseEvents.createdAt) })
          .from(pipelineCaseEvents)
          .where(and(eq(pipelineCaseEvents.companyId, companyId), inArray(pipelineCaseEvents.caseId, caseIds)))
          .groupBy(pipelineCaseEvents.caseId),
        db
          .select({
            caseId: pipelineCaseProjectLinks.caseId,
            id: projects.id,
            name: projects.name,
            status: projects.status,
          })
          .from(pipelineCaseProjectLinks)
          .innerJoin(projects, and(eq(projects.id, pipelineCaseProjectLinks.projectId), eq(projects.companyId, companyId)))
          .where(and(eq(pipelineCaseProjectLinks.companyId, companyId), inArray(pipelineCaseProjectLinks.caseId, caseIds)))
          .orderBy(asc(projects.name)),
        db
          .select({
            caseId: pipelineCaseIssueLinks.caseId,
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
            updatedAt: issues.updatedAt,
          })
          .from(pipelineCaseIssueLinks)
          .innerJoin(issues, and(eq(issues.id, pipelineCaseIssueLinks.issueId), eq(issues.companyId, companyId)))
          .where(
            and(
              eq(pipelineCaseIssueLinks.companyId, companyId),
              inArray(pipelineCaseIssueLinks.caseId, caseIds),
              isNull(pipelineCaseIssueLinks.retiredAt),
              isNull(issues.hiddenAt),
            ),
          )
          .orderBy(desc(issues.updatedAt)),
      ]);

      const cases = new Map<string, OrganisationHistoryCase>();
      for (const row of caseRows) {
        cases.set(row.id, {
          id: row.id,
          caseKey: row.caseKey,
          title: row.title,
          pipelineId: row.pipelineId,
          pipelineName: row.pipelineName,
          stageName: row.stageName,
          stageKind: row.stageKind,
          terminalKind: row.terminalKind === "done" || row.terminalKind === "cancelled" ? row.terminalKind : null,
          createdAt: iso(row.createdAt)!,
          updatedAt: iso(row.updatedAt)!,
          stageChanges: [],
          projects: [],
          tasks: [],
        });
      }
      for (const row of stageChanges) {
        cases.get(row.caseId)?.stageChanges.push({
          id: row.id,
          at: iso(row.at)!,
          fromStageName: row.fromStageName,
          toStageName: row.toStageName,
          forced: row.type === "transition_forced",
          actorType: row.actorType as "user" | "agent" | "system",
          actorAgentName: row.actorType === "agent" ? row.actorAgentName : null,
        });
      }
      for (const row of projectRows) {
        cases.get(row.caseId)?.projects.push({ id: row.id, name: row.name, status: row.status });
      }
      for (const row of taskRows) {
        cases.get(row.caseId)?.tasks.push({
          id: row.id,
          identifier: row.identifier,
          title: row.title,
          status: row.status,
          updatedAt: iso(row.updatedAt)!,
        });
      }

      const lastContactAt = latest([
        ...caseRows.map((row) => iso(row.createdAt)),
        ...lastEvents.map((row) => iso(row.at)),
        ...taskRows.map((row) => iso(row.updatedAt)),
      ]);
      return { organisationId, lastContactAt, cases: [...cases.values()] };
    },
  };
}
