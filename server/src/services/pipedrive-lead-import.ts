// Read-only import of the Pipedrive Leads inbox (John, 16 Oct: every bit of
// client information must come across). Leads become cases in one "Pipedrive
// leads" pipeline, keyed "pipedrive-lead-<id>", with their value, owner,
// person, organisation, labels, source and custom fields as typed fields.
// Pipedrive removes a lead when it is converted to a deal, so a lead that is
// no longer listed moves to "Converted or removed". Nothing is written to
// Pipedrive.
import { and, eq, like } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { pipelineCases, pipelines as pipelinesTable } from "@greatstone/db";
import type { OrganisationImportCounts, OrganisationImportResult } from "@greatstone/shared";
import { PipedriveApiError, PipedriveAuthError, type PipedriveClient, type PipedriveDeal, type PipedriveDealField } from "./crm-sync-pipedrive.js";
import type { OrganisationActor } from "./organisations.js";
import { pipedriveDealFieldSpecs, pipedriveDealImportService, type PipedriveFieldSpec } from "./pipedrive-deal-import.js";
import { pipelineService, type PipelineActor } from "./pipelines.js";

const MAX_ERROR_SAMPLES = 20;
export const PIPEDRIVE_LEADS_PIPELINE_KEY = "pipedrive-leads";
export const LEAD_OPEN_STAGE_KEY = "lead_open";
export const LEAD_ARCHIVED_STAGE_KEY = "lead_archived";
export const LEAD_CLOSED_STAGE_KEY = "lead_closed";

const LEAD_STAGES = [
  { key: LEAD_OPEN_STAGE_KEY, name: "Lead", kind: "working" as const, position: 100 },
  { key: LEAD_ARCHIVED_STAGE_KEY, name: "Archived", kind: "cancelled" as const, position: 200 },
  { key: LEAD_CLOSED_STAGE_KEY, name: "Converted or removed", kind: "done" as const, position: 300 },
];

export function caseKeyForPipedriveLeadId(leadId: string) {
  return `pipedrive-lead-${leadId}`;
}

function str(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function day(value: unknown): string | null {
  const text = str(value);
  const match = text ? /^(\d{4}-\d{2}-\d{2})/.exec(text) : null;
  return match ? match[1]! : null;
}

function idOf(value: unknown): string | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return str(record.value ?? record.id);
  }
  return str(value);
}

function sameFields(a: Record<string, unknown>, b: Record<string, unknown>) {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => key in b && JSON.stringify(a[key] ?? null) === JSON.stringify(b[key] ?? null));
}

/**
 * The typed fields of a lead case: the lead's own fields, then the custom
 * deal fields, which Pipedrive shares between deals and leads.
 */
export function pipedriveLeadFieldSpecs(
  dealFields: PipedriveDealField[],
  lookups: {
    users: Map<string, string>;
    labels: Map<string, string>;
    people: Map<string, string>;
    organisations: Map<string, string>;
  },
): PipedriveFieldSpec[] {
  const named = (value: unknown, byId: Map<string, string>) => {
    const id = idOf(value);
    return id ? byId.get(id) ?? id : null;
  };
  const value = (lead: Record<string, unknown>) =>
    lead.value && typeof lead.value === "object" ? lead.value as Record<string, unknown> : null;
  const own: PipedriveFieldSpec[] = [
    { key: "pipedriveLeadId", label: "Pipedrive lead id", type: "text", options: [], read: (lead) => str(lead.id) },
    { key: "leadValue", label: "Value", type: "number", options: [], read: (lead) => num(value(lead)?.amount) },
    { key: "leadCurrency", label: "Currency", type: "text", options: [], read: (lead) => str(value(lead)?.currency) },
    { key: "leadOwner", label: "Owner", type: "text", options: [], read: (lead) => named(lead.owner_id, lookups.users) },
    { key: "leadCreator", label: "Created by", type: "text", options: [], read: (lead) => named(lead.creator_id, lookups.users) },
    { key: "contactPerson", label: "Contact person", type: "text", options: [], read: (lead) => named(lead.person_id, lookups.people) },
    { key: "pipedriveOrganisation", label: "Organisation", type: "text", options: [], read: (lead) => named(lead.organization_id, lookups.organisations) },
    { key: "expectedCloseDate", label: "Expected close date", type: "date", options: [], read: (lead) => day(lead.expected_close_date) },
    {
      key: "leadLabels",
      label: "Labels",
      type: "multi_select",
      options: [...new Set(lookups.labels.values())],
      read: (lead) => Array.isArray(lead.label_ids)
        ? [...new Set(lead.label_ids.map((id) => lookups.labels.get(String(id)) ?? String(id)))]
        : [],
    },
    { key: "leadSource", label: "Lead source", type: "text", options: [], read: (lead) => str(lead.source_name) },
    { key: "sourceOrigin", label: "Source origin", type: "text", options: [], read: (lead) => str(lead.origin) },
    { key: "sourceChannel", label: "Source channel", type: "text", options: [], read: (lead) => str(lead.channel) },
    { key: "sourceChannelId", label: "Source channel id", type: "text", options: [], read: (lead) => str(lead.channel_id) },
    { key: "leadSeen", label: "Seen", type: "text", options: [], read: (lead) => typeof lead.was_seen === "boolean" ? (lead.was_seen ? "Yes" : "No") : null },
    { key: "addedOn", label: "Lead created", type: "date", options: [], read: (lead) => day(lead.add_time) },
    { key: "pipedriveUpdatedOn", label: "Update time", type: "date", options: [], read: (lead) => day(lead.update_time) },
  ];
  // Custom deal fields hold the same keys on leads.
  const custom = pipedriveDealFieldSpecs(dealFields, { users: lookups.users, stageNames: new Map() })
    .filter((spec) => spec.key.startsWith("pd_"));
  return [...own, ...custom];
}

