import { pgTable, uuid, text, timestamp, index, boolean, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { assets } from "./assets.js";
import { issues } from "./issues.js";
import { organisations } from "./organisations.js";

// Images made from a written description (image generation). The picture
// itself is an ordinary company asset; this row keeps the prompt, the shape,
// the provider and how the request went, so the gallery can show and retry it.
export const generatedImages = pgTable(
  "generated_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    prompt: text("prompt").notNull(),
    aspectRatio: text("aspect_ratio").notNull(),
    /** A style preset id; its guidance was added to the prompt sent to the provider. */
    style: text("style"),
    /** Cinema camera picks from the image studio; their wording was added to the prompt sent. */
    camera: jsonb("camera").$type<{ camera?: string; lens?: string; focalLength?: number; aperture?: string }>(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    status: text("status").notNull().default("pending"),
    error: text("error"),
    providerRequestId: text("provider_request_id"),
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    organisationId: uuid("organisation_id").references(() => organisations.id, { onDelete: "set null" }),
    /** Shown on the linked task's card; at most one per task. */
    issueCover: boolean("issue_cover").notNull().default(false),
    /** Shown on the linked client's card; at most one per client. */
    organisationCover: boolean("organisation_cover").notNull().default(false),
    /** Starred by the board or an agent as a keeper, so the best takes are easy to find. */
    favourite: boolean("favourite").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    companyCreatedIdx: index("generated_images_company_created_idx").on(table.companyId, table.createdAt),
    companyStatusIdx: index("generated_images_company_status_idx").on(table.companyId, table.status),
    companyIssueIdx: index("generated_images_company_issue_idx").on(table.companyId, table.issueId),
    companyOrganisationIdx: index("generated_images_company_organisation_idx").on(table.companyId, table.organisationId),
    companyFavouriteIdx: index("generated_images_company_favourite_idx").on(table.companyId, table.favourite),
  }),
);
