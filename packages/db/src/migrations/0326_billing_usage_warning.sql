-- Billing usage block (GRE-1389, B1 on GRE-1357): the monthly usage estimated
-- at sign-up, and the newest usage window that crossed the warn level (one
-- Inbox card per window). Additive only; three nullable columns, no data moved.
-- Rollback: ALTER TABLE "billing_accounts" DROP COLUMN "usage_warned_at", DROP COLUMN "usage_warned_window_start", DROP COLUMN "estimate_monthly_cents";
ALTER TABLE "billing_accounts" ADD COLUMN "estimate_monthly_cents" integer;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "usage_warned_window_start" date;--> statement-breakpoint
ALTER TABLE "billing_accounts" ADD COLUMN "usage_warned_at" timestamp with time zone;
