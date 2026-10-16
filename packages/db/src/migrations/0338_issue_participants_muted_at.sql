-- Team chat mute (GRE-1587, 15 Oct 2026): a person can mute a chat so new
-- messages no longer alert them; @mentions still do.
-- Additive: one nullable column, no default, no rewrite.
-- Rollback: ALTER TABLE "issue_participants" DROP COLUMN "muted_at";
ALTER TABLE "issue_participants" ADD COLUMN "muted_at" timestamp with time zone;
