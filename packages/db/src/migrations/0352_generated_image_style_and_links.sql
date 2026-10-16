-- Image styles and links (16 Oct 2026): a generated image can carry a style
-- preset and say which task and which client it was made for, so the gallery
-- can be searched and organised by client and task.
-- Additive: three nullable columns, two indexes. Existing rows stay as they are.
-- Rollback: ALTER TABLE "generated_images" DROP COLUMN "style", DROP COLUMN "issue_id", DROP COLUMN "organisation_id";
ALTER TABLE "generated_images" ADD COLUMN "style" text;--> statement-breakpoint
ALTER TABLE "generated_images" ADD COLUMN "issue_id" uuid;--> statement-breakpoint
ALTER TABLE "generated_images" ADD COLUMN "organisation_id" uuid;--> statement-breakpoint
ALTER TABLE "generated_images" ADD CONSTRAINT "generated_images_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_images" ADD CONSTRAINT "generated_images_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generated_images_company_issue_idx" ON "generated_images" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "generated_images_company_organisation_idx" ON "generated_images" USING btree ("company_id","organisation_id");
