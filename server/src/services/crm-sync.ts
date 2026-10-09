// CRM sync bindings, field maps, sync log, the conflict queue and suggested
// changes (GRE-1100, GRE-1076). Contract:
// doc/CRM-SYNC-CONTRACT.md. Every read and write here is scoped to one company;
// routes check the caller before they call in.
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Db } from "@greatstone/db";
import {
  crmSyncBindings,
  crmSyncConflicts,
  crmSyncEvents,
  crmSyncFieldMaps,
  crmSyncRecordLinks,
  pipelineCaseContacts,
  pipelineCases,
  pipelineFieldDefinitions,
  pipelineStages,
  pipelines,
  toolConnections,
  type CrmSyncStoredValue,
} from "@greatstone/db";
import { coerceCrmSyncFieldValue, crmSyncIsOwnChangeOnly, crmSyncValuesEqual } from "@greatstone/shared";
import type {
  CreateCrmSyncBinding,
  CreateCrmSyncSuggestion,
  CrmSyncBinding,
  CrmSyncBindingDirection,
  CrmSyncBindingStatus,
  CrmSyncCaseStatus,
  CrmSyncChangeAuthor,
  CrmSyncConflict,
  CrmSyncConflictKind,
  CrmSyncConflictResolution,
  CrmSyncConflictStatus,
  CrmSyncContainerKind,
  CrmSyncEntityKind,
  CrmSyncEvent,
  CrmSyncEventAction,
  CrmSyncEventDirection,
  CrmSyncFieldMap,
  CrmSyncFieldMapEntryInput,
  CrmSyncFieldOwner,
  CrmSyncFieldValue,
  CrmSyncPage,
  CrmSyncRecordLink,
  CrmSyncStageMapEntry,
  PipelineFieldType,
  ListCrmSyncConflictsQuery,
  ListCrmSyncEventsQuery,
  ProposeCrmSyncConflictResolution,
  ResolveCrmSyncConflict,
  RunCrmSyncBinding,
  CrmSyncRunQueued,
  UpdateCrmSyncBinding,
} from "@greatstone/shared";
import { badRequest, conflict, HttpError, notFound, unprocessable } from "../errors.js";

type SyncDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type BindingRow = typeof crmSyncBindings.$inferSelect;
type ConflictRow = typeof crmSyncConflicts.$inferSelect;
type EventRow = typeof crmSyncEvents.$inferSelect;
type FieldMapRow = typeof crmSyncFieldMaps.$inferSelect;

function isUniqueViolation(error: unknown) {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return candidate?.code === "23505" || candidate?.cause?.code === "23505";
}

function iso(value: Date | null) {
  return value ? value.toISOString() : null;
}

