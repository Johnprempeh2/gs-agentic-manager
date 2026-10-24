import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { assets } from "./assets.js";

// The Animation Lab's motion studies in GS Studio (GRE-2212). The study page
// itself is an ordinary company asset; this row is its catalogue entry and the
// decisions on it. Status and Decision are set by people; an agent's change is
// held in the proposed_* columns until a person accepts or declines it.
export const motionStudies = pgTable(
  "motion_studies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    /** The Lab's running number, zero padded, for example "021". */
    number: text("number").notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    concept: text("concept").notNull().default(""),
    theme: jsonb("theme").$type<string[]>().notNull().default([]),
    tech: text("tech").notNull().default(""),
    notes: text("notes"),
    /** YYYY-MM-DD, the day the study was made. */
    studyDate: text("study_date"),
    sourceUrl: text("source_url"),
    textSafe: boolean("text_safe").notNull().default(false),
    status: text("status").notNull().default("new"),
    decision: text("decision").notNull().default("undecided"),
    proposedStatus: text("proposed_status"),
    proposedDecision: text("proposed_decision"),
    proposalReason: text("proposal_reason"),
    proposedByAgentId: uuid("proposed_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    proposedAt: timestamp("proposed_at", { withTimezone: true }),
    /** lab_import, routine or manual. */
    source: text("source").notNull().default("manual"),
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
    /** A still frame of the study, shown on its card. */
    posterAssetId: uuid("poster_asset_id").references(() => assets.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySlugUq: uniqueIndex("motion_studies_company_slug_uq").on(table.companyId, table.slug),
    companyNumberIdx: index("motion_studies_company_number_idx").on(table.companyId, table.number),
    companyStatusIdx: index("motion_studies_company_status_idx").on(table.companyId, table.status),
  }),
);
