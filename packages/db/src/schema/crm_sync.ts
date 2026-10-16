// CRM sync (GRE-1100, contract in doc/CRM-SYNC-CONTRACT.md). A binding links one
// external container (a CRM pipeline) on a company connection to one GSAM
// pipeline. Credentials stay on the connection; these tables never hold them.
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { CrmSyncChangeAuthor, CrmSyncChangedField, CrmSyncFieldValue, CrmSyncStageMapping } from "@greatstone/shared";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { pipelines } from "./pipelines.js";
import { toolConnections } from "./tool_access.js";

/**
 * Wraps a field value so "never synced" (SQL null) differs from a synced
 * empty value (`{ value: null }`).
 */
export type CrmSyncStoredValue = { value: CrmSyncFieldValue };

export const crmSyncBindings = pgTable(
  "crm_sync_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull().references(() => toolConnections.id, { onDelete: "cascade" }),
    providerKey: text("provider_key").notNull(),
    containerKind: text("container_kind").notNull(),
    externalContainerId: text("external_container_id").notNull(),
    externalContainerLabel: text("external_container_label"),
    pipelineId: uuid("pipeline_id").notNull().references(() => pipelines.id, { onDelete: "cascade" }),
    direction: text("direction").notNull().default("both"),
    status: text("status").notNull().default("active"),
    stageMap: jsonb("stage_map").$type<CrmSyncStageMapping[]>().notNull().default([]),
    /** Adapter-owned poll state (cursor, last seen update time). Never holds credentials. */
    syncState: jsonb("sync_state").$type<Record<string, unknown>>().notNull().default({}),
    nextSyncAt: timestamp("next_sync_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastErrorMessage: text("last_error_message"),
    fieldMapUpdatedAt: timestamp("field_map_updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: text("created_by_user_id"),
    /** Set by DELETE. The binding stops syncing; its log, links and resolved conflicts stay. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    containerUq: uniqueIndex("crm_sync_bindings_container_uq")
      .on(table.companyId, table.connectionId, table.containerKind, table.externalContainerId)
      .where(sql`${table.deletedAt} is null`),
    companyIdx: index("crm_sync_bindings_company_idx").on(table.companyId, table.createdAt),
    pipelineIdx: index("crm_sync_bindings_pipeline_idx").on(table.pipelineId),
    dueIdx: index("crm_sync_bindings_due_idx").on(table.nextSyncAt).where(sql`${table.deletedAt} is null`),
    containerKindCheck: check("crm_sync_bindings_container_kind_check", sql`${table.containerKind} in ('crm_pipeline', 'notion_database')`),
    directionCheck: check("crm_sync_bindings_direction_check", sql`${table.direction} in ('both', 'inbound_only', 'outbound_only')`),
    statusCheck: check("crm_sync_bindings_status_check", sql`${table.status} in ('active', 'paused', 'error')`),
  }),
);

export const crmSyncFieldMaps = pgTable(
  "crm_sync_field_maps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    bindingId: uuid("binding_id").notNull().references(() => crmSyncBindings.id, { onDelete: "cascade" }),
    externalField: text("external_field").notNull(),
    externalFieldLabel: text("external_field_label"),
    gsamField: text("gsam_field").notNull(),
    owner: text("owner").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    externalFieldUq: uniqueIndex("crm_sync_field_maps_external_field_uq").on(table.bindingId, table.externalField),
    gsamFieldUq: uniqueIndex("crm_sync_field_maps_gsam_field_uq").on(table.bindingId, table.gsamField),
    companyIdx: index("crm_sync_field_maps_company_idx").on(table.companyId),
    ownerCheck: check("crm_sync_field_maps_owner_check", sql`${table.owner} in ('crm', 'gsam', 'shared')`),
  }),
);

// External id held by a GSAM case or contact, one per source (connection).
// entity_id points at pipeline_cases or pipeline_case_contacts by entity_kind.
export const crmSyncRecordLinks = pgTable(
  "crm_sync_record_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    entityKind: text("entity_kind").notNull(),
    entityId: uuid("entity_id").notNull(),
    connectionId: uuid("connection_id").notNull().references(() => toolConnections.id, { onDelete: "cascade" }),
    providerKey: text("provider_key").notNull(),
    externalId: text("external_id").notNull(),
    /** Last value both sides agreed on, keyed by GSAM field. The base for the three-value rule. */
    lastSyncedValues: jsonb("last_synced_values").$type<Record<string, CrmSyncFieldValue>>().notNull().default({}),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    entitySourceUq: uniqueIndex("crm_sync_record_links_entity_source_uq").on(table.entityKind, table.entityId, table.connectionId),
    externalUq: uniqueIndex("crm_sync_record_links_external_uq").on(table.connectionId, table.entityKind, table.externalId),
    companyEntityIdx: index("crm_sync_record_links_company_entity_idx").on(table.companyId, table.entityId),
    entityKindCheck: check("crm_sync_record_links_entity_kind_check", sql`${table.entityKind} in ('case', 'contact')`),
  }),
);

