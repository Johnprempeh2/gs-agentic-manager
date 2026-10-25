import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issueWorkProducts } from "./issue_work_products.js";
import { issues } from "./issues.js";
import { pipelineCases, pipelineCaseStageDeliverables } from "./pipeline_cases.js";

// Deliverable publishing on Clients > Deliverables (GRE-2373, migration 0401),
// carried over from the website client portal (its migration 0037). A
// deliverable filed for a client goes draft → pending approval → approved →
// published → accepted, or is withdrawn. Submitting freezes one version and
// its content fingerprint; only a registered approver of the client approves
// it, and the database refuses a published row whose fingerprint is not the
// approved one. Every step is a row in client_deliverable_publication_events,
// which no one can change or remove.

export const CLIENT_DELIVERABLE_PUBLICATION_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "published",
  "accepted",
  "withdrawn",
] as const;

// The people who may approve a client's deliverables before they are
// published. Removing one sets removed_at, so the audit keeps who it was.
export const clientDeliverableApprovers = pgTable(
  "client_deliverable_approvers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull().references(() => pipelineCases.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedByUserId: text("removed_by_user_id"),
  },
  (table) => ({
    companyCaseIdx: index("client_deliverable_approvers_company_case_idx").on(table.companyId, table.caseId),
    activeUq: uniqueIndex("client_deliverable_approvers_active_uq")
      .on(table.caseId, table.userId)
      .where(sql`${table.removedAt} is null`),
  }),
);

export const clientDeliverablePublications = pgTable(
  "client_deliverable_publications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull().references(() => pipelineCases.id, { onDelete: "cascade" }),
    // The filing under a stage this started from; the deliverable is named by
    // its task and key, like the filing, and the version is pinned below.
    stageLinkId: uuid("stage_link_id").references(() => pipelineCaseStageDeliverables.id, { onDelete: "set null" }),
    deliverableIssueId: uuid("deliverable_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    deliverableKey: text("deliverable_key").notNull(),
    // The version frozen on submit (a draft follows the newest until then).
    workProductId: uuid("work_product_id").references(() => issueWorkProducts.id, { onDelete: "set null" }),
    version: integer("version"),
    title: text("title").notNull(),
    status: text("status").$type<(typeof CLIENT_DELIVERABLE_PUBLICATION_STATUSES)[number]>().notNull().default("draft"),
    // sha256 of the frozen version's content, set on submit.
    fingerprint: text("fingerprint"),
    approverUserId: text("approver_user_id"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submittedByUserId: text("submitted_by_user_id"),
    submittedByAgentId: uuid("submitted_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedByUserId: text("approved_by_user_id"),
    approvedFingerprint: text("approved_fingerprint"),
    rejectedReason: text("rejected_reason"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedByUserId: text("published_by_user_id"),
    publishedFingerprint: text("published_fingerprint"),
    // The client's acceptance link: only the token's hash is kept.
    acceptanceTokenHash: text("acceptance_token_hash"),
    acceptanceLinkCreatedAt: timestamp("acceptance_link_created_at", { withTimezone: true }),
    acceptanceLinkExpiresAt: timestamp("acceptance_link_expires_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedName: text("accepted_name"),
    acceptedRole: text("accepted_role"),
    acceptedEmail: text("accepted_email"),
    acceptedIp: text("accepted_ip"),
    acceptedUserAgent: text("accepted_user_agent"),
    // The receipt email sent on acceptance: not_sent until there is one to send.
    receiptStatus: text("receipt_status").$type<"not_sent" | "sent" | "failed" | "not_configured">().notNull().default("not_sent"),
    receiptSentAt: timestamp("receipt_sent_at", { withTimezone: true }),
    receiptMessageId: text("receipt_message_id"),
    receiptError: text("receipt_error"),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    withdrawnReason: text("withdrawn_reason"),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCaseIdx: index("client_deliverable_publications_company_case_idx").on(table.companyId, table.caseId),
    companyStatusIdx: index("client_deliverable_publications_company_status_idx").on(table.companyId, table.status),
    tokenHashUq: uniqueIndex("client_deliverable_publications_token_hash_uq")
      .on(table.acceptanceTokenHash)
      .where(sql`${table.acceptanceTokenHash} is not null`),
    // One live publication per deliverable per client; a withdrawn one makes room for the next.
    liveUq: uniqueIndex("client_deliverable_publications_live_uq")
      .on(table.caseId, table.deliverableIssueId, table.deliverableKey)
      .where(sql`${table.status} <> 'withdrawn'`),
    statusCheck: check(
      "client_deliverable_publications_status_check",
      sql`${table.status} in ('draft', 'pending_approval', 'approved', 'published', 'accepted', 'withdrawn')`,
    ),
    receiptStatusCheck: check(
      "client_deliverable_publications_receipt_status_check",
      sql`${table.receiptStatus} in ('not_sent', 'sent', 'failed', 'not_configured')`,
    ),
    // Past draft, the version and its fingerprint are frozen and an approver is named.
    frozenCheck: check(
      "client_deliverable_publications_frozen_check",
      sql`${table.status} in ('draft', 'withdrawn')
        or (${table.workProductId} is not null and ${table.fingerprint} is not null and ${table.approverUserId} is not null)`,
    ),
    // Approved by the named approver, for the frozen content.
    approvedCheck: check(
      "client_deliverable_publications_approved_check",
      sql`${table.status} not in ('approved', 'published', 'accepted')
        or (${table.approvedByUserId} is not null and ${table.approvedFingerprint} is not null
          and ${table.approvedByUserId} = ${table.approverUserId} and ${table.approvedFingerprint} = ${table.fingerprint})`,
    ),
    // Published content is exactly the approved content.
    publishedCheck: check(
      "client_deliverable_publications_published_check",
      sql`${table.status} not in ('published', 'accepted')
        or (${table.publishedAt} is not null and ${table.publishedFingerprint} is not null
          and ${table.publishedFingerprint} = ${table.approvedFingerprint})`,
    ),
    acceptedCheck: check(
      "client_deliverable_publications_accepted_check",
      sql`${table.status} <> 'accepted' or (${table.acceptedAt} is not null and ${table.acceptedEmail} is not null)`,
    ),
  }),
);

// The audit trail. The client_deliverable_audit_guard trigger refuses every
// update and delete; rows go only when their client or company is removed. A
// publication itself cannot be deleted either (it is withdrawn instead).
export const clientDeliverablePublicationEvents = pgTable(
  "client_deliverable_publication_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull().references(() => pipelineCases.id, { onDelete: "cascade" }),
    publicationId: uuid("publication_id").notNull().references(() => clientDeliverablePublications.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    actorType: text("actor_type").notNull(),
    actorUserId: text("actor_user_id"),
    actorAgentId: uuid("actor_agent_id"),
    runId: uuid("run_id"),
    fingerprint: text("fingerprint"),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    publicationIdx: index("client_deliverable_publication_events_publication_idx").on(table.publicationId, table.createdAt),
    companyCaseIdx: index("client_deliverable_publication_events_company_case_idx").on(table.companyId, table.caseId),
    actorTypeCheck: check(
      "client_deliverable_publication_events_actor_type_check",
      sql`${table.actorType} in ('user', 'agent', 'client', 'system')`,
    ),
  }),
);
