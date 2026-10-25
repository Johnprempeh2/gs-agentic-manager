ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "resolver_user_ids" text[] DEFAULT '{}'::text[] NOT NULL;
