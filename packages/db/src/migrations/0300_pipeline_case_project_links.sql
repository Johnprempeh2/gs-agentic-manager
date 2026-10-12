-- Case–project links (GRE-1047, 9 Oct 2026): link a pipeline case (a client on
-- the "Client journey" pipeline) to the projects that serve it. Goals show
-- through the linked projects. New table, plus two new case event types
-- (project_linked, project_unlinked) in the existing type check.
-- Rollback: DROP TABLE "pipeline_case_project_links"; then re-add
-- "pipeline_case_events_type_check" without the two new types (delete any
-- project_linked / project_unlinked events first).
CREATE TABLE "pipeline_case_project_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipeline_case_events" DROP CONSTRAINT IF EXISTS "pipeline_case_events_type_check";--> statement-breakpoint
ALTER TABLE "pipeline_case_project_links" ADD CONSTRAINT "pipeline_case_project_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_project_links" ADD CONSTRAINT "pipeline_case_project_links_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_project_links" ADD CONSTRAINT "pipeline_case_project_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_project_links" ADD CONSTRAINT "pipeline_case_project_links_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_case_project_links_case_project_uq" ON "pipeline_case_project_links" USING btree ("case_id","project_id");--> statement-breakpoint
CREATE INDEX "pipeline_case_project_links_company_project_idx" ON "pipeline_case_project_links" USING btree ("company_id","project_id");--> statement-breakpoint
ALTER TABLE "pipeline_case_events" ADD CONSTRAINT "pipeline_case_events_type_check" CHECK ("pipeline_case_events"."type" in (
        'ingested',
        'updated',
        'claimed',
        'lease_released',
        'lease_expired',
        'transitioned',
        'transition_forced',
        'transition_suggested',
        'suggestion_resolved',
        'review_decided',
        'conversation_opened',
        'issue_linked',
        'issue_unlinked',
        'project_linked',
        'project_unlinked',
        'automation_executed',
        'automation_failed',
        'automation_retry_requested',
        'automation_effects_retired',
        'automation_retry_dispatched',
        'blockers_set',
        'blockers_resolved',
        'children_terminal',
        'upstream_drift',
        'drift_acknowledged'
      ));