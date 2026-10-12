import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { chatEndpoints } from "./chat_channels.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";

/**
 * One client support queue (GRE-665): a client code, the project its tickets
 * land in, the email inbox that feeds it, and who owns each kind of ticket.
 * Client codes only; client names never appear here.
 */
export const supportQueues = pgTable(
  "support_queues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    clientCode: text("client_code").notNull(),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    emailEndpointId: uuid("email_endpoint_id").references(() => chatEndpoints.id, { onDelete: "set null" }),
    triageAgentId: uuid("triage_agent_id").notNull().references(() => agents.id),
    installAgentId: uuid("install_agent_id").references(() => agents.id, { onDelete: "set null" }),
    reliabilityAgentId: uuid("reliability_agent_id").references(() => agents.id, { onDelete: "set null" }),
    coverAgentId: uuid("cover_agent_id").references(() => agents.id, { onDelete: "set null" }),
    p1UserId: text("p1_user_id"),
    holidays: jsonb("holidays").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("support_queues_company_code_uq").on(t.companyId, t.clientCode),
    uniqueIndex("support_queues_email_endpoint_uq")
      .on(t.emailEndpointId)
      .where(sql`${t.emailEndpointId} is not null`),
    check("support_queues_client_code_check", sql`${t.clientCode} ~ '^[A-Z0-9]{2,12}$'`),
  ],
);

/** The first-response clock for one support ticket (one issue). */
export const supportTickets = pgTable(
  "support_tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    queueId: uuid("queue_id").notNull().references(() => supportQueues.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    priority: text("priority").$type<"P1" | "P2" | "P3">().notNull(),
    category: text("category").$type<"general" | "install" | "reliability">().notNull().default("general"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    warnAt: timestamp("warn_at", { withTimezone: true }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    firstResponseAt: timestamp("first_response_at", { withTimezone: true }),
    warnedAt: timestamp("warned_at", { withTimezone: true }),
    breachedAt: timestamp("breached_at", { withTimezone: true }),
    p1AlertedAt: timestamp("p1_alerted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("support_tickets_issue_uq").on(t.issueId),
    index("support_tickets_open_idx")
      .on(t.companyId, t.dueAt)
      .where(sql`${t.firstResponseAt} is null`),
    check("support_tickets_priority_check", sql`${t.priority} in ('P1', 'P2', 'P3')`),
    check("support_tickets_category_check", sql`${t.category} in ('general', 'install', 'reliability')`),
  ],
);
