// Full read-only import of Pipedrive pipelines, stages and deals (John, 16 Oct:
// GSAM replaces Pipedrive, so every deal and field must come across). Each
// Pipedrive pipeline becomes its own GSAM pipeline with Pipedrive's stages plus
// Won and Lost, so a journey that differs from the DX one keeps its real
// stages. Every deal that is not deleted becomes a case keyed
// "pipedrive-<id>", the key the CRM sync and the export import use. Deal
// fields, custom fields included, become typed pipeline fields named after the
// Pipedrive field. A rerun updates in place. Nothing is written to Pipedrive.
import { and, eq, inArray, like } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { pipelineCases, pipelineFieldDefinitions, pipelines as pipelinesTable, pipelineStages } from "@greatstone/db";
import {
  checkPipelineFieldValue,
  isEmptyPipelineFieldValue,
  PIPELINE_FIELD_LONG_TEXT_MAX,
  PIPELINE_FIELD_TEXT_MAX,
  type OrganisationImportResult,
  type PipelineFieldType,
} from "@greatstone/shared";
import {
  PipedriveApiError,
  PipedriveAuthError,
  type PipedriveClient,
  type PipedriveDeal,
  type PipedriveDealField,
  type PipedrivePipeline,
  type PipedriveStage,
  type PipedriveUser,
} from "./crm-sync-pipedrive.js";
import type { OrganisationActor } from "./organisations.js";
import { readPipedriveDealProducts, summariseDealProducts, type MappedDealProduct } from "./pipedrive-product-import.js";
import {
  createPipelineFieldDefinition,
  listPipelineFieldDefinitions,
  updatePipelineFieldDefinition,
} from "./pipeline-fields.js";
import { pipelineService, type PipelineActor } from "./pipelines.js";

const MAX_ERROR_SAMPLES = 20;
const emptyImportCounts = () => ({ created: 0, updated: 0, skipped: 0, errors: 0 });
export const PIPEDRIVE_WON_STAGE_KEY = "won";
export const PIPEDRIVE_LOST_STAGE_KEY = "lost";

export function pipelineKeyForPipedrive(pipelineId: number | string) {
  return `pipedrive-${pipelineId}`;
}

export function stageKeyForPipedrive(stageId: number | string) {
  return `pd_${stageId}`;
}

/** The case field that lists a deal's products. */
export const PRODUCTS_FIELD_KEY = "dealProducts";

export function caseKeyForPipedriveDealId(dealId: number | string) {
  return `pipedrive-${dealId}`;
}

/** A typed field the import keeps on every Pipedrive deal case. */
export interface PipedriveFieldSpec {
  key: string;
  label: string;
  type: PipelineFieldType;
  options: string[];
  /** Reads the value from a v1 deal. */
  read: (deal: PipedriveDeal) => unknown;
}

type Lookups = {
  users: Map<string, string>;
  stageNames: Map<string, string>;
  /** Each deal's products as one readable block, by Pipedrive deal id. */
  productSummaries?: Map<string, string>;
};

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

/** "2026-03-04 10:00:00" or "2026-03-04" -> "2026-03-04". */
function day(value: unknown): string | null {
  const text = str(value);
  const match = text ? /^(\d{4}-\d{2}-\d{2})/.exec(text) : null;
  return match ? match[1]! : null;
}

/** Name of a linked user, person or organisation, which v1 answers as an object or a bare id. */
function linkedName(value: unknown, byId?: Map<string, string>): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const name = str(record.name);
    if (name) return name;
    const id = str(record.value ?? record.id);
    return id ? byId?.get(id) ?? id : null;
  }
  const id = str(value);
  return id ? byId?.get(id) ?? id : null;
}

export function linkedId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return str(record.value ?? record.id);
  }
  return str(value);
}

function optionLabels(field: PipedriveDealField | undefined) {
  return new Map((field?.options ?? []).map((option) => [String(option.id), option.label.trim().slice(0, 200)]));
}

function choiceIds(raw: unknown): string[] {
  if (raw === null || raw === undefined || raw === "") return [];
  if (Array.isArray(raw)) return raw.map((item) => String(item).trim()).filter(Boolean);
  return String(raw).split(",").map((item) => item.trim()).filter(Boolean);
}

function choiceLabels(raw: unknown, labels: Map<string, string>) {
  return [...new Set(choiceIds(raw).map((id) => labels.get(id) ?? id))];
}

function uniqueLabels(field: PipedriveDealField | undefined) {
  return [...new Set([...optionLabels(field).values()].filter(Boolean))];
}

