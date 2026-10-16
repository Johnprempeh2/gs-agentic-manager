import { and, asc, desc, eq, inArray, isNull, max, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@greatstone/db";
import {
  agents,
  crmFiles,
  crmTimelineEntries,
  issues,
  organisationContacts,
  organisations,
  pipelineCaseContacts,
  pipelineCaseEvents,
  pipelineCaseIssueLinks,
  pipelineCaseProjectLinks,
  pipelineCases,
  pipelineFieldDefinitions,
  pipelineStages,
  pipelines,
  projects,
} from "@greatstone/db";
import type { CrmFile, CrmRecordField, CrmTimelineEntry, OrganisationHistory, OrganisationHistoryCase } from "@greatstone/shared";

/** Newest timeline entries shown on the organisation page. */
const MAX_TIMELINE_ENTRIES = 300;
/** Newest CRM files shown on the organisation page. */
const MAX_FILES = 200;

export function crmFileContentPath(companyId: string, fileId: string) {
  return `/api/companies/${companyId}/crm-files/${fileId}/content`;
}

const STAGE_CHANGE_TYPES = ["transitioned", "transition_forced"];

function iso(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** A case field value as an imported field, or null when it is empty or not a plain value. */
function fieldValue(value: unknown): CrmRecordField["value"] | null {
  if (typeof value === "string") return value.trim() ? value : null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
    return items.length ? items : null;
  }
  return null;
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
          ndaStatus: pipelineCases.ndaStatus,
          engagementStatus: pipelineCases.engagementStatus,
          fields: pipelineCases.fields,
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

      const caseIds = caseRows.map((row) => row.id);

      // Activities, notes and calls about the organisation, its people or its cases.
      const contactIds = db
        .select({ id: organisationContacts.id })
        .from(organisationContacts)
        .where(and(eq(organisationContacts.companyId, companyId), eq(organisationContacts.organisationId, organisationId)));
      const timelineRows = await db
        .select({
          entry: crmTimelineEntries,
          contactName: organisationContacts.name,
          caseTitle: pipelineCases.title,
        })
        .from(crmTimelineEntries)
        .leftJoin(organisationContacts, eq(organisationContacts.id, crmTimelineEntries.contactId))
        .leftJoin(pipelineCases, eq(pipelineCases.id, crmTimelineEntries.caseId))
        .where(and(
          eq(crmTimelineEntries.companyId, companyId),
          or(
            eq(crmTimelineEntries.organisationId, organisationId),
            inArray(crmTimelineEntries.contactId, contactIds),
            ...(caseIds.length > 0 ? [inArray(crmTimelineEntries.caseId, caseIds)] : []),
          ),
        ))
        .orderBy(sql`${crmTimelineEntries.occurredAt} desc nulls last`, desc(crmTimelineEntries.createdAt))
        .limit(MAX_TIMELINE_ENTRIES);
      const timeline: CrmTimelineEntry[] = timelineRows.map(({ entry, contactName, caseTitle }) => ({
        id: entry.id,
        source: entry.source,
        kind: entry.kind as CrmTimelineEntry["kind"],
        activityType: entry.activityType,
        subject: entry.subject,
        body: entry.body,
        occurredAt: iso(entry.occurredAt),
        durationMinutes: entry.durationMinutes,
        done: entry.done,
        ownerName: entry.ownerName,
        contactId: entry.contactId,
        contactName,
        caseId: entry.caseId,
        caseTitle,
        details: entry.details ?? {},
      }));
      const fileRows = await db
        .select({ file: crmFiles, contactName: organisationContacts.name, caseTitle: pipelineCases.title })
        .from(crmFiles)
        .leftJoin(organisationContacts, eq(organisationContacts.id, crmFiles.contactId))
        .leftJoin(pipelineCases, eq(pipelineCases.id, crmFiles.caseId))
        .where(and(
          eq(crmFiles.companyId, companyId),
          or(
            eq(crmFiles.organisationId, organisationId),
            inArray(crmFiles.contactId, contactIds),
            ...(caseIds.length > 0 ? [inArray(crmFiles.caseId, caseIds)] : []),
          ),
        ))
        .orderBy(sql`${crmFiles.addedAt} desc nulls last`, desc(crmFiles.createdAt))
        .limit(MAX_FILES);
      const files: CrmFile[] = fileRows.map(({ file, contactName, caseTitle }) => ({
        id: file.id,
        source: file.source,
        name: file.name,
        contentType: file.contentType,
        byteSize: file.byteSize,
        description: file.description,
        ownerName: file.ownerName,
        addedAt: iso(file.addedAt),
        contentPath: file.assetId ? crmFileContentPath(companyId, file.id) : null,
        remoteUrl: file.remoteUrl,
        notCopied: typeof file.details?.notCopied === "string" ? file.details.notCopied : null,
        contactName,
        caseId: file.caseId,
        caseTitle,
      }));
      // A done activity, a note, a call or an email in the past counts as contact; a planned activity or a stage change does not.
      const nowIso = new Date().toISOString();
      const timelineContact = timeline
        .filter((entry) => entry.occurredAt && entry.occurredAt <= nowIso && entry.kind !== "stage_change" && (entry.kind !== "activity" || entry.done))
        .map((entry) => entry.occurredAt);

      if (caseRows.length === 0) return { organisationId, lastContactAt: latest(timelineContact), cases: [], timeline, files };

      const fromStage = alias(pipelineStages, "from_stage");
      const toStage = alias(pipelineStages, "to_stage");
      const pipelineIds = [...new Set(caseRows.map((row) => row.pipelineId))];
      const [stageChanges, lastEvents, projectRows, taskRows, fieldDefs, peopleRows] = await Promise.all([
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
        db
          .select({
            pipelineId: pipelineFieldDefinitions.pipelineId,
            key: pipelineFieldDefinitions.key,
            label: pipelineFieldDefinitions.label,
          })
          .from(pipelineFieldDefinitions)
          .where(and(
            eq(pipelineFieldDefinitions.companyId, companyId),
            inArray(pipelineFieldDefinitions.pipelineId, pipelineIds),
            isNull(pipelineFieldDefinitions.archivedAt),
          ))
          .orderBy(asc(pipelineFieldDefinitions.position), asc(pipelineFieldDefinitions.label)),
        db
          .select({ caseId: pipelineCaseContacts.caseId, name: pipelineCaseContacts.name, role: pipelineCaseContacts.role })
          .from(pipelineCaseContacts)
          .where(and(eq(pipelineCaseContacts.companyId, companyId), inArray(pipelineCaseContacts.caseId, caseIds)))
          .orderBy(asc(pipelineCaseContacts.position), asc(pipelineCaseContacts.name)),
      ]);
      const defsByPipeline = new Map<string, Array<{ key: string; label: string }>>();
      for (const def of fieldDefs) {
        const defs = defsByPipeline.get(def.pipelineId) ?? [];
        defs.push({ key: def.key, label: def.label });
        defsByPipeline.set(def.pipelineId, defs);
      }

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
          ndaStatus: row.ndaStatus === "accepted" || row.ndaStatus === "suspended" ? row.ndaStatus : "required",
          engagementStatus: row.engagementStatus === "sent" || row.engagementStatus === "accepted" ? row.engagementStatus : "not_sent",
          createdAt: iso(row.createdAt)!,
          updatedAt: iso(row.updatedAt)!,
          details: (defsByPipeline.get(row.pipelineId) ?? []).flatMap((def) => {
            const value = fieldValue(row.fields?.[def.key]);
            return value === null ? [] : [{ key: def.key, label: def.label, value }];
          }),
          people: [],
          stageChanges: [],
          projects: [],
          tasks: [],
        });
      }
      for (const row of peopleRows) {
        cases.get(row.caseId)?.people?.push({ name: row.name, role: row.role });
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
        ...timelineContact,
      ]);
      return { organisationId, lastContactAt, cases: [...cases.values()], timeline, files };
    },
  };
}
