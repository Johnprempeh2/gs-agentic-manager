ALTER TABLE "notification_preferences" ADD COLUMN "evening_summary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "evening_summary_hour" integer DEFAULT 18 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "quiet_weekends" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "last_evening_summary_on" text;