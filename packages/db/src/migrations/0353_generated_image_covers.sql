-- Image covers (16 Oct 2026): a finished image can show on the card of the task
-- or client it is linked to. At most one cover each; the service clears the last.
-- Additive: two booleans defaulting to false. Existing rows stay as they are.
-- Rollback: ALTER TABLE "generated_images" DROP COLUMN "issue_cover", DROP COLUMN "organisation_cover";
ALTER TABLE "generated_images" ADD COLUMN "issue_cover" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "generated_images" ADD COLUMN "organisation_cover" boolean DEFAULT false NOT NULL;
