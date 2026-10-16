-- Client journey by stage (GRE-1473): one new table, pipeline_case_stage_deliverables. Each row
-- files a client's deliverable (task + deliverable key) under one stage of its journey, with a
-- client_facing flag for the client portal. Additive only; no existing table or row changes.
-- Rollback: DROP TABLE "pipeline_case_stage_deliverables";
CREATE TABLE "pipeline_case_stage_deliverables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"deliverable_issue_id" uuid NOT NULL,
	"deliverable_key" text NOT NULL,
	"client_facing" boolean DEFAULT false NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipeline_case_stage_deliverables" ADD CONSTRAINT "pipeline_case_stage_deliverables_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_stage_deliverables" ADD CONSTRAINT "pipeline_case_stage_deliverables_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_stage_deliverables" ADD CONSTRAINT "pipeline_case_stage_deliverables_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_stage_deliverables" ADD CONSTRAINT "pipeline_case_stage_deliverables_deliverable_issue_id_issues_id_fk" FOREIGN KEY ("deliverable_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_stage_deliverables" ADD CONSTRAINT "pipeline_case_stage_deliverables_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_case_stage_deliverables_case_deliverable_uq" ON "pipeline_case_stage_deliverables" USING btree ("case_id","deliverable_issue_id","deliverable_key");--> statement-breakpoint
CREATE INDEX "pipeline_case_stage_deliverables_company_case_idx" ON "pipeline_case_stage_deliverables" USING btree ("company_id","case_id");--> statement-breakpoint
CREATE INDEX "pipeline_case_stage_deliverables_stage_idx" ON "pipeline_case_stage_deliverables" USING btree ("stage_id");