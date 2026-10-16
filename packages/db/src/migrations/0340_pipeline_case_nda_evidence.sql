-- Signed NDA on the client (15 Oct 2026, Ben 8 Oct): the evidence row that
-- holds the uploaded signed NDA. Additive: one nullable column, no rewrite.
ALTER TABLE "pipeline_cases" ADD COLUMN "nda_evidence_id" uuid;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD CONSTRAINT "pipeline_cases_nda_evidence_id_pipeline_case_evidence_id_fk" FOREIGN KEY ("nda_evidence_id") REFERENCES "public"."pipeline_case_evidence"("id") ON DELETE set null ON UPDATE no action;