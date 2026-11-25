CREATE TABLE "fleet_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fleet_instance_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"issued_by" text NOT NULL,
	"issued_by_user_id" text,
	"message" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"result" text,
	"result_code" text,
	"result_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fleet_orders" ADD CONSTRAINT "fleet_orders_fleet_instance_id_fleet_instances_id_fk" FOREIGN KEY ("fleet_instance_id") REFERENCES "public"."fleet_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fleet_orders_instance_seq_uq" ON "fleet_orders" USING btree ("fleet_instance_id","seq");