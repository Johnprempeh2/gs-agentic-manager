CREATE TABLE "notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"decisions" boolean DEFAULT true NOT NULL,
	"assigned_tasks" boolean DEFAULT true NOT NULL,
	"team_chat" boolean DEFAULT true NOT NULL,
	"morning_summary" boolean DEFAULT true NOT NULL,
	"morning_summary_hour" integer DEFAULT 8 NOT NULL,
	"quiet_hours_start" integer,
	"quiet_hours_end" integer,
	"time_zone" text DEFAULT 'Europe/London' NOT NULL,
	"last_morning_summary_on" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_company_user_uq" ON "notification_preferences" USING btree ("company_id","user_id");