CREATE TABLE "asset_texts" (
	"asset_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"status" text NOT NULL,
	"text" text,
	"error" text,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "asset_texts" ADD CONSTRAINT "asset_texts_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_texts" ADD CONSTRAINT "asset_texts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_texts_company_idx" ON "asset_texts" USING btree ("company_id");