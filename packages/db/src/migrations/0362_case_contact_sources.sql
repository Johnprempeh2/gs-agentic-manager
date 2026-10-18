ALTER TABLE "pipeline_case_contacts" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "pipeline_case_contacts" ADD COLUMN "external_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_case_contacts_case_source_external_uq" ON "pipeline_case_contacts" USING btree ("case_id","source","external_id") WHERE "pipeline_case_contacts"."external_id" is not null;