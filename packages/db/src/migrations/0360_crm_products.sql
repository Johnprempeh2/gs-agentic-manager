CREATE TABLE "crm_deal_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"case_id" uuid NOT NULL,
	"product_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	"quantity" double precision,
	"item_price" double precision,
	"discount" double precision,
	"discount_type" text,
	"tax" double precision,
	"sum" double precision,
	"currency" text,
	"comments" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"unit" text,
	"description" text,
	"tax" double precision,
	"active" boolean DEFAULT true NOT NULL,
	"owner_name" text,
	"prices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm_deal_products" ADD CONSTRAINT "crm_deal_products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deal_products" ADD CONSTRAINT "crm_deal_products_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_deal_products" ADD CONSTRAINT "crm_deal_products_product_id_crm_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."crm_products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_products" ADD CONSTRAINT "crm_products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crm_deal_products_company_source_external_uq" ON "crm_deal_products" USING btree ("company_id","source","external_id");--> statement-breakpoint
CREATE INDEX "crm_deal_products_company_case_idx" ON "crm_deal_products" USING btree ("company_id","case_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_products_company_source_external_uq" ON "crm_products" USING btree ("company_id","source","external_id");--> statement-breakpoint
CREATE INDEX "crm_products_company_name_idx" ON "crm_products" USING btree ("company_id","name");