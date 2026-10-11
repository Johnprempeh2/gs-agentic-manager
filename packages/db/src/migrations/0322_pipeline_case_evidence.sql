-- Client files (GRE-1311): one new table, pipeline_case_evidence. Each row points a
-- client (pipeline case) at an existing task attachment, task document or link.
-- Additive only; no existing table or row changes.
-- Rollback: DROP TABLE "pipeline_case_evidence";
CREATE TABLE "pipeline_case_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"note" text,
	"attachment_id" uuid,
	"document_id" uuid,
	"url" text,
	"source_issue_id" uuid,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_case_evidence_kind_check" CHECK (("pipeline_case_evidence"."kind" = 'attachment' and "pipeline_case_evidence"."attachment_id" is not null)
        or ("pipeline_case_evidence"."kind" = 'document' and "pipeline_case_evidence"."document_id" is not null)
        or ("pipeline_case_evidence"."kind" = 'link' and "pipeline_case_evidence"."url" is not null))
);
--> statement-breakpoint
ALTER TABLE "pipeline_case_evidence" ADD CONSTRAINT "pipeline_case_evidence_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_evidence" ADD CONSTRAINT "pipeline_case_evidence_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_evidence" ADD CONSTRAINT "pipeline_case_evidence_attachment_id_issue_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."issue_attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_evidence" ADD CONSTRAINT "pipeline_case_evidence_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_evidence" ADD CONSTRAINT "pipeline_case_evidence_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_evidence" ADD CONSTRAINT "pipeline_case_evidence_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_case_evidence_company_case_idx" ON "pipeline_case_evidence" USING btree ("company_id","case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_case_evidence_case_attachment_uq" ON "pipeline_case_evidence" USING btree ("case_id","attachment_id") WHERE "pipeline_case_evidence"."attachment_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_case_evidence_case_document_uq" ON "pipeline_case_evidence" USING btree ("case_id","document_id") WHERE "pipeline_case_evidence"."document_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_case_evidence_case_url_uq" ON "pipeline_case_evidence" USING btree ("case_id","url") WHERE "pipeline_case_evidence"."url" is not null;