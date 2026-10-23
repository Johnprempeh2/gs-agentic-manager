-- Sitemap options (GRE-2111): named drafts of a site's structure as a JSON tree; one approved per site.
-- Additive only. Rollback: DROP TABLE "website_sitemap_option"; (pages written by an approval stay).
CREATE TABLE "website_sitemap_option" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"tree" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"proposed_by_agent_id" uuid,
	"created_by_user_id" text,
	"approved_at" timestamp with time zone,
	"approved_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "website_sitemap_option_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "website_sitemap_option_status_chk" CHECK ("website_sitemap_option"."status" in ('draft', 'approved', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "website_sitemap_option" ADD CONSTRAINT "website_sitemap_option_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_sitemap_option" ADD CONSTRAINT "website_sitemap_option_proposed_by_agent_id_agents_id_fk" FOREIGN KEY ("proposed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_sitemap_option" ADD CONSTRAINT "website_sitemap_option_company_site_fk" FOREIGN KEY ("company_id","site_id") REFERENCES "public"."website_site"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "website_sitemap_option_site_idx" ON "website_sitemap_option" USING btree ("company_id","site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "website_sitemap_option_site_approved_uq" ON "website_sitemap_option" USING btree ("site_id") WHERE "website_sitemap_option"."status" = 'approved';