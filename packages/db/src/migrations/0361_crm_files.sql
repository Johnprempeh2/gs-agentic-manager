CREATE TABLE "crm_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text,
	"byte_size" bigint,
	"description" text,
	"owner_name" text,
	"added_at" timestamp with time zone,
	"remote_url" text,
	"asset_id" uuid,
	"organisation_id" uuid,
	"contact_id" uuid,
	"case_id" uuid,
	"evidence_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm_files" ADD CONSTRAINT "crm_files_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_files" ADD CONSTRAINT "crm_files_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_files" ADD CONSTRAINT "crm_files_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_files" ADD CONSTRAINT "crm_files_contact_id_organisation_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."organisation_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_files" ADD CONSTRAINT "crm_files_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_files" ADD CONSTRAINT "crm_files_evidence_id_pipeline_case_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."pipeline_case_evidence"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crm_files_company_source_external_uq" ON "crm_files" USING btree ("company_id","source","external_id");--> statement-breakpoint
CREATE INDEX "crm_files_company_organisation_idx" ON "crm_files" USING btree ("company_id","organisation_id");--> statement-breakpoint
CREATE INDEX "crm_files_company_case_idx" ON "crm_files" USING btree ("company_id","case_id");--> statement-breakpoint
CREATE INDEX "crm_files_company_contact_idx" ON "crm_files" USING btree ("company_id","contact_id");