CREATE TABLE "agent_daily_digests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"digest_date" date NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"body" text NOT NULL,
	"lead_agent_id" uuid,
	"delivered_issue_id" uuid,
	"delivered_at" timestamp with time zone,
	"skipped_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_daily_digests" ADD CONSTRAINT "agent_daily_digests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_daily_digests" ADD CONSTRAINT "agent_daily_digests_lead_agent_id_agents_id_fk" FOREIGN KEY ("lead_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_daily_digests" ADD CONSTRAINT "agent_daily_digests_delivered_issue_id_issues_id_fk" FOREIGN KEY ("delivered_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_daily_digests_company_date_uq" ON "agent_daily_digests" USING btree ("company_id","digest_date");--> statement-breakpoint
CREATE INDEX "agent_daily_digests_company_created_idx" ON "agent_daily_digests" USING btree ("company_id","created_at");