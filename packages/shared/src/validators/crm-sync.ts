import { z } from "zod";
import {
  CRM_SYNC_BINDING_DIRECTIONS,
  CRM_SYNC_BINDING_STATUSES,
  CRM_SYNC_CONFLICT_KINDS,
  CRM_SYNC_CONFLICT_STATUSES,
  CRM_SYNC_CONTAINER_KINDS,
  CRM_SYNC_ENTITY_KINDS,
  CRM_SYNC_EVENT_ACTIONS,
  CRM_SYNC_EVENT_DIRECTIONS,
  CRM_SYNC_FIELD_OWNERS,
} from "../crm-sync.js";

const externalIdSchema = z.string().trim().min(1).max(500);
const providerKeySchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/);
const stageKeySchema = z.string().trim().min(1).max(120);

export const crmSyncContainerKindSchema = z.enum(CRM_SYNC_CONTAINER_KINDS);
export const crmSyncBindingDirectionSchema = z.enum(CRM_SYNC_BINDING_DIRECTIONS);
export const crmSyncBindingStatusSchema = z.enum(CRM_SYNC_BINDING_STATUSES);
export const crmSyncFieldOwnerSchema = z.enum(CRM_SYNC_FIELD_OWNERS);
export const crmSyncEntityKindSchema = z.enum(CRM_SYNC_ENTITY_KINDS);
export const crmSyncEventDirectionSchema = z.enum(CRM_SYNC_EVENT_DIRECTIONS);
export const crmSyncEventActionSchema = z.enum(CRM_SYNC_EVENT_ACTIONS);
export const crmSyncConflictStatusSchema = z.enum(CRM_SYNC_CONFLICT_STATUSES);
export const crmSyncConflictKindSchema = z.enum(CRM_SYNC_CONFLICT_KINDS);

/**
 * GSAM side of a mapped field: the case title or summary, a pipeline case
 * field (`fields.<key>`), or a built-in contact field (`contact.<field>`).
 * The case stage is mapped through the binding's stage map, not here.
 */
export const crmSyncGsamFieldSchema = z.string().regex(
  /^(title|summary|fields\.[A-Za-z][A-Za-z0-9_]*|contact\.(name|role|phone|email))$/,
  "Use title, summary, fields.<key> or contact.<name|role|phone|email>",
);

export const crmSyncFieldValueSchema = z.union([
  z.string().max(10_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.string().max(1_000)).max(200),
]);

export const crmSyncStageMapEntrySchema = z.object({
  externalStageId: externalIdSchema,
  stageKey: stageKeySchema,
}).strict();

export const crmSyncStageMapSchema = z.array(crmSyncStageMapEntrySchema).max(100).superRefine((entries, ctx) => {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (seen.has(entry.externalStageId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "externalStageId"],
        message: "Each external stage can map to one GSAM stage only",
      });
    }
    seen.add(entry.externalStageId);
  });
});

export const crmSyncFieldMapEntrySchema = z.object({
  externalField: externalIdSchema,
  externalFieldLabel: z.string().trim().max(200).optional().nullable(),
  gsamField: crmSyncGsamFieldSchema,
  owner: crmSyncFieldOwnerSchema,
}).strict();

/** The whole field map for one binding. Each side of a field appears once, so each field has one owner. */
export const crmSyncFieldMapSchema = z.array(crmSyncFieldMapEntrySchema).max(200).superRefine((entries, ctx) => {
  const externalFields = new Set<string>();
  const gsamFields = new Set<string>();
  entries.forEach((entry, index) => {
    if (externalFields.has(entry.externalField)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "externalField"],
        message: "This external field is already mapped",
      });
    }
    if (gsamFields.has(entry.gsamField)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "gsamField"],
        message: "This GSAM field is already mapped",
      });
    }
    externalFields.add(entry.externalField);
    gsamFields.add(entry.gsamField);
  });
});

export const replaceCrmSyncFieldMapSchema = z.object({
  fields: crmSyncFieldMapSchema,
}).strict();

export const createCrmSyncBindingSchema = z.object({
  connectionId: z.string().guid(),
  providerKey: providerKeySchema,
  containerKind: crmSyncContainerKindSchema,
  externalContainerId: externalIdSchema,
  externalContainerLabel: z.string().trim().max(200).optional().nullable(),
  pipelineId: z.string().guid(),
  direction: crmSyncBindingDirectionSchema.optional().default("both"),
  stageMap: crmSyncStageMapSchema.optional().default([]),
  fieldMap: crmSyncFieldMapSchema.optional().default([]),
}).strict();

/** Connection, provider, container and pipeline are fixed once bound; make a new binding to change them. */
export const updateCrmSyncBindingSchema = z.object({
  externalContainerLabel: z.string().trim().max(200).optional().nullable(),
  direction: crmSyncBindingDirectionSchema.optional(),
  status: z.enum(["active", "paused"]).optional(),
  stageMap: crmSyncStageMapSchema.optional(),
}).strict();

export const runCrmSyncBindingSchema = z.object({
  direction: z.enum(["both", "inbound", "outbound"]).optional().default("both"),
}).strict();

/** One external id per source (connection) for each GSAM case or contact. */
export const crmSyncRecordLinkSchema = z.object({
  entityKind: crmSyncEntityKindSchema,
  entityId: z.string().guid(),
  connectionId: z.string().guid(),
  providerKey: providerKeySchema,
  externalId: externalIdSchema,
}).strict();

export const crmSyncRecordLinksSchema = z.array(crmSyncRecordLinkSchema).superRefine((links, ctx) => {
  const seen = new Set<string>();
  links.forEach((link, index) => {
    const key = `${link.entityKind}:${link.entityId}:${link.connectionId}`;
    if (seen.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "connectionId"],
        message: "A record can hold one external id per source",
      });
    }
    seen.add(key);
  });
});

