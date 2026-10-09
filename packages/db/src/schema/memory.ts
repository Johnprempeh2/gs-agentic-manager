import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

// Organization memory (GRE-672, ADR-0001). GSAM owns the governance record;
// the engine (Hindsight) owns content and retrieval. Every engine document id
// is a `memory_records.id`. Rollback: drop these four tables.
// Phase 2 (GRE-886) adds the review, relationship, conflict and extracted-fact
// stores below; see migration 0297 for its rollback.

/** One row per company. Memory is off until an admin turns it on. */
export const memorySettings = pgTable("memory_settings", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  /** `extract`: engine pulls facts and entities with a model. `chunks`: stored as-is, no model. */
  retainMode: text("retain_mode").notNull().default("extract"),
  updatedByUserId: text("updated_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A place memory lives. Client and restricted-project scopes get their own
 * engine bank; organization, project and agent scopes are strict tags inside
 * the company bank.
 */
export const memoryScopes = pgTable(
  "memory_scopes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    bankId: text("bank_id").notNull(),
    tag: text("tag").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("memory_scopes_company_idx").on(table.companyId),
    companyTagUq: uniqueIndex("memory_scopes_company_tag_uq").on(table.companyId, table.tag),
  }),
);

export const memoryRecords = pgTable(
  "memory_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id").notNull().references(() => memoryScopes.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("source_statement"),
    /** Review state: `unreviewed`, `approved`, `disputed`, `superseded`, `deleted` (GRE-886). */
    status: text("status").notNull(),
    /** What the contributor offered: `proposal` or `observation`. */
    entryType: text("entry_type").notNull().default("proposal"),
    /** Decides who may approve: `operational`, or `pricing`/`policy`/`legal`/`client_commitment` (John only). */
    decisionClass: text("decision_class").notNull().default("operational"),
    sensitivity: text("sensitivity").notNull().default("internal"),
    title: text("title"),
    /** Null once the record is deleted (tombstone). */
    content: text("content"),
    entities: jsonb("entities").$type<string[]>().notNull().default([]),
    topics: jsonb("topics").$type<string[]>().notNull().default([]),
    contributorAgentId: uuid("contributor_agent_id").references(() => agents.id, { onDelete: "set null" }),
    contributorUserId: text("contributor_user_id"),
    runId: uuid("run_id"),
    sourceKind: text("source_kind"),
    sourceId: text("source_id"),
    evidence: jsonb("evidence").$type<Record<string, unknown> | null>(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    supersedesId: uuid("supersedes_id"),
    supersededById: uuid("superseded_by_id"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    /** Last recall or read; working notes expire 90 days after it (G1 decision 7). */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    retainMode: text("retain_mode").notNull(),
    /** `pending` until the engine has the document; Ridge's outbox (GRE-673) retries these. */
    syncState: text("sync_state").notNull().default("pending"),
    syncError: text("sync_error"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    companyScopeIdx: index("memory_records_company_scope_idx").on(table.companyId, table.scopeId),
    companySyncIdx: index("memory_records_company_sync_idx").on(table.companyId, table.syncState),
    companyStatusIdx: index("memory_records_company_status_idx").on(table.companyId, table.status),
    companyUpdatedIdx: index("memory_records_company_updated_idx").on(table.companyId, table.updatedAt),
  }),
);

/** Append-only ledger of every gateway call, allowed or not. */
export const memoryOperations = pgTable(
  "memory_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    operation: text("operation").notNull(),
    outcome: text("outcome").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    agentId: uuid("agent_id"),
    runId: uuid("run_id"),
    /** The app the call came through and its session (GRE-1079); see `MemoryCallerApp`. */
    app: text("app"),
    sessionId: text("session_id"),
    scopeIds: jsonb("scope_ids").$type<string[]>().notNull().default([]),
    recordId: uuid("record_id"),
    detail: jsonb("detail").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("memory_operations_company_created_idx").on(table.companyId, table.createdAt),
  }),
);

/**
 * Who reviewed a record, how and why (GRE-886, plan 8.5). Append-only, kept
 * apart from the record so the history survives supersession and deletion.
 */
export const memoryReviewEvents = pgTable(
  "memory_review_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    recordId: uuid("record_id").notNull().references(() => memoryRecords.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id").notNull(),
    /** `contribute`, `approve`, `dispute`, `supersede`, `superseded_by`, `conflict_flagged`, `conflict_resolved`, `delete` */
    action: text("action").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    agentId: uuid("agent_id"),
    userId: text("user_id"),
    runId: uuid("run_id"),
    /** The app the person or agent acted through and its session (GRE-1079); see `MemoryCallerApp`. */
    app: text("app"),
    sessionId: text("session_id"),
    reason: text("reason"),
    relatedRecordId: uuid("related_record_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRecordIdx: index("memory_review_events_company_record_idx").on(table.companyId, table.recordId, table.createdAt),
    companyCreatedIdx: index("memory_review_events_company_created_idx").on(table.companyId, table.createdAt),
  }),
);

/**
 * Relationships a contributor or reviewer stated. Never inferred. `scope_id` is
 * the scope of the `from` record. Both ends sit in one scope, except that two
 * scopes that are not client or restricted scopes may be linked (memory
 * linking, 6 Oct 2026); every read checks both ends against the reader.
 */
