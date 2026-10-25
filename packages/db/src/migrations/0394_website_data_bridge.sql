-- Website admin bridge (GRE-2323): the site's data bridge address, read key id and the vault secret
-- that holds the read key. Additive: three nullable columns, so the previous live-* tag still runs on it.
-- Rollback: ALTER TABLE "website_site" DROP COLUMN "data_bridge_read_secret_id", DROP COLUMN "data_bridge_read_key_id", DROP COLUMN "data_bridge_url";
ALTER TABLE "website_site" ADD COLUMN "data_bridge_url" text;--> statement-breakpoint
ALTER TABLE "website_site" ADD COLUMN "data_bridge_read_key_id" text;--> statement-breakpoint
ALTER TABLE "website_site" ADD COLUMN "data_bridge_read_secret_id" uuid;--> statement-breakpoint
ALTER TABLE "website_site" ADD CONSTRAINT "website_site_data_bridge_read_secret_id_company_secrets_id_fk" FOREIGN KEY ("data_bridge_read_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;