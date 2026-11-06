CREATE TABLE "links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"type" text DEFAULT 'other' NOT NULL,
	"status" text DEFAULT 'live' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"client_case_id" uuid,
	"client_name" text,
	"project_id" uuid,
	"project_name" text,
	"source_issue_id" uuid,
	"notes" text,
	"deployed_at" timestamp with time zone,
	"added_by_agent_id" uuid,
	"added_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_client_case_id_pipeline_cases_id_fk" FOREIGN KEY ("client_case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_added_by_agent_id_agents_id_fk" FOREIGN KEY ("added_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "links_company_url_uq" ON "links" USING btree ("company_id","url");--> statement-breakpoint
CREATE INDEX "links_company_client_idx" ON "links" USING btree ("company_id","client_case_id");--> statement-breakpoint
CREATE INDEX "links_company_updated_idx" ON "links" USING btree ("company_id","updated_at");