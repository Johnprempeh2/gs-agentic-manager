-- Typed pipeline fields (GRE-1075, 9 Oct 2026): fields a pipeline declares for
-- its cases (text, number, date, choice, ...). New table only; case values stay in
-- pipeline_cases.fields.
-- Rollback: DROP TABLE "pipeline_field_definitions";
CREATE TABLE "pipeline_field_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"type" text NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_field_definitions_type_check" CHECK ("pipeline_field_definitions"."type" in ('text', 'long_text', 'number', 'boolean', 'date', 'select', 'multi_select', 'email', 'phone', 'url'))
);
--> statement-breakpoint
ALTER TABLE "pipeline_field_definitions" ADD CONSTRAINT "pipeline_field_definitions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_field_definitions" ADD CONSTRAINT "pipeline_field_definitions_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_field_definitions" ADD CONSTRAINT "pipeline_field_definitions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_field_definitions_pipeline_key_uq" ON "pipeline_field_definitions" USING btree ("pipeline_id","key");--> statement-breakpoint
CREATE INDEX "pipeline_field_definitions_company_pipeline_idx" ON "pipeline_field_definitions" USING btree ("company_id","pipeline_id");