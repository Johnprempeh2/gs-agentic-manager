-- Fleet registration and check-in (GRE-1082, 9 Oct 2026): client instances a
-- Greatstone hub oversees, and their signed check-ins (facts only, no client
-- business data). New tables only; no existing table or row changes.
-- Rollback: DROP TABLE "fleet_check_ins"; DROP TABLE "fleet_instances";
CREATE TABLE "fleet_check_ins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fleet_instance_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"registration_code_hash" text,
	"registration_code_expires_at" timestamp with time zone,
	"public_key_x" text,
	"last_seq" bigint,
	"last_check_in_at" timestamp with time zone,
	"registered_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fleet_check_ins" ADD CONSTRAINT "fleet_check_ins_fleet_instance_id_fleet_instances_id_fk" FOREIGN KEY ("fleet_instance_id") REFERENCES "public"."fleet_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fleet_check_ins_instance_received_idx" ON "fleet_check_ins" USING btree ("fleet_instance_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fleet_instances_code_uq" ON "fleet_instances" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "fleet_instances_registration_code_hash_uq" ON "fleet_instances" USING btree ("registration_code_hash");