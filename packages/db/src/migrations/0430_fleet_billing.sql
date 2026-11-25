CREATE TABLE "fleet_billing_customers" (
	"stripe_customer_id" text PRIMARY KEY NOT NULL,
	"fleet_instance_id" uuid NOT NULL,
	"stripe_subscription_id" text,
	"subscription_status" text,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_billing_events" (
	"stripe_event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"outcome" text NOT NULL,
	"fleet_instance_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_billing_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"module_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"monthly_amount" integer,
	"annual_amount" integer,
	"currency" text DEFAULT 'gbp' NOT NULL,
	"stripe_customer_id" text,
	"stripe_product_id" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fleet_billing_prices" (
	"stripe_price_id" text PRIMARY KEY NOT NULL,
	"item_id" uuid NOT NULL,
	"interval" text NOT NULL,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fleet_billing_customers" ADD CONSTRAINT "fleet_billing_customers_fleet_instance_id_fleet_instances_id_fk" FOREIGN KEY ("fleet_instance_id") REFERENCES "public"."fleet_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleet_billing_prices" ADD CONSTRAINT "fleet_billing_prices_item_id_fleet_billing_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."fleet_billing_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fleet_billing_customers_instance_uq" ON "fleet_billing_customers" USING btree ("fleet_instance_id");--> statement-breakpoint
CREATE INDEX "fleet_billing_prices_item_idx" ON "fleet_billing_prices" USING btree ("item_id");