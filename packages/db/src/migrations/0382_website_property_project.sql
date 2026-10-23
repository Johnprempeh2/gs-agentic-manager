-- Website hub (23 Oct 2026): a website property may name the project that builds it.
-- Additive and nullable. Rollback: ALTER TABLE "website_properties" DROP COLUMN "project_id";
ALTER TABLE "website_properties" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "website_properties" ADD CONSTRAINT "website_properties_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
