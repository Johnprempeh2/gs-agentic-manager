// Import of the CSV files Pipedrive exports, for teams without an API key.
// Organisations and people land on the same rows the API import uses (source
// "pipedrive", Pipedrive id as external id), so switching to the API later
// updates them instead of duplicating. Open deals become client cases in the
// chosen pipeline under the case key the CRM sync uses ("pipedrive-<id>"), so
// a later sync binding adopts them. Activities are attached to their deal's
// case. Nothing is sent anywhere.
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { organisations, pipelineCases } from "@greatstone/db";
import type { ImportHubspotExport, ImportPipedriveExport, OrganisationImportResult } from "@greatstone/shared";
import { unprocessable } from "../errors.js";
import {
  readHubspotCompaniesExport,
  readHubspotContactsExport,
  readHubspotDealsExport,
} from "./hubspot-export.js";
import {
  emptyImportCounts,
  type CrmImportSource,
  newImportResult,
  pipedriveRecordWriter,
} from "./organisation-import-pipedrive.js";
import { findOrCreateOrganisation, loadOrganisationNameIndex } from "./organisation-match.js";
import type { OrganisationActor } from "./organisations.js";
import {
  PipedriveExportError,
  readActivitiesExport,
  readDealsExport,
  readOrganisationsExport,
  readPeopleExport,
  type ExportActivity,
  type ExportContact,
  type ExportDeal,
  type ExportOrganisation,
  type ParsedRows,
} from "./pipedrive-export.js";
import { pipelineService, type PipelineActor } from "./pipelines.js";

/** Activities kept per case, newest first, so a busy deal stays within the case size limit. */
const MAX_ACTIVITIES_PER_CASE = 50;
const MAX_ERROR_SAMPLES = 20;
/** Stage kinds a case may be created in. Done and cancelled stages are left to people. */
const STARTABLE_STAGE_KINDS = new Set(["open", "working", "review"]);

export function caseKeyForPipedriveDeal(externalId: string) {
  return `pipedrive-${externalId}`;
}

/** Case keys and field names for each CRM, so a deal from one never overwrites a deal from another. */
const CRM_LABELS: Record<CrmImportSource, { app: string; dealIdField: string; stageField: string; activitiesField: string }> = {
  pipedrive: { app: "Pipedrive", dealIdField: "pipedriveDealId", stageField: "pipedriveStage", activitiesField: "pipedriveActivities" },
  hubspot: { app: "HubSpot", dealIdField: "hubspotDealId", stageField: "hubspotStage", activitiesField: "hubspotActivities" },
};

export function caseKeyForCrmDeal(source: CrmImportSource, externalId: string) {
  return `${source}-${externalId}`;
}

/** Export rows from one CRM, already read from its CSV files. */
export interface ParsedCrmExport {
  organisations: ParsedRows<ExportOrganisation> | null;
  people: ParsedRows<ExportContact> | null;
  deals: ParsedRows<ExportDeal> | null;
  activities: ParsedRows<ExportActivity> | null;
}

function nameKey(value: string | null | undefined) {
  return value ? value.trim().toLowerCase().replace(/\s+/g, " ") : "";
}

function dealSummary(deal: ExportDeal, app = "Pipedrive") {
  const parts = [`Imported from a ${app} export.`];
  if (deal.value !== null) parts.push(`Value ${deal.currency ? `${deal.currency} ` : ""}${deal.value.toLocaleString("en-GB")}.`);
  if (deal.expectedCloseDate) parts.push(`Expected close ${deal.expectedCloseDate}.`);
  if (deal.owner) parts.push(`Owner ${deal.owner}.`);
  if (deal.contactName) parts.push(`Contact ${deal.contactName}.`);
  return parts.join(" ");
}

function newestActivities(list: ExportActivity[]) {
  return [...list].sort((a, b) => (b.dueDate ?? "").localeCompare(a.dueDate ?? "")).slice(0, MAX_ACTIVITIES_PER_CASE);
}

function activityEntry(activity: ExportActivity) {
  return {
    subject: activity.subject,
    type: activity.type,
    dueDate: activity.dueDate,
    done: activity.done,
    note: activity.note,
  };
}

/** Reads every file before anything is written, so a bad file changes nothing. */
function readAll(read: () => ParsedCrmExport, code: string) {
  try {
    return read();
  } catch (error) {
    if (error instanceof PipedriveExportError) throw unprocessable(error.message, { code });
    throw error;
  }
}

export function pipedriveExportImportService(db: Db, deps: { now?: () => Date } = {}) {
  const importer = crmExportImporter(db, deps);
  return {
    run(companyId: string, files: ImportPipedriveExport, actor: OrganisationActor): Promise<OrganisationImportResult> {
      const parsed = readAll(() => ({
        organisations: files.organisations ? readOrganisationsExport(files.organisations) : null,
        people: files.people ? readPeopleExport(files.people) : null,
        deals: files.deals ? readDealsExport(files.deals) : null,
        activities: files.activities ? readActivitiesExport(files.activities) : null,
      }), "pipedrive_export_invalid");
      return importer.run(companyId, "pipedrive", parsed, files.pipelineId ?? null, actor);
    },
  };
}

