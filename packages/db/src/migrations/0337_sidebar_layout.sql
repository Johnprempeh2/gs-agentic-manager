-- Sidebar organise (15 Oct 2026): each user may reorder, move, hide and pin
-- sidebar items and fold sections, synced across devices.
-- Additive: one new column with an empty default.
-- Rollback: ALTER TABLE "user_sidebar_preferences" DROP COLUMN "layout";
ALTER TABLE "user_sidebar_preferences" ADD COLUMN "layout" jsonb DEFAULT '{}'::jsonb NOT NULL;
