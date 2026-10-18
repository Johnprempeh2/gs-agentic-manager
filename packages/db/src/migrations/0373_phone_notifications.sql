CREATE TABLE "push_notification_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"url" text NOT NULL,
	"tag" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "evening_summary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "evening_summary_hour" integer DEFAULT 18 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "quiet_weekends" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "last_evening_summary_on" text;--> statement-breakpoint
ALTER TABLE "push_notification_log" ADD CONSTRAINT "push_notification_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_notification_log_company_user_sent_idx" ON "push_notification_log" USING btree ("company_id","user_id","sent_at");