-- Deep Dive sync to the website (GRE-2439). Additive: one new table, four nullable columns on
-- "website_site" (the write key and the site's own call-back key), three nullable columns on
-- "pipeline_case_document_requests" (answered on the website), two indexes and one foreign key.
-- Nothing existing changes, so the previous live-* tag still runs on it.
-- Rollback:
--   DROP TABLE IF EXISTS "website_bridge_inbound_nonces";
--   DROP INDEX IF EXISTS "website_site_data_bridge_site_key_uq";
--   ALTER TABLE "website_site" DROP CONSTRAINT IF EXISTS "website_site_data_bridge_write_secret_id_company_secrets_id_fk";
--   ALTER TABLE "website_site" DROP COLUMN "data_bridge_site_public_key", DROP COLUMN "data_bridge_site_key_id",
--     DROP COLUMN "data_bridge_write_secret_id", DROP COLUMN "data_bridge_write_key_id";
--   ALTER TABLE "pipeline_case_document_requests" DROP COLUMN "website_answer", DROP COLUMN "website_answered_by",
--     DROP COLUMN "website_answered_at";
CREATE TABLE "website_bridge_inbound_nonces" (
	"key_id" text NOT NULL,
	"nonce" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "website_bridge_inbound_nonces_key_id_nonce_pk" PRIMARY KEY("key_id","nonce")
);
--> statement-breakpoint
ALTER TABLE "pipeline_case_document_requests" ADD COLUMN "website_answered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pipeline_case_document_requests" ADD COLUMN "website_answered_by" jsonb;--> statement-breakpoint
ALTER TABLE "pipeline_case_document_requests" ADD COLUMN "website_answer" jsonb;--> statement-breakpoint
ALTER TABLE "website_site" ADD COLUMN "data_bridge_write_key_id" text;--> statement-breakpoint
ALTER TABLE "website_site" ADD COLUMN "data_bridge_write_secret_id" uuid;--> statement-breakpoint
ALTER TABLE "website_site" ADD COLUMN "data_bridge_site_key_id" text;--> statement-breakpoint
ALTER TABLE "website_site" ADD COLUMN "data_bridge_site_public_key" text;--> statement-breakpoint
CREATE INDEX "website_bridge_inbound_nonces_expires_idx" ON "website_bridge_inbound_nonces" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "website_site" ADD CONSTRAINT "website_site_data_bridge_write_secret_id_company_secrets_id_fk" FOREIGN KEY ("data_bridge_write_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "website_site_data_bridge_site_key_uq" ON "website_site" USING btree ("data_bridge_site_key_id") WHERE "website_site"."data_bridge_site_key_id" is not null;