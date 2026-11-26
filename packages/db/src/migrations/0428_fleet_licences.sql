ALTER TABLE "fleet_instances" ADD COLUMN IF NOT EXISTS "entitlement_document" jsonb;--> statement-breakpoint
ALTER TABLE "fleet_instances" ADD COLUMN IF NOT EXISTS "entitlement_version" integer;--> statement-breakpoint
ALTER TABLE "fleet_instances" ADD COLUMN IF NOT EXISTS "operator_email" text;--> statement-breakpoint
ALTER TABLE "fleet_instances" ADD COLUMN IF NOT EXISTS "operator_secret" jsonb;