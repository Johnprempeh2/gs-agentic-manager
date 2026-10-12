-- Memory gateway M0 (GRE-1079, 9 Oct 2026): store the app and session on each
-- memory action, next to the person (agent or user) already stored.
-- Two nullable columns on two existing tables; no rewrite, no data change.
-- Rollback: ALTER TABLE "memory_operations" DROP COLUMN "app", DROP COLUMN "session_id";
--           ALTER TABLE "memory_review_events" DROP COLUMN "app", DROP COLUMN "session_id";
ALTER TABLE "memory_operations" ADD COLUMN "app" text;--> statement-breakpoint
ALTER TABLE "memory_operations" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "memory_review_events" ADD COLUMN "app" text;--> statement-breakpoint
ALTER TABLE "memory_review_events" ADD COLUMN "session_id" text;
