ALTER TABLE "organisation_contacts" DROP CONSTRAINT "organisation_contacts_source_check";--> statement-breakpoint
ALTER TABLE "organisations" DROP CONSTRAINT "organisations_source_check";--> statement-breakpoint
ALTER TABLE "organisation_contacts" ADD CONSTRAINT "organisation_contacts_source_check" CHECK ("organisation_contacts"."source" in ('manual', 'pipedrive', 'csv', 'hubspot'));--> statement-breakpoint
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_source_check" CHECK ("organisations"."source" in ('manual', 'pipedrive', 'csv', 'hubspot'));