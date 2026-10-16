-- Client pipeline (Ben, 8 and 12 Oct). Documents we ask a client for at one
-- stage, received once an upload is linked through evidence_id; and the
-- engagement pack after the NDA (not sent, sent, accepted) with its files.
-- Additive: one new table and nullable or defaulted columns.
CREATE TABLE "pipeline_case_document_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"title" text NOT NULL,
	"note" text,
	"position" integer DEFAULT 0 NOT NULL,
	"evidence_id" uuid,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD COLUMN "engagement_status" text DEFAULT 'not_sent' NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD COLUMN "engagement_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD COLUMN "engagement_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD COLUMN "engagement_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD COLUMN "engagement_changed_by_user_id" text;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD COLUMN "engagement_pack_evidence_id" uuid;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD COLUMN "engagement_acceptance_evidence_id" uuid;--> statement-breakpoint
ALTER TABLE "pipeline_case_document_requests" ADD CONSTRAINT "pipeline_case_document_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_document_requests" ADD CONSTRAINT "pipeline_case_document_requests_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_document_requests" ADD CONSTRAINT "pipeline_case_document_requests_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_document_requests" ADD CONSTRAINT "pipeline_case_document_requests_evidence_id_pipeline_case_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."pipeline_case_evidence"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_document_requests" ADD CONSTRAINT "pipeline_case_document_requests_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_case_document_requests_company_case_idx" ON "pipeline_case_document_requests" USING btree ("company_id","case_id");--> statement-breakpoint
CREATE INDEX "pipeline_case_document_requests_stage_idx" ON "pipeline_case_document_requests" USING btree ("stage_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_case_document_requests_case_stage_title_uq" ON "pipeline_case_document_requests" USING btree ("case_id","stage_id","title");--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD CONSTRAINT "pipeline_cases_engagement_pack_evidence_id_pipeline_case_evidence_id_fk" FOREIGN KEY ("engagement_pack_evidence_id") REFERENCES "public"."pipeline_case_evidence"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD CONSTRAINT "pipeline_cases_engagement_acceptance_evidence_id_pipeline_case_evidence_id_fk" FOREIGN KEY ("engagement_acceptance_evidence_id") REFERENCES "public"."pipeline_case_evidence"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD CONSTRAINT "pipeline_cases_engagement_status_check" CHECK ("pipeline_cases"."engagement_status" in ('not_sent', 'sent', 'accepted'));