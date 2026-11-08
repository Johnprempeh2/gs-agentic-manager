ALTER TABLE "website_release" DROP CONSTRAINT "website_release_status_chk";--> statement-breakpoint
ALTER TABLE "website_release" ADD CONSTRAINT "website_release_status_chk" CHECK ("website_release"."status" in ('building', 'checks_failed', 'uploading', 'switched', 'staged', 'pending', 'live', 'superseded', 'failed'));
