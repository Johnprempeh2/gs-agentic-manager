-- Website editor frame origin (GRE-2118, GRE-1916 frame contract section 2): the dedicated editor host
-- the Website page frames for /editor and /preview. Additive and nullable; null means no editor opens.
-- Rollback: ALTER TABLE "website_site" DROP COLUMN "editor_frame_origin";
ALTER TABLE "website_site" ADD COLUMN "editor_frame_origin" text;
