-- Board pack drafts (GRE-1200, 10 Oct 2026): the board secretary agent may make a
-- draft pack; a board member accepts it. Additive: new nullable columns and a
-- status that defaults to accepted, so every existing pack stays the meeting's pack.
-- Rollback: ALTER TABLE "strategy_board_packs" DROP CONSTRAINT "strategy_board_packs_status_check",
--   DROP CONSTRAINT "strategy_board_packs_created_by_agent_id_agents_id_fk", DROP COLUMN "accepted_at",
--   DROP COLUMN "accepted_by_user_id", DROP COLUMN "status", DROP COLUMN "created_by_agent_id";
ALTER TABLE "strategy_board_packs" ADD COLUMN "created_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "strategy_board_packs" ADD COLUMN "status" text DEFAULT 'accepted' NOT NULL;--> statement-breakpoint
ALTER TABLE "strategy_board_packs" ADD COLUMN "accepted_by_user_id" text;--> statement-breakpoint
ALTER TABLE "strategy_board_packs" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "strategy_board_packs" ADD CONSTRAINT "strategy_board_packs_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_board_packs" ADD CONSTRAINT "strategy_board_packs_status_check" CHECK ("strategy_board_packs"."status" in ('draft', 'accepted'));
--> statement-breakpoint
UPDATE "strategy_board_packs" SET "accepted_by_user_id" = "created_by_user_id", "accepted_at" = "created_at" WHERE "accepted_at" IS NULL;
