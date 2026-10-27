-- Parallel Interview review (GRE-2756). Additive: three nullable link columns, their indexes and a check on
-- deep_dive_interview_proposals; nothing existing changes, so the previous live-* tag still runs on it. An
-- accepted theme or person points at the Deep Dive record it became (a proposed finding, a person on the
-- organisation board, a process candidate). Removing the record nulls the link and keeps the decision.
-- Rollback:
--   ALTER TABLE "deep_dive_interview_proposals" DROP CONSTRAINT IF EXISTS "deep_dive_interview_proposals_record_check";
--   ALTER TABLE "deep_dive_interview_proposals" DROP COLUMN IF EXISTS "finding_id", DROP COLUMN IF EXISTS "person_id", DROP COLUMN IF EXISTS "process_id";
ALTER TABLE "deep_dive_interview_proposals" ADD COLUMN "finding_id" uuid;--> statement-breakpoint
ALTER TABLE "deep_dive_interview_proposals" ADD COLUMN "person_id" uuid;--> statement-breakpoint
ALTER TABLE "deep_dive_interview_proposals" ADD COLUMN "process_id" uuid;--> statement-breakpoint
ALTER TABLE "deep_dive_interview_proposals" ADD CONSTRAINT "deep_dive_interview_proposals_finding_id_deep_dive_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."deep_dive_findings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_interview_proposals" ADD CONSTRAINT "deep_dive_interview_proposals_person_id_deep_dive_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."deep_dive_people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_dive_interview_proposals" ADD CONSTRAINT "deep_dive_interview_proposals_process_id_deep_dive_processes_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."deep_dive_processes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deep_dive_interview_proposals_finding_idx" ON "deep_dive_interview_proposals" USING btree ("finding_id");--> statement-breakpoint
CREATE INDEX "deep_dive_interview_proposals_person_idx" ON "deep_dive_interview_proposals" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "deep_dive_interview_proposals_process_idx" ON "deep_dive_interview_proposals" USING btree ("process_id");--> statement-breakpoint
ALTER TABLE "deep_dive_interview_proposals" ADD CONSTRAINT "deep_dive_interview_proposals_record_check" CHECK (("deep_dive_interview_proposals"."finding_id" is null or ("deep_dive_interview_proposals"."kind" in ('pain', 'finding') and "deep_dive_interview_proposals"."status" = 'accepted'))
        and ("deep_dive_interview_proposals"."person_id" is null or ("deep_dive_interview_proposals"."kind" = 'person' and "deep_dive_interview_proposals"."status" = 'accepted'))
        and ("deep_dive_interview_proposals"."process_id" is null or ("deep_dive_interview_proposals"."kind" = 'process' and "deep_dive_interview_proposals"."status" = 'accepted')));