/** Custom fields have a 40-character hex key. */
export function isPipedriveCustomKey(key: string) {
  return /^[0-9a-f]{40}$/.test(key);
}

/** GSAM key of a Pipedrive custom field. Stable, so a rerun finds the same field. */
export function gsamKeyForCustomField(pipedriveKey: string) {
  return `pd_${pipedriveKey}`;
}

/**
 * The typed fields of a Pipedrive deal case: Pipedrive's own deal fields
 * first, then one per custom deal field, in Pipedrive's order.
 */
export function pipedriveDealFieldSpecs(dealFields: PipedriveDealField[], lookups: Lookups): PipedriveFieldSpec[] {
  const byKey = new Map(dealFields.map((field) => [field.key, field]));
  const labelOptions = optionLabels(byKey.get("label"));
  const channelOptions = optionLabels(byKey.get("channel"));
  const labelOf = (key: string, fallback: string) => byKey.get(key)?.name?.trim() || fallback;

  const specs: PipedriveFieldSpec[] = [
    { key: "pipedriveDealId", label: "Pipedrive deal id", type: "text", options: [], read: (deal) => String(deal.id) },
    {
      key: "dealStatus",
      label: "Deal status",
      type: "select",
      options: ["Open", "Won", "Lost"],
      read: (deal) => ({ open: "Open", won: "Won", lost: "Lost" } as Record<string, string>)[String(deal.status)] ?? null,
    },
    { key: "pipedriveStage", label: "Pipedrive stage", type: "text", options: [], read: (deal) => lookups.stageNames.get(String(deal.stage_id)) ?? null },
    { key: "dealValue", label: labelOf("value", "Value"), type: "number", options: [], read: (deal) => num(deal.value) },
    { key: "dealCurrency", label: labelOf("currency", "Currency"), type: "text", options: [], read: (deal) => str(deal.currency) },
    { key: "dealOwner", label: labelOf("user_id", "Owner"), type: "text", options: [], read: (deal) => linkedName(deal.user_id, lookups.users) },
    { key: "contactPerson", label: labelOf("person_id", "Contact person"), type: "text", options: [], read: (deal) => linkedName(deal.person_id) },
    { key: "pipedriveOrganisation", label: labelOf("org_id", "Organisation"), type: "text", options: [], read: (deal) => linkedName(deal.org_id) },
    { key: "expectedCloseDate", label: labelOf("expected_close_date", "Expected close date"), type: "date", options: [], read: (deal) => day(deal.expected_close_date) },
    { key: "probability", label: labelOf("probability", "Probability"), type: "number", options: [], read: (deal) => num(deal.probability) },
    { key: "lostReason", label: labelOf("lost_reason", "Lost reason"), type: "long_text", options: [], read: (deal) => str(deal.lost_reason) },
    {
      key: "dealLabels",
      label: labelOf("label", "Label"),
      type: "multi_select",
      options: uniqueLabels(byKey.get("label")),
      read: (deal) => choiceLabels(deal.label, labelOptions),
    },
    { key: "sourceOrigin", label: labelOf("origin", "Source origin"), type: "text", options: [], read: (deal) => str(deal.origin) },
    {
      key: "sourceChannel",
      label: labelOf("channel", "Source channel"),
      type: "text",
      options: [],
      read: (deal) => {
        const id = str(deal.channel);
        return id ? channelOptions.get(id) ?? id : null;
      },
    },
    { key: "sourceChannelId", label: labelOf("channel_id", "Source channel id"), type: "text", options: [], read: (deal) => str(deal.channel_id) },
    { key: "addedOn", label: labelOf("add_time", "Deal created"), type: "date", options: [], read: (deal) => day(deal.add_time) },
    { key: "stageChangedOn", label: labelOf("stage_change_time", "Last stage change"), type: "date", options: [], read: (deal) => day(deal.stage_change_time) },
    { key: "wonOn", label: labelOf("won_time", "Won time"), type: "date", options: [], read: (deal) => day(deal.won_time) },
    { key: "lostOn", label: labelOf("lost_time", "Lost time"), type: "date", options: [], read: (deal) => day(deal.lost_time) },
    { key: "closedOn", label: labelOf("close_time", "Deal closed on"), type: "date", options: [], read: (deal) => day(deal.close_time) },
    { key: "nextActivityDate", label: labelOf("next_activity_date", "Next activity date"), type: "date", options: [], read: (deal) => day(deal.next_activity_date) },
    { key: "lastActivityDate", label: labelOf("last_activity_date", "Last activity date"), type: "date", options: [], read: (deal) => day(deal.last_activity_date) },
    { key: "pipedriveUpdatedOn", label: labelOf("update_time", "Update time"), type: "date", options: [], read: (deal) => day(deal.update_time) },
    {
      key: PRODUCTS_FIELD_KEY,
      label: labelOf("products_count", "Products"),
      type: "long_text",
      options: [],
      read: (deal) => lookups.productSummaries?.get(String(deal.id)) ?? null,
    },
  ];

  for (const field of dealFields) {
    if (!isPipedriveCustomKey(field.key)) continue;
    const key = gsamKeyForCustomField(field.key);
    const label = field.name?.trim() || field.key;
    const labels = optionLabels(field);
    const read = (deal: PipedriveDeal) => deal[field.key] ?? (deal.custom_fields as Record<string, unknown> | undefined)?.[field.key];
    switch (field.field_type) {
      case "double":
      case "int":
        specs.push({ key, label, type: "number", options: [], read: (deal) => num(read(deal)) });
        break;
      case "monetary":
        specs.push({ key, label, type: "number", options: [], read: (deal) => {
          const raw = read(deal);
          return num(raw && typeof raw === "object" ? (raw as Record<string, unknown>).value : raw);
        } });
        specs.push({ key: `${key}_currency`, label: `${label} currency`, type: "text", options: [], read: (deal) => {
          const raw = read(deal);
          return str(raw && typeof raw === "object" ? (raw as Record<string, unknown>).currency : deal[`${field.key}_currency`]);
        } });
        break;
      case "date":
        specs.push({ key, label, type: "date", options: [], read: (deal) => day(read(deal)) });
        break;
      case "enum":
        specs.push({ key, label, type: "select", options: uniqueLabels(field), read: (deal) => choiceLabels(read(deal), labels)[0] ?? null });
        break;
      case "set":
        specs.push({ key, label, type: "multi_select", options: uniqueLabels(field), read: (deal) => choiceLabels(read(deal), labels) });
        break;
      case "user":
        specs.push({ key, label, type: "text", options: [], read: (deal) => linkedName(read(deal), lookups.users) });
        break;
      case "org":
      case "people":
        specs.push({ key, label, type: "text", options: [], read: (deal) => linkedName(read(deal)) });
        break;
      case "daterange":
      case "timerange":
        specs.push({ key, label, type: "text", options: [], read: (deal) => {
          const from = str(read(deal));
          const until = str(deal[`${field.key}_until`]);
          return from && until ? `${from} to ${until}` : from;
        } });
        break;
      default:
        // varchar, varchar_auto, text, phone, address, time and anything new.
        specs.push({ key, label, type: "long_text", options: [], read: (deal) => {
          const raw = read(deal);
          if (raw && typeof raw === "object") return linkedName(raw) ?? str((raw as Record<string, unknown>).formatted_address);
          return str(raw);
        } });
    }
  }
  return specs;
}

