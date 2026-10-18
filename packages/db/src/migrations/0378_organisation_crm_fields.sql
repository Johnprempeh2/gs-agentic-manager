-- Global CRM fields on organisations (GRE-1539, slice 2 of GRE-1538, 13 Oct 2026; renumbered 0354 to 0378 on 18 Oct).
-- Additive only: nullable columns, plus tags (NOT NULL, default empty array),
-- two indexes, two foreign keys (set null on delete) and four CHECKs that every
-- existing row passes (all new columns start null). No row is changed.
-- Rollback:
--   ALTER TABLE "organisations" DROP CONSTRAINT "organisations_not_own_parent_check",
--     DROP CONSTRAINT "organisations_one_account_owner_check",
--     DROP CONSTRAINT "organisations_ownership_type_check",
--     DROP CONSTRAINT "organisations_size_band_check",
--     DROP CONSTRAINT "organisations_account_owner_agent_id_agents_id_fk",
--     DROP CONSTRAINT "organisations_parent_organisation_id_organisations_id_fk";
--   DROP INDEX "organisations_parent_idx", "organisations_company_domain_idx";
--   ALTER TABLE "organisations" DROP COLUMN "legal_name", DROP COLUMN "domain", DROP COLUMN "phone",
--     DROP COLUMN "email", DROP COLUMN "address_street", DROP COLUMN "address_city",
--     DROP COLUMN "address_region", DROP COLUMN "address_postal_code", DROP COLUMN "employee_count",
--     DROP COLUMN "size_band", DROP COLUMN "annual_revenue", DROP COLUMN "annual_revenue_currency",
--     DROP COLUMN "ownership_type", DROP COLUMN "parent_organisation_id", DROP COLUMN "linkedin_url",
--     DROP COLUMN "account_owner_user_id", DROP COLUMN "account_owner_agent_id", DROP COLUMN "segment",
--     DROP COLUMN "tags", DROP COLUMN "description", DROP COLUMN "registration_number", DROP COLUMN "tax_id";
--   (Rollback loses any values typed into these fields; existing fields are untouched.)
ALTER TABLE "organisations" ADD COLUMN "legal_name" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "domain" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "address_street" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "address_city" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "address_region" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "address_postal_code" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "employee_count" integer;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "size_band" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "annual_revenue" numeric(20, 2);--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "annual_revenue_currency" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "ownership_type" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "parent_organisation_id" uuid;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "linkedin_url" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "account_owner_user_id" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "account_owner_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "segment" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "registration_number" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "tax_id" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_parent_organisation_id_organisations_id_fk" FOREIGN KEY ("parent_organisation_id") REFERENCES "public"."organisations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_account_owner_agent_id_agents_id_fk" FOREIGN KEY ("account_owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organisations_company_domain_idx" ON "organisations" USING btree ("company_id","domain");--> statement-breakpoint
CREATE INDEX "organisations_parent_idx" ON "organisations" USING btree ("parent_organisation_id");--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_size_band_check" CHECK ("organisations"."size_band" is null or "organisations"."size_band" in ('1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5001+'));--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_ownership_type_check" CHECK ("organisations"."ownership_type" is null or "organisations"."ownership_type" in ('private', 'public', 'subsidiary', 'government', 'non_profit', 'partnership', 'other'));--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_one_account_owner_check" CHECK ("organisations"."account_owner_user_id" is null or "organisations"."account_owner_agent_id" is null);--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_not_own_parent_check" CHECK ("organisations"."parent_organisation_id" <> "organisations"."id");