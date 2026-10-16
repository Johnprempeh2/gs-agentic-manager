import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { crmFiles, crmTimelineEntries, organisationContacts } from "@greatstone/db";
import type { CrmFile, CrmTimelineEntry, PipelineCaseCrmHistory } from "@greatstone/shared";
import { crmFileContentPath } from "./organisation-history.js";

// The whole CRM history of one client case (evening run, 16 Oct): the
// activities, notes, calls, emails and stage changes a CRM import filed on the
// case, and the files that were on the deal. Read only; the import owns the rows.

/** Newest timeline entries returned for one case. */
const MAX_TIMELINE_ENTRIES = 500;
/** Newest files returned for one case. */
const MAX_FILES = 200;

function iso(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function pipelineCaseCrmHistoryService(db: Db) {
  return {
    async get(companyId: string, caseId: string, caseTitle: string): Promise<PipelineCaseCrmHistory> {
      const timelineRows = await db
        .select({ entry: crmTimelineEntries, contactName: organisationContacts.name })
        .from(crmTimelineEntries)
        .leftJoin(organisationContacts, eq(organisationContacts.id, crmTimelineEntries.contactId))
        .where(and(eq(crmTimelineEntries.companyId, companyId), eq(crmTimelineEntries.caseId, caseId)))
        .orderBy(sql`${crmTimelineEntries.occurredAt} desc nulls last`, desc(crmTimelineEntries.createdAt))
        .limit(MAX_TIMELINE_ENTRIES + 1);
      const timeline: CrmTimelineEntry[] = timelineRows.slice(0, MAX_TIMELINE_ENTRIES).map(({ entry, contactName }) => ({
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
        .select({ file: crmFiles, contactName: organisationContacts.name })
        .from(crmFiles)
        .leftJoin(organisationContacts, eq(organisationContacts.id, crmFiles.contactId))
        .where(and(eq(crmFiles.companyId, companyId), eq(crmFiles.caseId, caseId)))
        .orderBy(sql`${crmFiles.addedAt} desc nulls last`, desc(crmFiles.createdAt))
        .limit(MAX_FILES);
      const files: CrmFile[] = fileRows.map(({ file, contactName }) => ({
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

      return { caseId, timeline, files, truncated: timelineRows.length > MAX_TIMELINE_ENTRIES };
    },
  };
}
