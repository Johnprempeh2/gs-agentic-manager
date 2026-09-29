CREATE TABLE "goal_check_ins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"author_agent_id" uuid,
	"author_user_id" text,
	"body" text NOT NULL,
	"progress_percent" integer,
	"blockers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "target_date" date;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "done_when" text;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "target_value" double precision;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "current_value" double precision;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "unit" text;--> statement-breakpoint
ALTER TABLE "goal_check_ins" ADD CONSTRAINT "goal_check_ins_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_check_ins" ADD CONSTRAINT "goal_check_ins_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_check_ins" ADD CONSTRAINT "goal_check_ins_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goal_check_ins_goal_created_idx" ON "goal_check_ins" USING btree ("goal_id","created_at");--> statement-breakpoint
CREATE INDEX "goal_check_ins_company_idx" ON "goal_check_ins" USING btree ("company_id");