/**
 * Turns a read value into one the GSAM field accepts. Text is cut to the
 * field's limit; a choice Pipedrive no longer lists is returned in `missing`
 * so the caller can add it rather than drop it.
 */
export function coerceForField(
  def: { type: string; options: string[] },
  raw: unknown,
): { value: unknown; missing: string[] } {
  if (isEmptyPipelineFieldValue(raw)) return { value: null, missing: [] };
  const type = def.type as PipelineFieldType;
  let value: unknown = raw;
  if (type === "text" || type === "long_text") {
    const text = typeof raw === "string" ? raw : String(raw);
    value = text.slice(0, type === "text" ? PIPELINE_FIELD_TEXT_MAX : PIPELINE_FIELD_LONG_TEXT_MAX);
  } else if (type === "multi_select") {
    value = Array.isArray(raw) ? [...new Set(raw.map(String))] : [String(raw)];
    return { value, missing: (value as string[]).filter((item) => !def.options.includes(item)) };
  } else if (type === "select") {
    value = String(raw);
    return { value, missing: def.options.includes(value as string) ? [] : [value as string] };
  }
  return checkPipelineFieldValue({ type, options: def.options }, value).ok ? { value, missing: [] } : { value: null, missing: [] };
}

/** Same keys and values, whatever order jsonb hands the keys back in. */
function sameFields(a: Record<string, unknown>, b: Record<string, unknown>) {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => key in b && JSON.stringify(a[key] ?? null) === JSON.stringify(b[key] ?? null));
}

