-- Memory linking (6 Oct 2026): possible links between memory records found by
-- the link check. Leads for a reviewer, not stated relationships. New table
-- only; no existing table or row changes.
-- Rollback: DROP TABLE "memory_link_leads";
CREATE TABLE "memory_link_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"from_record_id" uuid NOT NULL,
	"to_record_id" uuid NOT NULL,
	"from_scope_id" uuid NOT NULL,
	"to_scope_id" uuid NOT NULL,
	"basis" jsonb NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"resolution_note" text,
	"resolved_by_actor_type" text,
	"resolved_by_actor_id" text,
	"relationship_id" uuid,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "memory_link_leads" ADD CONSTRAINT "memory_link_leads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_link_leads" ADD CONSTRAINT "memory_link_leads_from_record_id_memory_records_id_fk" FOREIGN KEY ("from_record_id") REFERENCES "public"."memory_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_link_leads" ADD CONSTRAINT "memory_link_leads_to_record_id_memory_records_id_fk" FOREIGN KEY ("to_record_id") REFERENCES "public"."memory_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_link_leads" ADD CONSTRAINT "memory_link_leads_from_scope_id_memory_scopes_id_fk" FOREIGN KEY ("from_scope_id") REFERENCES "public"."memory_scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_link_leads" ADD CONSTRAINT "memory_link_leads_to_scope_id_memory_scopes_id_fk" FOREIGN KEY ("to_scope_id") REFERENCES "public"."memory_scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_link_leads" ADD CONSTRAINT "memory_link_leads_relationship_id_memory_relationships_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."memory_relationships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_link_leads_pair_uq" ON "memory_link_leads" USING btree ("from_record_id","to_record_id");--> statement-breakpoint
CREATE INDEX "memory_link_leads_company_state_idx" ON "memory_link_leads" USING btree ("company_id","state");--> statement-breakpoint
CREATE INDEX "memory_link_leads_company_to_idx" ON "memory_link_leads" USING btree ("company_id","to_record_id");