type LeadImportResult = {
  leads: OrganisationImportCounts;
  /** GSAM case id of every imported lead, by Pipedrive lead id, so activities and notes can link to it. */
  caseIdByLeadId: Map<string, string>;
};

export function pipedriveLeadImportService(db: Db) {
  const pipelines = pipelineService(db);
  const deals = pipedriveDealImportService(db);

  return {
    async ensurePipeline(companyId: string, actor: PipelineActor) {
      const found = await db.select().from(pipelinesTable)
        .where(and(eq(pipelinesTable.companyId, companyId), eq(pipelinesTable.key, PIPEDRIVE_LEADS_PIPELINE_KEY)))
        .then((rows) => rows[0] ?? null);
      if (!found) {
        const created = await pipelines.createPipeline({
          companyId,
          key: PIPEDRIVE_LEADS_PIPELINE_KEY,
          name: "Pipedrive leads",
          description: "Imported from the Pipedrive Leads inbox. A lead converted to a deal in Pipedrive moves to Converted or removed.",
          stages: LEAD_STAGES,
          actor,
        });
        return created.id;
      }
      const stages = await pipelines.listStages(companyId, found.id);
      for (const stage of LEAD_STAGES) {
        if (!stages.some((row) => row.key === stage.key)) {
          await pipelines.createStage({ companyId, pipelineId: found.id, ...stage, actor });
        }
      }
      return found.id;
    },

    async run(input: {
      companyId: string;
      client: PipedriveClient;
      actor: OrganisationActor;
      result: OrganisationImportResult;
      users: Map<string, string>;
      organisationIdByExternalId: Map<string, string>;
      /** Names of the people and organisations read earlier, by Pipedrive id. */
      peopleNames: Map<string, string>;
      organisationNames: Map<string, string>;
    }): Promise<LeadImportResult> {
      const { companyId, client, result } = input;
      const counts: LeadImportResult = { leads: { created: 0, updated: 0, skipped: 0, errors: 0 }, caseIdByLeadId: new Map() };
      result.leads = counts.leads;
      const pushError = (externalId: string, error: unknown) => {
        if (result.errorSamples.length < MAX_ERROR_SAMPLES) {
          result.errorSamples.push({ kind: "lead", externalId, message: error instanceof Error ? error.message : String(error) });
        }
      };
      const actor: PipelineActor = input.actor.userId ? { type: "user", userId: input.actor.userId } : { type: "system" };

      // Leads need their own Pipedrive scope; an account without it still imports the rest.
      let labels: Array<{ id: string; name?: string | null }>;
      let firstPage: Awaited<ReturnType<PipedriveClient["listLeadsPage"]>>;
      let dealFields: PipedriveDealField[];
      try {
        [labels, firstPage, dealFields] = await Promise.all([
          client.listLeadLabels(),
          client.listLeadsPage({ start: 0 }),
          client.listDealFields(),
        ]);
      } catch (error) {
        if (!(error instanceof PipedriveAuthError || error instanceof PipedriveApiError)) throw error;
        counts.leads.errors += 1;
        pushError("all", new Error(`Pipedrive did not share leads: ${error.message}`));
        return counts;
      }

      // No leads and nothing imported before: no empty pipeline.
      if (firstPage.items.length === 0) {
        const found = await db.select({ id: pipelinesTable.id }).from(pipelinesTable)
          .where(and(eq(pipelinesTable.companyId, companyId), eq(pipelinesTable.key, PIPEDRIVE_LEADS_PIPELINE_KEY)));
        if (found.length === 0) return counts;
      }
      const pipelineId = await this.ensurePipeline(companyId, actor);
      const specs = pipedriveLeadFieldSpecs(dealFields, {
        users: input.users,
        labels: new Map(labels.map((label) => [String(label.id), str(label.name) ?? String(label.id)])),
        people: input.peopleNames,
        organisations: input.organisationNames,
      });
      const defs = await deals.ensureFields(companyId, pipelineId, specs, actor);
      const stageKeyById = new Map((await pipelines.listStages(companyId, pipelineId)).map((stage) => [stage.id, stage.key]));
      const existing = await db.select().from(pipelineCases).where(and(
        eq(pipelineCases.companyId, companyId),
        eq(pipelineCases.pipelineId, pipelineId),
        like(pipelineCases.caseKey, "pipedrive-lead-%"),
      ));
      const caseByKey = new Map(existing.filter((row) => !row.retiredAt).map((row) => [row.caseKey, row]));
      const seen = new Set<string>();

      const moveTo = async (row: typeof pipelineCases.$inferSelect, stageKey: string, reason: string) => {
        if (stageKeyById.get(row.stageId) === stageKey) return { row, moved: false };
        const moved = await pipelines.transitionCase({
          companyId,
          caseId: row.id,
          toStageKey: stageKey,
          expectedVersion: row.version,
          actor,
          force: true,
          skipChildrenTerminalGate: true,
          reason,
        });
        return { row: moved.case, moved: true };
      };

      let page: typeof firstPage | null = firstPage;
      let complete = true;
      while (page) {
        for (const lead of page.items) {
          const externalId = str(lead.id);
          if (!externalId) {
            counts.leads.skipped += 1;
            continue;
          }
          const caseKey = caseKeyForPipedriveLeadId(externalId);
          seen.add(caseKey);
          try {
            const title = (str(lead.title) ?? `Pipedrive lead ${externalId}`).slice(0, 500);
            const stageKey = lead.is_archived === true ? LEAD_ARCHIVED_STAGE_KEY : LEAD_OPEN_STAGE_KEY;
            const fields = await deals.dealFields(companyId, lead as PipedriveDeal, specs, defs);
            const orgExternalId = idOf(lead.organization_id);
            const organisationId = orgExternalId ? input.organisationIdByExternalId.get(orgExternalId) ?? null : null;
            const current = caseByKey.get(caseKey);
            if (!current) {
              const ingested = await pipelines.ingestCase({
                companyId,
                pipelineId,
                caseKey,
                title,
                fields: Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null)),
                stageKey,
                organisationId,
                actor,
              });
              caseByKey.set(caseKey, ingested.case);
              counts.leads.created += 1;
              continue;
            }
            let row = current;
            let changed = false;
            const merged = { ...(row.fields ?? {}), ...fields };
            for (const key of Object.keys(merged)) if (merged[key] === null && !(key in (row.fields ?? {}))) delete merged[key];
            const newOrganisation = organisationId && organisationId !== row.organisationId ? organisationId : null;
            if (row.title !== title || !sameFields(merged, row.fields ?? {}) || newOrganisation) {
              row = await pipelines.patchCaseContent({
                companyId,
                caseId: row.id,
                title,
                fields: merged,
                ...(newOrganisation ? { organisationId: newOrganisation } : {}),
                actor,
              });
              changed = true;
            }
            const moved = await moveTo(row, stageKey, lead.is_archived === true ? "Archived in Pipedrive" : "Open in Pipedrive");
            row = moved.row;
            caseByKey.set(caseKey, row);
            if (changed || moved.moved) counts.leads.updated += 1;
            else counts.leads.skipped += 1;
          } catch (error) {
            counts.leads.errors += 1;
            pushError(externalId, error);
          }
        }
        if (page.nextStart === null) break;
        try {
          page = await client.listLeadsPage({ start: page.nextStart });
        } catch (error) {
          if (!(error instanceof PipedriveAuthError || error instanceof PipedriveApiError)) throw error;
          counts.leads.errors += 1;
          pushError("all", new Error(`Could not read every lead: ${error.message}`));
          complete = false;
          page = null;
        }
      }

      // A lead Pipedrive no longer lists was converted to a deal or deleted.
      if (complete) {
        for (const [caseKey, row] of caseByKey) {
          if (seen.has(caseKey)) continue;
          try {
            const moved = await moveTo(row, LEAD_CLOSED_STAGE_KEY, "No longer a lead in Pipedrive");
            caseByKey.set(caseKey, moved.row);
            if (moved.moved) counts.leads.updated += 1;
          } catch (error) {
            counts.leads.errors += 1;
            pushError(caseKey.slice("pipedrive-lead-".length), error);
          }
        }
      }
      for (const [caseKey, row] of caseByKey) counts.caseIdByLeadId.set(caseKey.slice("pipedrive-lead-".length), row.id);
      return counts;
    },
  };
}
