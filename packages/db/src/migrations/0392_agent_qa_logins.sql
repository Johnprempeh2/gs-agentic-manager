-- Browser QA access for an agent (GRE-2387): one row per grant of a QA member log-in.
-- Additive. Rollback: DROP TABLE "agent_qa_logins";
CREATE TABLE "agent_qa_logins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"granted_by_user_id" text NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_qa_logins" ADD CONSTRAINT "agent_qa_logins_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_qa_logins" ADD CONSTRAINT "agent_qa_logins_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_qa_logins" ADD CONSTRAINT "agent_qa_logins_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_qa_logins_active_agent_uq" ON "agent_qa_logins" USING btree ("company_id","agent_id") WHERE "agent_qa_logins"."status" = 'active';--> statement-breakpoint
CREATE INDEX "agent_qa_logins_user_idx" ON "agent_qa_logins" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_qa_logins_status_expires_idx" ON "agent_qa_logins" USING btree ("status","expires_at");