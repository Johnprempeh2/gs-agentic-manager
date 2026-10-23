import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";
import { documents } from "./documents.js";
import { documentRevisions } from "./document_revisions.js";
import { approvals } from "./approvals.js";
import { websiteProperties } from "./website.js";

/**
 * Website module (GRE-1914 ADR section 2, GRE-2105). GSAM holds the site's
 * content; pages and entries keep their JSON in `documents` +
 * `document_revisions`. Every child row carries a composite foreign key
 * `(company_id, site_id) -> website_site(company_id, id)`, so a row can never
 * point at another company's site.
 */
export const websiteSite = pgTable(
  "website_site",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    domain: text("domain").notNull(),
    repoUrl: text("repo_url"),
    netlifySiteId: text("netlify_site_id").notNull(),
    /** The site's own Netlify token lives only in the vault. */
    netlifyTokenSecretId: uuid("netlify_token_secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    blobsStoreName: text("blobs_store_name").notNull().default("gsam-content"),
    engineVersion: text("engine_version"),
    releaseSchemaVersion: integer("release_schema_version").notNull().default(1),
    theme: jsonb("theme").$type<Record<string, unknown>>().notNull().default({}),
    propertyId: uuid("property_id").references(() => websiteProperties.id, { onDelete: "set null" }),
    editorOrigins: text("editor_origins").array().notNull().default(sql`'{}'::text[]`),
    /**
     * The frame's own origin: the dedicated editor host that serves `/editor`
     * and `/preview` (GRE-1916 contract section 2, rules C1 and C2). Null
     * until a person with website:publish sets it; GSAM opens no editor until then.
     */
    editorFrameOrigin: text("editor_frame_origin"),
    checkPaths: jsonb("check_paths").$type<string[]>().notNull().default(["/"]),
    liveReleaseId: uuid("live_release_id"),
    publishLeaseId: uuid("publish_lease_id"),
    publishLeaseKind: text("publish_lease_kind"),
    publishLeaseExpiresAt: timestamp("publish_lease_expires_at", { withTimezone: true }),
    publishFence: bigint("publish_fence", { mode: "number" }).notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("website_site_company_id_uq").on(t.companyId, t.id),
    uniqueIndex("website_site_company_domain_uq").on(t.companyId, t.domain),
    index("website_site_property_idx").on(t.propertyId),
  ],
);

export const websitePage = pgTable(
  "website_page",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    siteId: uuid("site_id").notNull(),
    /** The page's URL path on the site, e.g. `/` or `/consultancy/deep-dive`. */
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    navOrder: integer("nav_order"),
    /** Sitemap parent (same site); null = top level. */
    parentPageId: uuid("parent_page_id"),
    menu: text("menu").notNull().default("none"),
    menuOrder: integer("menu_order"),
    /** planned (in the sitemap, no content yet), draft, review, approved, published. */
    status: text("status").notNull().default("draft"),
    seo: jsonb("seo").$type<Record<string, unknown>>().notNull().default({}),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "restrict" }),
    approvedRevisionId: uuid("approved_revision_id").references(() => documentRevisions.id, { onDelete: "set null" }),
    publishedRevisionId: uuid("published_revision_id").references(() => documentRevisions.id, { onDelete: "set null" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("website_page_company_id_uq").on(t.companyId, t.id),
    unique("website_page_company_site_id_uq").on(t.companyId, t.siteId, t.id),
    foreignKey({
      columns: [t.companyId, t.siteId],
      foreignColumns: [websiteSite.companyId, websiteSite.id],
      name: "website_page_company_site_fk",
    }).onDelete("cascade"),
    // The parent must be a page of the same site and company.
    foreignKey({
      columns: [t.companyId, t.siteId, t.parentPageId],
      foreignColumns: [t.companyId, t.siteId, t.id],
      name: "website_page_parent_fk",
    }),
    uniqueIndex("website_page_site_slug_live_uq")
      .on(t.companyId, t.siteId, t.slug)
      .where(sql`${t.archivedAt} is null`),
    uniqueIndex("website_page_document_uq").on(t.documentId),
    index("website_page_site_parent_idx").on(t.siteId, t.parentPageId),
    check("website_page_status_chk", sql`${t.status} in ('planned', 'draft', 'review', 'approved', 'published')`),
    check("website_page_menu_chk", sql`${t.menu} in ('header', 'footer', 'none')`),
    check("website_page_not_own_parent_chk", sql`${t.parentPageId} is null or ${t.parentPageId} <> ${t.id}`),
  ],
);

export const websiteEntry = pgTable(
  "website_entry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    siteId: uuid("site_id").notNull(),
    collection: text("collection").notNull(),
    entryKey: text("entry_key").notNull(),
    orgId: text("org_id"),
    status: text("status").notNull().default("draft"),
    sortOrder: integer("sort_order"),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "restrict" }),
    approvedRevisionId: uuid("approved_revision_id").references(() => documentRevisions.id, { onDelete: "set null" }),
    publishedRevisionId: uuid("published_revision_id").references(() => documentRevisions.id, { onDelete: "set null" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("website_entry_company_id_uq").on(t.companyId, t.id),
    foreignKey({
      columns: [t.companyId, t.siteId],
      foreignColumns: [websiteSite.companyId, websiteSite.id],
      name: "website_entry_company_site_fk",
    }).onDelete("cascade"),
    uniqueIndex("website_entry_site_collection_key_uq").on(t.companyId, t.siteId, t.collection, t.entryKey),
    uniqueIndex("website_entry_document_uq").on(t.documentId),
    index("website_entry_site_collection_idx").on(t.siteId, t.collection),
    check("website_entry_status_chk", sql`${t.status} in ('draft', 'review', 'approved', 'published')`),
  ],
);

export const websiteRelease = pgTable(
  "website_release",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    siteId: uuid("site_id").notNull(),
    number: integer("number").notNull(),
    kind: text("kind").notNull().default("publish"),
    rollbackOfReleaseId: uuid("rollback_of_release_id"),
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
    releaseSha256: text("release_sha256"),
    blobsKey: text("blobs_key"),
    checks: jsonb("checks").$type<unknown[]>().notNull().default([]),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    requestedByUserId: text("requested_by_user_id"),
    publishedByUserId: text("published_by_user_id"),
    status: text("status").notNull().default("building"),
    pendingReason: text("pending_reason"),
    switchedAt: timestamp("switched_at", { withTimezone: true }),
    liveAt: timestamp("live_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("website_release_company_id_uq").on(t.companyId, t.id),
    foreignKey({
      columns: [t.companyId, t.siteId],
      foreignColumns: [websiteSite.companyId, websiteSite.id],
      name: "website_release_company_site_fk",
    }).onDelete("cascade"),
    uniqueIndex("website_release_site_number_uq").on(t.companyId, t.siteId, t.number),
    uniqueIndex("website_release_site_live_uq").on(t.siteId).where(sql`${t.status} = 'live'`),
    check("website_release_kind_chk", sql`${t.kind} in ('publish', 'rollback')`),
    check(
      "website_release_status_chk",
      sql`${t.status} in ('building', 'checks_failed', 'uploading', 'switched', 'pending', 'live', 'superseded', 'failed')`,
    ),
  ],
);
