CREATE TABLE "motion_studies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"concept" text DEFAULT '' NOT NULL,
	"theme" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tech" text DEFAULT '' NOT NULL,
	"notes" text,
	"study_date" text,
	"source_url" text,
	"text_safe" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"decision" text DEFAULT 'undecided' NOT NULL,
	"proposed_status" text,
	"proposed_decision" text,
	"proposal_reason" text,
	"proposed_by_agent_id" uuid,
	"proposed_at" timestamp with time zone,
	"source" text DEFAULT 'manual' NOT NULL,
	"asset_id" uuid,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "motion_studies" ADD CONSTRAINT "motion_studies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motion_studies" ADD CONSTRAINT "motion_studies_proposed_by_agent_id_agents_id_fk" FOREIGN KEY ("proposed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motion_studies" ADD CONSTRAINT "motion_studies_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "motion_studies" ADD CONSTRAINT "motion_studies_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "motion_studies_company_slug_uq" ON "motion_studies" USING btree ("company_id","slug");--> statement-breakpoint
CREATE INDEX "motion_studies_company_number_idx" ON "motion_studies" USING btree ("company_id","number");--> statement-breakpoint
CREATE INDEX "motion_studies_company_status_idx" ON "motion_studies" USING btree ("company_id","status");