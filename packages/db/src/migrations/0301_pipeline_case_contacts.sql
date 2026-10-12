-- Case contacts (GRE-1048, 9 Oct 2026): the people at a client on the
-- "Client journey" pipeline (name, role, phone, email). New table only.
-- Rollback: DROP TABLE "pipeline_case_contacts";
CREATE TABLE "pipeline_case_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"phone" text,
	"email" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipeline_case_contacts" ADD CONSTRAINT "pipeline_case_contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_contacts" ADD CONSTRAINT "pipeline_case_contacts_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_case_contacts" ADD CONSTRAINT "pipeline_case_contacts_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipeline_case_contacts_company_case_idx" ON "pipeline_case_contacts" USING btree ("company_id","case_id");