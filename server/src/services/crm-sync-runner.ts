// CRM sync passes and the poll scheduler (GRE-1100 part 2, write-back GRE-1076).
// Contract: doc/CRM-SYNC-CONTRACT.md. One pass reads the deals Pipedrive
// changed since the last pass and imports them into cases through the
// binding's field map and stage map. It then writes GSAM changes back: fields
// the three-value rule pushes, and values a person chose in the "Sync
// conflicts" queue. Each record gets one inbound and at most one outbound log
// line per pass. This runner is the only code that writes to Pipedrive.
import { and, asc, desc, eq, gt, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import {
  crmSyncBindings,
  crmSyncConflicts,
  crmSyncEvents,
  crmSyncFieldMaps,
  crmSyncRecordLinks,
  pipelineCaseEvents,
  pipelineCases,
  pipelineFieldDefinitions,
  pipelineStages,
  toolConnections,
} from "@greatstone/db";
import {
  coerceCrmSyncFieldValue,
  crmSyncValuesEqual,
  decideCrmSyncField,
  type CrmSyncChangeAuthor,
  type CrmSyncChangedField,
  type CrmSyncEventAction,
  type CrmSyncFieldOwner,
  type CrmSyncFieldValue,
  type PipelineFieldType,
} from "@greatstone/shared";
import { logger } from "../middleware/logger.js";
import {
  buildPipedriveDealPatch,
  createPipedriveClient,
  flattenPipedriveDeal,
  PIPEDRIVE_PROVIDER_KEY,
  PipedriveAuthError,
  PipedriveRateLimitError,
  PipedriveValueError,
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
/** Cases changed in GSAM that one pass writes back, oldest change first. */
const OUTBOUND_BATCH_SIZE = 50;
const SYNC_ACTOR = { type: "system" } as const;

type BindingRow = typeof crmSyncBindings.$inferSelect;
type ConnectionRow = typeof toolConnections.$inferSelect;
type CaseRow = typeof pipelineCases.$inferSelect;
type FieldMapRow = typeof crmSyncFieldMaps.$inferSelect;
type LinkRow = typeof crmSyncRecordLinks.$inferSelect;
type ConflictRow = typeof crmSyncConflicts.$inferSelect;

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
    direction?: "inbound" | "outbound";
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
      direction: input.direction ?? "inbound",
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
    client: PipedriveClient;
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
      values.set(row.gsamField, coerceCrmSyncFieldValue(flat[row.externalField] ?? null, type));
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

  /**
   * Who changed the case in GSAM since the last sync, newest first. Case
   * events do not say which field changed, so this names everyone who edited
   * the case content in that window. The sync's own edits are not counted.
   */
  async function gsamAuthorsSince(binding: BindingRow, caseId: string, since: Date | null) {
    const rows = await db
      .select({
        actorType: pipelineCaseEvents.actorType,
        actorUserId: pipelineCaseEvents.actorUserId,
        actorAgentId: pipelineCaseEvents.actorAgentId,
        createdAt: pipelineCaseEvents.createdAt,
      })
      .from(pipelineCaseEvents)
      .where(and(
        eq(pipelineCaseEvents.companyId, binding.companyId),
        eq(pipelineCaseEvents.caseId, caseId),
        eq(pipelineCaseEvents.type, "updated"),
        ne(pipelineCaseEvents.actorType, "system"),
        sql`coalesce((${pipelineCaseEvents.payload} ->> 'materialChanged')::boolean, true)`,
        ...(since ? [gt(pipelineCaseEvents.createdAt, since)] : []),
      ))
      .orderBy(desc(pipelineCaseEvents.createdAt))
      .limit(50);
    const authors: CrmSyncChangeAuthor[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const author: CrmSyncChangeAuthor | null = row.actorType === "user" && row.actorUserId
        ? { actorType: "user", userId: row.actorUserId }
        : row.actorType === "agent" && row.actorAgentId
          ? { actorType: "agent", agentId: row.actorAgentId }
          : null;
      if (!author) continue;
      const key = author.actorType === "user" ? `user:${author.userId}` : `agent:${author.agentId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      authors.push(author);
    }
    return { authors, at: rows[0]?.createdAt ?? null };
  }

  function dealUpdatedAt(deal: PipedriveDeal) {
    if (!deal.update_time) return null;
    const at = new Date(deal.update_time);
    return Number.isNaN(at.getTime()) ? null : at;
  }

  /**
   * A deal already linked to a case: apply the three-value rule field by
   * field, then write GSAM changes back to the deal. A field held in the
   * "Sync conflicts" queue (open conflict or suggestion) is skipped both ways;
   * other fields keep syncing.
   */
  async function syncLinkedDeal(ctx: PassContext, deal: PipedriveDeal, externalId: string, link: LinkRow) {
    const { binding } = ctx;
    const allowPull = binding.direction !== "outbound_only";
    const allowPush = binding.direction !== "inbound_only";
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
      // Resolved since this record last synced: the chosen value goes to both sides now.
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

    const hasBase = (field: string) => Object.prototype.hasOwnProperty.call(link.lastSyncedValues, field);
    const lastSynced: Record<string, CrmSyncFieldValue> = { ...link.lastSyncedValues };
    const changed: CrmSyncChangedField[] = [];
    const content: { title?: string; summary?: string | null; fields: Record<string, unknown> } = { fields: {} };
    const conflictIds: string[] = [];
    const pushes: Array<{ row: FieldMapRow; from: CrmSyncFieldValue; value: CrmSyncFieldValue; conflict: ConflictRow | null }> = [];
    let gsamChange: Awaited<ReturnType<typeof gsamAuthorsSince>> | null = null;
    let blocked = 0;

    for (const row of ctx.fieldRows) {
      const field = row.gsamField;
      if (openConflicts.has(field)) continue; // held until a person decides
      const crmValue = crm.get(field) ?? null;
      const gsamValue = readCaseValue(caseRow, field);
      const resolved = resolvedConflicts.get(field);
      // A rejected suggestion changes nothing: the field syncs as usual.
      const rejectedSuggestion = resolved?.kind === "suggestion" && resolved.resolution === "keep_crm";
      if (resolved?.resolvedValue && !rejectedSuggestion) {
        const target = resolved.resolvedValue.value;
        if (!crmSyncValuesEqual(target, gsamValue)) {
          applyContent(content, field, target);
          changed.push({ gsamField: field, from: gsamValue, to: target });
        }
        if (crmSyncValuesEqual(target, crmValue)) {
          lastSynced[field] = target;
        } else if (allowPush) {
          pushes.push({ row, from: crmValue, value: target, conflict: resolved });
        } else {
          // Inbound-only: the CRM keeps its value. With it as the base, the
          // next pass treats the chosen value as a GSAM change.
          lastSynced[field] = crmValue;
          blocked += 1;
        }
        continue;
      }
      const decision = decideCrmSyncField({
        owner: row.owner as CrmSyncFieldOwner,
        lastSynced: hasBase(field) ? link.lastSyncedValues[field] : undefined,
        crm: crmValue,
        gsam: gsamValue,
      });
      if (decision.action === "none") {
        lastSynced[field] = decision.value;
      } else if (decision.action === "pull_from_crm") {
        if (!allowPull) {
          blocked += 1;
          continue;
        }
        applyContent(content, field, decision.value);
        lastSynced[field] = decision.value;
        changed.push({ gsamField: field, from: gsamValue, to: decision.value });
      } else if (decision.action === "push_to_crm") {
        // Never blank a CRM value for a field that has not synced yet (a new link).
        if (!hasBase(field) && crmSyncValuesEqual(decision.value, null)) continue;
        if (allowPush) pushes.push({ row, from: crmValue, value: decision.value, conflict: null });
        else blocked += 1;
      } else {
        gsamChange ??= await gsamAuthorsSince(binding, caseRow.id, link.lastSyncedAt);
        const previous = hasBase(field) ? link.lastSyncedValues[field] : undefined;
        const [created] = await db.insert(crmSyncConflicts).values({
          companyId: binding.companyId,
          bindingId: binding.id,
          kind: "conflict",
          entityKind: "case",
          entityId: caseRow.id,
          externalId,
          gsamField: field,
          externalField: row.externalField,
          lastSyncedValue: previous === undefined ? null : { value: previous },
          crmValue: { value: crmValue },
          gsamValue: { value: gsamValue },
          crmChangedAt: dealUpdatedAt(deal),
          gsamChangedBy: gsamChange.authors,
          gsamChangedAt: gsamChange.at,
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
        pushes.length = 0;
        for (const row of ctx.fieldRows) {
          if (hasBase(row.gsamField)) {
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
    if (!failure && allowPull && crmStageKey && lastSynced.stage !== crmStageKey) {
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

    // Write-back. On a passing error the link keeps its last sync time, so the
    // next pass finds the case again and retries.
    let pushed: CrmSyncChangedField[] = [];
    let pushFailure: string | null = null;
    let retryPush = false;
    let pushError: unknown = null;
    if (pushes.length > 0) {
      try {
        const patch = buildPipedriveDealPatch(
          pushes.map((push) => ({ externalField: push.row.externalField, value: push.value })),
          ctx.dealFields,
        );
        await ctx.client.updateDeal(externalId, patch);
        for (const push of pushes) lastSynced[push.row.gsamField] = push.value;
        pushed = pushes.map((push) => ({ gsamField: push.row.gsamField, from: push.from, to: push.value }));
      } catch (error) {
        pushError = error;
        retryPush = !(error instanceof PipedriveValueError);
        pushFailure = `Could not write to Pipedrive: ${errorMessage(error)}.${retryPush ? " It is tried again on the next pass." : " Fix the value in GSAM or the field map."}`;
      }
    }

    await db
      .update(crmSyncRecordLinks)
      .set({
        lastSyncedValues: lastSynced,
        ...(retryPush ? {} : { lastSyncedAt: now() }),
        updatedAt: now(),
      })
      .where(eq(crmSyncRecordLinks.id, link.id));

    let wrote = false;
    if (failure) {
      await writeEvent(binding, { action: "failed", entityId: caseRow.id, externalId, changedFields: changed, errorMessage: failure });
      wrote = true;
    } else if (conflictIds.length > 0) {
      await writeEvent(binding, { action: "conflict", entityId: caseRow.id, externalId, changedFields: changed, conflictId: conflictIds[0] });
      wrote = true;
    } else if (changed.length > 0) {
      await writeEvent(binding, { action: "updated", entityId: caseRow.id, externalId, changedFields: changed });
      wrote = true;
    } else if (blocked > 0) {
      await writeEvent(binding, { action: "unchanged", entityId: caseRow.id, externalId });
      wrote = true;
    }
    if (pushes.length > 0) {
      const conflictId = pushes.find((push) => push.conflict)?.conflict?.id ?? null;
      await writeEvent(binding, pushFailure
        ? {
          direction: "outbound",
          action: "failed",
          entityId: caseRow.id,
          externalId,
          changedFields: pushes.map((push) => ({ gsamField: push.row.gsamField, from: push.from, to: push.value })),
          conflictId,
          errorMessage: pushFailure,
        }
        : { direction: "outbound", action: "updated", entityId: caseRow.id, externalId, changedFields: pushed, conflictId });
      wrote = true;
    }
    // The pass stops on a rate limit or a refused credential.
    if (pushError instanceof PipedriveRateLimitError || pushError instanceof PipedriveAuthError) throw pushError;
    return wrote;
  }

  async function syncDeal(ctx: PassContext, deal: PipedriveDeal) {
    const externalId = String(deal.id);
    try {
      const link = await findLink(ctx.binding, externalId);
      return link ? await syncLinkedDeal(ctx, deal, externalId, link) : await importNewDeal(ctx, deal, externalId);
    } catch (error) {
      if (error instanceof PipedriveRateLimitError || error instanceof PipedriveAuthError) throw error;
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
      client,
      fieldRows: caseFieldRows(fieldRows),
      fieldTypes: new Map(definitions.map((row) => [row.key, row.type as PipelineFieldType])),
      stageKeyByExternalId: new Map(binding.stageMap.map((entry) => [entry.externalStageId, entry.stageKey])),
      stageKeyById: new Map(stages.map((row) => [row.id, row.key])),
      dealFields,
    };
  }

  /** Linked cases with something to write back. Inbound-only bindings only apply queue decisions. */
  async function pendingOutboundLinks(binding: BindingRow, skipExternalIds: Set<string>) {
    const since = sql`coalesce(${crmSyncRecordLinks.lastSyncedAt}, '-infinity'::timestamptz)`;
    const decided = sql`exists (
      select 1 from ${crmSyncConflicts}
      where ${crmSyncConflicts.bindingId} = ${binding.id}
        and ${crmSyncConflicts.entityKind} = 'case'
        and ${crmSyncConflicts.entityId} = ${crmSyncRecordLinks.entityId}
        and ${crmSyncConflicts.status} = 'resolved'
        and ${crmSyncConflicts.resolvedAt} > ${since}
    )`;
    const caseChanged = sql`${pipelineCases.updatedAt} > ${since}`;
    const rows = await db
      .select({ link: crmSyncRecordLinks })
      .from(crmSyncRecordLinks)
      .innerJoin(pipelineCases, eq(pipelineCases.id, crmSyncRecordLinks.entityId))
      .where(and(
        eq(crmSyncRecordLinks.companyId, binding.companyId),
        eq(crmSyncRecordLinks.connectionId, binding.connectionId),
        eq(crmSyncRecordLinks.entityKind, "case"),
        eq(pipelineCases.companyId, binding.companyId),
        eq(pipelineCases.pipelineId, binding.pipelineId),
        isNull(pipelineCases.retiredAt),
        binding.direction === "inbound_only" ? decided : or(caseChanged, decided),
      ))
      .orderBy(asc(pipelineCases.updatedAt))
      .limit(OUTBOUND_BATCH_SIZE);
    return rows.map((row) => row.link).filter((link) => !skipExternalIds.has(link.externalId));
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

      const seen = new Set<string>();
      let cursor: string | null = null;
      // An outbound-only binding never reads changes from Pipedrive.
      if (binding.direction !== "outbound_only") do {
        const page = await client.listDealsPage({
          pipelineId: binding.externalContainerId,
          updatedSince: state.updatedSince ?? null,
          cursor,
        });
        for (const deal of page.deals) {
          // Deals from another Pipedrive pipeline are never imported here.
          if (deal.pipeline_id != null && String(deal.pipeline_id) !== binding.externalContainerId) continue;
          if (await syncDeal(ctx, deal)) events += 1;
          seen.add(String(deal.id));
          processed += 1;
          if (deal.update_time && (!state.updatedSince || deal.update_time > state.updatedSince)) {
            state.updatedSince = deal.update_time;
          }
        }
        // Keep progress after every page, so a 429 later in the pass does not redo it.
        await saveState(binding.id, { syncState: { ...state } as Record<string, unknown> });
        cursor = page.nextCursor;
      } while (cursor);

      // Outbound: cases changed in GSAM, or with a decision from the queue,
      // since they last synced. Each deal is read fresh so the three-value
      // rule compares against what Pipedrive holds now.
      for (const link of await pendingOutboundLinks(binding, seen)) {
        const deal = await client.getDeal(link.externalId);
        if (!deal) {
          await writeEvent(binding, {
            direction: "outbound",
            action: "failed",
            entityId: link.entityId,
            externalId: link.externalId,
            errorMessage: "The Pipedrive deal no longer exists, so GSAM changes were not written back",
          });
          await db.update(crmSyncRecordLinks).set({ lastSyncedAt: now(), updatedAt: now() }).where(eq(crmSyncRecordLinks.id, link.id));
          events += 1;
          continue;
        }
        if (await syncDeal(ctx, deal)) events += 1;
        processed += 1;
      }

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
