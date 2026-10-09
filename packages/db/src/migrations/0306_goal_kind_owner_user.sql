-- Goals v2 (GRE-1132): a strategy layer (kind) and a person owner on goals.
-- Two nullable columns; existing goals keep kind = NULL and owner_user_id = NULL
-- and load unchanged. No existing row or column changes.
-- Rollback: ALTER TABLE "goals" DROP COLUMN "owner_user_id"; ALTER TABLE "goals" DROP COLUMN "kind";
ALTER TABLE "goals" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "owner_user_id" text;
