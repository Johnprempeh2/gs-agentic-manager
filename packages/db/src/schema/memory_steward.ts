import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { memoryScopes } from "./memory.js";

// Memory steward daily review (GRE-887). The steward reads memory records and
// writes only these tables; it never changes a record. Rollback: drop these
// five tables.

/** Scoped, expiring steward access, `sandbox` or `live` (GRE-933). Revoke by setting `revoked_at`. */
export const memoryStewardGrants = pgTable(
  "memory_steward_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    scopeIds: jsonb("scope_ids").$type<string[]>().notNull().default([]),
    /** `sandbox` (sandbox instance only) or `live` (John's grant, Greatstone scopes, max 30 days). */
    environment: text("environment").notNull().default("sandbox"),
    grantedByUserId: text("granted_by_user_id").notNull(),
    reason: text("reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("memory_steward_grants_company_agent_idx").on(table.companyId, table.agentId),
  }),
);

/** One row per company: the last record the review committed. */
export const memoryStewardCursors = pgTable("memory_steward_cursors", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  cursorUpdatedAt: timestamp("cursor_updated_at", { withTimezone: true }).notNull(),
  cursorRecordId: uuid("cursor_record_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One row per review pass. At most one `running` row per company (partial unique index). */
export const memoryStewardRuns = pgTable(
  "memory_steward_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    grantId: uuid("grant_id").references(() => memoryStewardGrants.id, { onDelete: "set null" }),
    /** `running` | `completed` | `interrupted` | `failed` */
    state: text("state").notNull().default("running"),
    claimToken: text("claim_token").notNull(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }).notNull(),
    until: timestamp("until", { withTimezone: true }).notNull(),
    cursorFrom: jsonb("cursor_from").$type<{ updatedAt: string; id: string } | null>(),
    cursorTo: jsonb("cursor_to").$type<{ updatedAt: string; id: string } | null>(),
    entriesSeen: integer("entries_seen").notNull().default(0),
    escalationsCreated: integer("escalations_created").notNull().default(0),
    escalationsDeduped: integer("escalations_deduped").notNull().default(0),
    /** Claude plan use by the review itself. Zero while the review uses no model. */
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    durationMs: integer("duration_ms"),
    resumedFromRunId: uuid("resumed_from_run_id"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => ({
    companyStartedIdx: index("memory_steward_runs_company_started_idx").on(table.companyId, table.startedAt),
    oneRunningUq: uniqueIndex("memory_steward_runs_one_running_uq")
      .on(table.companyId)
      .where(sql`${table.state} = 'running'`),
  }),
);

/** Decision queue for the steward's findings. Related findings share an open group. */
export const memoryStewardQueueItems = pgTable(
  "memory_steward_queue_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    groupKey: text("group_key").notNull(),
    /** `failed_ingestion` | `duplicate` | `stale` | `possible_contradiction` */
    kind: text("kind").notNull(),
    scopeId: uuid("scope_id").notNull().references(() => memoryScopes.id, { onDelete: "cascade" }),
    routeTo: jsonb("route_to").$type<Record<string, unknown>>().notNull(),
    sources: jsonb("sources").$type<Array<Record<string, unknown>>>().notNull().default([]),
    approvedPosition: jsonb("approved_position").$type<Array<{ recordId: string; title: string | null }>>().notNull().default([]),
    proposedResolution: text("proposed_resolution").notNull(),
    /** `open` | `resolved`. Only the owner resolves, through the review workflow. */
    state: text("state").notNull().default("open"),
    resolvedByUserId: text("resolved_by_user_id"),
    resolvedByAgentId: uuid("resolved_by_agent_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStateIdx: index("memory_steward_queue_items_company_state_idx").on(table.companyId, table.state),
    openGroupUq: uniqueIndex("memory_steward_queue_items_open_group_uq")
      .on(table.companyId, table.groupKey)
      .where(sql`${table.state} = 'open'`),
  }),
);

/** One row per escalation ever written. The unique key makes a repeat escalation a no-op. */
export const memoryStewardEscalations = pgTable(
  "memory_steward_escalations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** `${kind}:${recordId}:v${version}` */
    dedupeKey: text("dedupe_key").notNull(),
    queueItemId: uuid("queue_item_id")
      .notNull()
      .references(() => memoryStewardQueueItems.id, { onDelete: "cascade" }),
    recordId: uuid("record_id").notNull(),
    runId: uuid("run_id").references(() => memoryStewardRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    dedupeUq: uniqueIndex("memory_steward_escalations_dedupe_uq").on(table.companyId, table.dedupeKey),
  }),
);
