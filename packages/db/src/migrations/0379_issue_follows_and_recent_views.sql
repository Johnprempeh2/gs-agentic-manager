CREATE TABLE "issue_follows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_recent_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_follows" ADD CONSTRAINT "issue_follows_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_follows" ADD CONSTRAINT "issue_follows_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_recent_views" ADD CONSTRAINT "issue_recent_views_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_recent_views" ADD CONSTRAINT "issue_recent_views_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_follows_company_user_idx" ON "issue_follows" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_follows_company_issue_user_idx" ON "issue_follows" USING btree ("company_id","issue_id","user_id");--> statement-breakpoint
CREATE INDEX "issue_recent_views_company_user_viewed_idx" ON "issue_recent_views" USING btree ("company_id","user_id","viewed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_recent_views_company_issue_user_idx" ON "issue_recent_views" USING btree ("company_id","issue_id","user_id");