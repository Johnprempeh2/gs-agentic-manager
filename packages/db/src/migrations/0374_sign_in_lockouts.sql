CREATE TABLE "sign_in_lockout" (
	"account_key" text PRIMARY KEY NOT NULL,
	"failure_times" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sign_in_lockout_updated_at_idx" ON "sign_in_lockout" USING btree ("updated_at");