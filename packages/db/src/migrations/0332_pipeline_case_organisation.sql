-- Pipeline cases link to an organisation (GRE-1478, slice 2 of GRE-1472).
-- Additive only: a nullable case column and a pipeline flag that is off by
-- default, so no existing pipeline or case changes behaviour.
-- Rollback: DROP INDEX "pipeline_cases_company_organisation_idx";
--   ALTER TABLE "pipeline_cases" DROP COLUMN "organisation_id";
--   ALTER TABLE "pipelines" DROP COLUMN "requires_organisation";
ALTER TABLE "pipeline_cases" ADD COLUMN "organisation_id" uuid;--> statement-breakpoint
ALTER TABLE "pipelines" ADD COLUMN "requires_organisation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD CONSTRAINT "pipeline_cases_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_cases_company_organisation_idx" ON "pipeline_cases" USING btree ("company_id","organisation_id");