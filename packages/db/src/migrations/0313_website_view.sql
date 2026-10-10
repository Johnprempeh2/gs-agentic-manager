-- Website view (GRE-1087, 9 Oct 2026): website properties a company watches
-- and the daily GA4 / Search Console pulls stored for them. New tables only.
-- Rollback: DROP TABLE "website_pulls"; DROP TABLE "website_properties";
CREATE TABLE "website_properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"site_url" text NOT NULL,
	"ga4_property_id" text NOT NULL,
	"connection_status" text DEFAULT 'not_connected' NOT NULL,
	"google_token_secret_id" uuid,
	"connected_at" timestamp with time zone,
	"connected_by_user_id" text,
	"last_pull_at" timestamp with time zone,
	"last_pull_status" text,
	"last_pull_errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "website_pulls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"range_start" text NOT NULL,
	"range_end" text NOT NULL,
	"ga4_report" jsonb,
	"search_console_report" jsonb,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "website_properties" ADD CONSTRAINT "website_properties_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_properties" ADD CONSTRAINT "website_properties_google_token_secret_id_company_secrets_id_fk" FOREIGN KEY ("google_token_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_pulls" ADD CONSTRAINT "website_pulls_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_pulls" ADD CONSTRAINT "website_pulls_property_id_website_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."website_properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "website_properties_company_idx" ON "website_properties" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "website_properties_company_site_uq" ON "website_properties" USING btree ("company_id","site_url");--> statement-breakpoint
CREATE INDEX "website_pulls_property_started_idx" ON "website_pulls" USING btree ("property_id","started_at");--> statement-breakpoint
CREATE INDEX "website_pulls_company_idx" ON "website_pulls" USING btree ("company_id");