-- Pinned pipelines (10 Oct 2026): a user may star a pipeline so it shows in the
-- sidebar, the same way starred projects, agents and documents do. Additive: one
-- new empty table, star only (no join/leave state).
-- Rollback: DROP TABLE "pipeline_memberships";
CREATE TABLE "pipeline_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"starred_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipeline_memberships" ADD CONSTRAINT "pipeline_memberships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_memberships" ADD CONSTRAINT "pipeline_memberships_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable; this index is created with the new empty membership table.
CREATE INDEX "pipeline_memberships_company_user_starred_idx" ON "pipeline_memberships" USING btree ("company_id","user_id","starred_at");--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable; this index is created with the new empty membership table.
CREATE UNIQUE INDEX "pipeline_memberships_company_user_pipeline_uq" ON "pipeline_memberships" USING btree ("company_id","user_id","pipeline_id");