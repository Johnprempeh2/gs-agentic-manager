-- Website admin bridge 2c(b): the refund_request key (GRE-2354, GRE-2375). Additive: two nullable columns on
-- "website_site" and one foreign key. The write key columns came with 0403 (the Deep Dive sync key is also the
-- commerce write key). A null key turns that capability off; nothing existing changes, so the previous live-* tag
-- still runs on it, and the columns are safe to leave in place on a rollback of the app.
-- Rollback:
--   ALTER TABLE "website_site" DROP CONSTRAINT IF EXISTS "website_site_data_bridge_refund_secret_id_company_secrets_id_fk";
--   ALTER TABLE "website_site" DROP COLUMN "data_bridge_refund_secret_id", DROP COLUMN "data_bridge_refund_key_id";
ALTER TABLE "website_site" ADD COLUMN "data_bridge_refund_key_id" text;--> statement-breakpoint
ALTER TABLE "website_site" ADD COLUMN "data_bridge_refund_secret_id" uuid;--> statement-breakpoint
ALTER TABLE "website_site" ADD CONSTRAINT "website_site_data_bridge_refund_secret_id_company_secrets_id_fk" FOREIGN KEY ("data_bridge_refund_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;