export const crmSyncConflicts = pgTable(
  "crm_sync_conflicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    bindingId: uuid("binding_id").notNull().references(() => crmSyncBindings.id, { onDelete: "cascade" }),
    /** `conflict` (both sides changed a shared field) or `suggestion` (a change to a CRM-owned field). */
    kind: text("kind").notNull().default("conflict"),
    entityKind: text("entity_kind").notNull(),
    entityId: uuid("entity_id").notNull(),
    externalId: text("external_id").notNull(),
    gsamField: text("gsam_field").notNull(),
    externalField: text("external_field").notNull(),
    /** Null when the field was never synced. */
    lastSyncedValue: jsonb("last_synced_value").$type<CrmSyncStoredValue>(),
    crmValue: jsonb("crm_value").$type<CrmSyncStoredValue>().notNull(),
    gsamValue: jsonb("gsam_value").$type<CrmSyncStoredValue>().notNull(),
    /** The CRM record's own update time when the conflict was found. */
    crmChangedAt: timestamp("crm_changed_at", { withTimezone: true }),
    /** Who changed the GSAM side since the last sync; the suggester for a suggestion. */
    gsamChangedBy: jsonb("gsam_changed_by").$type<CrmSyncChangeAuthor[]>().notNull().default([]),
    gsamChangedAt: timestamp("gsam_changed_at", { withTimezone: true }),
    /** Why a suggestion was made. */
    reason: text("reason"),
    proposedResolution: text("proposed_resolution"),
    proposedValue: jsonb("proposed_value").$type<CrmSyncStoredValue>(),
    proposalReason: text("proposal_reason"),
    proposedByAgentId: uuid("proposed_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    proposedByUserId: text("proposed_by_user_id"),
    proposedAt: timestamp("proposed_at", { withTimezone: true }),
    status: text("status").notNull().default("open"),
    resolution: text("resolution"),
    resolvedValue: jsonb("resolved_value").$type<CrmSyncStoredValue>(),
    resolutionReason: text("resolution_reason"),
    dismissReason: text("dismiss_reason"),
    resolvedByUserId: text("resolved_by_user_id"),
    resolvedByAgentId: uuid("resolved_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    openFieldUq: uniqueIndex("crm_sync_conflicts_open_field_uq")
      .on(table.bindingId, table.entityKind, table.entityId, table.gsamField)
      .where(sql`${table.status} = 'open'`),
    companyStatusIdx: index("crm_sync_conflicts_company_status_idx").on(table.companyId, table.status, table.detectedAt),
    bindingStatusIdx: index("crm_sync_conflicts_binding_status_idx").on(table.bindingId, table.status),
    entityKindCheck: check("crm_sync_conflicts_entity_kind_check", sql`${table.entityKind} in ('case', 'contact')`),
    kindCheck: check("crm_sync_conflicts_kind_check", sql`${table.kind} in ('conflict', 'suggestion')`),
    proposedResolutionCheck: check(
      "crm_sync_conflicts_proposed_resolution_check",
      sql`${table.proposedResolution} is null or ${table.proposedResolution} in ('keep_crm', 'keep_gsam', 'custom')`,
    ),
    statusCheck: check("crm_sync_conflicts_status_check", sql`${table.status} in ('open', 'resolved', 'dismissed')`),
    resolutionCheck: check(
      "crm_sync_conflicts_resolution_check",
      sql`${table.resolution} is null or ${table.resolution} in ('keep_crm', 'keep_gsam', 'custom')`,
    ),
  }),
);

/** The sync log: one line per record per pass. Written by the server only. */
export const crmSyncEvents = pgTable(
  "crm_sync_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    bindingId: uuid("binding_id").notNull().references(() => crmSyncBindings.id, { onDelete: "cascade" }),
    direction: text("direction").notNull(),
    action: text("action").notNull(),
    entityKind: text("entity_kind").notNull(),
    entityId: uuid("entity_id"),
    externalId: text("external_id").notNull(),
    changedFields: jsonb("changed_fields").$type<CrmSyncChangedField[]>().notNull().default([]),
    conflictId: uuid("conflict_id").references(() => crmSyncConflicts.id, { onDelete: "set null" }),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    bindingCreatedIdx: index("crm_sync_events_binding_created_idx").on(table.bindingId, table.createdAt, table.id),
    companyEntityIdx: index("crm_sync_events_company_entity_idx").on(table.companyId, table.entityId),
    directionCheck: check("crm_sync_events_direction_check", sql`${table.direction} in ('inbound', 'outbound')`),
    actionCheck: check(
      "crm_sync_events_action_check",
      sql`${table.action} in ('created', 'updated', 'unchanged', 'conflict', 'failed')`,
    ),
    entityKindCheck: check("crm_sync_events_entity_kind_check", sql`${table.entityKind} in ('case', 'contact')`),
  }),
);
