-- Organization memory phase 2 (GRE-886): review states, review events,
-- explicit relationships, conflicts and extracted-fact provenance; plus the
-- five memory_steward_* tables for the steward daily review (GRE-887).
-- Rollback: drop the five memory_steward_* tables and the four other new tables, then
--   UPDATE memory_records SET status = entry_type WHERE status = 'unreviewed';
--   and drop the five new memory_records columns and two indexes.
CREATE TABLE "memory_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"approved_record_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"shared_terms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"resolution_note" text,
	"resolved_by_actor_type" text,
	"resolved_by_actor_id" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memory_extracted_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"bank_id" text NOT NULL,
	"engine_unit_id" text NOT NULL,
	"fact_type" text,
	"contributor_agent_id" uuid,
	"contributor_user_id" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"from_record_id" uuid NOT NULL,
	"to_record_id" uuid NOT NULL,
	"type" text NOT NULL,
	"author_agent_id" uuid,
	"author_user_id" text,
	"run_id" uuid,
	"source_kind" text,
	"source_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_review_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"action" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"agent_id" uuid,
	"user_id" text,
	"run_id" uuid,
	"reason" text,
	"related_record_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_records" ADD COLUMN "entry_type" text DEFAULT 'proposal' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_records" ADD COLUMN "decision_class" text DEFAULT 'operational' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_records" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_records" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_records" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_conflicts" ADD CONSTRAINT "memory_conflicts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_conflicts" ADD CONSTRAINT "memory_conflicts_scope_id_memory_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."memory_scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_conflicts" ADD CONSTRAINT "memory_conflicts_record_id_memory_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."memory_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_conflicts" ADD CONSTRAINT "memory_conflicts_approved_record_id_memory_records_id_fk" FOREIGN KEY ("approved_record_id") REFERENCES "public"."memory_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_extracted_facts" ADD CONSTRAINT "memory_extracted_facts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_extracted_facts" ADD CONSTRAINT "memory_extracted_facts_record_id_memory_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."memory_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_relationships" ADD CONSTRAINT "memory_relationships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_relationships" ADD CONSTRAINT "memory_relationships_scope_id_memory_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."memory_scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_relationships" ADD CONSTRAINT "memory_relationships_from_record_id_memory_records_id_fk" FOREIGN KEY ("from_record_id") REFERENCES "public"."memory_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_relationships" ADD CONSTRAINT "memory_relationships_to_record_id_memory_records_id_fk" FOREIGN KEY ("to_record_id") REFERENCES "public"."memory_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_review_events" ADD CONSTRAINT "memory_review_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_review_events" ADD CONSTRAINT "memory_review_events_record_id_memory_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."memory_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_conflicts_pair_uq" ON "memory_conflicts" USING btree ("record_id","approved_record_id");--> statement-breakpoint
CREATE INDEX "memory_conflicts_company_state_idx" ON "memory_conflicts" USING btree ("company_id","state");--> statement-breakpoint
CREATE INDEX "memory_conflicts_company_approved_idx" ON "memory_conflicts" USING btree ("company_id","approved_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_extracted_facts_unit_uq" ON "memory_extracted_facts" USING btree ("company_id","bank_id","engine_unit_id");--> statement-breakpoint
CREATE INDEX "memory_extracted_facts_company_record_idx" ON "memory_extracted_facts" USING btree ("company_id","record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_relationships_edge_uq" ON "memory_relationships" USING btree ("from_record_id","to_record_id","type");--> statement-breakpoint
CREATE INDEX "memory_relationships_company_from_idx" ON "memory_relationships" USING btree ("company_id","from_record_id");--> statement-breakpoint
CREATE INDEX "memory_relationships_company_to_idx" ON "memory_relationships" USING btree ("company_id","to_record_id");--> statement-breakpoint
CREATE INDEX "memory_review_events_company_record_idx" ON "memory_review_events" USING btree ("company_id","record_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_review_events_company_created_idx" ON "memory_review_events" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_records_company_status_idx" ON "memory_records" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "memory_records_company_updated_idx" ON "memory_records" USING btree ("company_id","updated_at");--> statement-breakpoint
CREATE TABLE "memory_steward_cursors" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"cursor_updated_at" timestamp with time zone NOT NULL,
	"cursor_record_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_steward_escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"dedupe_key" text NOT NULL,
	"queue_item_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_steward_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"scope_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"environment" text DEFAULT 'sandbox' NOT NULL,
	"granted_by_user_id" text NOT NULL,
	"reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_steward_queue_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"group_key" text NOT NULL,
	"kind" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"route_to" jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_position" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proposed_resolution" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"resolved_by_user_id" text,
	"resolved_by_agent_id" uuid,
	"resolved_at" timestamp with time zone,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_steward_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"grant_id" uuid,
	"state" text DEFAULT 'running' NOT NULL,
	"claim_token" text NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"cursor_from" jsonb,
	"cursor_to" jsonb,
	"entries_seen" integer DEFAULT 0 NOT NULL,
	"escalations_created" integer DEFAULT 0 NOT NULL,
	"escalations_deduped" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"resumed_from_run_id" uuid,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "memory_steward_cursors" ADD CONSTRAINT "memory_steward_cursors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_steward_escalations" ADD CONSTRAINT "memory_steward_escalations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_steward_escalations" ADD CONSTRAINT "memory_steward_escalations_queue_item_id_memory_steward_queue_items_id_fk" FOREIGN KEY ("queue_item_id") REFERENCES "public"."memory_steward_queue_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_steward_escalations" ADD CONSTRAINT "memory_steward_escalations_run_id_memory_steward_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."memory_steward_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_steward_grants" ADD CONSTRAINT "memory_steward_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_steward_grants" ADD CONSTRAINT "memory_steward_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_steward_queue_items" ADD CONSTRAINT "memory_steward_queue_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_steward_queue_items" ADD CONSTRAINT "memory_steward_queue_items_scope_id_memory_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."memory_scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_steward_runs" ADD CONSTRAINT "memory_steward_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_steward_runs" ADD CONSTRAINT "memory_steward_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_steward_runs" ADD CONSTRAINT "memory_steward_runs_grant_id_memory_steward_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."memory_steward_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_steward_escalations_dedupe_uq" ON "memory_steward_escalations" USING btree ("company_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "memory_steward_grants_company_agent_idx" ON "memory_steward_grants" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX "memory_steward_queue_items_company_state_idx" ON "memory_steward_queue_items" USING btree ("company_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_steward_queue_items_open_group_uq" ON "memory_steward_queue_items" USING btree ("company_id","group_key") WHERE "memory_steward_queue_items"."state" = 'open';--> statement-breakpoint
CREATE INDEX "memory_steward_runs_company_started_idx" ON "memory_steward_runs" USING btree ("company_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_steward_runs_one_running_uq" ON "memory_steward_runs" USING btree ("company_id") WHERE "memory_steward_runs"."state" = 'running';--> statement-breakpoint
-- Proposal and observation become entry types; the status column now holds the review state.
UPDATE "memory_records" SET "entry_type" = "status", "status" = 'unreviewed' WHERE "status" IN ('proposal', 'observation');
