-- Fleet support bridge (GRE-1084, 12 Oct 2026). Hub side: fleet_support_*
-- link a client instance's "Get help" ticket to a support ticket, and keep
-- the replies we send and the files the client picked. Spoke side:
-- client_support_* hold the client's own tickets. New tables plus one
-- nullable column on fleet_instances; no existing row changes.
-- Rollback: DROP TABLE "fleet_support_attachments", "fleet_support_replies", "fleet_support_tickets",
--   "client_support_attachments", "client_support_replies", "client_support_tickets";
--   ALTER TABLE "fleet_instances" DROP COLUMN "support_queue_id";
CREATE TABLE "client_support_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"object_key" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_by_user_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_support_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"hub_reply_id" uuid NOT NULL,
	"body" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"priority" text NOT NULL,
	"linked_issue_id" uuid,
	"created_by_user_id" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"sent_revision" integer,
	"status" text DEFAULT 'queued' NOT NULL,
	"refused_reason" text,
	"hub_ticket_id" text,
	"hub_priority" text,
	"hub_category" text,
	"hub_owner" text,
	"hub_received_at" timestamp with time zone,
	"first_response_due_at" timestamp with time zone,
	"first_response_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_support_tickets_kind_check" CHECK ("client_support_tickets"."kind" in ('support', 'quality-review', 'upgrade')),
	CONSTRAINT "client_support_tickets_priority_check" CHECK ("client_support_tickets"."priority" in ('P1', 'P2', 'P3'))
);
--> statement-breakpoint
CREATE TABLE "fleet_support_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fleet_support_ticket_id" uuid NOT NULL,
	"spoke_ref" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_support_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fleet_support_ticket_id" uuid NOT NULL,
	"body" text NOT NULL,
	"author_agent_id" uuid,
	"author_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fleet_instance_id" uuid NOT NULL,
	"spoke_ref" uuid NOT NULL,
	"kind" text NOT NULL,
	"revision" integer NOT NULL,
	"support_ticket_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fleet_instances" ADD COLUMN "support_queue_id" uuid;--> statement-breakpoint
ALTER TABLE "client_support_attachments" ADD CONSTRAINT "client_support_attachments_ticket_id_client_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."client_support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_support_attachments" ADD CONSTRAINT "client_support_attachments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_support_replies" ADD CONSTRAINT "client_support_replies_ticket_id_client_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."client_support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_support_tickets" ADD CONSTRAINT "client_support_tickets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_support_tickets" ADD CONSTRAINT "client_support_tickets_linked_issue_id_issues_id_fk" FOREIGN KEY ("linked_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_support_attachments" ADD CONSTRAINT "fleet_support_attachments_fleet_support_ticket_id_fleet_support_tickets_id_fk" FOREIGN KEY ("fleet_support_ticket_id") REFERENCES "public"."fleet_support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_support_attachments" ADD CONSTRAINT "fleet_support_attachments_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_support_replies" ADD CONSTRAINT "fleet_support_replies_fleet_support_ticket_id_fleet_support_tickets_id_fk" FOREIGN KEY ("fleet_support_ticket_id") REFERENCES "public"."fleet_support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_support_tickets" ADD CONSTRAINT "fleet_support_tickets_fleet_instance_id_fleet_instances_id_fk" FOREIGN KEY ("fleet_instance_id") REFERENCES "public"."fleet_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_support_tickets" ADD CONSTRAINT "fleet_support_tickets_support_ticket_id_support_tickets_id_fk" FOREIGN KEY ("support_ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_support_tickets" ADD CONSTRAINT "fleet_support_tickets_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_support_attachments_ticket_idx" ON "client_support_attachments" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "client_support_replies_ticket_hub_reply_uq" ON "client_support_replies" USING btree ("ticket_id","hub_reply_id");--> statement-breakpoint
CREATE INDEX "client_support_tickets_company_created_idx" ON "client_support_tickets" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fleet_support_attachments_ticket_ref_uq" ON "fleet_support_attachments" USING btree ("fleet_support_ticket_id","spoke_ref");--> statement-breakpoint
CREATE INDEX "fleet_support_replies_ticket_created_idx" ON "fleet_support_replies" USING btree ("fleet_support_ticket_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fleet_support_tickets_instance_ref_uq" ON "fleet_support_tickets" USING btree ("fleet_instance_id","spoke_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "fleet_support_tickets_issue_uq" ON "fleet_support_tickets" USING btree ("issue_id");--> statement-breakpoint
ALTER TABLE "fleet_instances" ADD CONSTRAINT "fleet_instances_support_queue_id_support_queues_id_fk" FOREIGN KEY ("support_queue_id") REFERENCES "public"."support_queues"("id") ON DELETE set null ON UPDATE no action;