// The log also records stage moves (`stage`), which the stage map drives.
const changedFieldSchema = z.object({
  gsamField: z.union([crmSyncGsamFieldSchema, z.literal("stage")]),
  from: crmSyncFieldValueSchema,
  to: crmSyncFieldValueSchema,
}).strict();

/** One line of the sync log. Written by the server only. */
export const crmSyncEventSchema = z.object({
  bindingId: z.string().guid(),
  direction: crmSyncEventDirectionSchema,
  action: crmSyncEventActionSchema,
  entityKind: crmSyncEntityKindSchema,
  entityId: z.string().guid().nullable(),
  externalId: externalIdSchema,
  changedFields: z.array(changedFieldSchema).max(200).default([]),
  conflictId: z.string().guid().nullable().default(null),
  errorMessage: z.string().max(2_000).nullable().default(null),
}).strict().superRefine((value, ctx) => {
  if (value.action === "failed" && !value.errorMessage) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["errorMessage"], message: "Failed events need an error message" });
  }
  if (value.action === "conflict" && !value.conflictId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["conflictId"], message: "Conflict events need a conflict id" });
  }
});

export const listCrmSyncEventsQuerySchema = z.object({
  direction: crmSyncEventDirectionSchema.optional(),
  action: crmSyncEventActionSchema.optional(),
  entityId: z.string().guid().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
}).strict();

/** A shared field changed on both sides. Holds all three values so a person can choose. */
export const crmSyncConflictSchema = z.object({
  bindingId: z.string().guid(),
  entityKind: crmSyncEntityKindSchema,
  entityId: z.string().guid(),
  externalId: externalIdSchema,
  gsamField: crmSyncGsamFieldSchema,
  externalField: externalIdSchema,
  /** Missing when the field was never synced (first link of two existing records). */
  lastSyncedValue: crmSyncFieldValueSchema.optional(),
  crmValue: crmSyncFieldValueSchema,
  gsamValue: crmSyncFieldValueSchema,
}).strict();

export const listCrmSyncConflictsQuerySchema = z.object({
  status: crmSyncConflictStatusSchema.optional().default("open"),
  kind: crmSyncConflictKindSchema.optional(),
  bindingId: z.string().guid().optional(),
  entityId: z.string().guid().optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
}).strict();

const decisionReasonSchema = z.string().trim().min(1).max(2_000);

/** Keep CRM, keep GSAM, or type a value. For a suggestion, keep_gsam accepts the suggested value. */
export const resolveCrmSyncConflictSchema = z.discriminatedUnion("resolution", [
  z.object({ resolution: z.literal("keep_crm"), reason: decisionReasonSchema.optional() }).strict(),
  z.object({ resolution: z.literal("keep_gsam"), reason: decisionReasonSchema.optional() }).strict(),
  z.object({ resolution: z.literal("custom"), value: crmSyncFieldValueSchema, reason: decisionReasonSchema.optional() }).strict(),
]);

/** An agent with Work cases proposes a resolution with a reason; a person accepts it. */
export const proposeCrmSyncConflictResolutionSchema = z.discriminatedUnion("resolution", [
  z.object({ resolution: z.literal("keep_crm"), reason: decisionReasonSchema }).strict(),
  z.object({ resolution: z.literal("keep_gsam"), reason: decisionReasonSchema }).strict(),
  z.object({ resolution: z.literal("custom"), value: crmSyncFieldValueSchema, reason: decisionReasonSchema }).strict(),
]);

export const acceptCrmSyncConflictProposalSchema = z.object({}).strict();

/**
 * A suggested change to a CRM-owned field. It waits in the review queue and is
 * written to the CRM only after a person accepts it. `bindingId` is needed only
 * when the case syncs with more than one source that maps the field.
 */
export const createCrmSyncSuggestionSchema = z.object({
  gsamField: crmSyncGsamFieldSchema,
  value: crmSyncFieldValueSchema,
  reason: decisionReasonSchema,
  bindingId: z.string().guid().optional(),
}).strict();

export const dismissCrmSyncConflictSchema = z.object({
  reason: z.string().trim().max(2_000).optional(),
}).strict();

export type CrmSyncStageMapEntry = z.infer<typeof crmSyncStageMapEntrySchema>;
export type CrmSyncFieldMapEntryInput = z.infer<typeof crmSyncFieldMapEntrySchema>;
export type ReplaceCrmSyncFieldMap = z.infer<typeof replaceCrmSyncFieldMapSchema>;
export type CreateCrmSyncBinding = z.infer<typeof createCrmSyncBindingSchema>;
export type UpdateCrmSyncBinding = z.infer<typeof updateCrmSyncBindingSchema>;
export type RunCrmSyncBinding = z.infer<typeof runCrmSyncBindingSchema>;
export type CrmSyncRecordLinkInput = z.infer<typeof crmSyncRecordLinkSchema>;
export type CrmSyncEventInput = z.infer<typeof crmSyncEventSchema>;
export type ListCrmSyncEventsQuery = z.infer<typeof listCrmSyncEventsQuerySchema>;
export type CrmSyncConflictInput = z.infer<typeof crmSyncConflictSchema>;
export type ListCrmSyncConflictsQuery = z.infer<typeof listCrmSyncConflictsQuerySchema>;
export type ResolveCrmSyncConflict = z.infer<typeof resolveCrmSyncConflictSchema>;
export type DismissCrmSyncConflict = z.infer<typeof dismissCrmSyncConflictSchema>;
export type ProposeCrmSyncConflictResolution = z.infer<typeof proposeCrmSyncConflictResolutionSchema>;
export type CreateCrmSyncSuggestion = z.infer<typeof createCrmSyncSuggestionSchema>;
