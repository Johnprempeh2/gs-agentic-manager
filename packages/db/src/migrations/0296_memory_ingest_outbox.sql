CREATE TABLE "memory_ingest_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"op" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"claim_token" text,
	"last_error_kind" text,
	"last_error" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_ingest_outbox" ADD CONSTRAINT "memory_ingest_outbox_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_ingest_outbox" ADD CONSTRAINT "memory_ingest_outbox_record_id_memory_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."memory_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_ingest_outbox_dedupe_idx" ON "memory_ingest_outbox" USING btree ("record_id","op","payload_hash");--> statement-breakpoint
CREATE INDEX "memory_ingest_outbox_due_idx" ON "memory_ingest_outbox" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "memory_ingest_outbox_company_synced_idx" ON "memory_ingest_outbox" USING btree ("company_id","synced_at");