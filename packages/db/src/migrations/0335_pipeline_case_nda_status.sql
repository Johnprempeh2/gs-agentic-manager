-- The client's NDA is three-way, not a flag (Ben and John, 13 Oct): required
-- (the default), accepted (nda_accepted_at is its date) or suspended (the
-- engagement proceeds; the reason is required and kept). Additive only: new
-- columns with a default, and cases that already recorded an NDA become
-- accepted. nda_accepted_at stays as the accepted date.
-- Rollback:
--   ALTER TABLE "pipeline_cases" DROP COLUMN "nda_status_changed_by_user_id";
--   ALTER TABLE "pipeline_cases" DROP COLUMN "nda_status_changed_at";
--   ALTER TABLE "pipeline_cases" DROP COLUMN "nda_suspended_reason";
--   ALTER TABLE "pipeline_cases" DROP COLUMN "nda_status";
ALTER TABLE "pipeline_cases" ADD COLUMN "nda_status" text DEFAULT 'required' NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD COLUMN "nda_suspended_reason" text;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD COLUMN "nda_status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD COLUMN "nda_status_changed_by_user_id" text;--> statement-breakpoint
UPDATE "pipeline_cases" SET "nda_status" = 'accepted', "nda_status_changed_at" = "nda_accepted_at" WHERE "nda_accepted_at" IS NOT NULL;
