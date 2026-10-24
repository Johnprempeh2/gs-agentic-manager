-- Website preview addresses (24 Oct 2026): the Preview tab's Live and In development views.
-- live_preview_url: an optional frameable exact copy of the live deploy (null: the live domain).
-- dev_preview_url: the development build (null: the editor address). Additive and nullable.
-- Rollback: ALTER TABLE "website_site" DROP COLUMN "live_preview_url"; ALTER TABLE "website_site" DROP COLUMN "dev_preview_url";
ALTER TABLE "website_site" ADD COLUMN "live_preview_url" text;--> statement-breakpoint
ALTER TABLE "website_site" ADD COLUMN "dev_preview_url" text;
