-- CRM sync tables (GRE-1100, 9 Oct 2026): bindings, field maps, record links,
-- conflicts and the sync log. New tables only; no existing table changes.
-- Rollback: DROP TABLE "crm_sync_events", "crm_sync_conflicts", "crm_sync_record_links", "crm_sync_field_maps", "crm_sync_bindings";
CREATE TABLE "crm_sync_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_key" text NOT NULL,
	"container_kind" text NOT NULL,
	"external_container_id" text NOT NULL,
	"external_container_label" text,
	"pipeline_id" uuid NOT NULL,
	"direction" text DEFAULT 'both' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"stage_map" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sync_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_sync_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_error_message" text,
	"field_map_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_sync_bindings_container_kind_check" CHECK ("crm_sync_bindings"."container_kind" in ('crm_pipeline', 'notion_database')),
	CONSTRAINT "crm_sync_bindings_direction_check" CHECK ("crm_sync_bindings"."direction" in ('both', 'inbound_only', 'outbound_only')),
	CONSTRAINT "crm_sync_bindings_status_check" CHECK ("crm_sync_bindings"."status" in ('active', 'paused', 'error'))
);
--> statement-breakpoint
CREATE TABLE "crm_sync_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"entity_kind" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"gsam_field" text NOT NULL,
	"external_field" text NOT NULL,
	"last_synced_value" jsonb,
	"crm_value" jsonb NOT NULL,
	"gsam_value" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"resolved_value" jsonb,
	"dismiss_reason" text,
	"resolved_by_user_id" text,
	"resolved_by_agent_id" uuid,
	"resolved_at" timestamp with time zone,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_sync_conflicts_entity_kind_check" CHECK ("crm_sync_conflicts"."entity_kind" in ('case', 'contact')),
	CONSTRAINT "crm_sync_conflicts_status_check" CHECK ("crm_sync_conflicts"."status" in ('open', 'resolved', 'dismissed')),
	CONSTRAINT "crm_sync_conflicts_resolution_check" CHECK ("crm_sync_conflicts"."resolution" is null or "crm_sync_conflicts"."resolution" in ('keep_crm', 'keep_gsam', 'custom'))
);
--> statement-breakpoint
CREATE TABLE "crm_sync_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"action" text NOT NULL,
	"entity_kind" text NOT NULL,
	"entity_id" uuid,
	"external_id" text NOT NULL,
	"changed_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conflict_id" uuid,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_sync_events_direction_check" CHECK ("crm_sync_events"."direction" in ('inbound', 'outbound')),
	CONSTRAINT "crm_sync_events_action_check" CHECK ("crm_sync_events"."action" in ('created', 'updated', 'unchanged', 'conflict', 'failed')),
	CONSTRAINT "crm_sync_events_entity_kind_check" CHECK ("crm_sync_events"."entity_kind" in ('case', 'contact'))
);
--> statement-breakpoint
CREATE TABLE "crm_sync_field_maps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"external_field" text NOT NULL,
	"external_field_label" text,
	"gsam_field" text NOT NULL,
	"owner" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_sync_field_maps_owner_check" CHECK ("crm_sync_field_maps"."owner" in ('crm', 'gsam', 'shared'))
);
--> statement-breakpoint
CREATE TABLE "crm_sync_record_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"entity_kind" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_key" text NOT NULL,
	"external_id" text NOT NULL,
	"last_synced_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_sync_record_links_entity_kind_check" CHECK ("crm_sync_record_links"."entity_kind" in ('case', 'contact'))
);
--> statement-breakpoint
ALTER TABLE "crm_sync_bindings" ADD CONSTRAINT "crm_sync_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_bindings" ADD CONSTRAINT "crm_sync_bindings_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_bindings" ADD CONSTRAINT "crm_sync_bindings_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_conflicts" ADD CONSTRAINT "crm_sync_conflicts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_conflicts" ADD CONSTRAINT "crm_sync_conflicts_binding_id_crm_sync_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."crm_sync_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_conflicts" ADD CONSTRAINT "crm_sync_conflicts_resolved_by_agent_id_agents_id_fk" FOREIGN KEY ("resolved_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_events" ADD CONSTRAINT "crm_sync_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_events" ADD CONSTRAINT "crm_sync_events_binding_id_crm_sync_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."crm_sync_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_events" ADD CONSTRAINT "crm_sync_events_conflict_id_crm_sync_conflicts_id_fk" FOREIGN KEY ("conflict_id") REFERENCES "public"."crm_sync_conflicts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_field_maps" ADD CONSTRAINT "crm_sync_field_maps_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_field_maps" ADD CONSTRAINT "crm_sync_field_maps_binding_id_crm_sync_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."crm_sync_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_record_links" ADD CONSTRAINT "crm_sync_record_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_sync_record_links" ADD CONSTRAINT "crm_sync_record_links_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crm_sync_bindings_container_uq" ON "crm_sync_bindings" USING btree ("company_id","connection_id","container_kind","external_container_id") WHERE "crm_sync_bindings"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "crm_sync_bindings_company_idx" ON "crm_sync_bindings" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "crm_sync_bindings_pipeline_idx" ON "crm_sync_bindings" USING btree ("pipeline_id");--> statement-breakpoint
CREATE INDEX "crm_sync_bindings_due_idx" ON "crm_sync_bindings" USING btree ("next_sync_at") WHERE "crm_sync_bindings"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "crm_sync_conflicts_open_field_uq" ON "crm_sync_conflicts" USING btree ("binding_id","entity_kind","entity_id","gsam_field") WHERE "crm_sync_conflicts"."status" = 'open';--> statement-breakpoint
CREATE INDEX "crm_sync_conflicts_company_status_idx" ON "crm_sync_conflicts" USING btree ("company_id","status","detected_at");--> statement-breakpoint
CREATE INDEX "crm_sync_conflicts_binding_status_idx" ON "crm_sync_conflicts" USING btree ("binding_id","status");--> statement-breakpoint
CREATE INDEX "crm_sync_events_binding_created_idx" ON "crm_sync_events" USING btree ("binding_id","created_at","id");--> statement-breakpoint
CREATE INDEX "crm_sync_events_company_entity_idx" ON "crm_sync_events" USING btree ("company_id","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_sync_field_maps_external_field_uq" ON "crm_sync_field_maps" USING btree ("binding_id","external_field");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_sync_field_maps_gsam_field_uq" ON "crm_sync_field_maps" USING btree ("binding_id","gsam_field");--> statement-breakpoint
CREATE INDEX "crm_sync_field_maps_company_idx" ON "crm_sync_field_maps" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_sync_record_links_entity_source_uq" ON "crm_sync_record_links" USING btree ("entity_kind","entity_id","connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_sync_record_links_external_uq" ON "crm_sync_record_links" USING btree ("connection_id","entity_kind","external_id");--> statement-breakpoint
CREATE INDEX "crm_sync_record_links_company_entity_idx" ON "crm_sync_record_links" USING btree ("company_id","entity_id");