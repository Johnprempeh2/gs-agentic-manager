-- Company pause (GRE-1364): a paused company suspends its connections and grants.
-- tool_connections.pause_suspended_at marks a connection the pause turned off; it stays
-- off until it is re-enabled one by one and passes a health check. connection_grants
-- gets a new status, 'suspended', for grants held by the pause.
-- Additive only; no existing row changes.
-- Rollback: UPDATE "connection_grants" SET "status" = 'active' WHERE "status" = 'suspended'; ALTER TABLE "connection_grants" DROP CONSTRAINT "connection_grants_status_check"; ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_status_check" CHECK ("connection_grants"."status" in ('active', 'revoked', 'expired', 'needs_reauthorization')); ALTER TABLE "tool_connections" DROP COLUMN "pause_suspended_at";
ALTER TABLE "connection_grants" DROP CONSTRAINT "connection_grants_status_check";--> statement-breakpoint
ALTER TABLE "tool_connections" ADD COLUMN "pause_suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_status_check" CHECK ("connection_grants"."status" in ('active', 'revoked', 'expired', 'needs_reauthorization', 'suspended'));