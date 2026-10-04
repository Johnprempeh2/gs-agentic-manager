CREATE TABLE "memory_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"outcome" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"agent_id" uuid,
	"run_id" uuid,
	"scope_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"record_id" uuid,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"kind" text DEFAULT 'source_statement' NOT NULL,
	"status" text NOT NULL,
	"sensitivity" text DEFAULT 'internal' NOT NULL,
	"title" text,
	"content" text,
	"entities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"contributor_agent_id" uuid,
	"contributor_user_id" text,
	"run_id" uuid,
	"source_kind" text,
	"source_id" text,
	"evidence" jsonb,
	"effective_from" timestamp with time zone,
	"effective_to" timestamp with time zone,
	"supersedes_id" uuid,
	"superseded_by_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"retain_mode" text NOT NULL,
	"sync_state" text DEFAULT 'pending' NOT NULL,
	"sync_error" text,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memory_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"project_id" uuid,
	"agent_id" uuid,
	"bank_id" text NOT NULL,
	"tag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"retain_mode" text DEFAULT 'extract' NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_scope_id_memory_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."memory_scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_records" ADD CONSTRAINT "memory_records_contributor_agent_id_agents_id_fk" FOREIGN KEY ("contributor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_scopes" ADD CONSTRAINT "memory_scopes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_scopes" ADD CONSTRAINT "memory_scopes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_scopes" ADD CONSTRAINT "memory_scopes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_settings" ADD CONSTRAINT "memory_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_operations_company_created_idx" ON "memory_operations" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_records_company_scope_idx" ON "memory_records" USING btree ("company_id","scope_id");--> statement-breakpoint
CREATE INDEX "memory_records_company_sync_idx" ON "memory_records" USING btree ("company_id","sync_state");--> statement-breakpoint
CREATE INDEX "memory_scopes_company_idx" ON "memory_scopes" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_scopes_company_tag_uq" ON "memory_scopes" USING btree ("company_id","tag");