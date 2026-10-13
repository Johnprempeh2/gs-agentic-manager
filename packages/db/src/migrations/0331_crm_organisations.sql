-- CRM organisations (GRE-1477, slice 1 of GRE-1472, 12 Oct 2026). Two new
-- company-scoped tables: organisations (the primary CRM record) and their
-- contacts. Additive only; no existing table or row changes.
-- Rollback: DROP TABLE "organisation_contacts", "organisations";
CREATE TABLE "organisation_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"email" text,
	"phone" text,
	"is_key_contact" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"external_id" text,
	"archived_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organisation_contacts_source_check" CHECK ("organisation_contacts"."source" in ('manual', 'pipedrive', 'csv'))
);
--> statement-breakpoint
CREATE TABLE "organisations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"website" text,
	"industry" text,
	"country" text,
	"country_owner" text,
	"status" text DEFAULT 'target' NOT NULL,
	"notes" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"external_id" text,
	"archived_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organisations_status_check" CHECK ("organisations"."status" in ('target', 'prospect', 'client', 'former')),
	CONSTRAINT "organisations_source_check" CHECK ("organisations"."source" in ('manual', 'pipedrive', 'csv'))
);
--> statement-breakpoint
ALTER TABLE "organisation_contacts" ADD CONSTRAINT "organisation_contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_contacts" ADD CONSTRAINT "organisation_contacts_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_contacts" ADD CONSTRAINT "organisation_contacts_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organisation_contacts_company_organisation_idx" ON "organisation_contacts" USING btree ("company_id","organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organisation_contacts_company_source_external_uq" ON "organisation_contacts" USING btree ("company_id","source","external_id") WHERE "organisation_contacts"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "organisations_company_name_idx" ON "organisations" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "organisations_company_status_idx" ON "organisations" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "organisations_company_source_external_uq" ON "organisations" USING btree ("company_id","source","external_id") WHERE "organisations"."external_id" is not null;