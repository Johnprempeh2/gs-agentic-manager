-- Intelligence page (13 Oct 2026): daily reports (Daily Pulse, AI briefing),
-- leaderboard snapshots and GSAM feature / skill recommendations, written by an
-- agent through the API. New tables only.
-- Rollback: DROP TABLE "intelligence_recommendations"; DROP TABLE "intelligence_board_snapshots";
--   DROP TABLE "intelligence_reports";
CREATE TABLE "intelligence_board_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"board" text NOT NULL,
	"snapshot_date" text NOT NULL,
	"entries" jsonb NOT NULL,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intelligence_recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"why" text NOT NULL,
	"effort" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"source_url" text,
	"report_date" text,
	"issue_id" uuid,
	"created_by_agent_id" uuid,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intelligence_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"report_date" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"headline" text,
	"sections" jsonb NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "intelligence_board_snapshots" ADD CONSTRAINT "intelligence_board_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intelligence_board_snapshots" ADD CONSTRAINT "intelligence_board_snapshots_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intelligence_recommendations" ADD CONSTRAINT "intelligence_recommendations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intelligence_recommendations" ADD CONSTRAINT "intelligence_recommendations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intelligence_recommendations" ADD CONSTRAINT "intelligence_recommendations_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intelligence_reports" ADD CONSTRAINT "intelligence_reports_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intelligence_reports" ADD CONSTRAINT "intelligence_reports_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "intelligence_board_snapshots_company_board_date_uq" ON "intelligence_board_snapshots" USING btree ("company_id","board","snapshot_date");--> statement-breakpoint
CREATE INDEX "intelligence_recommendations_company_status_idx" ON "intelligence_recommendations" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "intelligence_recommendations_company_kind_title_uq" ON "intelligence_recommendations" USING btree ("company_id","kind","title");--> statement-breakpoint
CREATE UNIQUE INDEX "intelligence_reports_company_date_kind_uq" ON "intelligence_reports" USING btree ("company_id","report_date","kind");