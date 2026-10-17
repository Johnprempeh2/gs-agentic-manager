CREATE TABLE "generated_videos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"duration_seconds" integer NOT NULL,
	"motion" text,
	"camera" jsonb,
	"source_image_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"provider_request_id" text,
	"asset_id" uuid,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"issue_id" uuid,
	"organisation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "studio_looks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"style" text,
	"camera" jsonb,
	"words" text,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "generated_videos" ADD CONSTRAINT "generated_videos_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_videos" ADD CONSTRAINT "generated_videos_source_image_id_generated_images_id_fk" FOREIGN KEY ("source_image_id") REFERENCES "public"."generated_images"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_videos" ADD CONSTRAINT "generated_videos_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_videos" ADD CONSTRAINT "generated_videos_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_videos" ADD CONSTRAINT "generated_videos_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_videos" ADD CONSTRAINT "generated_videos_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_looks" ADD CONSTRAINT "studio_looks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_looks" ADD CONSTRAINT "studio_looks_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generated_videos_company_created_idx" ON "generated_videos" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "generated_videos_company_status_idx" ON "generated_videos" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "generated_videos_company_issue_idx" ON "generated_videos" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "studio_looks_company_name_idx" ON "studio_looks" USING btree ("company_id","name");