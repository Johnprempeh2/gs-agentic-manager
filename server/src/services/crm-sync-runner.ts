// CRM sync passes and the poll scheduler (GRE-1100 part 2). Contract:
// doc/CRM-SYNC-CONTRACT.md. One pass reads the deals Pipedrive changed since
// the last pass and imports them into cases through the binding's field map
// and stage map. It writes one sync log line per changed record. Nothing here
// writes to Pipedrive: a field the three-value rule would push is logged as
// `unchanged`.
import { and, asc, eq, gt, isNull, lte, ne, or } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  crmSyncBindings,
  crmSyncConflicts,
  crmSyncEvents,
  crmSyncFieldMaps,
  crmSyncRecordLinks,
  pipelineCases,
  pipelineFieldDefinitions,
  pipelineStages,
  toolConnections,
} from "@greatstone/db";
import {
  crmSyncValuesEqual,
  decideCrmSyncField,
  type CrmSyncChangedField,
  type CrmSyncEventAction,
  type CrmSyncFieldOwner,
  type CrmSyncFieldValue,
  type PipelineFieldType,
} from "@greatstone/shared";
import { logger } from "../middleware/logger.js";
import {
  createPipedriveClient,
  flattenPipedriveDeal,
  PIPEDRIVE_PROVIDER_KEY,
  PipedriveAuthError,
  PipedriveRateLimitError,
  resolvePipedriveBaseUrl,
  type PipedriveClient,
  type PipedriveDeal,
  type PipedriveDealField,
  type PipedriveFetch,
} from "./crm-sync-pipedrive.js";
import { isEntitled } from "./entitlements.js";
import { pipelineService } from "./pipelines.js";
import { secretService } from "./secrets.js";

/** How often an active binding polls. */
export const CRM_SYNC_POLL_INTERVAL_MS = 5 * 60_000;
/** How often the scheduler looks for due bindings. */
export const CRM_SYNC_SCHEDULER_TICK_MS = 60_000;
/** A claimed pass holds the binding this long, so a crash does not strand it. */
const CLAIM_LEASE_MS = 10 * 60_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 30 * 60_000;
const MAX_ERROR_BACKOFF_MS = 60 * 60_000;
const DUE_BATCH_SIZE = 10;
const SYNC_ACTOR = { type: "system" } as const;

type BindingRow = typeof crmSyncBindings.$inferSelect;
type ConnectionRow = typeof toolConnections.$inferSelect;
type CaseRow = typeof pipelineCases.$inferSelect;
type FieldMapRow = typeof crmSyncFieldMaps.$inferSelect;
type LinkRow = typeof crmSyncRecordLinks.$inferSelect;

/** Poll state kept in `crm_sync_bindings.sync_state`. Never holds credentials. */
interface PipedriveSyncState {
  /** Newest deal `update_time` fully processed. The next pass asks for changes since then. */
  updatedSince?: string;
  rateLimitedUntil?: string;
  consecutiveFailures?: number;
}

export type CrmSyncPassResult =
  | { status: "skipped"; reason: string }
  | { status: "ok"; processed: number; events: number }
  | { status: "rate_limited"; retryAt: string; processed: number }
  | { status: "failed"; error: string; processed: number };

