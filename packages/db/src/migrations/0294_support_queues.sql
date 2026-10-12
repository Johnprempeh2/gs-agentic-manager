CREATE TABLE "support_queues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"client_code" text NOT NULL,
	"project_id" uuid NOT NULL,
	"email_endpoint_id" uuid,
	"triage_agent_id" uuid NOT NULL,
	"install_agent_id" uuid,
	"reliability_agent_id" uuid,
	"cover_agent_id" uuid,
	"p1_user_id" text,
	"holidays" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_queues_client_code_check" CHECK ("support_queues"."client_code" ~ '^[A-Z0-9]{2,12}$')
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"queue_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"priority" text NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"warn_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"first_response_at" timestamp with time zone,
	"warned_at" timestamp with time zone,
	"breached_at" timestamp with time zone,
	"p1_alerted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_tickets_priority_check" CHECK ("support_tickets"."priority" in ('P1', 'P2', 'P3')),
	CONSTRAINT "support_tickets_category_check" CHECK ("support_tickets"."category" in ('general', 'install', 'reliability'))
);
--> statement-breakpoint
ALTER TABLE "support_queues" ADD CONSTRAINT "support_queues_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_queues" ADD CONSTRAINT "support_queues_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_queues" ADD CONSTRAINT "support_queues_email_endpoint_id_chat_endpoints_id_fk" FOREIGN KEY ("email_endpoint_id") REFERENCES "public"."chat_endpoints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_queues" ADD CONSTRAINT "support_queues_triage_agent_id_agents_id_fk" FOREIGN KEY ("triage_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_queues" ADD CONSTRAINT "support_queues_install_agent_id_agents_id_fk" FOREIGN KEY ("install_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_queues" ADD CONSTRAINT "support_queues_reliability_agent_id_agents_id_fk" FOREIGN KEY ("reliability_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_queues" ADD CONSTRAINT "support_queues_cover_agent_id_agents_id_fk" FOREIGN KEY ("cover_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_queue_id_support_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."support_queues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "support_queues_company_code_uq" ON "support_queues" USING btree ("company_id","client_code");--> statement-breakpoint
CREATE UNIQUE INDEX "support_queues_email_endpoint_uq" ON "support_queues" USING btree ("email_endpoint_id") WHERE "support_queues"."email_endpoint_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "support_tickets_issue_uq" ON "support_tickets" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "support_tickets_open_idx" ON "support_tickets" USING btree ("company_id","due_at") WHERE "support_tickets"."first_response_at" is null;