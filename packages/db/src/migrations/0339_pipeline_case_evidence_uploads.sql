-- Client uploads (15 Oct 2026, Ben 12 and 13 Oct): a file can be uploaded
-- straight onto a client as evidence (kind upload, held as an asset), and
-- evidence can be filed under one stage of the client's journey.
-- Additive: two nullable columns, no rewrite; the kind check gains upload.
ALTER TABLE "pipeline_case_evidence" DROP CONSTRAINT "pipeline_case_evidence_kind_check";--> statement-breakpoint
ALTER TABLE "pipeline_case_evidence" ADD COLUMN "asset_id" uuid;--> statement-breakpoint
ALTER TABLE "pipeline_case_evidence" ADD COLUMN "stage_id" uuid;--> statement-breakpoint
ALTER TABLE "pipeline_case_evidence" ADD CONSTRAINT "pipeline_case_evidence_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_evidence" ADD CONSTRAINT "pipeline_case_evidence_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_case_evidence_stage_idx" ON "pipeline_case_evidence" USING btree ("stage_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_case_evidence_asset_uq" ON "pipeline_case_evidence" USING btree ("asset_id") WHERE "pipeline_case_evidence"."asset_id" is not null;--> statement-breakpoint
ALTER TABLE "pipeline_case_evidence" ADD CONSTRAINT "pipeline_case_evidence_kind_check" CHECK (("pipeline_case_evidence"."kind" = 'attachment' and "pipeline_case_evidence"."attachment_id" is not null)
        or ("pipeline_case_evidence"."kind" = 'document' and "pipeline_case_evidence"."document_id" is not null)
        or ("pipeline_case_evidence"."kind" = 'link' and "pipeline_case_evidence"."url" is not null)
        or ("pipeline_case_evidence"."kind" = 'upload' and "pipeline_case_evidence"."asset_id" is not null));