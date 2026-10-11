-- Fleet check-in v2 (GRE-1366): the hub keeps the lifecycle (active, paused,
-- archived) and app health of the last check-in on each fleet instance, so a
-- paused instance shows paused, not down. Additive only; three nullable columns.
-- Rollback: ALTER TABLE "fleet_instances" DROP COLUMN "lifecycle", DROP COLUMN "lifecycle_changed_at", DROP COLUMN "last_app_health";
ALTER TABLE "fleet_instances" ADD COLUMN "lifecycle" text;--> statement-breakpoint
ALTER TABLE "fleet_instances" ADD COLUMN "lifecycle_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fleet_instances" ADD COLUMN "last_app_health" text;