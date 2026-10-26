-- Website module foundation (GRE-2105, ADR GRE-1914 section 2): four new company-scoped tables; children
-- are tied to their site by a composite (company_id, site_id) foreign key. Additive only.
-- Rollback, in one transaction, in this order (tested on a sandbox copy, GRE-2126). Collect the page and
-- entry documents first: once the tables are gone nothing names them. document_id is ON DELETE restrict,
-- so the website rows must go before their documents; revisions cascade with the documents. Later
-- migrations that use these tables (0405 website activity, 0394 website_site data bridge columns,
-- 0393 website_feature, 0385 website_sitemap_option) are rolled back first.
--   BEGIN;
--   DROP TABLE IF EXISTS "website_activity_events", "website_activity_cursors";
--   DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792971569218;
--   DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792889652512;
--   DROP TABLE IF EXISTS "website_feature";
--   DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792889651512;
--   DROP TABLE IF EXISTS "website_sitemap_option";
--   DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792790160161;
--   CREATE TEMP TABLE _wm_docs ON COMMIT DROP AS
--     SELECT document_id FROM "website_page" UNION SELECT document_id FROM "website_entry";
--   DROP TABLE "website_release", "website_entry", "website_page", "website_site";
--   DELETE FROM "documents" WHERE "id" IN (SELECT document_id FROM _wm_docs);
--   DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" = 1792789172049;
--   COMMIT;
-- Netlify token secrets ("Website Netlify token ...") stay in company_secrets; remove them in Settings.
CREATE TABLE "website_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"collection" text NOT NULL,
	"entry_key" text NOT NULL,
	"org_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"sort_order" integer,
	"document_id" uuid NOT NULL,
	"approved_revision_id" uuid,
	"published_revision_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "website_entry_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "website_entry_status_chk" CHECK ("website_entry"."status" in ('draft', 'review', 'approved', 'published'))
);
--> statement-breakpoint
CREATE TABLE "website_page" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"nav_order" integer,
	"parent_page_id" uuid,
	"menu" text DEFAULT 'none' NOT NULL,
	"menu_order" integer,
	"status" text DEFAULT 'draft' NOT NULL,
	"seo" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"document_id" uuid NOT NULL,
	"approved_revision_id" uuid,
	"published_revision_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "website_page_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "website_page_company_site_id_uq" UNIQUE("company_id","site_id","id"),
	CONSTRAINT "website_page_status_chk" CHECK ("website_page"."status" in ('planned', 'draft', 'review', 'approved', 'published')),
	CONSTRAINT "website_page_menu_chk" CHECK ("website_page"."menu" in ('header', 'footer', 'none')),
	CONSTRAINT "website_page_not_own_parent_chk" CHECK ("website_page"."parent_page_id" is null or "website_page"."parent_page_id" <> "website_page"."id")
);
--> statement-breakpoint
CREATE TABLE "website_release" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"kind" text DEFAULT 'publish' NOT NULL,
	"rollback_of_release_id" uuid,
	"manifest" jsonb NOT NULL,
	"release_sha256" text,
	"blobs_key" text,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approval_id" uuid,
	"requested_by_agent_id" uuid,
	"requested_by_user_id" text,
	"published_by_user_id" text,
	"status" text DEFAULT 'building' NOT NULL,
	"pending_reason" text,
	"switched_at" timestamp with time zone,
	"live_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "website_release_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "website_release_kind_chk" CHECK ("website_release"."kind" in ('publish', 'rollback')),
	CONSTRAINT "website_release_status_chk" CHECK ("website_release"."status" in ('building', 'checks_failed', 'uploading', 'switched', 'pending', 'live', 'superseded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "website_site" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"repo_url" text,
	"netlify_site_id" text NOT NULL,
	"netlify_token_secret_id" uuid,
	"blobs_store_name" text DEFAULT 'gsam-content' NOT NULL,
	"engine_version" text,
	"release_schema_version" integer DEFAULT 1 NOT NULL,
	"theme" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"property_id" uuid,
	"editor_origins" text[] DEFAULT '{}'::text[] NOT NULL,
	"check_paths" jsonb DEFAULT '["/"]'::jsonb NOT NULL,
	"live_release_id" uuid,
	"publish_lease_id" uuid,
	"publish_lease_kind" text,
	"publish_lease_expires_at" timestamp with time zone,
	"publish_fence" bigint DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "website_site_company_id_uq" UNIQUE("company_id","id")
);
--> statement-breakpoint
ALTER TABLE "website_entry" ADD CONSTRAINT "website_entry_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_entry" ADD CONSTRAINT "website_entry_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_entry" ADD CONSTRAINT "website_entry_approved_revision_id_document_revisions_id_fk" FOREIGN KEY ("approved_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_entry" ADD CONSTRAINT "website_entry_published_revision_id_document_revisions_id_fk" FOREIGN KEY ("published_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_entry" ADD CONSTRAINT "website_entry_company_site_fk" FOREIGN KEY ("company_id","site_id") REFERENCES "public"."website_site"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_page" ADD CONSTRAINT "website_page_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_page" ADD CONSTRAINT "website_page_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_page" ADD CONSTRAINT "website_page_approved_revision_id_document_revisions_id_fk" FOREIGN KEY ("approved_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_page" ADD CONSTRAINT "website_page_published_revision_id_document_revisions_id_fk" FOREIGN KEY ("published_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_page" ADD CONSTRAINT "website_page_company_site_fk" FOREIGN KEY ("company_id","site_id") REFERENCES "public"."website_site"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_page" ADD CONSTRAINT "website_page_parent_fk" FOREIGN KEY ("company_id","site_id","parent_page_id") REFERENCES "public"."website_page"("company_id","site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_release" ADD CONSTRAINT "website_release_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_release" ADD CONSTRAINT "website_release_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_release" ADD CONSTRAINT "website_release_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_release" ADD CONSTRAINT "website_release_company_site_fk" FOREIGN KEY ("company_id","site_id") REFERENCES "public"."website_site"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_site" ADD CONSTRAINT "website_site_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_site" ADD CONSTRAINT "website_site_netlify_token_secret_id_company_secrets_id_fk" FOREIGN KEY ("netlify_token_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_site" ADD CONSTRAINT "website_site_property_id_website_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."website_properties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "website_entry_site_collection_key_uq" ON "website_entry" USING btree ("company_id","site_id","collection","entry_key");--> statement-breakpoint
CREATE UNIQUE INDEX "website_entry_document_uq" ON "website_entry" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "website_entry_site_collection_idx" ON "website_entry" USING btree ("site_id","collection");--> statement-breakpoint
CREATE UNIQUE INDEX "website_page_site_slug_live_uq" ON "website_page" USING btree ("company_id","site_id","slug") WHERE "website_page"."archived_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "website_page_document_uq" ON "website_page" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "website_page_site_parent_idx" ON "website_page" USING btree ("site_id","parent_page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "website_release_site_number_uq" ON "website_release" USING btree ("company_id","site_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "website_release_site_live_uq" ON "website_release" USING btree ("site_id") WHERE "website_release"."status" = 'live';--> statement-breakpoint
CREATE UNIQUE INDEX "website_site_company_domain_uq" ON "website_site" USING btree ("company_id","domain");--> statement-breakpoint
CREATE INDEX "website_site_property_idx" ON "website_site" USING btree ("property_id");
