ALTER TABLE "issues" ADD COLUMN "tabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "tabled_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "tabled_by_user_id" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "tabled_from_status" text;--> statement-breakpoint
CREATE INDEX "issues_tabled_until_idx" ON "issues" USING btree ("tabled_until") WHERE "issues"."tabled_at" is not null;