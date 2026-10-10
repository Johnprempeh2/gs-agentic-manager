-- Element and region anchors for deliverable comments (GRE-1223, 10 Oct 2026).
-- Adds two columns; existing rows become text comments with no locator.
-- Rollback: ALTER TABLE "deliverable_comments" DROP COLUMN "locator"; ALTER TABLE "deliverable_comments" DROP COLUMN "anchor_kind";
ALTER TABLE "deliverable_comments" ADD COLUMN "anchor_kind" text DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "deliverable_comments" ADD COLUMN "locator" jsonb;