export interface CrmSyncRunnerDeps {
  /** Reads the connection's credential from the vault. Tests pass a stub. */
  resolveCredential?: (connection: ConnectionRow) => Promise<string>;
  fetch?: PipedriveFetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

class CredentialMissingError extends Error {}

/**
 * The connection's API token or OAuth access token, read from the company
 * vault through the connection's own secret binding.
 */
export async function resolveCrmConnectionCredential(db: Db, connection: ConnectionRow) {
  const secretRef = connection.credentialSecretRefs.find((ref) =>
    ["credentials.api_token", "credentials.apiToken", "credentials.access_token", "credentials.token"].includes(ref.configPath),
  ) ?? connection.credentialSecretRefs[0];
  const credentialRef = secretRef ? null : connection.credentialRefs[0];
  const secretId = secretRef?.secretId ?? credentialRef?.secretId;
  if (!secretId) throw new CredentialMissingError("The Pipedrive connection has no saved credential");
  const configPath = secretRef?.configPath ?? `credentials.${credentialRef!.name}`;
  const version = secretRef?.versionSelector ?? credentialRef?.version ?? "latest";
  const context = {
    consumerType: "tool_connection" as const,
    consumerId: connection.id,
    configPath,
    actorType: "system" as const,
  };
  return secretService(db).resolveSecretValue(connection.companyId, secretId, version, {
    bindingContext: context,
    accessContext: context,
  });
}

function minutes(ms: number) {
  return Math.max(1, Math.round(ms / 60_000));
}

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

/** A case or deal value as a plain sync value (string, number, boolean, null or list of strings). */
function asFieldValue(raw: unknown): CrmSyncFieldValue {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return raw;
  if (Array.isArray(raw)) return raw.map((item) => String(item));
  return null;
}

/** Shapes a CRM value for the typed field it lands in, so it compares and validates as that type. */
function coerceForField(value: CrmSyncFieldValue, type: PipelineFieldType | undefined): CrmSyncFieldValue {
  if (value === null || type === undefined) return value;
  switch (type) {
    case "number": {
      if (typeof value === "number") return value;
      const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
      return Number.isFinite(parsed) ? parsed : value;
    }
    case "boolean":
      if (value === "true") return true;
      if (value === "false") return false;
      return value;
    case "multi_select":
      return Array.isArray(value) ? value : [String(value)];
    case "date":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : value;
    default:
      return Array.isArray(value) ? value.join(", ") : typeof value === "string" ? value : String(value);
  }
}

function readCaseValue(row: Pick<CaseRow, "title" | "summary" | "fields">, gsamField: string): CrmSyncFieldValue {
  if (gsamField === "title") return row.title;
  if (gsamField === "summary") return row.summary;
  if (gsamField.startsWith("fields.")) return asFieldValue(row.fields[gsamField.slice("fields.".length)]);
  return null;
}

/** Field map rows this pass handles. `contact.*` rows wait for contact import (not in this slice). */
function caseFieldRows(rows: FieldMapRow[]) {
  return rows.filter((row) => row.gsamField === "title" || row.gsamField === "summary" || row.gsamField.startsWith("fields."));
}

function caseKeyForDeal(externalId: string) {
  return `pipedrive-${externalId}`;
}

export function crmSyncRunner(db: Db, deps: CrmSyncRunnerDeps = {}) {
  const now = deps.now ?? (() => new Date());
  const resolveCredential = deps.resolveCredential ?? ((connection: ConnectionRow) => resolveCrmConnectionCredential(db, connection));
  const pipelines = pipelineService(db);

  async function writeEvent(binding: BindingRow, input: {
    action: CrmSyncEventAction;
    entityId: string | null;
    externalId: string;
    changedFields?: CrmSyncChangedField[];
    conflictId?: string | null;
    errorMessage?: string | null;
  }) {
    await db.insert(crmSyncEvents).values({
      companyId: binding.companyId,
      bindingId: binding.id,
      direction: "inbound",
      action: input.action,
      entityKind: "case",
      entityId: input.entityId,
      externalId: input.externalId,
      changedFields: input.changedFields ?? [],
      conflictId: input.conflictId ?? null,
      errorMessage: input.action === "failed" ? input.errorMessage ?? "Sync failed" : null,
    });
  }

  interface PassContext {
    binding: BindingRow;
    fieldRows: FieldMapRow[];
    fieldTypes: Map<string, PipelineFieldType>;
    stageKeyByExternalId: Map<string, string>;
    stageKeyById: Map<string, string>;
    dealFields: PipedriveDealField[];
  }

  function crmValuesFor(ctx: PassContext, deal: PipedriveDeal) {
    const flat = flattenPipedriveDeal(deal, ctx.dealFields);
    const values = new Map<string, CrmSyncFieldValue>();
    for (const row of ctx.fieldRows) {
      const type = row.gsamField.startsWith("fields.") ? ctx.fieldTypes.get(row.gsamField.slice("fields.".length)) : undefined;
      values.set(row.gsamField, coerceForField(flat[row.externalField] ?? null, type));
    }
    return values;
  }

  async function findLink(binding: BindingRow, externalId: string) {
    return db
      .select()
      .from(crmSyncRecordLinks)
      .where(and(
        eq(crmSyncRecordLinks.companyId, binding.companyId),
        eq(crmSyncRecordLinks.connectionId, binding.connectionId),
        eq(crmSyncRecordLinks.entityKind, "case"),
        eq(crmSyncRecordLinks.externalId, externalId),
      ))
      .then((rows) => rows[0] ?? null);
  }

  /** A new deal: make the case through the pipeline service, then link it. */
  async function importNewDeal(ctx: PassContext, deal: PipedriveDeal, externalId: string) {
    const { binding } = ctx;
    const crm = crmValuesFor(ctx, deal);
    const changed: CrmSyncChangedField[] = [];
    const lastSynced: Record<string, CrmSyncFieldValue> = {};
    const content: { title?: string; summary?: string | null; fields: Record<string, unknown> } = { fields: {} };
    for (const row of ctx.fieldRows) {
      const decision = decideCrmSyncField({
        owner: row.owner as CrmSyncFieldOwner,
        lastSynced: undefined,
        crm: crm.get(row.gsamField) ?? null,
        gsam: null,
      });
      // A gsam-owned field would be pushed; this slice never writes to Pipedrive.
      if (decision.action === "none") lastSynced[row.gsamField] = decision.value;
      if (decision.action !== "pull_from_crm") continue;
      applyContent(content, row.gsamField, decision.value);
      lastSynced[row.gsamField] = decision.value;
      changed.push({ gsamField: row.gsamField, from: null, to: decision.value });
    }
    const stageKey = ctx.stageKeyByExternalId.get(String(deal.stage_id ?? ""));
    if (stageKey) {
      lastSynced.stage = stageKey;
      changed.push({ gsamField: "stage", from: null, to: stageKey });
    }
    const title = content.title?.trim() || (typeof deal.title === "string" && deal.title.trim()) || `Pipedrive deal ${externalId}`;

    let caseRow: CaseRow;
    try {
      const result = await pipelines.ingestCase({
        companyId: binding.companyId,
        pipelineId: binding.pipelineId,
        caseKey: caseKeyForDeal(externalId),
        title,
        summary: content.summary,
        fields: content.fields,
        stageKey: stageKey ?? null,
        actor: SYNC_ACTOR,
      });
      caseRow = result.case;
      if (!result.created) {
        // A case already holds this key. Adopt it only if no other record of this source does.
        const held = await db
          .select({ id: crmSyncRecordLinks.id })
          .from(crmSyncRecordLinks)
          .where(and(
            eq(crmSyncRecordLinks.entityKind, "case"),
            eq(crmSyncRecordLinks.entityId, caseRow.id),
            eq(crmSyncRecordLinks.connectionId, binding.connectionId),
          ))
          .then((rows) => rows[0] ?? null);
        if (held) throw new Error(`Case ${caseRow.caseKey} is already linked to another Pipedrive deal`);
      }
    } catch (error) {
      await writeEvent(binding, {
        action: "failed",
        entityId: null,
        externalId,
        errorMessage: `Could not import the deal: ${errorMessage(error)}. It is tried again when the deal changes in Pipedrive.`,
      });
      return true;
    }
    await db.insert(crmSyncRecordLinks).values({
      companyId: binding.companyId,
      entityKind: "case",
      entityId: caseRow.id,
      connectionId: binding.connectionId,
      providerKey: binding.providerKey,
      externalId,
      lastSyncedValues: lastSynced,
      lastSyncedAt: now(),
    });
    await writeEvent(binding, { action: "created", entityId: caseRow.id, externalId, changedFields: changed });
    return true;
  }

  function applyContent(
    content: { title?: string; summary?: string | null; fields: Record<string, unknown> },
    gsamField: string,
    value: CrmSyncFieldValue,
  ) {
    if (gsamField === "title") {
      if (typeof value === "string" && value.trim()) content.title = value;
    } else if (gsamField === "summary") {
      content.summary = value === null ? null : Array.isArray(value) ? value.join(", ") : String(value);
    } else if (gsamField.startsWith("fields.")) {
      content.fields[gsamField.slice("fields.".length)] = value;
    }
  }

  /** A deal already linked to a case: apply the three-value rule field by field. */
  async function syncLinkedDeal(ctx: PassContext, deal: PipedriveDeal, externalId: string, link: LinkRow) {
    const { binding } = ctx;
    const caseRow = await db
      .select()
      .from(pipelineCases)
      .where(and(eq(pipelineCases.id, link.entityId), eq(pipelineCases.companyId, binding.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!caseRow || caseRow.retiredAt || caseRow.pipelineId !== binding.pipelineId) {
      await writeEvent(binding, {
        action: "failed",
        entityId: caseRow?.id ?? null,
        externalId,
        errorMessage: "The linked case was removed or moved to another pipeline, so the deal was not synced",
      });
      return true;
    }

    const crm = crmValuesFor(ctx, deal);
    const [openConflicts, resolvedConflicts] = await Promise.all([
      db
        .select({ gsamField: crmSyncConflicts.gsamField })
        .from(crmSyncConflicts)
        .where(and(
          eq(crmSyncConflicts.bindingId, binding.id),
          eq(crmSyncConflicts.entityKind, "case"),
          eq(crmSyncConflicts.entityId, caseRow.id),
          eq(crmSyncConflicts.status, "open"),
        ))
        .then((rows) => new Set(rows.map((row) => row.gsamField))),
      // Resolved since this record last synced: the chosen value goes into GSAM now.
      db
        .select()
        .from(crmSyncConflicts)
        .where(and(
          eq(crmSyncConflicts.bindingId, binding.id),
          eq(crmSyncConflicts.entityKind, "case"),
          eq(crmSyncConflicts.entityId, caseRow.id),
          eq(crmSyncConflicts.status, "resolved"),
          ...(link.lastSyncedAt ? [gt(crmSyncConflicts.resolvedAt, link.lastSyncedAt)] : []),
        ))
        .orderBy(asc(crmSyncConflicts.resolvedAt))
        .then((rows) => new Map(rows.map((row) => [row.gsamField, row]))),
    ]);

    const lastSynced: Record<string, CrmSyncFieldValue> = { ...link.lastSyncedValues };
    const changed: CrmSyncChangedField[] = [];
    const content: { title?: string; summary?: string | null; fields: Record<string, unknown> } = { fields: {} };
    const conflictIds: string[] = [];
    let blocked = 0;

    for (const row of ctx.fieldRows) {
      const field = row.gsamField;
      if (openConflicts.has(field)) continue; // keeps its last-synced value until a person decides
      const crmValue = crm.get(field) ?? null;
      const gsamValue = readCaseValue(caseRow, field);
      const resolved = resolvedConflicts.get(field);
      if (resolved?.resolvedValue) {
        const target = resolved.resolvedValue.value;
        if (!crmSyncValuesEqual(target, gsamValue)) {
          applyContent(content, field, target);
          changed.push({ gsamField: field, from: gsamValue, to: target });
        }
        // The CRM still holds its value. With it as the base, a later write
        // slice pushes the chosen value; this read slice never does.
        lastSynced[field] = crmValue;
        if (!crmSyncValuesEqual(target, crmValue)) blocked += 1;
        continue;
      }
      const decision = decideCrmSyncField({
        owner: row.owner as CrmSyncFieldOwner,
        lastSynced: Object.prototype.hasOwnProperty.call(link.lastSyncedValues, field) ? link.lastSyncedValues[field] : undefined,
        crm: crmValue,
        gsam: gsamValue,
      });
      if (decision.action === "none") {
        lastSynced[field] = decision.value;
      } else if (decision.action === "pull_from_crm") {
        applyContent(content, field, decision.value);
        lastSynced[field] = decision.value;
        changed.push({ gsamField: field, from: gsamValue, to: decision.value });
      } else if (decision.action === "push_to_crm") {
        blocked += 1;
      } else {
        const previous = Object.prototype.hasOwnProperty.call(link.lastSyncedValues, field) ? link.lastSyncedValues[field] : undefined;
        const [created] = await db.insert(crmSyncConflicts).values({
          companyId: binding.companyId,
          bindingId: binding.id,
          entityKind: "case",
          entityId: caseRow.id,
          externalId,
          gsamField: field,
          externalField: row.externalField,
          lastSyncedValue: previous === undefined ? null : { value: previous },
          crmValue: { value: crmValue },
          gsamValue: { value: gsamValue },
        }).onConflictDoNothing().returning({ id: crmSyncConflicts.id });
        if (created) conflictIds.push(created.id);
      }
    }

    let failure: string | null = null;
    let current = caseRow;
    const hasContent = content.title !== undefined || content.summary !== undefined || Object.keys(content.fields).length > 0;
    if (hasContent) {
      try {
        current = await pipelines.patchCaseContent({
          companyId: binding.companyId,
          caseId: caseRow.id,
          ...(content.title !== undefined ? { title: content.title } : {}),
          ...(content.summary !== undefined ? { summary: content.summary } : {}),
          ...(Object.keys(content.fields).length > 0 ? { fields: { ...caseRow.fields, ...content.fields } } : {}),
          actor: SYNC_ACTOR,
        });
      } catch (error) {
        failure = `Could not update the case: ${errorMessage(error)}`;
        changed.length = 0;
        for (const row of ctx.fieldRows) {
          if (Object.prototype.hasOwnProperty.call(link.lastSyncedValues, row.gsamField)) {
            lastSynced[row.gsamField] = link.lastSyncedValues[row.gsamField]!;
          } else {
            delete lastSynced[row.gsamField];
          }
        }
      }
    }

    // Stage: move the case only when the deal's stage changed since the last sync,
    // so a stage set in GSAM is not undone by an unrelated deal edit.
    const crmStageKey = ctx.stageKeyByExternalId.get(String(deal.stage_id ?? ""));
    if (!failure && crmStageKey && lastSynced.stage !== crmStageKey) {
      const currentStageKey = ctx.stageKeyById.get(current.stageId) ?? null;
      if (currentStageKey !== crmStageKey) {
        try {
          await pipelines.transitionCase({
            companyId: binding.companyId,
            caseId: current.id,
            toStageKey: crmStageKey,
            expectedVersion: current.version,
            actor: SYNC_ACTOR,
            reason: "Stage changed in Pipedrive",
            force: true,
          });
          changed.push({ gsamField: "stage", from: currentStageKey, to: crmStageKey });
          lastSynced.stage = crmStageKey;
        } catch (error) {
          failure = `Could not move the case to stage ${crmStageKey}: ${errorMessage(error)}`;
        }
      } else {
        lastSynced.stage = crmStageKey;
      }
    }

    await db
      .update(crmSyncRecordLinks)
      .set({ lastSyncedValues: lastSynced, lastSyncedAt: now(), updatedAt: now() })
      .where(eq(crmSyncRecordLinks.id, link.id));

    if (failure) {
      await writeEvent(binding, { action: "failed", entityId: caseRow.id, externalId, changedFields: changed, errorMessage: failure });
    } else if (conflictIds.length > 0) {
      await writeEvent(binding, { action: "conflict", entityId: caseRow.id, externalId, changedFields: changed, conflictId: conflictIds[0] });
    } else if (changed.length > 0) {
      await writeEvent(binding, { action: "updated", entityId: caseRow.id, externalId, changedFields: changed });
    } else if (blocked > 0) {
      await writeEvent(binding, { action: "unchanged", entityId: caseRow.id, externalId });
    } else {
      return false; // nothing changed: no log line
    }
    return true;
  }

  async function syncDeal(ctx: PassContext, deal: PipedriveDeal) {
    const externalId = String(deal.id);
    try {
      const link = await findLink(ctx.binding, externalId);
      return link ? await syncLinkedDeal(ctx, deal, externalId, link) : await importNewDeal(ctx, deal, externalId);
    } catch (error) {
      logger.warn({ err: error, bindingId: ctx.binding.id, externalId }, "crm sync deal failed");
      await writeEvent(ctx.binding, { action: "failed", entityId: null, externalId, errorMessage: errorMessage(error) });
      return true;
    }
  }

  async function loadContext(binding: BindingRow, client: PipedriveClient): Promise<PassContext> {
    const [fieldRows, definitions, stages, dealFields] = await Promise.all([
      db
        .select()
        .from(crmSyncFieldMaps)
        .where(and(eq(crmSyncFieldMaps.bindingId, binding.id), eq(crmSyncFieldMaps.companyId, binding.companyId)))
        .orderBy(asc(crmSyncFieldMaps.position)),
      db
        .select({ key: pipelineFieldDefinitions.key, type: pipelineFieldDefinitions.type })
        .from(pipelineFieldDefinitions)
        .where(and(
          eq(pipelineFieldDefinitions.companyId, binding.companyId),
          eq(pipelineFieldDefinitions.pipelineId, binding.pipelineId),
        )),
      db
        .select({ id: pipelineStages.id, key: pipelineStages.key })
        .from(pipelineStages)
        .where(eq(pipelineStages.pipelineId, binding.pipelineId)),
      client.listDealFields(),
    ]);
    return {
      binding,
      fieldRows: caseFieldRows(fieldRows),
      fieldTypes: new Map(definitions.map((row) => [row.key, row.type as PipelineFieldType])),
      stageKeyByExternalId: new Map(binding.stageMap.map((entry) => [entry.externalStageId, entry.stageKey])),
      stageKeyById: new Map(stages.map((row) => [row.id, row.key])),
      dealFields,
    };
  }

  async function saveState(bindingId: string, values: Partial<typeof crmSyncBindings.$inferInsert>) {
    await db.update(crmSyncBindings).set({ ...values, updatedAt: now() }).where(eq(crmSyncBindings.id, bindingId));
  }

  /** Runs one inbound pass for a binding. The caller has claimed it (or is a test). */
  async function runBindingPass(bindingId: string): Promise<CrmSyncPassResult> {
    const binding = await db
      .select()
      .from(crmSyncBindings)
      .where(and(eq(crmSyncBindings.id, bindingId), isNull(crmSyncBindings.deletedAt)))
      .then((rows) => rows[0] ?? null);
    if (!binding) return { status: "skipped", reason: "binding_not_found" };
    if (binding.status !== "active") return { status: "skipped", reason: "binding_not_active" };
    if (binding.providerKey !== PIPEDRIVE_PROVIDER_KEY) return { status: "skipped", reason: "provider_not_supported" };
    if (binding.direction === "outbound_only") return { status: "skipped", reason: "outbound_only" };

    const state = { ...(binding.syncState as PipedriveSyncState) };
    let processed = 0;
    let events = 0;
    try {
      const connection = await db
        .select()
        .from(toolConnections)
        .where(and(eq(toolConnections.id, binding.connectionId), eq(toolConnections.companyId, binding.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!connection || !connection.enabled || connection.status !== "active") {
        throw new CredentialMissingError("The Pipedrive connection is missing, turned off or not active");
      }
      const token = await resolveCredential(connection);
      const client = createPipedriveClient({
        token,
        authKind: connection.authKind,
        baseUrl: resolvePipedriveBaseUrl(connection.config),
        fetch: deps.fetch,
        sleep: deps.sleep,
      });
      const ctx = await loadContext(binding, client);

      let cursor: string | null = null;
      do {
        const page = await client.listDealsPage({
          pipelineId: binding.externalContainerId,
          updatedSince: state.updatedSince ?? null,
          cursor,
        });
        for (const deal of page.deals) {
          // Deals from another Pipedrive pipeline are never imported here.
          if (deal.pipeline_id != null && String(deal.pipeline_id) !== binding.externalContainerId) continue;
          if (await syncDeal(ctx, deal)) events += 1;
          processed += 1;
          if (deal.update_time && (!state.updatedSince || deal.update_time > state.updatedSince)) {
            state.updatedSince = deal.update_time;
          }
        }
        // Keep progress after every page, so a 429 later in the pass does not redo it.
        await saveState(binding.id, { syncState: { ...state } as Record<string, unknown> });
        cursor = page.nextCursor;
      } while (cursor);

      delete state.rateLimitedUntil;
      delete state.consecutiveFailures;
      await saveState(binding.id, {
        syncState: { ...state } as Record<string, unknown>,
        lastSyncedAt: now(),
        lastErrorMessage: null,
        nextSyncAt: new Date(now().getTime() + CRM_SYNC_POLL_INTERVAL_MS),
      });
      return { status: "ok", processed, events };
    } catch (error) {
      const failures = (state.consecutiveFailures ?? 0) + 1;
      state.consecutiveFailures = failures;
      if (error instanceof PipedriveRateLimitError) {
        const backoff = Math.min(CRM_SYNC_POLL_INTERVAL_MS * 2 ** (failures - 1), MAX_RATE_LIMIT_BACKOFF_MS);
        const retryAt = new Date(now().getTime() + Math.max(error.retryAfterMs, backoff));
        state.rateLimitedUntil = retryAt.toISOString();
        await saveState(binding.id, {
          syncState: { ...state } as Record<string, unknown>,
          nextSyncAt: retryAt,
          lastErrorMessage: `Pipedrive rate limit reached. Sync retries in ${minutes(retryAt.getTime() - now().getTime())} min.`,
        });
        logger.warn({ bindingId: binding.id, retryAt }, "crm sync rate limited");
        return { status: "rate_limited", retryAt: retryAt.toISOString(), processed };
      }
      delete state.rateLimitedUntil;
      if (error instanceof PipedriveAuthError || error instanceof CredentialMissingError) {
        // A person must fix the connection; stop polling until the binding is resumed.
        await saveState(binding.id, {
          syncState: { ...state } as Record<string, unknown>,
          status: "error",
          nextSyncAt: null,
          lastErrorMessage: `${errorMessage(error)}. Reconnect Pipedrive, then resume the binding.`,
        });
        return { status: "failed", error: errorMessage(error), processed };
      }
      const backoff = Math.min(CRM_SYNC_POLL_INTERVAL_MS * 2 ** (failures - 1), MAX_ERROR_BACKOFF_MS);
      await saveState(binding.id, {
        syncState: { ...state } as Record<string, unknown>,
        nextSyncAt: new Date(now().getTime() + backoff),
        lastErrorMessage: `${errorMessage(error)}. Sync retries in ${minutes(backoff)} min.`,
      });
      logger.warn({ err: error, bindingId: binding.id }, "crm sync pass failed");
      return { status: "failed", error: errorMessage(error), processed };
    }
  }

  /** Claims a due binding by pushing its next run out; only one caller wins. */
  async function claim(bindingId: string) {
    const at = now();
    const [claimed] = await db
      .update(crmSyncBindings)
      .set({ nextSyncAt: new Date(at.getTime() + CLAIM_LEASE_MS) })
      .where(and(
        eq(crmSyncBindings.id, bindingId),
        isNull(crmSyncBindings.deletedAt),
        eq(crmSyncBindings.status, "active"),
        or(isNull(crmSyncBindings.nextSyncAt), lte(crmSyncBindings.nextSyncAt, at)),
      ))
      .returning({ id: crmSyncBindings.id });
    return Boolean(claimed);
  }

  /** One scheduler tick: runs every due Pipedrive binding, one at a time. */
  async function runDuePasses() {
    if (!(await isEntitled(db, "enablePipelines"))) return [];
    const at = now();
    const due = await db
      .select({ id: crmSyncBindings.id })
      .from(crmSyncBindings)
      .where(and(
        isNull(crmSyncBindings.deletedAt),
        eq(crmSyncBindings.status, "active"),
        eq(crmSyncBindings.providerKey, PIPEDRIVE_PROVIDER_KEY),
        ne(crmSyncBindings.direction, "outbound_only"),
        or(isNull(crmSyncBindings.nextSyncAt), lte(crmSyncBindings.nextSyncAt, at)),
      ))
      .orderBy(asc(crmSyncBindings.nextSyncAt))
      .limit(DUE_BATCH_SIZE);
    const results: Array<{ bindingId: string; result: CrmSyncPassResult }> = [];
    for (const row of due) {
      if (!(await claim(row.id))) continue;
      results.push({ bindingId: row.id, result: await runBindingPass(row.id) });
    }
    return results;
  }

  return { runBindingPass, runDuePasses };
}

/** Starts the poll timer. Returns a stop function for shutdown. */
export function startCrmSyncScheduler(db: Db, deps: CrmSyncRunnerDeps = {}) {
  const runner = crmSyncRunner(db, deps);
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    runner
      .runDuePasses()
      .catch((err) => logger.error({ err }, "crm sync scheduler tick failed"))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, CRM_SYNC_SCHEDULER_TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
