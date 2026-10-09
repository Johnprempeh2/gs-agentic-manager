-- Shared memory M1 (GRE-1089): one steward row per memory scope. Stewards are
-- people; client and restricted scopes never get a row (they route to the owner).
-- New table only; no existing table or row changes.
-- Rollback: DROP TABLE "memory_scope_stewards";
CREATE TABLE "memory_scope_stewards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"primary_user_id" text,
	"backup_user_id" text,
	"set_by_user_id" text NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_scope_stewards" ADD CONSTRAINT "memory_scope_stewards_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_scope_stewards" ADD CONSTRAINT "memory_scope_stewards_scope_id_memory_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."memory_scopes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_scope_stewards_scope_uq" ON "memory_scope_stewards" USING btree ("scope_id");--> statement-breakpoint
CREATE INDEX "memory_scope_stewards_company_idx" ON "memory_scope_stewards" USING btree ("company_id");