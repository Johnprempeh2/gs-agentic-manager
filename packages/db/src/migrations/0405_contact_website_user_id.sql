-- CRM contacts point at the website user, not a copy of their email (GRE-2658, from Flint's GRE-2623 audit).
-- Additive: one nullable column, one partial index and one check on each of "organisation_contacts" and
-- "pipeline_case_contacts". Every existing row has website_user_id null, so the check holds for all of them and no
-- data changes. A linked contact (website_user_id set) may not also hold an email; an unlinked CRM entry keeps its
-- email until it is linked. The previous live-* tag runs unchanged on this schema.
-- Rollback:
--   ALTER TABLE "organisation_contacts" DROP CONSTRAINT IF EXISTS "organisation_contacts_linked_no_email_check";
--   ALTER TABLE "pipeline_case_contacts" DROP CONSTRAINT IF EXISTS "pipeline_case_contacts_linked_no_email_check";
--   DROP INDEX IF EXISTS "organisation_contacts_company_website_user_idx";
--   DROP INDEX IF EXISTS "pipeline_case_contacts_company_website_user_idx";
--   ALTER TABLE "organisation_contacts" DROP COLUMN "website_user_id";
--   ALTER TABLE "pipeline_case_contacts" DROP COLUMN "website_user_id";
ALTER TABLE "organisation_contacts" ADD COLUMN "website_user_id" text;--> statement-breakpoint
ALTER TABLE "pipeline_case_contacts" ADD COLUMN "website_user_id" text;--> statement-breakpoint
CREATE INDEX "organisation_contacts_company_website_user_idx" ON "organisation_contacts" USING btree ("company_id","website_user_id") WHERE "organisation_contacts"."website_user_id" is not null;--> statement-breakpoint
CREATE INDEX "pipeline_case_contacts_company_website_user_idx" ON "pipeline_case_contacts" USING btree ("company_id","website_user_id") WHERE "pipeline_case_contacts"."website_user_id" is not null;--> statement-breakpoint
ALTER TABLE "organisation_contacts" ADD CONSTRAINT "organisation_contacts_linked_no_email_check" CHECK ("organisation_contacts"."website_user_id" is null or "organisation_contacts"."email" is null);--> statement-breakpoint
ALTER TABLE "pipeline_case_contacts" ADD CONSTRAINT "pipeline_case_contacts_linked_no_email_check" CHECK ("pipeline_case_contacts"."website_user_id" is null or "pipeline_case_contacts"."email" is null);