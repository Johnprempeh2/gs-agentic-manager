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
    status: text("status").notNull(),
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
    scopeIds: jsonb("scope_ids").$type<string[]>().notNull().default([]),
    recordId: uuid("record_id"),
    detail: jsonb("detail").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("memory_operations_company_created_idx").on(table.companyId, table.createdAt),
  }),
);
