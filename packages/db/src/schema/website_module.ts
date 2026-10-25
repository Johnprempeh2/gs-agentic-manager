import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
import { projects } from "./projects.js";
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
    /** True when the site created the token secret (a pasted token). A shared secret (false) is never rotated or deleted by the site. */
    netlifyTokenSecretOwned: boolean("netlify_token_secret_owned").notNull().default(true),
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
    /**
     * Preview addresses for the Preview tab's Live and In development views
     * (24 Oct 2026), set by a person with website:publish. The live view is an
     * optional frameable exact copy of the live deploy (null: the live domain);
     * the development view defaults to the editor address when null.
     */
    livePreviewUrl: text("live_preview_url"),
    devPreviewUrl: text("dev_preview_url"),
    checkPaths: jsonb("check_paths").$type<string[]>().notNull().default(["/"]),
    /**
     * The website admin bridge (GRE-2323): GSAM reads the site's customer
     * records by calling `<url>/api/admin/v1/*`, signed with an Ed25519 read
     * key. Null url: `https://<domain>`. The private key lives only in the
     * vault; the key id is shown so a person can match it to the site's
     * `GSAM_BRIDGE_KEYS`.
     */
    dataBridgeUrl: text("data_bridge_url"),
    dataBridgeReadKeyId: text("data_bridge_read_key_id"),
    dataBridgeReadSecretId: uuid("data_bridge_read_secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    /**
     * Deep Dive sync (GRE-2439): GSAM pushes a client's Shared items with a
     * separate `write` key, kept in the vault like the read key. The same key
     * makes the commerce writes (GRE-2354 2c(b)). Null: commerce writes are off.
     */
    dataBridgeWriteKeyId: text("data_bridge_write_key_id"),
    dataBridgeWriteSecretId: uuid("data_bridge_write_secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    /**
     * The `refund_request` key (GRE-2354 2c(b)): records a refund request on
     * the site, which a person then decides. It moves no money. Null: off.
     */
    dataBridgeRefundKeyId: text("data_bridge_refund_key_id"),
    dataBridgeRefundSecretId: uuid("data_bridge_refund_secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    /**
     * The site's own key for its calls back to GSAM (a client answered a
     * document request). The site keeps the private key; GSAM keeps only the
     * raw Ed25519 public key (base64url) and its id.
     */
    dataBridgeSiteKeyId: text("data_bridge_site_key_id"),
    dataBridgeSitePublicKey: text("data_bridge_site_public_key"),
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
    // A call back names its key; the key names one site, so one company.
    uniqueIndex("website_site_data_bridge_site_key_uq").on(t.dataBridgeSiteKeyId).where(sql`${t.dataBridgeSiteKeyId} is not null`),
  ],
);

/**
 * Nonces of the site's signed calls back to GSAM (GRE-2439): a nonce works
 * once per key. Rows older than the 60 s time window are pruned on insert.
 */
export const websiteBridgeInboundNonces = pgTable(
  "website_bridge_inbound_nonces",
  {
    keyId: text("key_id").notNull(),
    nonce: text("nonce").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.keyId, t.nonce] }),
    index("website_bridge_inbound_nonces_expires_idx").on(t.expiresAt),
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
    /**
     * The Netlify production deploy that serves this release (GRE-2108):
     * `{ method, requestedAt, deployId, commitRef, state, errorMessage }`.
     * Retry reads `state` (verify only when `ready`); rollback restores
     * `deployId` when `commitRef` still matches the live engine commit.
     */
    deploy: jsonb("deploy").$type<Record<string, unknown>>(),
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

/**
 * Sitemap options (GRE-2111): named drafts of the site's structure, each a
 * JSON tree of pages, menus and journeys. Options cost nothing and never
 * touch pages; approving one (a person with website:publish) writes its tree
 * into `website_page` rows. At most one approved option per site.
 */
export const websiteSitemapOption = pgTable(
  "website_sitemap_option",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    siteId: uuid("site_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    tree: jsonb("tree").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("draft"),
    proposedByAgentId: uuid("proposed_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedByUserId: text("approved_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("website_sitemap_option_company_id_uq").on(t.companyId, t.id),
    foreignKey({
      columns: [t.companyId, t.siteId],
      foreignColumns: [websiteSite.companyId, websiteSite.id],
      name: "website_sitemap_option_company_site_fk",
    }).onDelete("cascade"),
    index("website_sitemap_option_site_idx").on(t.companyId, t.siteId),
    uniqueIndex("website_sitemap_option_site_approved_uq").on(t.siteId).where(sql`${t.status} = 'approved'`),
    check("website_sitemap_option_status_chk", sql`${t.status} in ('draft', 'approved', 'archived')`),
  ],
);

/**
 * Website features (GRE-2325, plan of 24 Oct 2026): the big parts of a site,
 * each with its slice of the sitemap (route prefixes) and collections. Owner
 * and lead agent are optional. Switching a feature off hides its screens and
 * never deletes data; removing one archives the registry row only.
 */
export const websiteFeature = pgTable(
  "website_feature",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    siteId: uuid("site_id").notNull(),
    /** Stable key per site, for example `shop`. */
    key: text("key").notNull(),
    name: text("name").notNull(),
    purpose: text("purpose").notNull().default(""),
    icon: text("icon").notNull().default("blocks"),
    ownerUserId: text("owner_user_id"),
    /** A name shown as a hint in Settings; never sets the owner on its own. */
    suggestedOwner: text("suggested_owner"),
    leadAgentId: uuid("lead_agent_id").references(() => agents.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    /** Admin screens planned for this feature, each naming the task that moves it in: `{ name, issue }[]`. */
    adminScreens: jsonb("admin_screens").$type<Array<{ name: string; issue: string | null }>>().notNull().default([]),
    routePrefixes: text("route_prefixes").array().notNull().default(sql`'{}'::text[]`),
    collections: text("collections").array().notNull().default(sql`'{}'::text[]`),
    enabled: boolean("enabled").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("website_feature_company_id_uq").on(t.companyId, t.id),
    foreignKey({
      columns: [t.companyId, t.siteId],
      foreignColumns: [websiteSite.companyId, websiteSite.id],
      name: "website_feature_company_site_fk",
    }).onDelete("cascade"),
    index("website_feature_site_idx").on(t.companyId, t.siteId),
    uniqueIndex("website_feature_site_key_uq").on(t.siteId, t.key).where(sql`${t.archivedAt} is null`),
  ],
);
