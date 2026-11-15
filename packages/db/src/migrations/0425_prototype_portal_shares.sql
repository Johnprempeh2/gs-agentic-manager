CREATE TABLE "prototype_portal_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"deliverable_key" text NOT NULL,
	"organisation_id" uuid NOT NULL,
	"website_organisation_id" text NOT NULL,
	"shared_url" text NOT NULL,
	"shared_by_user_id" text NOT NULL,
	"shared_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prototype_portal_shares" ADD CONSTRAINT "prototype_portal_shares_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prototype_portal_shares" ADD CONSTRAINT "prototype_portal_shares_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prototype_portal_shares" ADD CONSTRAINT "prototype_portal_shares_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prototype_portal_shares_prototype_uq" ON "prototype_portal_shares" USING btree ("company_id","issue_id","deliverable_key");--> statement-breakpoint
CREATE INDEX "prototype_portal_shares_website_organisation_idx" ON "prototype_portal_shares" USING btree ("company_id","website_organisation_id");