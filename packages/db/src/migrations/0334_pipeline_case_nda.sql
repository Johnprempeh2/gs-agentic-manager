-- Client NDA flag on pipeline cases (external deliverables). Additive only: a
-- nullable timestamp set by the board. Client-labelled deliverables reach the
-- client portal only once it is set; nothing changes for existing cases.
-- Rollback: ALTER TABLE "pipeline_cases" DROP COLUMN "nda_accepted_at";
ALTER TABLE "pipeline_cases" ADD COLUMN "nda_accepted_at" timestamp with time zone;
