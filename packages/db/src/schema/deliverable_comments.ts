import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { DeliverableCommentLocator } from "@greatstone/shared";
import { companies } from "./companies.js";
import { issueComments } from "./issue_comments.js";
import { issueWorkProducts } from "./issue_work_products.js";
import { issues } from "./issues.js";

/**
 * Notes a board user pins to a passage of one deliverable version (GRE-982).
 * Drafts belong to their author until "Send comments" posts them together as
 * one task comment; then they are read only. A new version starts with none.
 * Since GRE-1223 a note can also pin to an element or a drawn region: then
 * `anchor_kind` says which, `locator` finds it again and `quote` is a label.
 */
export const deliverableComments = pgTable(
  "deliverable_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workProductId: uuid("work_product_id")
      .notNull()
      .references(() => issueWorkProducts.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    anchorKind: text("anchor_kind").notNull().default("text"),
    quote: text("quote").notNull(),
    prefix: text("prefix"),
    suffix: text("suffix"),
    textStart: integer("text_start"),
    locator: jsonb("locator").$type<DeliverableCommentLocator>(),
    body: text("body").notNull(),
    status: text("status").notNull().default("draft"),
    authorUserId: text("author_user_id").notNull(),
    sentCommentId: uuid("sent_comment_id").references(() => issueComments.id, { onDelete: "set null" }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyWorkProductIdx: index("deliverable_comments_company_work_product_idx").on(
      table.companyId,
      table.workProductId,
      table.createdAt,
    ),
  }),
);
