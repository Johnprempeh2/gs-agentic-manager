-- Website modules (GRE-2325, plan of 24 Oct 2026): the module registry of a site.
-- Additive: one new table. Owner, lead agent and project are optional.
-- Rollback: DROP TABLE "website_module";
CREATE TABLE "website_module" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"purpose" text DEFAULT '' NOT NULL,
	"icon" text DEFAULT 'blocks' NOT NULL,
	"owner_user_id" text,
	"lead_agent_id" uuid,
	"project_id" uuid,
	"route_prefixes" text[] DEFAULT '{}'::text[] NOT NULL,
	"collections" text[] DEFAULT '{}'::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "website_module_company_id_uq" UNIQUE("company_id","id")
);
--> statement-breakpoint
ALTER TABLE "website_module" ADD CONSTRAINT "website_module_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_module" ADD CONSTRAINT "website_module_lead_agent_id_agents_id_fk" FOREIGN KEY ("lead_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_module" ADD CONSTRAINT "website_module_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_module" ADD CONSTRAINT "website_module_company_site_fk" FOREIGN KEY ("company_id","site_id") REFERENCES "public"."website_site"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "website_module_site_idx" ON "website_module" USING btree ("company_id","site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "website_module_site_key_uq" ON "website_module" USING btree ("site_id","key") WHERE "website_module"."archived_at" is null;