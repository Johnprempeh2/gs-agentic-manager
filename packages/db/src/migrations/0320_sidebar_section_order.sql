-- Sidebar rearranging (10 Oct 2026): each user may reorder the sidebar sections,
-- synced across devices. Additive: one new column with an empty default.
-- Rollback: ALTER TABLE "user_sidebar_preferences" DROP COLUMN "section_order";
ALTER TABLE "user_sidebar_preferences" ADD COLUMN "section_order" jsonb DEFAULT '[]'::jsonb NOT NULL;