export function toCrmSyncBinding(row: BindingRow, openConflictCount: number): CrmSyncBinding {
  return {
    id: row.id,
    companyId: row.companyId,
    connectionId: row.connectionId,
    providerKey: row.providerKey,
    containerKind: row.containerKind as CrmSyncContainerKind,
    externalContainerId: row.externalContainerId,
    externalContainerLabel: row.externalContainerLabel,
    pipelineId: row.pipelineId,
    direction: row.direction as CrmSyncBindingDirection,
    status: row.status as CrmSyncBindingStatus,
    stageMap: row.stageMap,
    openConflictCount,
    lastSyncedAt: iso(row.lastSyncedAt),
    lastErrorMessage: row.lastErrorMessage,
    nextSyncAt: iso(row.nextSyncAt),
    rateLimitedUntil: readRateLimitedUntil(row.syncState),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** `syncState.rateLimitedUntil` as an ISO time, or null once it has passed or was never set. */
export function readRateLimitedUntil(syncState: Record<string, unknown>, now = new Date()) {
  const raw = syncState.rateLimitedUntil;
  if (typeof raw !== "string") return null;
  const until = new Date(raw);
  if (Number.isNaN(until.getTime()) || until <= now) return null;
  return until.toISOString();
}

function toFieldMap(binding: BindingRow, rows: FieldMapRow[]): CrmSyncFieldMap {
  return {
    bindingId: binding.id,
    fields: rows.map((row) => ({
      id: row.id,
      bindingId: row.bindingId,
      externalField: row.externalField,
      externalFieldLabel: row.externalFieldLabel,
      gsamField: row.gsamField,
      owner: row.owner as CrmSyncFieldOwner,
    })),
    updatedAt: binding.fieldMapUpdatedAt.toISOString(),
  };
}

function toEvent(row: EventRow): CrmSyncEvent {
  return {
    id: row.id,
    companyId: row.companyId,
    bindingId: row.bindingId,
    direction: row.direction as CrmSyncEventDirection,
    action: row.action as CrmSyncEventAction,
    entityKind: row.entityKind as CrmSyncEntityKind,
    entityId: row.entityId,
    externalId: row.externalId,
    changedFields: row.changedFields,
    conflictId: row.conflictId,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toCrmSyncConflict(row: ConflictRow): CrmSyncConflict {
  return {
    id: row.id,
    companyId: row.companyId,
    bindingId: row.bindingId,
    kind: row.kind as CrmSyncConflictKind,
    entityKind: row.entityKind as CrmSyncEntityKind,
    entityId: row.entityId,
    externalId: row.externalId,
    gsamField: row.gsamField,
    externalField: row.externalField,
    ...(row.lastSyncedValue ? { lastSyncedValue: row.lastSyncedValue.value } : {}),
    crmValue: row.crmValue.value,
    gsamValue: row.gsamValue.value,
    crmChangedAt: iso(row.crmChangedAt),
    gsamChangedBy: row.gsamChangedBy,
    gsamChangedAt: iso(row.gsamChangedAt),
    reason: row.reason,
    proposal: row.proposedResolution && row.proposedAt
      ? {
        resolution: row.proposedResolution as CrmSyncConflictResolution,
        value: row.proposedValue?.value ?? null,
        reason: row.proposalReason ?? "",
        proposedByAgentId: row.proposedByAgentId,
        proposedByUserId: row.proposedByUserId,
        proposedAt: row.proposedAt.toISOString(),
      }
      : null,
    status: row.status as CrmSyncConflictStatus,
    resolution: row.resolution as CrmSyncConflictResolution | null,
    ...(row.resolvedValue ? { resolvedValue: row.resolvedValue.value } : {}),
    resolvedByUserId: row.resolvedByUserId,
    resolvedByAgentId: row.resolvedByAgentId,
    resolvedAt: iso(row.resolvedAt),
    decisionReason: row.resolutionReason ?? row.dismissReason,
    detectedAt: row.detectedAt.toISOString(),
  };
}

// Pages are newest first. The cursor is the (time, id) of the last item served.
function encodeCursor(at: Date, id: string) {
  return Buffer.from(JSON.stringify([at.toISOString(), id])).toString("base64url");
}

function decodeCursor(cursor: string | undefined) {
  if (!cursor) return null;
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as [string, string];
    const date = new Date(at);
    if (Number.isNaN(date.getTime()) || typeof id !== "string") throw new Error("bad cursor");
    return { at: date, id };
  } catch {
    throw badRequest("Invalid cursor");
  }
}

// Postgres keeps microseconds and the cursor keeps milliseconds, so compare at
// millisecond precision; the id breaks ties.
function beforeCursor(at: AnyPgColumn, id: AnyPgColumn, cursor: { at: Date; id: string }) {
  return sql`(date_trunc('milliseconds', ${at}), ${id}) < (${cursor.at.toISOString()}::timestamptz, ${cursor.id}::uuid)`;
}

async function openConflictCounts(db: SyncDb, bindingIds: string[]) {
  const counts = new Map<string, number>();
  if (bindingIds.length === 0) return counts;
  const rows = await db
    .select({ bindingId: crmSyncConflicts.bindingId, count: sql<number>`count(*)::int` })
    .from(crmSyncConflicts)
    .where(and(inArray(crmSyncConflicts.bindingId, bindingIds), eq(crmSyncConflicts.status, "open")))
    .groupBy(crmSyncConflicts.bindingId);
  for (const row of rows) counts.set(row.bindingId, row.count);
  return counts;
}

/** Loads a live (not deleted) binding. Routes check the caller's company against the result. */
export async function loadCrmSyncBinding(db: SyncDb, bindingId: string) {
  const row = await db
    .select()
    .from(crmSyncBindings)
    .where(and(eq(crmSyncBindings.id, bindingId), isNull(crmSyncBindings.deletedAt)))
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Binding not found");
  return row;
}

export async function loadCrmSyncConflict(db: SyncDb, conflictId: string) {
  const row = await db
    .select()
    .from(crmSyncConflicts)
    .where(eq(crmSyncConflicts.id, conflictId))
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Conflict not found");
  return row;
}

export async function loadCaseCompanyId(db: SyncDb, caseId: string) {
  const row = await db
    .select({ companyId: pipelineCases.companyId })
    .from(pipelineCases)
    .where(eq(pipelineCases.id, caseId))
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Case not found");
  return row.companyId;
}

async function assertStageMapMatchesPipeline(db: SyncDb, pipelineId: string, stageMap: CrmSyncStageMapEntry[]) {
  if (stageMap.length === 0) return;
  const keys = await db
    .select({ key: pipelineStages.key })
    .from(pipelineStages)
    .where(eq(pipelineStages.pipelineId, pipelineId))
    .then((rows) => new Set(rows.map((row) => row.key)));
  const missing = stageMap.map((entry) => entry.stageKey).filter((key) => !keys.has(key));
  if (missing.length > 0) {
    throw unprocessable("The stage map names stages this pipeline does not have", {
      code: "unknown_stage_key",
      stageKeys: [...new Set(missing)],
    });
  }
}

// `fields.<key>` must name a typed field (GRE-1075) on the bound pipeline that
// is not archived, so imported values land in a field with a known type.
async function assertFieldMapMatchesPipeline(
  db: SyncDb,
  input: { companyId: string; pipelineId: string; fields: CrmSyncFieldMapEntryInput[] },
) {
  const wanted = input.fields
    .map((entry) => entry.gsamField)
    .filter((field) => field.startsWith("fields."))
    .map((field) => field.slice("fields.".length));
  if (wanted.length === 0) return;
  const known = await db
    .select({ key: pipelineFieldDefinitions.key })
    .from(pipelineFieldDefinitions)
    .where(and(
      eq(pipelineFieldDefinitions.companyId, input.companyId),
      eq(pipelineFieldDefinitions.pipelineId, input.pipelineId),
      isNull(pipelineFieldDefinitions.archivedAt),
    ))
    .then((rows) => new Set(rows.map((row) => row.key)));
  const missing = wanted.filter((key) => !known.has(key));
  if (missing.length > 0) {
    throw unprocessable("The field map names pipeline fields that do not exist or are archived", {
      code: "unknown_pipeline_field",
      fieldKeys: missing,
    });
  }
}

async function writeFieldMap(
  db: SyncDb,
  binding: Pick<BindingRow, "id" | "companyId">,
  fields: CrmSyncFieldMapEntryInput[],
) {
  await db.delete(crmSyncFieldMaps).where(eq(crmSyncFieldMaps.bindingId, binding.id));
  if (fields.length === 0) return [];
  return db
    .insert(crmSyncFieldMaps)
    .values(fields.map((entry, position) => ({
      companyId: binding.companyId,
      bindingId: binding.id,
      externalField: entry.externalField,
      externalFieldLabel: entry.externalFieldLabel ?? null,
      gsamField: entry.gsamField,
      owner: entry.owner,
      position,
    })))
    .returning();
}

/** A typed value lands as the pipeline field's type (number, date, list), like an imported CRM value. */
async function coerceForGsamField(
  db: SyncDb,
  input: { companyId: string; pipelineId: string; gsamField: string; value: CrmSyncFieldValue },
) {
  if (!input.gsamField.startsWith("fields.")) return input.value;
  const definition = await db
    .select({ type: pipelineFieldDefinitions.type })
    .from(pipelineFieldDefinitions)
    .where(and(
      eq(pipelineFieldDefinitions.companyId, input.companyId),
      eq(pipelineFieldDefinitions.pipelineId, input.pipelineId),
      eq(pipelineFieldDefinitions.key, input.gsamField.slice("fields.".length)),
    ))
    .then((rows) => rows[0] ?? null);
  const type = definition?.type as PipelineFieldType | undefined;
  const value = coerceCrmSyncFieldValue(input.value, type);
  if ((type === "number" && value !== null && typeof value !== "number") || (type === "boolean" && value !== null && typeof value !== "boolean")) {
    throw unprocessable(`Enter a ${type} for this field`, { code: "invalid_value", gsamField: input.gsamField, type });
  }
  return value;
}

/** Nobody resolves a conflict that holds only their own change (deck slide 8). */
function assertNotOwnChangeOnly(row: ConflictRow, userId: string) {
  if (crmSyncIsOwnChangeOnly(row.gsamChangedBy, userId)) {
    throw new HttpError(403, "This holds only your own change. Ask someone else to decide.", { code: "own_change" });
  }
}

export function crmSyncService(db: Db) {
  async function bindingWithCount(row: BindingRow) {
    const counts = await openConflictCounts(db, [row.id]);
    return toCrmSyncBinding(row, counts.get(row.id) ?? 0);
  }

  return {
    async listBindings(companyId: string) {
      const rows = await db
        .select()
        .from(crmSyncBindings)
        .where(and(eq(crmSyncBindings.companyId, companyId), isNull(crmSyncBindings.deletedAt)))
        .orderBy(asc(crmSyncBindings.createdAt), asc(crmSyncBindings.id));
      const counts = await openConflictCounts(db, rows.map((row) => row.id));
      return rows.map((row) => toCrmSyncBinding(row, counts.get(row.id) ?? 0));
    },

    getBinding: bindingWithCount,

    async createBinding(companyId: string, input: CreateCrmSyncBinding, actor: { userId: string }) {
      const [connection, pipeline] = await Promise.all([
        db
          .select({ id: toolConnections.id })
          .from(toolConnections)
          .where(and(eq(toolConnections.id, input.connectionId), eq(toolConnections.companyId, companyId)))
          .then((rows) => rows[0] ?? null),
        db
          .select({ id: pipelines.id })
          .from(pipelines)
          .where(and(eq(pipelines.id, input.pipelineId), eq(pipelines.companyId, companyId)))
          .then((rows) => rows[0] ?? null),
      ]);
      // Same answer for "missing" and "another company's" so ids do not leak.
      if (!connection) throw unprocessable("Connection not found", { code: "connection_not_found" });
      if (!pipeline) throw unprocessable("Pipeline not found", { code: "pipeline_not_found" });
      await assertStageMapMatchesPipeline(db, input.pipelineId, input.stageMap);
      await assertFieldMapMatchesPipeline(db, { companyId, pipelineId: input.pipelineId, fields: input.fieldMap });

      try {
        const created = await db.transaction(async (tx) => {
          const [row] = await tx.insert(crmSyncBindings).values({
            companyId,
            connectionId: input.connectionId,
            providerKey: input.providerKey,
            containerKind: input.containerKind,
            externalContainerId: input.externalContainerId,
            externalContainerLabel: input.externalContainerLabel ?? null,
            pipelineId: input.pipelineId,
            direction: input.direction,
            stageMap: input.stageMap,
            createdByUserId: actor.userId,
          }).returning();
          await writeFieldMap(tx, row!, input.fieldMap);
          return row!;
        });
        return toCrmSyncBinding(created, 0);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict("This external container is already bound for this connection", {
            code: "duplicate_binding",
            externalContainerId: input.externalContainerId,
          });
        }
        throw error;
      }
    },

    async updateBinding(binding: BindingRow, patch: UpdateCrmSyncBinding) {
      if (patch.stageMap) await assertStageMapMatchesPipeline(db, binding.pipelineId, patch.stageMap);
      const values: Partial<typeof crmSyncBindings.$inferInsert> = { updatedAt: new Date() };
      if (patch.externalContainerLabel !== undefined) values.externalContainerLabel = patch.externalContainerLabel;
      if (patch.direction) values.direction = patch.direction;
      if (patch.stageMap) values.stageMap = patch.stageMap;
      if (patch.status) {
        values.status = patch.status;
        // Resuming clears the server error so the next pass can run.
        if (patch.status === "active") values.lastErrorMessage = null;
      }
      const [updated] = await db
        .update(crmSyncBindings)
        .set(values)
        .where(and(eq(crmSyncBindings.id, binding.id), isNull(crmSyncBindings.deletedAt)))
        .returning();
      if (!updated) throw notFound("Binding not found");
      return bindingWithCount(updated);
    },

    /** Stops sync. Keeps the log, record links and resolved conflicts; open conflicts are dismissed. */
    async deleteBinding(binding: BindingRow, actor: { userId: string }) {
      const now = new Date();
      return db.transaction(async (tx) => {
        const dismissed = await tx
          .update(crmSyncConflicts)
          .set({
            status: "dismissed",
            dismissReason: "Binding deleted",
            resolvedByUserId: actor.userId,
            resolvedAt: now,
          })
          .where(and(eq(crmSyncConflicts.bindingId, binding.id), eq(crmSyncConflicts.status, "open")))
          .returning({ id: crmSyncConflicts.id });
        await tx
          .update(crmSyncBindings)
          .set({ deletedAt: now, status: "paused", nextSyncAt: null, updatedAt: now })
          .where(eq(crmSyncBindings.id, binding.id));
        return { dismissedConflictCount: dismissed.length };
      });
    },

    async getFieldMap(binding: BindingRow) {
      const rows = await db
        .select()
        .from(crmSyncFieldMaps)
        .where(and(eq(crmSyncFieldMaps.bindingId, binding.id), eq(crmSyncFieldMaps.companyId, binding.companyId)))
        .orderBy(asc(crmSyncFieldMaps.position));
      return toFieldMap(binding, rows);
    },

    async replaceFieldMap(binding: BindingRow, fields: CrmSyncFieldMapEntryInput[]) {
      await assertFieldMapMatchesPipeline(db, {
        companyId: binding.companyId,
        pipelineId: binding.pipelineId,
        fields,
      });
      return db.transaction(async (tx) => {
        const rows = await writeFieldMap(tx, binding, fields);
        const [updated] = await tx
          .update(crmSyncBindings)
          .set({ fieldMapUpdatedAt: new Date(), updatedAt: new Date() })
          .where(eq(crmSyncBindings.id, binding.id))
          .returning();
        return toFieldMap(updated!, rows);
      });
    },

    async listEvents(binding: BindingRow, query: ListCrmSyncEventsQuery): Promise<CrmSyncPage<CrmSyncEvent>> {
      const cursor = decodeCursor(query.cursor);
      const conditions = [
        eq(crmSyncEvents.companyId, binding.companyId),
        eq(crmSyncEvents.bindingId, binding.id),
      ];
      if (query.direction) conditions.push(eq(crmSyncEvents.direction, query.direction));
      if (query.action) conditions.push(eq(crmSyncEvents.action, query.action));
      if (query.entityId) conditions.push(eq(crmSyncEvents.entityId, query.entityId));
      if (cursor) {
        conditions.push(beforeCursor(crmSyncEvents.createdAt, crmSyncEvents.id, cursor));
      }
      const rows = await db
        .select()
        .from(crmSyncEvents)
        .where(and(...conditions))
        .orderBy(desc(crmSyncEvents.createdAt), desc(crmSyncEvents.id))
        .limit(query.limit + 1);
      const items = rows.slice(0, query.limit);
      const last = items[items.length - 1];
      return {
        items: items.map(toEvent),
        nextCursor: rows.length > query.limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    },

    async listConflicts(companyId: string, query: ListCrmSyncConflictsQuery): Promise<CrmSyncPage<CrmSyncConflict>> {
      const cursor = decodeCursor(query.cursor);
      const conditions = [eq(crmSyncConflicts.companyId, companyId), eq(crmSyncConflicts.status, query.status)];
      if (query.kind) conditions.push(eq(crmSyncConflicts.kind, query.kind));
      if (query.bindingId) conditions.push(eq(crmSyncConflicts.bindingId, query.bindingId));
      if (query.entityId) conditions.push(eq(crmSyncConflicts.entityId, query.entityId));
      if (cursor) {
        conditions.push(beforeCursor(crmSyncConflicts.detectedAt, crmSyncConflicts.id, cursor));
      }
      const rows = await db
        .select()
        .from(crmSyncConflicts)
        .where(and(...conditions))
        .orderBy(desc(crmSyncConflicts.detectedAt), desc(crmSyncConflicts.id))
        .limit(query.limit + 1);
      const items = rows.slice(0, query.limit);
      const last = items[items.length - 1];
      return {
        items: items.map(toCrmSyncConflict),
        nextCursor: rows.length > query.limit && last ? encodeCursor(last.detectedAt, last.id) : null,
      };
    },

    /**
     * A person decides. Keep CRM, keep GSAM (for a suggestion: accept it) or a
     * typed value; the next pass writes it to both sides. Nobody resolves a
     * conflict that holds only their own change.
     */
    async resolveConflict(row: ConflictRow, input: ResolveCrmSyncConflict, actor: { userId: string }) {
      assertNotOwnChangeOnly(row, actor.userId);
      const resolvedValue: CrmSyncStoredValue = input.resolution === "keep_crm"
        ? row.crmValue
        : input.resolution === "keep_gsam"
          ? row.gsamValue
          : { value: await coerceForGsamField(db, { ...(await conflictScope(row)), gsamField: row.gsamField, value: input.value }) };
      const resolved = await closeConflict(row, {
        status: "resolved",
        resolution: input.resolution,
        resolvedValue,
        resolutionReason: input.reason ?? null,
        resolvedByUserId: actor.userId,
        resolvedAt: new Date(),
      });
      await queueNextPass(row.bindingId);
      return resolved;
    },

    /** A person accepts the open proposal as it stands. The proposal's reason is the decision's reason. */
    async acceptProposal(row: ConflictRow, actor: { userId: string }) {
      if (!row.proposedResolution || !row.proposedAt) {
        throw unprocessable("This conflict has no proposed resolution", { code: "no_proposal" });
      }
      assertNotOwnChangeOnly(row, actor.userId);
      const resolvedValue: CrmSyncStoredValue = row.proposedResolution === "keep_crm"
        ? row.crmValue
        : row.proposedResolution === "keep_gsam"
          ? row.gsamValue
          : row.proposedValue ?? { value: null };
      const resolved = await closeConflict(row, {
        status: "resolved",
        resolution: row.proposedResolution,
        resolvedValue,
        resolutionReason: row.proposalReason,
        resolvedByUserId: actor.userId,
        resolvedAt: new Date(),
      }, { proposedAt: row.proposedAt });
      await queueNextPass(row.bindingId);
      return resolved;
    },

    /** An agent with Work cases (or a person) proposes a resolution with a reason. It changes nothing until accepted. */
    async proposeResolution(
      row: ConflictRow,
      input: ProposeCrmSyncConflictResolution,
      actor: { agentId: string | null; userId: string | null },
    ) {
      const [updated] = await db
        .update(crmSyncConflicts)
        .set({
          proposedResolution: input.resolution,
          proposedValue: input.resolution === "custom"
            ? { value: await coerceForGsamField(db, { ...(await conflictScope(row)), gsamField: row.gsamField, value: input.value }) }
            : null,
          proposalReason: input.reason,
          proposedByAgentId: actor.agentId,
          proposedByUserId: actor.userId,
          proposedAt: new Date(),
        })
        .where(and(eq(crmSyncConflicts.id, row.id), eq(crmSyncConflicts.status, "open")))
        .returning();
      if (!updated) throw conflict("This conflict is already closed", { code: "conflict_closed", status: row.status });
      return toCrmSyncConflict(updated);
    },

    /**
     * Dismisses a conflict, or rejects a suggestion. The suggester may withdraw
     * their own suggestion; a conflict that holds only the caller's change
     * needs someone else.
     */
    async dismissConflict(row: ConflictRow, reason: string | undefined, actor: { userId: string }) {
      if (row.kind !== "suggestion") assertNotOwnChangeOnly(row, actor.userId);
      return closeConflict(row, {
        status: "dismissed",
        dismissReason: reason?.trim() || null,
        resolvedByUserId: actor.userId,
        resolvedAt: new Date(),
      });
    },

    /**
     * A suggested change to a CRM-owned field. It holds the field for this case
     * and waits in the queue; a person accepts it before it is written to the CRM.
     */
    async createSuggestion(
      caseRow: { id: string; companyId: string; pipelineId: string },
      input: CreateCrmSyncSuggestion,
      author: CrmSyncChangeAuthor,
    ) {
      const links = await db
        .select()
        .from(crmSyncRecordLinks)
        .where(and(
          eq(crmSyncRecordLinks.companyId, caseRow.companyId),
          eq(crmSyncRecordLinks.entityKind, "case"),
          eq(crmSyncRecordLinks.entityId, caseRow.id),
        ));
      const bindings = links.length === 0 ? [] : await db
        .select()
        .from(crmSyncBindings)
        .where(and(
          eq(crmSyncBindings.companyId, caseRow.companyId),
          eq(crmSyncBindings.pipelineId, caseRow.pipelineId),
          inArray(crmSyncBindings.connectionId, links.map((link) => link.connectionId)),
          isNull(crmSyncBindings.deletedAt),
          ...(input.bindingId ? [eq(crmSyncBindings.id, input.bindingId)] : []),
        ));
      const mapped = bindings.length === 0 ? [] : await db
        .select()
        .from(crmSyncFieldMaps)
        .where(and(
          eq(crmSyncFieldMaps.companyId, caseRow.companyId),
          inArray(crmSyncFieldMaps.bindingId, bindings.map((binding) => binding.id)),
          eq(crmSyncFieldMaps.gsamField, input.gsamField),
        ));
      if (mapped.length === 0) {
        throw unprocessable("This case does not sync this field with a CRM", { code: "field_not_synced", gsamField: input.gsamField });
      }
      const crmOwned = mapped.filter((row) => row.owner === "crm");
      if (crmOwned.length === 0) {
        throw unprocessable("Only CRM-owned fields take suggestions; edit this field on the case", {
          code: "not_crm_owned",
          gsamField: input.gsamField,
          owner: mapped[0]!.owner,
        });
      }
      if (crmOwned.length > 1) {
        throw unprocessable("More than one CRM owns this field for this case; name the binding", {
          code: "binding_required",
          bindingIds: crmOwned.map((row) => row.bindingId),
        });
      }
      const fieldRow = crmOwned[0]!;
      const binding = bindings.find((row) => row.id === fieldRow.bindingId)!;
      const link = links.find((row) => row.connectionId === binding.connectionId)!;
      const hasBase = Object.prototype.hasOwnProperty.call(link.lastSyncedValues, input.gsamField);
      const crmValue: CrmSyncFieldValue = hasBase ? link.lastSyncedValues[input.gsamField]! : null;
      const value = await coerceForGsamField(db, {
        companyId: caseRow.companyId,
        pipelineId: caseRow.pipelineId,
        gsamField: input.gsamField,
        value: input.value,
      });
      if (crmSyncValuesEqual(crmValue, value)) {
        throw unprocessable("The CRM already holds this value", { code: "no_change" });
      }
      try {
        const [created] = await db.insert(crmSyncConflicts).values({
          companyId: caseRow.companyId,
          bindingId: binding.id,
          kind: "suggestion",
          entityKind: "case",
          entityId: caseRow.id,
          externalId: link.externalId,
          gsamField: input.gsamField,
          externalField: fieldRow.externalField,
          lastSyncedValue: hasBase ? { value: crmValue } : null,
          crmValue: { value: crmValue },
          gsamValue: { value },
          gsamChangedBy: [author],
          gsamChangedAt: new Date(),
          reason: input.reason,
        }).returning();
        return toCrmSyncConflict(created!);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict("This field is already waiting for review on this case", {
            code: "field_under_review",
            gsamField: input.gsamField,
          });
        }
        throw error;
      }
    },

    /**
     * Queues one pass (read changes, then write GSAM changes back): the poll
     * scheduler runs it on its next tick. While Pipedrive is rate-limiting,
     * the pass waits for the retry time.
     */
    async queueRun(binding: BindingRow, direction: RunCrmSyncBinding["direction"]): Promise<CrmSyncRunQueued> {
      if (binding.providerKey !== "pipedrive") {
        throw unprocessable("Sync is not built for this CRM yet", { code: "provider_not_supported", providerKey: binding.providerKey });
      }
      if (
        (direction === "outbound" && binding.direction === "inbound_only") ||
        (direction === "inbound" && binding.direction === "outbound_only")
      ) {
        throw unprocessable("This binding does not sync in that direction", {
          code: "direction_not_allowed",
          bindingDirection: binding.direction,
        });
      }
      if (binding.status !== "active") {
        throw conflict("Resume the binding before you run a sync", { code: "binding_not_active", status: binding.status });
      }
      const rateLimitedUntil = readRateLimitedUntil(binding.syncState);
      const nextSyncAt = rateLimitedUntil ? new Date(rateLimitedUntil) : new Date();
      await db
        .update(crmSyncBindings)
        .set({ nextSyncAt, updatedAt: new Date() })
        .where(and(eq(crmSyncBindings.id, binding.id), isNull(crmSyncBindings.deletedAt)));
      return { bindingId: binding.id, nextSyncAt: nextSyncAt.toISOString() };
    },

    /** Sync state for each source the case is linked to, with its newest log line. */
    async getCaseStatus(companyId: string, caseId: string): Promise<CrmSyncCaseStatus> {
      const caseRow = await db
        .select({ pipelineId: pipelineCases.pipelineId })
        .from(pipelineCases)
        .where(and(eq(pipelineCases.id, caseId), eq(pipelineCases.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!caseRow) throw notFound("Case not found");
      const links = await db
        .select()
        .from(crmSyncRecordLinks)
        .where(and(
          eq(crmSyncRecordLinks.companyId, companyId),
          eq(crmSyncRecordLinks.entityKind, "case"),
          eq(crmSyncRecordLinks.entityId, caseId),
        ));
      if (links.length === 0) return { caseId, sources: [] };
      const bindings = await db
        .select()
        .from(crmSyncBindings)
        .where(and(
          eq(crmSyncBindings.companyId, companyId),
          eq(crmSyncBindings.pipelineId, caseRow.pipelineId),
          inArray(crmSyncBindings.connectionId, links.map((link) => link.connectionId)),
          isNull(crmSyncBindings.deletedAt),
        ))
        .orderBy(asc(crmSyncBindings.createdAt));
      const sources = await Promise.all(bindings.map(async (binding) => {
        const link = links.find((row) => row.connectionId === binding.connectionId)!;
        const lastEvent = await db
          .select()
          .from(crmSyncEvents)
          .where(and(
            eq(crmSyncEvents.companyId, companyId),
            eq(crmSyncEvents.bindingId, binding.id),
            eq(crmSyncEvents.entityId, caseId),
          ))
          .orderBy(desc(crmSyncEvents.createdAt), desc(crmSyncEvents.id))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        return {
          bindingId: binding.id,
          connectionId: binding.connectionId,
          providerKey: binding.providerKey,
          externalContainerLabel: binding.externalContainerLabel,
          externalId: link.externalId,
          bindingStatus: binding.status as CrmSyncBindingStatus,
          lastSyncedAt: iso(link.lastSyncedAt),
          lastErrorMessage: binding.lastErrorMessage,
          nextSyncAt: iso(binding.nextSyncAt),
          rateLimitedUntil: readRateLimitedUntil(binding.syncState),
          lastEvent: lastEvent ? toEvent(lastEvent) : null,
        };
      }));
      return { caseId, sources };
    },

    /** External ids held by the case and its contacts. */
    async listCaseLinks(companyId: string, caseId: string): Promise<CrmSyncRecordLink[]> {
      const contactIds = await db
        .select({ id: pipelineCaseContacts.id })
        .from(pipelineCaseContacts)
        .where(and(eq(pipelineCaseContacts.companyId, companyId), eq(pipelineCaseContacts.caseId, caseId)))
        .then((rows) => rows.map((row) => row.id));
      const rows = await db
        .select()
        .from(crmSyncRecordLinks)
        .where(and(
          eq(crmSyncRecordLinks.companyId, companyId),
          or(
            and(eq(crmSyncRecordLinks.entityKind, "case"), eq(crmSyncRecordLinks.entityId, caseId)),
            contactIds.length > 0
              ? and(eq(crmSyncRecordLinks.entityKind, "contact"), inArray(crmSyncRecordLinks.entityId, contactIds))
              : sql`false`,
          ),
        ))
        .orderBy(asc(crmSyncRecordLinks.createdAt), asc(crmSyncRecordLinks.id));
      return rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        entityKind: row.entityKind as CrmSyncEntityKind,
        entityId: row.entityId,
        connectionId: row.connectionId,
        providerKey: row.providerKey,
        externalId: row.externalId,
        lastSyncedAt: iso(row.lastSyncedAt),
        createdAt: row.createdAt.toISOString(),
      }));
    },
  };

  // A resolved or dismissed conflict is never reopened; only an open one can close.
  // `expect.proposedAt` makes accepting a proposal fail if it was replaced meanwhile.
  async function closeConflict(
    row: ConflictRow,
    values: Partial<typeof crmSyncConflicts.$inferInsert>,
    expect: { proposedAt?: Date } = {},
  ) {
    const [updated] = await db
      .update(crmSyncConflicts)
      .set(values)
      .where(and(
        eq(crmSyncConflicts.id, row.id),
        eq(crmSyncConflicts.status, "open"),
        ...(expect.proposedAt ? [eq(crmSyncConflicts.proposedAt, expect.proposedAt)] : []),
      ))
      .returning();
    if (!updated) {
      const latest = await loadCrmSyncConflict(db, row.id);
      if (latest.status === "open") {
        throw conflict("The proposal changed; review it again", { code: "proposal_changed" });
      }
      throw conflict("This conflict is already closed", { code: "conflict_closed", status: latest.status });
    }
    return toCrmSyncConflict(updated);
  }

  async function conflictScope(row: ConflictRow) {
    const binding = await db
      .select({ pipelineId: crmSyncBindings.pipelineId })
      .from(crmSyncBindings)
      .where(eq(crmSyncBindings.id, row.bindingId))
      .then((rows) => rows[0]!);
    return { companyId: row.companyId, pipelineId: binding.pipelineId };
  }

  /** Runs the binding soon after a decision, so the result reaches both sides without waiting for the poll. */
  async function queueNextPass(bindingId: string) {
    const binding = await db
      .select()
      .from(crmSyncBindings)
      .where(and(eq(crmSyncBindings.id, bindingId), isNull(crmSyncBindings.deletedAt), eq(crmSyncBindings.status, "active")))
      .then((rows) => rows[0] ?? null);
    if (!binding) return;
    const at = new Date(readRateLimitedUntil(binding.syncState) ?? Date.now());
    if (binding.nextSyncAt && binding.nextSyncAt <= at) return;
    await db.update(crmSyncBindings).set({ nextSyncAt: at }).where(eq(crmSyncBindings.id, bindingId));
  }
}
