CREATE TABLE "client_acceptance_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"accepted_name" text,
	"accepted_role" text,
	"accepted_email" text,
	"accepted_ip" text,
	"accepted_user_agent" text
);
--> statement-breakpoint
ALTER TABLE "client_acceptance_links" ADD CONSTRAINT "client_acceptance_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_acceptance_links" ADD CONSTRAINT "client_acceptance_links_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_acceptance_links_token_hash_uq" ON "client_acceptance_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "client_acceptance_links_case_idx" ON "client_acceptance_links" USING btree ("company_id","case_id");--> statement-breakpoint
CREATE INDEX "client_acceptance_links_open_case_idx" ON "client_acceptance_links" USING btree ("case_id") WHERE "client_acceptance_links"."revoked_at" is null;