type DealImportResult = Required<Pick<OrganisationImportResult, "deals" | "pipelines">> & {
  /** GSAM case id of every imported deal, by Pipedrive deal id, so activities and notes can link to it. */
  caseIdByDealId: Map<string, string>;
  /** The products on each deal whose products could be read, by Pipedrive deal id. */
  lineItemsByDealId: Map<string, MappedDealProduct[]>;
};

/**
 * Imports every Pipedrive pipeline, stage and deal for one company. Callers
 * pass the organisation rows already imported, by Pipedrive id, so deals link
 * to them. Counts and errors go into `result`.
 */
export function pipedriveDealImportService(db: Db) {
  const pipelines = pipelineService(db);

  return {
    async run(input: {
      companyId: string;
      client: PipedriveClient;
      actor: OrganisationActor;
      organisationIdByExternalId: Map<string, string>;
      result: OrganisationImportResult;
    }): Promise<DealImportResult> {
      const { companyId, client, result } = input;
      const counts: DealImportResult = { deals: emptyImportCounts(), pipelines: emptyImportCounts(), caseIdByDealId: new Map(), lineItemsByDealId: new Map() };
      result.deals = counts.deals;
      result.pipelines = counts.pipelines;
      const pushError = (kind: "deal" | "pipeline" | "product", externalId: string, error: unknown) => {
        if (result.errorSamples.length < MAX_ERROR_SAMPLES) {
          result.errorSamples.push({ kind, externalId, message: error instanceof Error ? error.message : String(error) });
        }
      };
      const actor: PipelineActor = input.actor.userId ? { type: "user", userId: input.actor.userId } : { type: "system" };

      const [pdPipelines, pdStages, users, dealFields] = await Promise.all([
        client.listPipelines(),
        client.listStages(),
        // Owner names also come on each deal, so a token that may not list users still imports.
        client.listUsers().catch(() => [] as PipedriveUser[]),
        client.listDealFields(),
      ]);
      const lookups: Lookups = {
        users: new Map(users.map((user: PipedriveUser) => [String(user.id), user.name?.trim() || user.email || String(user.id)])),
        stageNames: new Map(pdStages.map((stage: PipedriveStage) => [String(stage.id), stage.name?.trim() || String(stage.id)])),
        productSummaries: new Map(),
      };
      let canReadDealProducts = true;
      const specs = pipedriveDealFieldSpecs(dealFields, lookups);

      // Pipeline and field set-up, one Pipedrive pipeline at a time.
      const gsamPipelineByPdId = new Map<string, string>();
      const defsByPipeline = new Map<string, Map<string, { id: string; type: string; options: string[] }>>();
      for (const pdPipeline of [...pdPipelines].sort((a, b) => (a.order_nr ?? 0) - (b.order_nr ?? 0))) {
        try {
          const stages = pdStages.filter((stage) => stage.pipeline_id === pdPipeline.id);
          const pipelineId = await this.ensurePipeline(companyId, pdPipeline, stages, actor, counts.pipelines);
          gsamPipelineByPdId.set(String(pdPipeline.id), pipelineId);
          defsByPipeline.set(pipelineId, await this.ensureFields(companyId, pipelineId, specs, actor));
        } catch (error) {
          counts.pipelines.errors += 1;
          pushError("pipeline", String(pdPipeline.id), error);
        }
      }
      const gsamPipelineIds = [...gsamPipelineByPdId.values()];

      // Existing deal cases in any Pipedrive pipeline, so a rerun updates them.
      const existing = gsamPipelineIds.length === 0
        ? []
        : await db
          .select()
          .from(pipelineCases)
          .where(and(
            eq(pipelineCases.companyId, companyId),
            inArray(pipelineCases.pipelineId, gsamPipelineIds),
            like(pipelineCases.caseKey, "pipedrive-%"),
          ));
      const caseByKey = new Map(existing.filter((row) => !row.retiredAt).map((row) => [row.caseKey, row]));
      const stageKeyById = new Map<string, string>();
      if (gsamPipelineIds.length > 0) {
        const rows = await db.select().from(pipelineStages).where(inArray(pipelineStages.pipelineId, gsamPipelineIds));
        for (const row of rows) stageKeyById.set(row.id, row.key);
      }

      let start: number | null = 0;
      while (start !== null) {
        const page: Awaited<ReturnType<PipedriveClient["listAllDealsPage"]>> = await client.listAllDealsPage({ start });
        for (const deal of page.items) {
          const externalId = String(deal.id);
          try {
            const pipelineId = gsamPipelineByPdId.get(String(deal.pipeline_id));
            const defs = pipelineId ? defsByPipeline.get(pipelineId) : undefined;
            if (!pipelineId || !defs) {
              counts.deals.skipped += 1;
              continue;
            }
            const title = (str(deal.title) ?? `Pipedrive deal ${externalId}`).slice(0, 500);
            const stageKey = deal.status === "won"
              ? PIPEDRIVE_WON_STAGE_KEY
              : deal.status === "lost"
                ? PIPEDRIVE_LOST_STAGE_KEY
                : stageKeyForPipedrive(String(deal.stage_id));
            // Products on the deal, read only for deals that have some.
            let productsKnown = false;
            const productCount = num(deal.products_count);
            if (productCount === 0) {
              counts.lineItemsByDealId.set(externalId, []);
              productsKnown = true;
            } else if (productCount !== null && canReadDealProducts) {
              try {
                const items = await readPipedriveDealProducts(client, externalId);
                counts.lineItemsByDealId.set(externalId, items);
                const summary = summariseDealProducts(items);
                if (summary) lookups.productSummaries!.set(externalId, summary);
                productsKnown = true;
              } catch (error) {
                if (!(error instanceof PipedriveAuthError || error instanceof PipedriveApiError)) throw error;
                // The token cannot read deal products at all; stop asking for every deal.
                if (error instanceof PipedriveAuthError) canReadDealProducts = false;
                pushError("product", externalId, new Error(`Could not read the deal's products: ${error.message}`));
              }
            }
            const fields = await this.dealFields(companyId, deal, specs, defs);
            // Products that could not be read keep what the case had.
            if (!productsKnown) delete fields[PRODUCTS_FIELD_KEY];
            const orgExternalId = linkedId(deal.org_id);
            const organisationId = orgExternalId ? input.organisationIdByExternalId.get(orgExternalId) ?? null : null;
            const caseKey = caseKeyForPipedriveDealId(externalId);
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
              counts.deals.created += 1;
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
            if (row.pipelineId !== pipelineId) {
              pushError("deal", externalId, new Error("moved to another pipeline in Pipedrive; its fields are updated where it is"));
            } else if (stageKeyById.get(row.stageId) !== stageKey) {
              const moved = await pipelines.transitionCase({
                companyId,
                caseId: row.id,
                toStageKey: stageKey,
                expectedVersion: row.version,
                actor,
                force: true,
                skipChildrenTerminalGate: true,
                reason: "Moved in Pipedrive",
              });
              row = moved.case;
              changed = true;
            }
            caseByKey.set(caseKey, row);
            if (changed) counts.deals.updated += 1;
            else counts.deals.skipped += 1;
          } catch (error) {
            counts.deals.errors += 1;
            pushError("deal", externalId, error);
          }
        }
        start = page.nextStart;
      }
      for (const [caseKey, row] of caseByKey) counts.caseIdByDealId.set(caseKey.slice("pipedrive-".length), row.id);
      return counts;
    },

    /** Creates the GSAM pipeline for one Pipedrive pipeline, or brings its name and stages up to date. */
    async ensurePipeline(
      companyId: string,
      pdPipeline: PipedrivePipeline,
      pdStages: PipedriveStage[],
      actor: PipelineActor,
      counts: ReturnType<typeof emptyImportCounts>,
    ) {
      const key = pipelineKeyForPipedrive(pdPipeline.id);
      const name = (str(pdPipeline.name) ?? `Pipedrive pipeline ${pdPipeline.id}`).slice(0, 200);
      const ordered = [...pdStages].sort((a, b) => (a.order_nr ?? 0) - (b.order_nr ?? 0));
      const wanted = [
        ...ordered.map((stage, index) => ({
          key: stageKeyForPipedrive(stage.id),
          name: (str(stage.name) ?? `Stage ${stage.id}`).slice(0, 200),
          kind: "working" as const,
          position: (index + 1) * 100,
        })),
        { key: PIPEDRIVE_WON_STAGE_KEY, name: "Won", kind: "done" as const, position: (ordered.length + 1) * 100 },
        { key: PIPEDRIVE_LOST_STAGE_KEY, name: "Lost", kind: "cancelled" as const, position: (ordered.length + 2) * 100 },
      ];
      const description = "Imported from Pipedrive. Stages follow Pipedrive; Won and Lost hold closed deals.";

      const found = await db
        .select()
        .from(pipelinesTable)
        .where(and(eq(pipelinesTable.companyId, companyId), eq(pipelinesTable.key, key)))
        .then((rows) => rows[0] ?? null);
      if (!found) {
        const created = await pipelines.createPipeline({ companyId, key, name, description, stages: wanted, actor });
        counts.created += 1;
        return created.id;
      }

      let changed = false;
      if (found.name !== name) {
        await db.update(pipelinesTable).set({ name, updatedAt: new Date() })
          .where(and(eq(pipelinesTable.companyId, companyId), eq(pipelinesTable.id, found.id)));
        changed = true;
      }
      const existingStages = await pipelines.listStages(companyId, found.id);
      const byKey = new Map(existingStages.map((stage) => [stage.key, stage]));
      for (const stage of wanted) {
        const current = byKey.get(stage.key);
        if (!current) {
          // New Pipedrive stages go just before Won, so closed stages stay last.
          const won = byKey.get(PIPEDRIVE_WON_STAGE_KEY);
          await pipelines.createStage({
            companyId,
            pipelineId: found.id,
            key: stage.key,
            name: stage.name,
            kind: stage.kind,
            position: stage.kind === "working" && won ? won.position : stage.position,
            actor,
          });
          changed = true;
        } else if (current.name !== stage.name) {
          await db.update(pipelineStages).set({ name: stage.name, updatedAt: new Date() }).where(eq(pipelineStages.id, current.id));
          changed = true;
        }
      }
      if (changed) counts.updated += 1;
      else counts.skipped += 1;
      return found.id;
    },

    /** Makes sure every field spec has a definition, keeping choices Pipedrive added. */
    async ensureFields(companyId: string, pipelineId: string, specs: PipedriveFieldSpec[], actor: PipelineActor) {
      const rows = await listPipelineFieldDefinitions(db, { companyId, pipelineId, includeArchived: true });
      const byKey = new Map(rows.map((row) => [row.key, row]));
      const out = new Map<string, { id: string; type: string; options: string[] }>();
      let position = rows.reduce((max, row) => Math.max(max, row.position), -1) + 1;
      for (const spec of specs) {
        const row = byKey.get(spec.key);
        // A choice field needs at least one choice; with none, keep the value as text.
        const type = (spec.type === "select" || spec.type === "multi_select") && spec.options.length === 0 ? "text" : spec.type;
        const fieldActor = actor.type === "user" ? actor : { type: "system" as const };
        if (!row) {
          const created = await createPipelineFieldDefinition(db, {
            companyId,
            pipelineId,
            field: { key: spec.key, label: spec.label.slice(0, 200), type, required: false, options: type === spec.type ? spec.options : [], position },
            actor: fieldActor,
          });
          position += 1;
          out.set(spec.key, { id: created.id, type: created.type, options: created.options });
          continue;
        }
        const patch: { label?: string; options?: string[]; archived?: boolean } = {};
        const label = spec.label.slice(0, 200);
        if (row.label !== label) patch.label = label;
        if ((row.type === "select" || row.type === "multi_select") && spec.options.some((option) => !row.options.includes(option))) {
          patch.options = [...row.options, ...spec.options.filter((option) => !row.options.includes(option))];
        }
        if (row.archivedAt) patch.archived = false;
        if (Object.keys(patch).length > 0) {
          const { after } = await updatePipelineFieldDefinition(db, { companyId, pipelineId, fieldId: row.id, patch });
          out.set(spec.key, { id: after.id, type: after.type, options: after.options });
        } else {
          out.set(spec.key, { id: row.id, type: row.type, options: row.options });
        }
      }
      return out;
    },

    /** One deal's field values, typed for the pipeline. A choice Pipedrive no longer lists is added. */
    async dealFields(
      companyId: string,
      deal: PipedriveDeal,
      specs: PipedriveFieldSpec[],
      defs: Map<string, { id: string; type: string; options: string[] }>,
    ) {
      const fields: Record<string, unknown> = {};
      for (const spec of specs) {
        const def = defs.get(spec.key);
        if (!def) continue;
        const { value, missing } = coerceForField(def, spec.read(deal));
        if (missing.length > 0) {
          const options = [...def.options, ...missing.filter((item) => !def.options.includes(item))];
          await db.update(pipelineFieldDefinitions).set({ options, updatedAt: new Date() })
            .where(and(eq(pipelineFieldDefinitions.companyId, companyId), eq(pipelineFieldDefinitions.id, def.id)));
          def.options = options;
        }
        fields[spec.key] = value;
      }
      return fields;
    },
  };
}