export const memoryRelationships = pgTable(
  "memory_relationships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id").notNull().references(() => memoryScopes.id, { onDelete: "cascade" }),
    fromRecordId: uuid("from_record_id").notNull().references(() => memoryRecords.id, { onDelete: "cascade" }),
    toRecordId: uuid("to_record_id").notNull().references(() => memoryRecords.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    authorAgentId: uuid("author_agent_id"),
    authorUserId: text("author_user_id"),
    runId: uuid("run_id"),
    sourceKind: text("source_kind"),
    sourceId: text("source_id"),
    /** Cleared when either end is deleted. */
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    edgeUq: uniqueIndex("memory_relationships_edge_uq").on(table.fromRecordId, table.toRecordId, table.type),
    companyFromIdx: index("memory_relationships_company_from_idx").on(table.companyId, table.fromRecordId),
    companyToIdx: index("memory_relationships_company_to_idx").on(table.companyId, table.toRecordId),
  }),
);

/**
 * A possible conflict between a record and the approved record it may
 * contradict. Detection is fallible; a row is a lead for a reviewer, not proof.
 */
export const memoryConflicts = pgTable(
  "memory_conflicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    scopeId: uuid("scope_id").notNull().references(() => memoryScopes.id, { onDelete: "cascade" }),
    recordId: uuid("record_id").notNull().references(() => memoryRecords.id, { onDelete: "cascade" }),
    /** The current approved position the record may contradict. */
    approvedRecordId: uuid("approved_record_id").notNull().references(() => memoryRecords.id, { onDelete: "cascade" }),
    /** `contribution_check` | `relationship` */
    origin: text("origin").notNull(),
    /** The entity or topic names both records share. Cleared on delete. */
    sharedTerms: jsonb("shared_terms").$type<string[]>().notNull().default([]),
    /** `open` | `resolved` */
    state: text("state").notNull().default("open"),
    resolution: text("resolution"),
    resolutionNote: text("resolution_note"),
    resolvedByActorType: text("resolved_by_actor_type"),
    resolvedByActorId: text("resolved_by_actor_id"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => ({
    pairUq: uniqueIndex("memory_conflicts_pair_uq").on(table.recordId, table.approvedRecordId),
    companyStateIdx: index("memory_conflicts_company_state_idx").on(table.companyId, table.state),
    companyApprovedIdx: index("memory_conflicts_company_approved_idx").on(table.companyId, table.approvedRecordId),
  }),
);

/** What two records share, as found by the link check. Cleared when either end is deleted. */
export type MemoryLinkBasisRow = {
  entities: string[];
  topics: string[];
  values: string[];
  sameSource: boolean;
};

/**
 * Possible links found by the link check (memory linking, 6 Oct 2026). A lead
 * for a reviewer, never a stated relationship: confirming one writes a
 * `memory_relationships` row with the reviewer as author. One row per pair of
 * records, stored in id order, so a dismissed pair is never proposed again.
 * Rollback: drop this table (migration 0298).
 */
export const memoryLinkLeads = pgTable(
  "memory_link_leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    fromRecordId: uuid("from_record_id").notNull().references(() => memoryRecords.id, { onDelete: "cascade" }),
    toRecordId: uuid("to_record_id").notNull().references(() => memoryRecords.id, { onDelete: "cascade" }),
    fromScopeId: uuid("from_scope_id").notNull().references(() => memoryScopes.id, { onDelete: "cascade" }),
    toScopeId: uuid("to_scope_id").notNull().references(() => memoryScopes.id, { onDelete: "cascade" }),
    basis: jsonb("basis").$type<MemoryLinkBasisRow>().notNull(),
    /** How much the pair shares; orders leads for a reviewer. Not a measure of truth. */
    score: integer("score").notNull().default(0),
    /** `open` | `confirmed` | `dismissed` */
    state: text("state").notNull().default("open"),
    resolution: text("resolution"),
    resolutionNote: text("resolution_note"),
    resolvedByActorType: text("resolved_by_actor_type"),
    resolvedByActorId: text("resolved_by_actor_id"),
    /** The stated relationship written when the lead was confirmed. */
    relationshipId: uuid("relationship_id").references(() => memoryRelationships.id, { onDelete: "set null" }),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => ({
    pairUq: uniqueIndex("memory_link_leads_pair_uq").on(table.fromRecordId, table.toRecordId),
    companyStateIdx: index("memory_link_leads_company_state_idx").on(table.companyId, table.state),
    companyToIdx: index("memory_link_leads_company_to_idx").on(table.companyId, table.toRecordId),
  }),
);

/**
 * Engine-extracted facts seen by the gateway, linked to the record and the
 * contributor they came from (plan 8.5). Ids only, never fact text.
 */
export const memoryExtractedFacts = pgTable(
  "memory_extracted_facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    recordId: uuid("record_id").notNull().references(() => memoryRecords.id, { onDelete: "cascade" }),
    bankId: text("bank_id").notNull(),
    engineUnitId: text("engine_unit_id").notNull(),
    factType: text("fact_type"),
    contributorAgentId: uuid("contributor_agent_id"),
    contributorUserId: text("contributor_user_id"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    unitUq: uniqueIndex("memory_extracted_facts_unit_uq").on(table.companyId, table.bankId, table.engineUnitId),
    companyRecordIdx: index("memory_extracted_facts_company_record_idx").on(table.companyId, table.recordId),
  }),
);
