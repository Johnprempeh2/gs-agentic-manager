import { pgTable, uuid, text, timestamp, index, integer, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { assets } from "./assets.js";
import { issues } from "./issues.js";
import { organisations } from "./organisations.js";
import { generatedImages } from "./generated_images.js";

// Clips made in the image studio, from a description or by animating a
// finished studio image. The clip itself is an ordinary company asset; this
// row keeps the request and how it went, so the studio can show and retry it.
export const generatedVideos = pgTable(
  "generated_videos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    prompt: text("prompt").notNull(),
    /** A video model id from VIDEO_MODELS in @greatstone/shared. */
    model: text("model").notNull(),
    provider: text("provider").notNull(),
    durationSeconds: integer("duration_seconds").notNull(),
    /** A motion preset id; its words were added to the prompt sent. */
    motion: text("motion"),
    camera: jsonb("camera").$type<{ camera?: string; lens?: string; focalLength?: number; aperture?: string }>(),
    sourceImageId: uuid("source_image_id").references(() => generatedImages.id, { onDelete: "set null" }),
    status: text("status").notNull().default("pending"),
    error: text("error"),
    providerRequestId: text("provider_request_id"),
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    organisationId: uuid("organisation_id").references(() => organisations.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    companyCreatedIdx: index("generated_videos_company_created_idx").on(table.companyId, table.createdAt),
    companyStatusIdx: index("generated_videos_company_status_idx").on(table.companyId, table.status),
    companyIssueIdx: index("generated_videos_company_issue_idx").on(table.companyId, table.issueId),
  }),
);