/**
 * Import of the CSV files HubSpot exports. Companies and contacts keep source
 * "hubspot" and the HubSpot record id; open deals become cases keyed
 * "hubspot-<id>". Closed won and closed lost deals only set the company status.
 */
export function hubspotExportImportService(db: Db, deps: { now?: () => Date } = {}) {
  const importer = crmExportImporter(db, deps);
  return {
    run(companyId: string, files: ImportHubspotExport, actor: OrganisationActor): Promise<OrganisationImportResult> {
      const parsed = readAll(() => ({
        organisations: files.companies ? readHubspotCompaniesExport(files.companies) : null,
        people: files.contacts ? readHubspotContactsExport(files.contacts) : null,
        deals: files.deals ? readHubspotDealsExport(files.deals) : null,
        activities: null,
      }), "hubspot_export_invalid");
      return importer.run(companyId, "hubspot", parsed, files.pipelineId ?? null, actor);
    },
  };
}

function crmExportImporter(db: Db, deps: { now?: () => Date } = {}) {
  const now = deps.now ?? (() => new Date());
  const pipelines = pipelineService(db);

  return {
    async run(
      companyId: string,
      source: CrmImportSource,
      parsed: ParsedCrmExport,
      pipelineId: string | null,
      actor: OrganisationActor,
    ): Promise<OrganisationImportResult> {
      const labels = CRM_LABELS[source];
      const caseKeyFor = (externalId: string) => caseKeyForCrmDeal(source, externalId);
      const files = { pipelineId };
      const { organisations: orgRows, people: peopleRows, deals: dealRows, activities: activityRows } = parsed;
      if (dealRows && !files.pipelineId && dealRows.records.some((deal) => deal.status === "open" || deal.status === null)) {
        throw unprocessable("Choose the pipeline your open deals should go into.", { code: "pipeline_required" });
      }

      const stages = files.pipelineId ? await pipelines.listStages(companyId, files.pipelineId) : [];
      const stageKeyByName = new Map(
        stages.filter((stage) => STARTABLE_STAGE_KINDS.has(stage.kind)).map((stage) => [nameKey(stage.name), stage.key]),
      );

      const result = newImportResult(now(), source);
      const writer = pipedriveRecordWriter(db, companyId, actor, result, now, source);
      const pushError = (kind: "deal" | "activity", externalId: string, error: unknown) => {
        if (result.errorSamples.length < MAX_ERROR_SAMPLES) {
          result.errorSamples.push({ kind, externalId, message: error instanceof Error ? error.message : String(error) });
        }
      };

      // Won deals make a new organisation a client; open ones a prospect.
      const dealStatusByOrg = new Map<string, "client" | "prospect">();
      for (const deal of dealRows?.records ?? []) {
        for (const key of [deal.organisationExternalId, nameKey(deal.organisationName)]) {
          if (!key) continue;
          if (deal.status === "won") dealStatusByOrg.set(key, "client");
          else if (deal.status === "open" && !dealStatusByOrg.has(key)) dealStatusByOrg.set(key, "prospect");
        }
      }

      await writer.loadOrganisations();
      if (orgRows) {
        result.organisations.skipped += orgRows.skipped;
        for (const org of orgRows.records) {
          const fromDeals = dealStatusByOrg.get(org.externalId) ?? dealStatusByOrg.get(nameKey(org.name));
          const status = org.status === "client" || fromDeals === "client" ? "client" : fromDeals ?? org.status;
          await writer.writeOrganisation({ ...org, status });
        }
      }

      // Every organisation in the company, by Pipedrive id and by name, so people
      // and deals link even when the export has no organisation id column.
      const companyOrgs = await db
        .select()
        .from(organisations)
        .where(and(eq(organisations.companyId, companyId), isNull(organisations.archivedAt)));
      const orgByName = new Map(companyOrgs.map((row) => [nameKey(row.name), row]));
      for (const row of writer.orgByExternalId.values()) orgByName.set(nameKey(row.name), row);
      let nameIndex: Map<string, string> | undefined;
      const findOrganisation = (externalId: string | null, name: string | null) =>
        (externalId ? writer.orgByExternalId.get(externalId) : undefined) ?? (name ? orgByName.get(nameKey(name)) : undefined);

      if (peopleRows) {
        await writer.loadContacts();
        result.contacts.skipped += peopleRows.skipped;
        for (const person of peopleRows.records) {
          // A person with no organisation, or whose organisation is not in the file, is kept on their own.
          const organisation = findOrganisation(person.organisationExternalId, person.organisationName) ?? null;
          await writer.writeContact(person, organisation);
        }
      }

      if (!dealRows && !activityRows) {
        result.finishedAt = now().toISOString();
        return result;
      }

      const deals = emptyImportCounts();
      const activities = emptyImportCounts();
      result.deals = deals;
      result.activities = activities;
      deals.skipped += dealRows?.skipped ?? 0;
      activities.skipped += activityRows?.skipped ?? 0;

      // Activities grouped by deal id, falling back to the deal title.
      const activitiesByDeal = new Map<string, ExportActivity[]>();
      const dealIdByTitle = new Map((dealRows?.records ?? []).map((deal) => [nameKey(deal.title), deal.externalId]));
      for (const activity of activityRows?.records ?? []) {
        const dealId = activity.dealExternalId ?? dealIdByTitle.get(nameKey(activity.dealTitle));
        if (!dealId) {
          activities.skipped += 1;
          continue;
        }
        activitiesByDeal.set(dealId, [...(activitiesByDeal.get(dealId) ?? []), activity]);
      }

      const pipelineActor: PipelineActor = actor.userId ? { type: "user", userId: actor.userId } : { type: "system" };
      const handledDealIds = new Set<string>();

      /** Updates an existing deal case; true when anything changed. Fields are merged, never dropped. */
      async function patchDealCase(
        current: typeof pipelineCases.$inferSelect,
        content: { title?: string; summary?: string; fields: Record<string, unknown>; organisationId?: string | null },
      ) {
        const patched = await pipelines.patchCaseContent({
          companyId,
          caseId: current.id,
          ...(content.title ? { title: content.title } : {}),
          ...(content.summary ? { summary: content.summary } : {}),
          fields: { ...(current.fields ?? {}), ...content.fields },
          ...(content.organisationId && !current.organisationId ? { organisationId: content.organisationId } : {}),
          actor: pipelineActor,
        });
        return patched.version !== current.version;
      }

      for (const deal of dealRows?.records ?? []) {
        if (deal.status !== "open" && deal.status !== null) {
          // Won and lost deals set the organisation's status above; they do not reopen as cases.
          deals.skipped += 1;
          continue;
        }
        if (!files.pipelineId) {
          deals.skipped += 1;
          continue;
        }
        const known = findOrganisation(deal.organisationExternalId, deal.organisationName);
        const allActivities = activitiesByDeal.get(deal.externalId) ?? [];
        const dealActivities = newestActivities(allActivities);
        activities.skipped += allActivities.length - dealActivities.length;
        const fields: Record<string, unknown> = {
          [labels.dealIdField]: deal.externalId,
          dealValue: deal.value,
          dealCurrency: deal.currency,
          expectedCloseDate: deal.expectedCloseDate,
          dealOwner: deal.owner,
          [labels.stageField]: deal.stageName,
        };
        if (dealActivities.length > 0) fields[labels.activitiesField] = dealActivities.map(activityEntry);
        try {
          // Every card needs an organisation (GRE-1538): one not in the files is found or added by name.
          if (!known) nameIndex ??= await loadOrganisationNameIndex(db, companyId);
          const organisationId = known?.id ?? (await findOrCreateOrganisation(db, {
            companyId,
            name: deal.organisationName?.trim() || deal.title,
            status: "prospect",
          }, nameIndex))?.id ?? null;
          const ingested = await pipelines.ingestCase({
            companyId,
            pipelineId: files.pipelineId,
            caseKey: caseKeyFor(deal.externalId),
            title: deal.title,
            summary: dealSummary(deal, labels.app),
            fields,
            stageKey: stageKeyByName.get(nameKey(deal.stageName)) ?? null,
            organisationId,
            actor: pipelineActor,
          });
          const changed = ingested.created
            ? true
            : await patchDealCase(ingested.case, {
              title: deal.title,
              summary: dealSummary(deal, labels.app),
              fields,
              organisationId,
            });
          if (ingested.created) deals.created += 1;
          else if (changed) deals.updated += 1;
          else deals.skipped += 1;
          handledDealIds.add(deal.externalId);
          if (changed) activities.created += dealActivities.length;
          else activities.skipped += dealActivities.length;
        } catch (error) {
          deals.errors += 1;
          pushError("deal", deal.externalId, error);
        }
      }

      // Activities for deals imported earlier: attach them to the existing case.
      const laterDealIds = [...activitiesByDeal.keys()].filter((dealId) => !handledDealIds.has(dealId));
      const existingCases = laterDealIds.length === 0
        ? []
        : await db
          .select()
          .from(pipelineCases)
          .where(and(
            eq(pipelineCases.companyId, companyId),
            inArray(pipelineCases.caseKey, laterDealIds.map(caseKeyFor)),
            isNull(pipelineCases.retiredAt),
          ));
      const caseByKey = new Map(existingCases.map((row) => [row.caseKey, row]));
      for (const dealId of laterDealIds) {
        const list = activitiesByDeal.get(dealId)!;
        const caseRow = caseByKey.get(caseKeyFor(dealId));
        if (!caseRow) {
          activities.skipped += list.length;
          continue;
        }
        const entries = newestActivities(list);
        try {
          const changed = await patchDealCase(caseRow, {
            fields: { ...(caseRow.fields ?? {}), [labels.activitiesField]: entries.map(activityEntry) },
          });
          if (changed) activities.created += entries.length;
          else activities.skipped += entries.length;
          activities.skipped += list.length - entries.length;
        } catch (error) {
          activities.errors += list.length;
          pushError("activity", dealId, error);
        }
      }

      result.finishedAt = now().toISOString();
      return result;
    },
  };
}
