-- GSAM organisation -> website organisation link (GRE-2682). Additive: one nullable column on "organisations" and a
-- partial unique index so one website organisation (website customers.id) links to at most one organisation per
-- company. No backfill: every row starts unlinked and a person links it by hand. The previous live-* tag ignores the
-- column, so it is safe to leave in place on a rollback of the app.
-- Rollback:
--   DROP INDEX IF EXISTS "organisations_company_website_organisation_uq";
--   ALTER TABLE "organisations" DROP COLUMN IF EXISTS "website_organisation_id";
ALTER TABLE "organisations" ADD COLUMN "website_organisation_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "organisations_company_website_organisation_uq" ON "organisations" USING btree ("company_id","website_organisation_id") WHERE "organisations"."website_organisation_id" is not null;
