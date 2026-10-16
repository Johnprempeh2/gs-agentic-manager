CREATE TABLE "crm_timeline_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"kind" text NOT NULL,
	"activity_type" text,
	"subject" text,
	"body" text,
	"occurred_at" timestamp with time zone,
	"duration_minutes" integer,
	"done" boolean,
	"owner_name" text,
	"organisation_id" uuid,
	"contact_id" uuid,
	"case_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_timeline_entries_kind_check" CHECK ("crm_timeline_entries"."kind" in ('activity', 'note', 'call'))
);
--> statement-breakpoint
ALTER TABLE "crm_timeline_entries" ADD CONSTRAINT "crm_timeline_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_timeline_entries" ADD CONSTRAINT "crm_timeline_entries_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_timeline_entries" ADD CONSTRAINT "crm_timeline_entries_contact_id_organisation_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."organisation_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_timeline_entries" ADD CONSTRAINT "crm_timeline_entries_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crm_timeline_entries_company_source_kind_external_uq" ON "crm_timeline_entries" USING btree ("company_id","source","kind","external_id");--> statement-breakpoint
CREATE INDEX "crm_timeline_entries_company_organisation_idx" ON "crm_timeline_entries" USING btree ("company_id","organisation_id","occurred_at");--> statement-breakpoint
CREATE INDEX "crm_timeline_entries_company_case_idx" ON "crm_timeline_entries" USING btree ("company_id","case_id","occurred_at");--> statement-breakpoint
CREATE INDEX "crm_timeline_entries_company_contact_idx" ON "crm_timeline_entries" USING btree ("company_id","contact_id");