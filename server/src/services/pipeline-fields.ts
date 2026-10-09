// Typed pipeline fields (GRE-1075). Definitions live in
// pipeline_field_definitions; case values stay in pipeline_cases.fields.
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@greatstone/db";
import { pipelineFieldDefinitions } from "@greatstone/db";
import {
  checkPipelineFieldValue,
  isEmptyPipelineFieldValue,
  PIPELINE_FIELD_TYPES_WITH_OPTIONS,
  type CreatePipelineField,
  type PipelineFieldType,
  type UpdatePipelineField,
} from "@greatstone/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

type FieldDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type FieldDefinitionRow = typeof pipelineFieldDefinitions.$inferSelect;

export type PipelineFieldActor =
  | { type: "user"; userId: string }
  | { type: "agent"; agentId: string; runId?: string | null }
  | { type: "system" };

function isUniqueViolation(error: unknown) {
  // Drizzle wraps the driver error and keeps it as `cause`.
  const candidate = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return candidate?.code === "23505" || candidate?.cause?.code === "23505";
}

export async function listPipelineFieldDefinitions(
  db: FieldDb,
  input: { companyId: string; pipelineId: string; includeArchived?: boolean },
) {
  const conditions = [
    eq(pipelineFieldDefinitions.companyId, input.companyId),
    eq(pipelineFieldDefinitions.pipelineId, input.pipelineId),
  ];
  if (!input.includeArchived) conditions.push(isNull(pipelineFieldDefinitions.archivedAt));
  return db
    .select()
    .from(pipelineFieldDefinitions)
    .where(and(...conditions))
    .orderBy(asc(pipelineFieldDefinitions.position), asc(pipelineFieldDefinitions.createdAt));
}

export async function createPipelineFieldDefinition(
  db: FieldDb,
  input: { companyId: string; pipelineId: string; field: CreatePipelineField; actor: PipelineFieldActor },
) {
  const position = input.field.position ?? await db
    .select({ next: sql<number>`coalesce(max(${pipelineFieldDefinitions.position}) + 1, 0)::int` })
    .from(pipelineFieldDefinitions)
    .where(and(
      eq(pipelineFieldDefinitions.companyId, input.companyId),
      eq(pipelineFieldDefinitions.pipelineId, input.pipelineId),
    ))
    .then((rows) => rows[0]?.next ?? 0);
  try {
    const [created] = await db.insert(pipelineFieldDefinitions).values({
      companyId: input.companyId,
      pipelineId: input.pipelineId,
      key: input.field.key,
      label: input.field.label,
      description: input.field.description ?? null,
      type: input.field.type,
      required: input.field.required,
      options: input.field.options,
      position,
      createdByUserId: input.actor.type === "user" ? input.actor.userId : null,
      createdByAgentId: input.actor.type === "agent" ? input.actor.agentId : null,
    }).returning();
    return created!;
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Archived keys stay reserved so old case values keep their type.
      throw conflict("This pipeline already has a field with that key. Restore it or pick a new key.", {
        code: "duplicate_field_key",
        fieldKey: input.field.key,
      });
    }
    throw error;
  }
}

export async function updatePipelineFieldDefinition(
  db: FieldDb,
  input: { companyId: string; pipelineId: string; fieldId: string; patch: UpdatePipelineField },
) {
  const existing = await db
    .select()
    .from(pipelineFieldDefinitions)
    .where(and(
      eq(pipelineFieldDefinitions.companyId, input.companyId),
      eq(pipelineFieldDefinitions.pipelineId, input.pipelineId),
      eq(pipelineFieldDefinitions.id, input.fieldId),
    ))
    .then((rows) => rows[0] ?? null);
  if (!existing) throw notFound("Field not found");

  const { archived, ...rest } = input.patch;
  if (rest.options !== undefined) {
    const needsOptions = PIPELINE_FIELD_TYPES_WITH_OPTIONS.includes(existing.type as PipelineFieldType);
    if (needsOptions && rest.options.length === 0) {
      throw unprocessable("Add at least one choice", { code: "validation", fieldKey: existing.key });
    }
    if (!needsOptions && rest.options.length > 0) {
      throw unprocessable("Only choice fields have choices", { code: "validation", fieldKey: existing.key });
    }
  }
  const patch: Partial<typeof pipelineFieldDefinitions.$inferInsert> = { ...rest, updatedAt: new Date() };
  if (archived !== undefined) patch.archivedAt = archived ? existing.archivedAt ?? new Date() : null;
  const [updated] = await db
    .update(pipelineFieldDefinitions)
    .set(patch)
    .where(and(
      eq(pipelineFieldDefinitions.companyId, input.companyId),
      eq(pipelineFieldDefinitions.id, existing.id),
    ))
    .returning();
  return { before: existing, after: updated! };
}

function invalidField(definition: FieldDefinitionRow, message: string, code: string) {
  return unprocessable(`${definition.label} ${message}`, {
    code,
    fieldKey: definition.key,
    label: definition.label,
  });
}

/**
 * Checks case values against the pipeline's active typed fields. Keys with no
 * definition pass through untouched (stage variables and older cases use them).
 *
 * - On create (`previous` absent) every required field needs a value.
 * - On edit, a required field may stay empty if it was already empty, so cases
 *   made before the field existed can still be edited; clearing it is refused.
 */
export async function assertCaseFieldValues(
  db: FieldDb,
  input: {
    companyId: string;
    pipelineId: string;
    fields: Record<string, unknown>;
    previous?: Record<string, unknown> | null;
  },
) {
  const definitions = await listPipelineFieldDefinitions(db, {
    companyId: input.companyId,
    pipelineId: input.pipelineId,
  });
  for (const definition of definitions) {
    const value = input.fields[definition.key];
    if (isEmptyPipelineFieldValue(value)) {
      if (!definition.required) continue;
      const previousValue = input.previous ? input.previous[definition.key] : undefined;
      const wasEmpty = input.previous !== undefined && isEmptyPipelineFieldValue(previousValue);
      if (!wasEmpty) throw invalidField(definition, "is required", "required_field");
      continue;
    }
    // Unchanged values written before a rule tightened (for example a removed
    // choice) do not block other edits on the same case.
    if (input.previous && JSON.stringify(input.previous[definition.key]) === JSON.stringify(value)) continue;
    const check = checkPipelineFieldValue(
      { type: definition.type as PipelineFieldType, options: definition.options ?? [] },
      value,
    );
    if (!check.ok) throw invalidField(definition, check.message, "invalid_field_value");
  }
}
