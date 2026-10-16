CREATE TABLE "inbound_task_hooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"public_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"assignee_agent_id" uuid,
	"last_used_at" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"created_by_user_id" text,
	"disabled_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inbound_task_hooks" ADD CONSTRAINT "inbound_task_hooks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_task_hooks" ADD CONSTRAINT "inbound_task_hooks_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_task_hooks_public_id_uq" ON "inbound_task_hooks" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "inbound_task_hooks_company_idx" ON "inbound_task_hooks" USING btree ("company_id");